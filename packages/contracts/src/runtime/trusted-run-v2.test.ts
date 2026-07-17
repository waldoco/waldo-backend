import { describe, expect, it } from 'vitest';
import { trustedRunV2StateSchema as publicTrustedRunV2StateSchema } from '../index';
import { ROSTER } from '../model/roster';
import { TOOL_PERMISSIONS } from '../tools/permissions';
import { acceptTrustedInvocation, runtimeInvocationV2RecordSchema } from './invocation';
import { trustedRunV2StateSchema } from './trusted-run-v2';

const HEX = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);
const ref = (prefix: string, value = HEX) => `${prefix}_${value}`;
const providerExecution = {
  step: { provider: 'workers_ai' as const, model: ROSTER.primary, cache: 'none' as const },
  context: 'full_context' as const,
  fallback_step: 'configured_model' as const,
};

function acceptedInvocation() {
  const accepted = acceptTrustedInvocation({
    admission_source: 'trusted_scheduler',
    verified_authority: {
      principal_ref: ref('prn'),
      tenant_ref: ref('ten'),
      verification_ref: ref('ver'),
    },
    input_refs: [{ input_ref: ref('inp'), content_digest: `sha256:${DIGEST}` }],
    intent: { kind: 'assemble_brief', variant: 'morning' },
    occurrence: { occurrence_ref: ref('occ'), occurred_at: 1_700_000_000_000 },
    idempotency_ref: ref('idem'),
    accepted_at: 1_700_000_000_100,
  });
  if (!accepted.ok) throw new Error(`trusted fixture was rejected: ${accepted.error.code}`);
  return accepted.value;
}

function validState() {
  const invocation = acceptedInvocation();
  return {
    receipt_protocol: 'reconciled_effects_v1' as const,
    canonical_identity_hash: 'c'.repeat(64),
    snapshot: { snapshot_ref: ref('snp'), snapshot_at: 1_700_000_000_100 },
    record: runtimeInvocationV2RecordSchema.parse({
      format: 'invocation_contract_v2',
      record_version: 2,
      invocation,
      context: null,
      tool_checkpoints: [],
      persisted_at: 1_700_000_000_100,
    }),
    plan: null,
    synthesis: null,
    pending_effect: null,
    tool_effect_witnesses: [],
    evidence: {
      prompt_digest: null,
      source_count: 0,
      source_taint: null,
      recall_status: null,
      tool_acl: [...TOOL_PERMISSIONS.brief],
      provider_calls: 0,
      total_tokens: 0,
    },
  } as const;
}

function withContext<T extends ReturnType<typeof validState>>(state: T) {
  const context = {
    context_version: 2 as const,
    context_ref: ref('ctx'),
    principal_ref: ref('prn'),
    tenant_ref: ref('ten'),
    invocation_idempotency_ref: ref('idem'),
    produced_at: 1_700_000_000_100,
    source_taint: null,
    sanitisation: 'passed' as const,
    sources: [
      {
        source_ref: ref('src'),
        source_kind: 'runtime_metadata' as const,
        scope: 'system' as const,
        source_taint: null,
        produced_at: 1_700_000_000_100,
      },
    ],
  };
  return {
    ...state,
    record: runtimeInvocationV2RecordSchema.parse({ ...state.record, context }),
    evidence: {
      ...state.evidence,
      prompt_digest: `sha256:${'d'.repeat(64)}`,
      source_count: 1,
      recall_status: 'skipped' as const,
    },
  };
}

