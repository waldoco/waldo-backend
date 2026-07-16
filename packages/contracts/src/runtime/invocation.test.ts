import { describe, expect, it } from 'vitest';
import { EXTERNAL_ORIGIN_TOOLS, PRIVILEGED_ACTION_TOOLS } from '../tools/handler';
import { toolNameSchema } from '../tools/permissions';
import {
  acceptTrustedInvocation as publicAcceptTrustedInvocation,
  runtimeContextCheckpointSchema as publicRuntimeContextCheckpointSchema,
  runtimeToolCheckpointSchema as publicRuntimeToolCheckpointSchema,
} from '../index';
import {
  acceptTrustedInvocation,
  canonicalInvocationIdempotencySerialization,
  legacyRuntimeRunRecordSchema,
  OUTPUT_DISPOSITION_SEMANTICS,
  parsePersistedInvocationRecord,
  parseSurfaceInvocationRequest,
  runtimeContextCheckpointSchema,
  runtimeInvocationV2RecordSchema,
  runtimeToolCheckpointSchema,
  surfaceInvocationRequestSchema,
  trustedInvocationEnvelopeSchema,
} from './invocation';
import {
  runtimeToolDispatchFailureReasonSchema,
  type RuntimeToolDispatchFailureReason,
} from './run';

const HEX = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);

const ref = (prefix: string, value = HEX) => `${prefix}_${value}`;

const surfaceRequest = {
  input: { kind: 'text' as const, text: 'Please help me plan today.' },
  retry_token: ref('rty'),
};

const trustedAdmission = {
  admission_source: 'authenticated_ingress' as const,
  verified_authority: {
    principal_ref: ref('prn'),
    tenant_ref: ref('ten'),
    verification_ref: ref('ver'),
  },
  input_refs: [{ input_ref: ref('inp'), content_digest: `sha256:${DIGEST}` }],
  intent: { kind: 'respond_to_user' as const },
  occurrence: { occurrence_ref: ref('occ'), occurred_at: 1_700_000_000_000 },
  idempotency_ref: ref('idem'),
  accepted_at: 1_700_000_000_100,
};

const firstTrustedInputRef = trustedAdmission.input_refs[0];
if (!firstTrustedInputRef) throw new Error('trusted admission fixture requires an input reference');

