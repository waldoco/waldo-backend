import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import { sourceTaintSchema } from '../memory/sanitise';
import {
  EXTERNAL_ORIGIN_TOOLS,
  PRIVILEGED_ACTION_TOOLS,
  taintGateBlocksDirectExecution,
} from '../tools/handler';
import { TOOL_PERMISSIONS, toolNameSchema } from '../tools/permissions';
import { runtimeRunRecordSchema, runtimeToolDispatchFailureReasonSchema } from './run';

const opaqueRef = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{32}$`), {
    error: `${prefix} reference must be an opaque 32-character hexadecimal token`,
  });

const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const surfaceInvocationRequestSchema = z.strictObject({
  input: z.strictObject({
    kind: z.literal('text'),
    text: z.string().min(1).max(8_192),
  }),
  retry_token: opaqueRef('rty').optional(),
});
export type SurfaceInvocationRequest = z.infer<typeof surfaceInvocationRequestSchema>;

export const invocationContractErrorCodeSchema = z.enum([
  'invalid_surface_request',
  'invalid_trusted_admission',
  'unsupported_persisted_invocation',
]);
export type InvocationContractErrorCode = z.infer<typeof invocationContractErrorCodeSchema>;

export interface InvocationContractError {
  code: InvocationContractErrorCode;
}

export type InvocationContractResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: InvocationContractError };

export function parseSurfaceInvocationRequest(
  value: unknown,
): InvocationContractResult<SurfaceInvocationRequest> {
  const parsed = surfaceInvocationRequestSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: { code: 'invalid_surface_request' } };
}

export const verifiedInvocationAuthoritySchema = z.strictObject({
  principal_ref: opaqueRef('prn'),
  tenant_ref: opaqueRef('ten'),
  verification_ref: opaqueRef('ver'),
});
export type VerifiedInvocationAuthority = z.infer<typeof verifiedInvocationAuthoritySchema>;

export const invocationInputReferenceSchema = z.strictObject({
  input_ref: opaqueRef('inp'),
  content_digest: contentDigestSchema,
});
export type InvocationInputReference = z.infer<typeof invocationInputReferenceSchema>;

export const invocationIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('respond_to_user') }),
  z.strictObject({ kind: z.literal('assemble_brief'), variant: briefVariantSchema }),
  z.strictObject({ kind: z.literal('evaluate_fetch') }),
  z.strictObject({ kind: z.literal('run_patrol') }),
  z.strictObject({ kind: z.literal('pre_brief_work') }),
  z.strictObject({ kind: z.literal('handoff_explore') }),
  z.strictObject({ kind: z.literal('handoff_plan') }),
  z.strictObject({ kind: z.literal('handoff_act') }),
  z.strictObject({ kind: z.literal('handoff_replan') }),
  z.strictObject({ kind: z.literal('intervene') }),
  z.strictObject({ kind: z.literal('dream') }),
  z.strictObject({ kind: z.literal('prepare_pre_activity') }),
]);
export type InvocationIntent = z.infer<typeof invocationIntentSchema>;

export const trustedInvocationAdmissionSourceSchema = z.enum([
  'authenticated_ingress',
  'trusted_scheduler',
  'trusted_internal',
]);
export type TrustedInvocationAdmissionSource = z.infer<
  typeof trustedInvocationAdmissionSourceSchema
>;

function hasUniqueInputReferences(references: readonly InvocationInputReference[]): boolean {
  return new Set(references.map((reference) => reference.input_ref)).size === references.length;
}

function admissionSourceAllowsIntent(
  source: TrustedInvocationAdmissionSource,
  intent: InvocationIntent,
): boolean {
  return (source === 'authenticated_ingress') === (intent.kind === 'respond_to_user');
}

export const trustedInvocationAdmissionSchema = z
  .strictObject({
    admission_source: trustedInvocationAdmissionSourceSchema,
    verified_authority: verifiedInvocationAuthoritySchema,
    input_refs: z
      .array(invocationInputReferenceSchema)
      .min(1)
      .max(8)
      .refine(hasUniqueInputReferences, {
        error: 'input references must be unique',
        path: ['input_refs'],
      }),
    intent: invocationIntentSchema,
    occurrence: z.strictObject({
      occurrence_ref: opaqueRef('occ'),
      occurred_at: z.int().nonnegative(),
    }),
    idempotency_ref: opaqueRef('idem'),
    accepted_at: z.int().nonnegative(),
  })
  .superRefine((admission, context) => {
    if (!admissionSourceAllowsIntent(admission.admission_source, admission.intent)) {
      context.addIssue({
        code: 'custom',
        path: ['intent'],
        message: 'admission source and intent must agree on whether work is solicited',
      });
    }
  });
export type TrustedInvocationAdmission = z.infer<typeof trustedInvocationAdmissionSchema>;

export const runtimeInvocationBindingSchema = z.strictObject({
  trigger: triggerTypeSchema,
  variant: briefVariantSchema.nullable(),
  governor_resolution: z.literal('from_trigger'),
});
export type RuntimeInvocationBinding = z.infer<typeof runtimeInvocationBindingSchema>;

export const invocationOutputDispositionKindSchema = z.enum([
  'solicited_reply',
  'proactive_delivery',
  'internal_no_output',
]);
export type InvocationOutputDispositionKind = z.infer<
  typeof invocationOutputDispositionKindSchema
>;

export const invocationOutputDispositionSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    disposition: z.literal('solicited_reply'),
    correlation_ref: opaqueRef('occ'),
  }),
  z.strictObject({
    disposition: z.literal('proactive_delivery'),
    occurrence_ref: opaqueRef('occ'),
  }),
  z.strictObject({ disposition: z.literal('internal_no_output') }),
]);
export type InvocationOutputDisposition = z.infer<typeof invocationOutputDispositionSchema>;

export const runtimeContextSourceSchema = z.strictObject({
  source_ref: opaqueRef('src'),
  source_kind: z.enum([
    'invocation_input',
    'recall',
    'skill',
    'derived_health_view',
    'connector_snapshot',
    'workspace_snapshot',
    'tool_result',
    'runtime_metadata',
  ]),
  scope: z.enum(['invocation', 'principal', 'tenant', 'thread', 'system']),
  source_taint: sourceTaintSchema,
  produced_at: z.int().nonnegative(),
});
export type RuntimeContextSource = z.infer<typeof runtimeContextSourceSchema>;

const isExternalOriginContextSource = (source: RuntimeContextSource): boolean =>
  source.source_kind === 'connector_snapshot' || source.source_kind === 'workspace_snapshot';

export const runtimeContextCheckpointSchema = z
  .strictObject({
    context_version: z.literal(2),
    context_ref: opaqueRef('ctx'),
    principal_ref: opaqueRef('prn'),
    tenant_ref: opaqueRef('ten'),
    invocation_idempotency_ref: opaqueRef('idem'),
    produced_at: z.int().nonnegative(),
    source_taint: sourceTaintSchema,
    sanitisation: z.literal('passed'),
    sources: z.array(runtimeContextSourceSchema).min(1).max(32),
  })
  .superRefine((checkpoint, context) => {
    const refs = checkpoint.sources.map((source) => source.source_ref);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'context provenance source references must be unique',
      });
    }

    if (checkpoint.sources.some((source) => source.produced_at > checkpoint.produced_at)) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'context provenance cannot be produced after its checkpoint',
      });
    }

    const aggregateTaint = checkpoint.sources.some((source) => source.source_taint === 'external')
      ? 'external'
      : null;
    if (checkpoint.source_taint !== aggregateTaint) {
      context.addIssue({
        code: 'custom',
        path: ['source_taint'],
        message: 'context source taint must equal aggregate provenance taint',
      });
    }

    if (
      checkpoint.sources.some(
        (source) => isExternalOriginContextSource(source) && source.source_taint !== 'external',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'connector and workspace provenance require external taint',
      });
    }

    if (
      checkpoint.sources.some(
        (source) =>
          source.source_kind === 'derived_health_view' &&
          source.scope !== 'invocation' &&
          source.scope !== 'principal',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'derived health provenance must remain invocation or principal scoped',
      });
    }
  });
export type RuntimeContextCheckpoint = z.infer<typeof runtimeContextCheckpointSchema>;

const runtimeToolCheckpointGuardsSchema = z.strictObject({
  args_schema: z.literal('validated'),
  result_schema: z.literal('validated'),
  acl: z.literal('allowed'),
  approval: z.enum(['not_required', 'approved']),
  argument_taint: sourceTaintSchema,
  result_taint: sourceTaintSchema,
  taint_gate: z.literal('passed'),
  sanitisation: z.literal('passed'),
  size: z.literal('within_limit'),
});

const BLOCKED_TOOL_FAILURE_REASONS_BY_STAGE = {
  parse: ['unknown_tool'],
  validation: ['invalid_args'],
  acl: ['acl_denied'],
  hook: ['hook_halt'],
  approval: ['approval_denied'],
  sanitisation: ['sanitise_denied'],
  egress: ['egress_denied'],
  handler: [
    'handler_unavailable',
    'effect_receipt_unavailable',
    'handler_acl_drift',
    'handler_failed',
    'invalid_handler_result',
  ],
  result: ['tool_result_error', 'invalid_tool_result'],
  size: ['result_oversize'],
} as const;

// A receipt is only legal after an adapter has crossed the tool boundary. These are the exact
// bounded failure results that the trusted dispatcher can produce after that point; availability,
// ACL, and pre-tool validation failures must remain receipt-free because no physical effect is
// proven.
const TRUSTED_REJECTED_EFFECT_FAILURE_REASONS = [
  'hook_halt',
  'invalid_handler_result',
  'tool_result_error',
  'invalid_tool_result',
  'result_oversize',
] as const;

export const runtimeToolCheckpointSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      checkpoint_version: z.literal(2),
      status: z.literal('completed'),
      call_ref: opaqueRef('call'),
      tool: toolNameSchema,
      args_ref: opaqueRef('arg'),
      args_hash: z.string().regex(/^[a-f0-9]{64}$/),
      result_ref: opaqueRef('res'),
      result_hash: z.string().regex(/^[a-f0-9]{64}$/),
      audit_ref: opaqueRef('aud'),
      guards: runtimeToolCheckpointGuardsSchema,
    }),
    z.strictObject({
      checkpoint_version: z.literal(2),
      status: z.literal('blocked'),
      call_ref: opaqueRef('call'),
      tool: toolNameSchema.nullable(),
      stage: z.enum([
        'parse',
        'validation',
        'acl',
        'hook',
        'approval',
        'sanitisation',
        'egress',
        'handler',
        'result',
        'size',
      ]),
      reason: runtimeToolDispatchFailureReasonSchema,
      // Present only when a trusted V2 adapter did run and returned a bounded rejected receipt.
      // It carries hashes only; pre-effect blocks intentionally have no effect receipt.
      effect_receipt: z
        .strictObject({
          outcome: z.literal('rejected'),
          args_hash: z.string().regex(/^[a-f0-9]{64}$/),
          result_hash: z.string().regex(/^[a-f0-9]{64}$/),
          argument_taint: sourceTaintSchema,
        })
        .optional(),
      audit_ref: opaqueRef('aud'),
    }),
  ])
  .superRefine((checkpoint, context) => {
    if (checkpoint.status === 'blocked') {
      if (checkpoint.tool === null && checkpoint.stage !== 'parse') {
        context.addIssue({
          code: 'custom',
          path: ['tool'],
          message: 'only parse-stage failures may omit a tool identity',
        });
      }

      if (
        checkpoint.effect_receipt !== undefined &&
        (checkpoint.tool === null ||
          !TRUSTED_REJECTED_EFFECT_FAILURE_REASONS.includes(
            checkpoint.reason as (typeof TRUSTED_REJECTED_EFFECT_FAILURE_REASONS)[number],
          ))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['effect_receipt'],
          message: 'rejected trusted tool receipts require a post-effect failure reason',
        });
      }

      if (
        !(BLOCKED_TOOL_FAILURE_REASONS_BY_STAGE[checkpoint.stage] as readonly string[]).includes(
          checkpoint.reason,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'blocked checkpoint reason must match its recorded stage',
        });
      }
      return;
    }

    if (
      PRIVILEGED_ACTION_TOOLS.includes(checkpoint.tool) &&
      checkpoint.guards.approval !== 'approved'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['guards', 'approval'],
        message: 'privileged completed checkpoints require approval evidence',
      });
    }

    if (taintGateBlocksDirectExecution(checkpoint.tool, checkpoint.guards.argument_taint)) {
      context.addIssue({
        code: 'custom',
        path: ['guards', 'argument_taint'],
        message: 'external-tainted privileged actions cannot be completed directly',
      });
    }

    if (
      EXTERNAL_ORIGIN_TOOLS.includes(checkpoint.tool) &&
      checkpoint.guards.result_taint !== 'external'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['guards', 'result_taint'],
        message: 'external-origin tool results require external taint evidence',
      });
    }
  });
export type RuntimeToolCheckpoint = z.infer<typeof runtimeToolCheckpointSchema>;

// This is classification only. It does not select a channel, sink, budget, or policy verdict.
export const OUTPUT_DISPOSITION_SEMANTICS = {
  solicited_reply: {
    user_visible: true,
    visible_safety_egress_required: true,
    delivery_gate_applicable: false,
    proactive_policy_applicable: false,
    proactive_budget_applicable: false,
  },
  proactive_delivery: {
    user_visible: true,
    visible_safety_egress_required: true,
    delivery_gate_applicable: true,
    proactive_policy_applicable: true,
    proactive_budget_applicable: true,
  },
  internal_no_output: {
    user_visible: false,
    visible_safety_egress_required: false,
    delivery_gate_applicable: false,
    proactive_policy_applicable: false,
    proactive_budget_applicable: false,
  },
} as const;

export const invocationIdempotencySchema = z.strictObject({
  scope: z.enum(['authenticated_request', 'scheduled_occurrence', 'internal_work']),
  key_ref: opaqueRef('idem'),
});
export type InvocationIdempotency = z.infer<typeof invocationIdempotencySchema>;

function outputForAdmissionSource(
  source: TrustedInvocationAdmissionSource,
  occurrenceRef: string,
): InvocationOutputDisposition {
  switch (source) {
    case 'authenticated_ingress':
      return { disposition: 'solicited_reply', correlation_ref: occurrenceRef };
    case 'trusted_scheduler':
      return { disposition: 'proactive_delivery', occurrence_ref: occurrenceRef };
    case 'trusted_internal':
      return { disposition: 'internal_no_output' };
  }
}

function outputMatchesAdmissionSource(
  output: InvocationOutputDisposition,
  source: TrustedInvocationAdmissionSource,
  occurrenceRef: string,
): boolean {
  switch (source) {
    case 'authenticated_ingress':
      return output.disposition === 'solicited_reply' && output.correlation_ref === occurrenceRef;
    case 'trusted_scheduler':
      return output.disposition === 'proactive_delivery' && output.occurrence_ref === occurrenceRef;
    case 'trusted_internal':
      return output.disposition === 'internal_no_output';
  }
}

export const trustedInvocationEnvelopeSchema = z
  .strictObject({
    contract_version: z.literal(1),
    admission_source: trustedInvocationAdmissionSourceSchema,
    verified_authority: verifiedInvocationAuthoritySchema,
    input_refs: z.array(invocationInputReferenceSchema).min(1).max(8),
    intent: invocationIntentSchema,
    occurrence: z.strictObject({
      occurrence_ref: opaqueRef('occ'),
      occurred_at: z.int().nonnegative(),
    }),
    idempotency: invocationIdempotencySchema,
    output: invocationOutputDispositionSchema,
    runtime_binding: runtimeInvocationBindingSchema,
    accepted_at: z.int().nonnegative(),
  })
  .superRefine((envelope, context) => {
    if (!hasUniqueInputReferences(envelope.input_refs)) {
      context.addIssue({
        code: 'custom',
        path: ['input_refs'],
        message: 'input references must be unique',
      });
    }

    if (!admissionSourceAllowsIntent(envelope.admission_source, envelope.intent)) {
      context.addIssue({
        code: 'custom',
        path: ['intent'],
        message: 'admission source and intent must agree on whether work is solicited',
      });
    }

    if (
      !outputMatchesAdmissionSource(
        envelope.output,
        envelope.admission_source,
        envelope.occurrence.occurrence_ref,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['output'],
        message: 'output disposition must be derived from admission source and occurrence',
      });
    }

    const expectedBinding = runtimeBindingForIntent(envelope.intent);
    if (
      envelope.runtime_binding.trigger !== expectedBinding.trigger ||
      envelope.runtime_binding.variant !== expectedBinding.variant
    ) {
      context.addIssue({
        code: 'custom',
        path: ['runtime_binding'],
        message: 'runtime binding must be derived from the trusted intent',
      });
    }

    const expectedScope = idempotencyScopeForSource(envelope.admission_source);
    if (envelope.idempotency.scope !== expectedScope) {
      context.addIssue({
        code: 'custom',
        path: ['idempotency', 'scope'],
        message: 'idempotency scope must be derived from the admission source',
      });
    }

    if (envelope.accepted_at < envelope.occurrence.occurred_at) {
      context.addIssue({
        code: 'custom',
        path: ['accepted_at'],
        message: 'accepted invocation cannot precede its trusted occurrence',
      });
    }
  });
export type TrustedInvocationEnvelope = z.infer<typeof trustedInvocationEnvelopeSchema>;

function runtimeBindingForIntent(intent: InvocationIntent): RuntimeInvocationBinding {
  switch (intent.kind) {
    case 'respond_to_user':
      return { trigger: 'user_message', variant: null, governor_resolution: 'from_trigger' };
    case 'assemble_brief':
      return { trigger: 'brief', variant: intent.variant, governor_resolution: 'from_trigger' };
    case 'evaluate_fetch':
      return { trigger: 'fetch_alert', variant: null, governor_resolution: 'from_trigger' };
    case 'run_patrol':
      return { trigger: 'patrol', variant: null, governor_resolution: 'from_trigger' };
    case 'pre_brief_work':
      return { trigger: 'pre_brief_sweep', variant: null, governor_resolution: 'from_trigger' };
    case 'handoff_explore':
    case 'handoff_plan':
    case 'handoff_act':
    case 'handoff_replan':
      return { trigger: intent.kind, variant: null, governor_resolution: 'from_trigger' };
    case 'intervene':
      return { trigger: 'intervention', variant: null, governor_resolution: 'from_trigger' };
    case 'dream':
      return { trigger: 'dreaming_mode', variant: null, governor_resolution: 'from_trigger' };
    case 'prepare_pre_activity':
      return { trigger: 'pre_activity_spot', variant: null, governor_resolution: 'from_trigger' };
  }
}

function idempotencyScopeForSource(
  source: TrustedInvocationAdmissionSource,
): InvocationIdempotency['scope'] {
  switch (source) {
    case 'authenticated_ingress':
      return 'authenticated_request';
    case 'trusted_scheduler':
      return 'scheduled_occurrence';
    case 'trusted_internal':
      return 'internal_work';
  }
}

export function acceptTrustedInvocation(
  value: unknown,
): InvocationContractResult<TrustedInvocationEnvelope> {
  const admission = trustedInvocationAdmissionSchema.safeParse(value);
  if (!admission.success) return { ok: false, error: { code: 'invalid_trusted_admission' } };

  const envelope = trustedInvocationEnvelopeSchema.safeParse({
    contract_version: 1,
    admission_source: admission.data.admission_source,
    verified_authority: admission.data.verified_authority,
    input_refs: admission.data.input_refs,
    intent: admission.data.intent,
    occurrence: admission.data.occurrence,
    idempotency: {
      scope: idempotencyScopeForSource(admission.data.admission_source),
      key_ref: admission.data.idempotency_ref,
    },
    output: outputForAdmissionSource(
      admission.data.admission_source,
      admission.data.occurrence.occurrence_ref,
    ),
    runtime_binding: runtimeBindingForIntent(admission.data.intent),
    accepted_at: admission.data.accepted_at,
  });

  return envelope.success
    ? { ok: true, value: envelope.data }
    : { ok: false, error: { code: 'invalid_trusted_admission' } };
}

export function canonicalInvocationIdempotencySerialization(
  envelope: TrustedInvocationEnvelope,
): string {
  const parsed = trustedInvocationEnvelopeSchema.parse(envelope);
  const contentDigests = [...parsed.input_refs]
    .map((reference) => reference.content_digest)
    .sort();

  return JSON.stringify([
    ['contract_version', parsed.contract_version],
    ['principal_ref', parsed.verified_authority.principal_ref],
    ['tenant_ref', parsed.verified_authority.tenant_ref],
    ['intent', parsed.intent.kind],
    ['variant', parsed.runtime_binding.variant],
    ['occurrence_ref', parsed.occurrence.occurrence_ref],
    ['idempotency_scope', parsed.idempotency.scope],
    ['idempotency_ref', parsed.idempotency.key_ref],
    ['occurrence_occurred_at', parsed.occurrence.occurred_at],
    ['content_digests', contentDigests],
  ]);
}

// Policy state is tenant-owned even when one authenticated principal legitimately belongs to
// multiple tenants. Runtime derives and hashes this compact canonical material before writing
// its journal/Governor/DeliveryGate policy-owner reference. The existing runtime run owner field
// may still retain the opaque principal reference for run ownership; this helper scopes policy
// isolation rather than prohibiting that durable runtime identity.
export function canonicalTrustedOperationalScopeSerialization(
  authority: VerifiedInvocationAuthority,
): string {
  const parsed = verifiedInvocationAuthoritySchema.parse(authority);
  return JSON.stringify([
    ['tenant_ref', parsed.tenant_ref],
    ['principal_ref', parsed.principal_ref],
  ]);
}

// The existing runtime record remains the V1 reader until a later run-loop lane writes V2 records.
// It is intentionally not widened: fake-derived/get_crs rows remain readable without being claimed
// as V2 provenance.
// The only legacy normalization retained here matches the existing run-loop audit: pre-Scribe V1
// context/scratch objects omitted the required taint stamp. It adds the known null default before
// parsing the unchanged strict V1 record; it does not infer source provenance or repair other rows.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalisePreScribeTaint(value: unknown): unknown {
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, 'source_taint')) return value;
  return { ...value, source_taint: null };
}

function normaliseLegacyRuntimeRunRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    context_json: normalisePreScribeTaint(value.context_json),
    scratch_json: normalisePreScribeTaint(value.scratch_json),
  };
}

export const legacyRuntimeRunRecordSchema = z.preprocess(
  normaliseLegacyRuntimeRunRecord,
  runtimeRunRecordSchema,
);
export type LegacyRuntimeRunRecord = z.infer<typeof legacyRuntimeRunRecordSchema>;

export const runtimeInvocationV2RecordSchema = z
  .strictObject({
    format: z.literal('invocation_contract_v2'),
    record_version: z.literal(2),
    invocation: trustedInvocationEnvelopeSchema,
    context: runtimeContextCheckpointSchema.nullable(),
    tool_checkpoints: z.array(runtimeToolCheckpointSchema).max(16),
    persisted_at: z.int().nonnegative(),
  })
  .superRefine((record, context) => {
    if (record.context !== null) {
      if (record.context.principal_ref !== record.invocation.verified_authority.principal_ref) {
        context.addIssue({
          code: 'custom',
          path: ['context', 'principal_ref'],
          message: 'context principal must match the trusted invocation principal',
        });
      }

      if (record.context.tenant_ref !== record.invocation.verified_authority.tenant_ref) {
        context.addIssue({
          code: 'custom',
          path: ['context', 'tenant_ref'],
          message: 'context tenant must match the trusted invocation tenant',
        });
      }

      if (record.context.invocation_idempotency_ref !== record.invocation.idempotency.key_ref) {
        context.addIssue({
          code: 'custom',
          path: ['context', 'invocation_idempotency_ref'],
          message: 'context idempotency reference must match the trusted invocation',
        });
      }
    }

    const callRefs = record.tool_checkpoints.map((checkpoint) => checkpoint.call_ref);
    if (new Set(callRefs).size !== callRefs.length) {
      context.addIssue({
        code: 'custom',
        path: ['tool_checkpoints'],
        message: 'tool checkpoint call references must be unique',
      });
    }

    for (const [index, checkpoint] of record.tool_checkpoints.entries()) {
      const settledTool =
        checkpoint.status === 'completed' ||
        (checkpoint.status === 'blocked' && checkpoint.effect_receipt !== undefined);
      if (
        settledTool &&
        checkpoint.tool !== null &&
        !TOOL_PERMISSIONS[record.invocation.runtime_binding.trigger].includes(checkpoint.tool)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['tool_checkpoints', index, 'tool'],
          message: 'settled tool checkpoint must be allowed by the trusted trigger ACL',
        });
      }
    }
  });
export type RuntimeInvocationV2Record = z.infer<typeof runtimeInvocationV2RecordSchema>;

export type PersistedInvocationRecord =
  | { format: 'legacy_runtime_v1'; record: LegacyRuntimeRunRecord }
  | { format: 'invocation_contract_v2'; record: RuntimeInvocationV2Record };

export function parsePersistedInvocationRecord(
  value: unknown,
): InvocationContractResult<PersistedInvocationRecord> {
  const v2 = runtimeInvocationV2RecordSchema.safeParse(value);
  if (v2.success) return { ok: true, value: { format: 'invocation_contract_v2', record: v2.data } };

  const legacy = legacyRuntimeRunRecordSchema.safeParse(value);
  return legacy.success
    ? { ok: true, value: { format: 'legacy_runtime_v1', record: legacy.data } }
    : { ok: false, error: { code: 'unsupported_persisted_invocation' } };
}