describe('trusted V2 run persistence contract', () => {
  it('owns the complete strict content-free V2 state envelope', () => {
    const state = validState();

    expect(trustedRunV2StateSchema.parse(state)).toEqual(state);
    expect(
      trustedRunV2StateSchema.safeParse({ ...state, prompt: 'must never persist' }).success,
    ).toBe(false);
    expect(publicTrustedRunV2StateSchema).toBe(trustedRunV2StateSchema);
  });

  it('persists only a bounded content-free pending provider intent and receipt witness', () => {
    const state = withContext(validState());
    const effect = {
      kind: 'provider_plan' as const,
      effect_ref: ref('eff'),
      idempotency_key: ref('idk'),
      request_digest: 'd'.repeat(64),
      iteration: 1,
      execution: providerExecution,
    };
    const withPendingEffect = { ...state, pending_effect: effect };

    expect(trustedRunV2StateSchema.safeParse(withPendingEffect).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withPendingEffect,
        pending_effect: { ...effect, prompt: 'ephemeral only' },
      }).success,
    ).toBe(false);

    const withReceipt = {
      ...state,
      evidence: { ...(state.evidence as Record<string, unknown>), provider_calls: 1 },
      plan: {
        iteration: 1,
        plan_ref: ref('pln'),
        plan_digest: 'e'.repeat(64),
        effect,
      },
    };
    expect(trustedRunV2StateSchema.safeParse(withReceipt).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withReceipt,
        plan: { ...withReceipt.plan, iteration: 2 },
      }).success,
    ).toBe(false);
  });

  it('binds each settled trusted tool effect to one completed checkpoint', () => {
    const state = withContext(validState());
    const checkpoint = {
      checkpoint_version: 2 as const,
      status: 'completed' as const,
      call_ref: ref('call'),
      tool: 'get_crs' as const,
      args_ref: ref('arg'),
      args_hash: 'd'.repeat(64),
      result_ref: ref('res'),
      result_hash: 'e'.repeat(64),
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
    const effect = {
      kind: 'tool' as const,
      effect_ref: ref('eff'),
      idempotency_key: ref('idk'),
      request_digest: 'f'.repeat(64),
      call_ref: checkpoint.call_ref,
      tool: checkpoint.tool,
      args_hash: checkpoint.args_hash,
      argument_taint: checkpoint.guards.argument_taint,
    };
    const withToolReceipt = {
      ...state,
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        tool_checkpoints: [checkpoint],
      }),
      tool_effect_witnesses: [effect],
    };

    expect(trustedRunV2StateSchema.safeParse(withToolReceipt).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withToolReceipt,
        tool_effect_witnesses: [{ ...effect, args_hash: '0'.repeat(64) }],
      }).success,
    ).toBe(false);

    const secondCheckpoint = {
      ...checkpoint,
      call_ref: ref('call', 'c'.repeat(32)),
      args_ref: ref('arg', 'c'.repeat(32)),
      result_ref: ref('res', 'c'.repeat(32)),
      audit_ref: ref('aud', 'c'.repeat(32)),
    };
    // Count equality is not enough: two distinct witnesses for the first call must not leave
    // the second completed external effect without its durable reconciliation witness.
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withToolReceipt,
        record: runtimeInvocationV2RecordSchema.parse({
          ...withToolReceipt.record,
          tool_checkpoints: [checkpoint, secondCheckpoint],
        }),
        tool_effect_witnesses: [
          effect,
          {
            ...effect,
            effect_ref: ref('eff', 'd'.repeat(32)),
            idempotency_key: ref('idk', 'd'.repeat(32)),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('binds a rejected trusted tool receipt to its ACL-safe taint witness without payloads', () => {
    const state = withContext(validState());
    const checkpoint = {
      checkpoint_version: 2 as const,
      status: 'blocked' as const,
      call_ref: ref('call'),
      tool: 'get_crs' as const,
      stage: 'result' as const,
      reason: 'tool_result_error' as const,
      effect_receipt: {
        outcome: 'rejected' as const,
        args_hash: 'd'.repeat(64),
        result_hash: 'e'.repeat(64),
        argument_taint: 'external' as const,
      },
      audit_ref: ref('aud'),
    };
    const effect = {
      kind: 'tool' as const,
      effect_ref: ref('eff'),
      idempotency_key: ref('idk'),
      request_digest: 'f'.repeat(64),
      call_ref: checkpoint.call_ref,
      tool: checkpoint.tool,
      args_hash: checkpoint.effect_receipt.args_hash,
      argument_taint: checkpoint.effect_receipt.argument_taint,
    };
    const withReceipt = {
      ...state,
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        tool_checkpoints: [checkpoint],
      }),
      tool_effect_witnesses: [effect],
    };

    expect(trustedRunV2StateSchema.safeParse(withReceipt).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withReceipt,
        tool_effect_witnesses: [{ ...effect, argument_taint: null }],
      }).success,
    ).toBe(false);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withReceipt,
        tool_effect_witnesses: [],
      }).success,
    ).toBe(false);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withReceipt,
        record: {
          ...withReceipt.record,
          tool_checkpoints: [
            {
              ...checkpoint,
              tool: 'execute_code',
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unresolved effects that could bypass a settled synthesis or tool receipt', () => {
    const state = withContext(validState());
    const synthesisEffect = {
      kind: 'provider_observe' as const,
      effect_ref: ref('eff'),
      idempotency_key: ref('idk'),
      request_digest: 'd'.repeat(64),
      iteration: 1,
      execution: providerExecution,
    };
    const synthesis = {
      result_ref: ref('syn'),
      result_digest: 'e'.repeat(64),
      effect: synthesisEffect,
    };
    const withSynthesis = {
      ...state,
      synthesis,
      evidence: { ...(state.evidence as Record<string, unknown>), provider_calls: 1 },
    };
    expect(trustedRunV2StateSchema.safeParse(withSynthesis).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withSynthesis,
        pending_effect: {
          kind: 'provider_observe',
          effect_ref: ref('eff', 'c'.repeat(32)),
          idempotency_key: ref('idk', 'c'.repeat(32)),
          request_digest: 'f'.repeat(64),
          iteration: 2,
          execution: providerExecution,
        },
      }).success,
    ).toBe(false);

    const checkpoint = {
      checkpoint_version: 2 as const,
      status: 'completed' as const,
      call_ref: ref('call'),
      tool: 'get_crs' as const,
      args_ref: ref('arg'),
      args_hash: 'd'.repeat(64),
      result_ref: ref('res'),
      result_hash: 'e'.repeat(64),
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
    const activePlan = {
      iteration: 1,
      plan_ref: ref('pln'),
      plan_digest: 'f'.repeat(64),
      effect: {
        kind: 'provider_plan' as const,
        effect_ref: ref('eff', '1'.repeat(32)),
        idempotency_key: ref('idk', '1'.repeat(32)),
        request_digest: '1'.repeat(64),
        iteration: 1,
        execution: providerExecution,
      },
    };
    const withCompletedTool = {
      ...state,
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        tool_checkpoints: [checkpoint],
      }),
      plan: activePlan,
      evidence: { ...(state.evidence as Record<string, unknown>), provider_calls: 1 },
      tool_effect_witnesses: [
        {
          kind: 'tool' as const,
          effect_ref: ref('eff', '2'.repeat(32)),
          idempotency_key: ref('idk', '2'.repeat(32)),
          request_digest: '2'.repeat(64),
          call_ref: checkpoint.call_ref,
          tool: checkpoint.tool,
          args_hash: checkpoint.args_hash,
          argument_taint: checkpoint.guards.argument_taint,
        },
      ],
    };
    expect(trustedRunV2StateSchema.safeParse(withCompletedTool).success).toBe(true);
    expect(
      trustedRunV2StateSchema.safeParse({
        ...withCompletedTool,
        pending_effect: {
          kind: 'tool',
          effect_ref: ref('eff', '3'.repeat(32)),
          idempotency_key: ref('idk', '3'.repeat(32)),
          request_digest: '3'.repeat(64),
          call_ref: checkpoint.call_ref,
          tool: checkpoint.tool,
          args_hash: checkpoint.args_hash,
          argument_taint: checkpoint.guards.argument_taint,
        },
      }).success,
    ).toBe(false);
  });
});