function accept(input: unknown = trustedAdmission) {
  const result = acceptTrustedInvocation(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected accepted invocation, received ${result.error.code}`);
  return result.value;
}

function normaliseTestIngress(parsed: ReturnType<typeof parseSurfaceInvocationRequest>) {
  if (!parsed.ok) throw new Error(`expected parsed surface request, received ${parsed.error.code}`);

  // Test-only ingress adapter: it stages transient content and mints trusted opaque evidence.
  // No raw surface values cross into the accepted envelope.
  const stagedInput =
    parsed.value.input.text === surfaceRequest.input.text
      ? firstTrustedInputRef
      : {
          input_ref: ref('inp', 'f'.repeat(32)),
          content_digest: `sha256:${'e'.repeat(64)}`,
        };
  const idempotencyRef =
    parsed.value.retry_token === surfaceRequest.retry_token
      ? trustedAdmission.idempotency_ref
      : ref('idem', 'd'.repeat(32));

  return accept({ ...trustedAdmission, input_refs: [stagedInput], idempotency_ref: idempotencyRef });
}

describe('surface invocation request', () => {
  it('parses only bounded, ephemeral text and a retry hint', () => {
    expect(surfaceInvocationRequestSchema.safeParse(surfaceRequest).success).toBe(true);
    expect(parseSurfaceInvocationRequest(surfaceRequest)).toEqual({ ok: true, value: surfaceRequest });
  });

  it.each(
    Object.entries({
      user_id: 'user-controlled',
      userId: 'user-controlled',
      owner: 'owner-controlled',
      owner_id: 'owner-controlled',
      principal_ref: ref('prn'),
      tenant: 'tenant-controlled',
      tenant_ref: ref('ten'),
      subscription_tier: 'pro',
      durable_object_id: 'do-controlled',
      do_id: 'do-controlled',
      provider: 'provider-controlled',
      model: 'model-controlled',
      routing_rung: 'routing-controlled',
      spend_state: 'spend-controlled',
      tool_permissions: ['send_message'],
      safety_outcome: 'allow',
      delivery_policy: 'send',
      output: { disposition: 'proactive_delivery' },
      trigger: 'user_message',
      push_class: 'brief',
      channel: 'transport-controlled',
      sink: 'transport-controlled',
      telegram_chat_id: 'transport-controlled',
      telegram: 'transport-controlled',
      whatsapp_recipient: 'transport-controlled',
      whatsapp: 'transport-controlled',
      app_install_id: 'transport-controlled',
      app: 'transport-controlled',
      desktop_session_id: 'transport-controlled',
      desktop: 'transport-controlled',
      cli_session_id: 'transport-controlled',
      cli: 'transport-controlled',
      mcp_server: 'transport-controlled',
      mcp: 'transport-controlled',
    }),
  )('rejects the forbidden %s field', (_field, value) => {
    const request = { ...surfaceRequest, [_field]: value };

    expect(surfaceInvocationRequestSchema.safeParse(request).success).toBe(false);
    expect(parseSurfaceInvocationRequest(request)).toEqual({
      ok: false,
      error: { code: 'invalid_surface_request' },
    });
  });

  it('rejects nested authority and does not echo untrusted content in its error', () => {
    const result = parseSurfaceInvocationRequest({
      input: { ...surfaceRequest.input, owner: 'surface-private-value' },
    });

    expect(result).toEqual({ ok: false, error: { code: 'invalid_surface_request' } });
    expect(JSON.stringify(result)).not.toContain('surface-private-value');
  });

  it('cannot treat a parsed surface body as a trusted admission', () => {
    const parsed = parseSurfaceInvocationRequest(surfaceRequest);
    if (!parsed.ok) throw new Error('surface fixture should parse');

    expect(acceptTrustedInvocation(parsed.value)).toEqual({
      ok: false,
      error: { code: 'invalid_trusted_admission' },
    });
  });
});

describe('trusted invocation acceptance', () => {
  it('derives a portable solicited envelope and runtime binding from trusted admission only', () => {
    const invocation = accept();

    expect(invocation).toMatchObject({
      contract_version: 1,
      verified_authority: trustedAdmission.verified_authority,
      intent: trustedAdmission.intent,
      idempotency: { scope: 'authenticated_request', key_ref: trustedAdmission.idempotency_ref },
      output: { disposition: 'solicited_reply', correlation_ref: trustedAdmission.occurrence.occurrence_ref },
      runtime_binding: {
        trigger: 'user_message',
        variant: null,
        governor_resolution: 'from_trigger',
      },
    });
    expect(JSON.stringify(invocation)).not.toContain(surfaceRequest.input.text);
    expect(JSON.stringify(invocation)).not.toContain(surfaceRequest.retry_token);
  });

  it('is deterministic across semantically identical CLI, MCP, and app ingress fixtures', () => {
    const stageCli = (fixture: { stdin: string; retryToken: string }) =>
      parseSurfaceInvocationRequest({
        input: { kind: 'text', text: fixture.stdin },
        retry_token: fixture.retryToken,
      });
    const stageMcp = (fixture: { params: { prompt: string }; requestId: string }) =>
      parseSurfaceInvocationRequest({
        input: { kind: 'text', text: fixture.params.prompt },
        retry_token: fixture.requestId,
      });
    const stageApp = (fixture: { message: { body: string }; clientRetryToken: string }) =>
      parseSurfaceInvocationRequest({
        input: { kind: 'text', text: fixture.message.body },
        retry_token: fixture.clientRetryToken,
      });
    const cli = normaliseTestIngress(
      stageCli({ stdin: surfaceRequest.input.text, retryToken: ref('rty') }),
    );
    const mcp = normaliseTestIngress(
      stageMcp({ params: { prompt: surfaceRequest.input.text }, requestId: ref('rty') }),
    );
    const app = normaliseTestIngress(
      stageApp({ message: { body: surfaceRequest.input.text }, clientRetryToken: ref('rty') }),
    );

    expect(mcp).toEqual(cli);
    expect(app).toEqual(cli);
    expect(canonicalInvocationIdempotencySerialization(mcp)).toBe(
      canonicalInvocationIdempotencySerialization(cli),
    );
    expect(canonicalInvocationIdempotencySerialization(app)).toBe(
      canonicalInvocationIdempotencySerialization(cli),
    );

    const changedContent = normaliseTestIngress(
      stageCli({ stdin: 'A different request body.', retryToken: ref('rty') }),
    );
    expect(canonicalInvocationIdempotencySerialization(changedContent)).not.toBe(
      canonicalInvocationIdempotencySerialization(cli),
    );
  });

  it('keeps retry identity stable while keeping tenant identity in the canonical material', () => {
    const initial = accept();
    const retry = accept({ ...trustedAdmission, accepted_at: trustedAdmission.accepted_at + 1 });
    const anotherTenant = accept({
      ...trustedAdmission,
      verified_authority: { ...trustedAdmission.verified_authority, tenant_ref: ref('ten', 'c'.repeat(32)) },
    });

    expect(canonicalInvocationIdempotencySerialization(retry)).toBe(
      canonicalInvocationIdempotencySerialization(initial),
    );
    expect(canonicalInvocationIdempotencySerialization(anotherTenant)).not.toBe(
      canonicalInvocationIdempotencySerialization(initial),
    );
  });

  it('serializes trusted idempotency material in a fixed, surface-free order', () => {
    expect(canonicalInvocationIdempotencySerialization(accept())).toBe(
      JSON.stringify([
        ['contract_version', 1],
        ['principal_ref', trustedAdmission.verified_authority.principal_ref],
        ['tenant_ref', trustedAdmission.verified_authority.tenant_ref],
        ['intent', 'respond_to_user'],
        ['variant', null],
        ['occurrence_ref', trustedAdmission.occurrence.occurrence_ref],
        ['idempotency_scope', 'authenticated_request'],
        ['idempotency_ref', trustedAdmission.idempotency_ref],
        ['occurrence_occurred_at', trustedAdmission.occurrence.occurred_at],
        ['content_digests', [firstTrustedInputRef.content_digest]],
      ]),
    );
  });

  it('binds idempotency material to staged content evidence instead of a surface retry token', () => {
    const initial = accept();
    const sameContentDifferentStorageRef = accept({
      ...trustedAdmission,
      input_refs: [{ ...firstTrustedInputRef, input_ref: ref('inp', 'f'.repeat(32)) }],
    });
    const differentContent = accept({
      ...trustedAdmission,
      input_refs: [{ ...firstTrustedInputRef, content_digest: `sha256:${'e'.repeat(64)}` }],
    });

    expect(canonicalInvocationIdempotencySerialization(sameContentDifferentStorageRef)).toBe(
      canonicalInvocationIdempotencySerialization(initial),
    );
    expect(canonicalInvocationIdempotencySerialization(differentContent)).not.toBe(
      canonicalInvocationIdempotencySerialization(initial),
    );

    const sameReferenceDifferentOccurrence = accept({
      ...trustedAdmission,
      occurrence: { ...trustedAdmission.occurrence, occurred_at: trustedAdmission.occurrence.occurred_at + 1 },
    });
    expect(canonicalInvocationIdempotencySerialization(sameReferenceDifferentOccurrence)).not.toBe(
      canonicalInvocationIdempotencySerialization(initial),
    );
  });

  it.each([
    [{ kind: 'assemble_brief', variant: 'evening' }, 'brief', 'evening'],
    [{ kind: 'evaluate_fetch' }, 'fetch_alert', null],
    [{ kind: 'run_patrol' }, 'patrol', null],
    [{ kind: 'pre_brief_work' }, 'pre_brief_sweep', null],
    [{ kind: 'handoff_explore' }, 'handoff_explore', null],
    [{ kind: 'handoff_plan' }, 'handoff_plan', null],
    [{ kind: 'handoff_act' }, 'handoff_act', null],
    [{ kind: 'handoff_replan' }, 'handoff_replan', null],
    [{ kind: 'intervene' }, 'intervention', null],
    [{ kind: 'dream' }, 'dreaming_mode', null],
    [{ kind: 'prepare_pre_activity' }, 'pre_activity_spot', null],
  ])('maps trusted intent %o to the existing trigger vocabulary only', (intent, trigger, variant) => {
    const invocation = accept({
      ...trustedAdmission,
      admission_source: 'trusted_internal',
      intent,
    });

    expect(invocation.runtime_binding).toEqual({
      trigger,
      variant,
      governor_resolution: 'from_trigger',
    });
  });

  it.each([
    ['owner', 'owner-controlled'],
    ['subscription_tier', 'pro'],
    ['durable_object_id', 'do-controlled'],
    ['provider', 'provider-controlled'],
    ['model', 'model-controlled'],
    ['routing_rung', 'routing-controlled'],
    ['spend_state', 'spend-controlled'],
    ['tool_permissions', ['send_message']],
    ['safety_outcome', 'allow'],
    ['delivery_policy', 'send'],
  ])('rejects %s even when it is smuggled into a trusted admission', (_field, value) => {
    const result = acceptTrustedInvocation({ ...trustedAdmission, [_field]: value });

    expect(result).toEqual({ ok: false, error: { code: 'invalid_trusted_admission' } });
    expect(JSON.stringify(result)).not.toContain('controlled');
  });

  it('revalidates source-derived output, intent, and input uniqueness at the durable-envelope boundary', () => {
    const invocation = accept();
    const inputRef = invocation.input_refs[0];
    if (!inputRef) throw new Error('accepted invocation requires an input reference');

    expect(
      trustedInvocationEnvelopeSchema.safeParse({
        ...invocation,
        output: {
          disposition: 'proactive_delivery',
          occurrence_ref: invocation.occurrence.occurrence_ref,
        },
      }).success,
    ).toBe(false);
    expect(
      trustedInvocationEnvelopeSchema.safeParse({
        ...invocation,
        output: {
          disposition: 'solicited_reply',
          correlation_ref: ref('occ', 'd'.repeat(32)),
        },
      }).success,
    ).toBe(false);
    expect(
      trustedInvocationEnvelopeSchema.safeParse({
        ...invocation,
        admission_source: 'trusted_scheduler',
        idempotency: { ...invocation.idempotency, scope: 'scheduled_occurrence' },
        output: {
          disposition: 'proactive_delivery',
          occurrence_ref: invocation.occurrence.occurrence_ref,
        },
      }).success,
    ).toBe(false);
    expect(
      trustedInvocationEnvelopeSchema.safeParse({
        ...invocation,
        input_refs: [inputRef, inputRef],
      }).success,
    ).toBe(false);
    expect(
      trustedInvocationEnvelopeSchema.safeParse({
        ...invocation,
        accepted_at: invocation.occurrence.occurred_at - 1,
      }).success,
    ).toBe(false);
  });
});

describe('output dispositions', () => {
  it.each([
    {
      name: 'authenticated user invocation',
      admission: trustedAdmission,
      disposition: 'solicited_reply',
      semantics: {
        user_visible: true,
        visible_safety_egress_required: true,
        delivery_gate_applicable: false,
        proactive_policy_applicable: false,
        proactive_budget_applicable: false,
      },
    },
    {
      name: 'trusted scheduled invocation',
      admission: {
        ...trustedAdmission,
        admission_source: 'trusted_scheduler' as const,
        intent: { kind: 'assemble_brief' as const, variant: 'morning' as const },
      },
      disposition: 'proactive_delivery',
      semantics: {
        user_visible: true,
        visible_safety_egress_required: true,
        delivery_gate_applicable: true,
        proactive_policy_applicable: true,
        proactive_budget_applicable: true,
      },
    },
    {
      name: 'trusted internal invocation',
      admission: {
        ...trustedAdmission,
        admission_source: 'trusted_internal' as const,
        intent: { kind: 'dream' as const },
      },
      disposition: 'internal_no_output',
      semantics: {
        user_visible: false,
        visible_safety_egress_required: false,
        delivery_gate_applicable: false,
        proactive_policy_applicable: false,
        proactive_budget_applicable: false,
      },
    },
  ])('$name derives only $disposition semantics', ({ admission, disposition, semantics }) => {
    const invocation = accept(admission);

    expect(invocation.output.disposition).toBe(disposition);
    expect(OUTPUT_DISPOSITION_SEMANTICS[invocation.output.disposition]).toEqual(semantics);
    expect(JSON.stringify(invocation.output)).not.toMatch(/channel|payload|sink/u);
  });

  it('rejects caller-selected output and source/intent reclassification', () => {
    expect(
      acceptTrustedInvocation({
        ...trustedAdmission,
        output: { disposition: 'proactive_delivery' },
      }),
    ).toEqual({ ok: false, error: { code: 'invalid_trusted_admission' } });
    expect(
      acceptTrustedInvocation({
        ...trustedAdmission,
        admission_source: 'trusted_scheduler',
      }),
    ).toEqual({ ok: false, error: { code: 'invalid_trusted_admission' } });
  });
});

describe('runtime context provenance', () => {
  const contextCheckpoint = {
    context_version: 2 as const,
    context_ref: ref('ctx'),
    principal_ref: ref('prn'),
    tenant_ref: ref('ten'),
    invocation_idempotency_ref: ref('idem'),
    produced_at: 1_700_000_000_200,
    source_taint: 'external' as const,
    sanitisation: 'passed' as const,
    sources: [
      {
        source_ref: ref('src'),
        source_kind: 'connector_snapshot' as const,
        scope: 'invocation' as const,
        source_taint: 'external' as const,
        produced_at: 1_700_000_000_100,
      },
    ],
  };

  it('records only opaque source provenance with aggregate taint and production time', () => {
    expect(runtimeContextCheckpointSchema.safeParse(contextCheckpoint).success).toBe(true);
  });

  it('rejects taint laundering, duplicate sources, time travel, and unsanitised context', () => {
    expect(
      runtimeContextCheckpointSchema.safeParse({ ...contextCheckpoint, source_taint: null }).success,
    ).toBe(false);
    expect(
      runtimeContextCheckpointSchema.safeParse({
        ...contextCheckpoint,
        sources: [...contextCheckpoint.sources, contextCheckpoint.sources[0]],
      }).success,
    ).toBe(false);
    expect(
      runtimeContextCheckpointSchema.safeParse({
        ...contextCheckpoint,
        sources: [{ ...contextCheckpoint.sources[0], produced_at: contextCheckpoint.produced_at + 1 }],
      }).success,
    ).toBe(false);
    expect(
      runtimeContextCheckpointSchema.safeParse({ ...contextCheckpoint, sanitisation: 'bypassed' })
        .success,
    ).toBe(false);
  });

  it('rejects legacy fake provenance and arbitrary durable payload fields', () => {
    expect(
      runtimeContextCheckpointSchema.safeParse({ ...contextCheckpoint, source: 'fake-derived' }).success,
    ).toBe(false);
    expect(
      runtimeContextCheckpointSchema.safeParse({ ...contextCheckpoint, payload: 'private-value' }).success,
    ).toBe(false);
  });

  it('does not permit connector or workspace provenance to lose external taint', () => {
    for (const sourceKind of ['connector_snapshot', 'workspace_snapshot'] as const) {
      expect(
        runtimeContextCheckpointSchema.safeParse({
          ...contextCheckpoint,
          source_taint: null,
          sources: [{ ...contextCheckpoint.sources[0], source_kind: sourceKind, source_taint: null }],
        }).success,
      ).toBe(false);
    }
  });

  it('keeps derived health provenance inside invocation or principal scope', () => {
    expect(
      runtimeContextCheckpointSchema.safeParse({
        ...contextCheckpoint,
        sources: [
          {
            ...contextCheckpoint.sources[0],
            source_kind: 'derived_health_view',
            scope: 'tenant',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('persisted invocation compatibility', () => {
  const legacyRunRecord = {
    run_id: 'run-legacy-1',
    user_id: 'user-legacy-1',
    trigger: 'user_message' as const,
    variant: null,
    state: 'TOOLS_DONE' as const,
    step: 2,
    attempts: 1,
    run_nonce: 'legacy-nonce-1',
    context_json: {
      source: 'fake-derived' as const,
      trigger: 'user_message' as const,
      body_state: 'steady' as const,
      session_started_at: 1_700_000_000_000,
      tool_permissions: ['get_crs'] as const,
      source_taint: null,
    },
    scratch_json: {
      tool_calls: [{ id: 'call-legacy-1', name: 'get_crs' as const, args: { range_days: 1 } }],
      tool_results: [{ tool: 'get_crs' as const, ok: true as const }],
      source_taint: null,
    },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_200,
    next_expected_wake: null,
    failure_reason: null,
  };

  it('keeps current fake-derived/get_crs records readable through the explicit V1 reader', () => {
    expect(legacyRuntimeRunRecordSchema.safeParse(legacyRunRecord).success).toBe(true);
    expect(parsePersistedInvocationRecord(legacyRunRecord)).toEqual({
      ok: true,
      value: { format: 'legacy_runtime_v1', record: legacyRunRecord },
    });
  });

  it('explicitly normalises only the pre-Scribe absent-taint V1 shape', () => {
    const { source_taint: _contextTaint, ...preScribeContext } = legacyRunRecord.context_json;
    const { source_taint: _scratchTaint, ...preScribeScratch } = legacyRunRecord.scratch_json;
    const preScribeRecord = {
      ...legacyRunRecord,
      context_json: preScribeContext,
      scratch_json: preScribeScratch,
    };

    expect(parsePersistedInvocationRecord(preScribeRecord)).toEqual({
      ok: true,
      value: { format: 'legacy_runtime_v1', record: legacyRunRecord },
    });
  });

  it('fails closed for malformed legacy records and mixed V1/V2 shapes', () => {
    expect(
      parsePersistedInvocationRecord({
        ...legacyRunRecord,
        context_json: { ...legacyRunRecord.context_json, source: 'invented' },
      }),
    ).toEqual({ ok: false, error: { code: 'unsupported_persisted_invocation' } });
    expect(
      parsePersistedInvocationRecord({
        ...legacyRunRecord,
        format: 'invocation_contract_v2',
      }),
    ).toEqual({ ok: false, error: { code: 'unsupported_persisted_invocation' } });
  });

  it('versions V2 records and binds context to the accepted principal, tenant, and idempotency', () => {
    const invocation = accept();
    const v2Record = {
      format: 'invocation_contract_v2' as const,
      record_version: 2 as const,
      invocation,
      context: {
        context_version: 2 as const,
        context_ref: ref('ctx'),
        principal_ref: invocation.verified_authority.principal_ref,
        tenant_ref: invocation.verified_authority.tenant_ref,
        invocation_idempotency_ref: invocation.idempotency.key_ref,
        produced_at: 1_700_000_000_200,
        source_taint: null,
        sanitisation: 'passed' as const,
        sources: [
          {
            source_ref: ref('src'),
            source_kind: 'skill' as const,
            scope: 'principal' as const,
            source_taint: null,
            produced_at: 1_700_000_000_100,
          },
        ],
      },
      tool_checkpoints: [],
      persisted_at: 1_700_000_000_300,
    };

    expect(runtimeInvocationV2RecordSchema.safeParse(v2Record).success).toBe(true);
    expect(parsePersistedInvocationRecord(v2Record)).toEqual({
      ok: true,
      value: { format: 'invocation_contract_v2', record: v2Record },
    });
    expect(
      runtimeInvocationV2RecordSchema.safeParse({
        ...v2Record,
        context: { ...v2Record.context, tenant_ref: ref('ten', 'd'.repeat(32)) },
      }).success,
    ).toBe(false);
    expect(
      runtimeInvocationV2RecordSchema.safeParse({
        ...v2Record,
        context: { ...v2Record.context, principal_ref: ref('prn', 'd'.repeat(32)) },
      }).success,
    ).toBe(false);
    expect(
      runtimeInvocationV2RecordSchema.safeParse({
        ...v2Record,
        invocation: {
          ...v2Record.invocation,
          output: {
            disposition: 'proactive_delivery',
            occurrence_ref: v2Record.invocation.occurrence.occurrence_ref,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      parsePersistedInvocationRecord({
        ...v2Record,
        invocation: {
          ...v2Record.invocation,
          output: {
            disposition: 'proactive_delivery',
            occurrence_ref: v2Record.invocation.occurrence.occurrence_ref,
          },
        },
      }),
    ).toEqual({ ok: false, error: { code: 'unsupported_persisted_invocation' } });
  });
});

describe('generic runtime tool checkpoints', () => {
  const blockedStageByReason = {
    unknown_tool: 'parse',
    invalid_args: 'validation',
    acl_denied: 'acl',
    handler_unavailable: 'handler',
    handler_acl_drift: 'handler',
    hook_halt: 'hook',
    approval_denied: 'approval',
    egress_denied: 'egress',
    sanitise_denied: 'sanitisation',
    handler_failed: 'handler',
    invalid_handler_result: 'handler',
    tool_result_error: 'result',
    invalid_tool_result: 'result',
    result_oversize: 'size',
  } as const satisfies Readonly<Record<RuntimeToolDispatchFailureReason, string>>;

  const completedCheckpoint = {
    checkpoint_version: 2 as const,
    status: 'completed' as const,
    call_ref: ref('call'),
    tool: 'get_crs' as const,
    args_ref: ref('arg'),
    args_hash: DIGEST,
    result_ref: ref('res'),
    result_hash: 'c'.repeat(64),
    audit_ref: ref('aud'),
    guards: {
      args_schema: 'validated' as const,
      result_schema: 'validated' as const,
      acl: 'allowed' as const,
      approval: 'not_required' as const,
      argument_taint: null,
      result_taint: null,
      taint_gate: 'passed' as const,
      sanitisation: 'passed' as const,
      size: 'within_limit' as const,
    },
  };

  it('records only post-dispatch hashes, references, and guard evidence for every known tool', () => {
    for (const tool of toolNameSchema.options) {
      expect(
        runtimeToolCheckpointSchema.safeParse({
          ...completedCheckpoint,
          tool,
          guards: {
            ...completedCheckpoint.guards,
            approval: PRIVILEGED_ACTION_TOOLS.includes(tool) ? 'approved' : 'not_required',
            result_taint: EXTERNAL_ORIGIN_TOOLS.includes(tool) ? 'external' : null,
          },
        }).success,
      ).toBe(true);
    }
  });

  it('requires audit evidence and rejects raw executable payloads in completed summaries', () => {
    const { audit_ref: _auditRef, ...withoutAudit } = completedCheckpoint;
    expect(runtimeToolCheckpointSchema.safeParse(withoutAudit).success).toBe(false);
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...completedCheckpoint,
        args: { arbitrary: 'private-value' },
      }).success,
    ).toBe(false);
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...completedCheckpoint,
        result: { arbitrary: 'private-value' },
      }).success,
    ).toBe(false);
  });

  it('has a closed-union checkpoint property that kills guard-laundering mutations', () => {
    // Mutation candidate: widen completed.sanitisation or completed.acl away from their literals.
    for (const tool of toolNameSchema.options) {
      const guards = {
        ...completedCheckpoint.guards,
        approval: PRIVILEGED_ACTION_TOOLS.includes(tool) ? ('approved' as const) : ('not_required' as const),
        result_taint: EXTERNAL_ORIGIN_TOOLS.includes(tool) ? ('external' as const) : null,
      };
      expect(
        runtimeToolCheckpointSchema.safeParse({
          ...completedCheckpoint,
          tool,
          guards: { ...guards, sanitisation: 'bypassed' },
        }).success,
      ).toBe(false);
      expect(
        runtimeToolCheckpointSchema.safeParse({
          ...completedCheckpoint,
          tool,
          guards: { ...guards, acl: 'denied' },
        }).success,
      ).toBe(false);
    }
  });

  it('permits a finite blocked summary but never raw arguments or results', () => {
    const blocked = {
      checkpoint_version: 2 as const,
      status: 'blocked' as const,
      call_ref: ref('call'),
      tool: 'get_crs' as const,
      stage: 'acl' as const,
      reason: 'acl_denied' as const,
      audit_ref: ref('aud'),
    };

    expect(runtimeToolCheckpointSchema.safeParse(blocked).success).toBe(true);
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...blocked,
        args: { arbitrary: 'private-value' },
      }).success,
    ).toBe(false);
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...blocked,
        result: { arbitrary: 'private-value' },
      }).success,
    ).toBe(false);
  });

  it('keeps blocked stages, reasons, and tool identity internally consistent', () => {
    const blocked = {
      checkpoint_version: 2 as const,
      status: 'blocked' as const,
      call_ref: ref('call'),
      tool: 'get_crs' as const,
      stage: 'acl' as const,
      reason: 'acl_denied' as const,
      audit_ref: ref('aud'),
    };

    expect(runtimeToolCheckpointSchema.safeParse(blocked).success).toBe(true);
    expect(
      runtimeToolCheckpointSchema.safeParse({ ...blocked, reason: 'invalid_args' }).success,
    ).toBe(false);
    expect(
      runtimeToolCheckpointSchema.safeParse({ ...blocked, tool: null }).success,
    ).toBe(false);
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...blocked,
        tool: null,
        stage: 'parse',
        reason: 'unknown_tool',
      }).success,
    ).toBe(true);
  });

  it('covers every dispatcher reason with its accurate durable checkpoint stage', () => {
    expect(Object.keys(blockedStageByReason).sort()).toEqual(
      [...runtimeToolDispatchFailureReasonSchema.options].sort(),
    );

    for (const [reason, stage] of Object.entries(blockedStageByReason)) {
      expect(
        runtimeToolCheckpointSchema.safeParse({
          checkpoint_version: 2,
          status: 'blocked',
          call_ref: ref('call'),
          tool: reason === 'unknown_tool' ? null : 'get_crs',
          stage,
          reason,
          audit_ref: ref('aud'),
        }).success,
      ).toBe(true);
    }
  });

  it('rejects a direct completed checkpoint for an external-tainted privileged action', () => {
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...completedCheckpoint,
        tool: 'send_message',
        guards: {
          ...completedCheckpoint.guards,
          approval: 'approved',
          argument_taint: 'external',
        },
      }).success,
    ).toBe(false);
  });

  it('preserves external result taint for a non-privileged completed read', () => {
    expect(
      runtimeToolCheckpointSchema.safeParse({
        ...completedCheckpoint,
        tool: 'read_document',
        guards: { ...completedCheckpoint.guards, result_taint: 'external' },
      }).success,
    ).toBe(true);
  });

  it.each(EXTERNAL_ORIGIN_TOOLS)(
    'rejects an untainted durable result summary for the external-origin %s tool',
    (tool) => {
      expect(
        runtimeToolCheckpointSchema.safeParse({ ...completedCheckpoint, tool }).success,
      ).toBe(false);
    },
  );

  it('requires a completed checkpoint to be allowed by the accepted trigger ACL', () => {
    const invocation = accept();
    const v2Record = {
      format: 'invocation_contract_v2' as const,
      record_version: 2 as const,
      invocation,
      context: null,
      tool_checkpoints: [
        {
          ...completedCheckpoint,
          tool: 'execute_code' as const,
        },
      ],
      persisted_at: 1_700_000_000_300,
    };

    expect(runtimeInvocationV2RecordSchema.safeParse(v2Record).success).toBe(false);
    expect(
      runtimeInvocationV2RecordSchema.safeParse({
        ...v2Record,
        tool_checkpoints: [{ ...completedCheckpoint, tool: 'get_crs' as const }],
      }).success,
    ).toBe(true);
    expect(
      runtimeInvocationV2RecordSchema.safeParse({
        ...v2Record,
        tool_checkpoints: [
          { ...completedCheckpoint, tool: 'get_crs' as const },
          {
            ...completedCheckpoint,
            tool: 'get_crs' as const,
            audit_ref: ref('aud', 'd'.repeat(32)),
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('contract package boundary', () => {
  it('exports the portable invocation vocabulary through the public contracts barrel', () => {
    expect(publicAcceptTrustedInvocation).toBe(acceptTrustedInvocation);
    expect(publicRuntimeContextCheckpointSchema).toBe(runtimeContextCheckpointSchema);
    expect(publicRuntimeToolCheckpointSchema).toBe(runtimeToolCheckpointSchema);
  });
});
