// Private V2 durable vocabulary for RunLoopDO. This module owns no scheduling, provider call,
// journal transition, or storage handle; RunLoopDO remains the sole runtime orchestrator/writer.
import {
  TOOL_PERMISSIONS,
  runtimeOperationalRefSchema,
  trustedRunV2StateSchema,
  type RuntimeInvocationV2Record,
  type RuntimeToolCheckpoint,
  type SourceTaint,
  type TrustedRunV2State as ContractTrustedRunV2State,
  type TrustedRunV2PendingEffect,
  type TrustedRunV2ProviderExecutionWitness,
  type TrustedRunV2SettledToolCheckpoint,
  type TrustedRunV2ToolEffectWitness,
  type V2PlanReceipt,
  type V2RunEvidence,
  type V2SynthesisReceipt,
} from '@waldo/contracts';

const DIGEST = /^[a-f0-9]{64}$/;

// The full persisted envelope is contract-owned. This module keeps only RunLoopDO-specific
// semantic checks and pure state transforms; it deliberately owns no second parser or durable
// representation.
export type TrustedRunV2State = ContractTrustedRunV2State;
export type {
  TrustedRunV2PendingEffect,
  TrustedRunV2ProviderExecutionWitness,
  TrustedRunV2SettledToolCheckpoint,
  TrustedRunV2ToolEffectWitness,
  V2PlanReceipt,
  V2RunEvidence,
  V2SynthesisReceipt,
};

export type V2ReplayArtifactSource = Readonly<{
  resolvePlan(input: Readonly<{
    iteration: number;
    plan_ref: string;
    plan_digest: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
  resolveToolResult(input: Readonly<{
    result_ref: string;
    result_hash: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
  resolveSynthesis(input: Readonly<{
    result_ref: string;
    result_digest: string;
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<unknown>;
}>;

export function initialTrustedRunV2State(input: {
  canonicalIdentityHash: string;
  snapshotRef: string;
  snapshotAt: number;
  record: RuntimeInvocationV2Record;
}): TrustedRunV2State {
  return parseTrustedRunV2State({
    receipt_protocol: 'reconciled_effects_v1',
    canonical_identity_hash: input.canonicalIdentityHash,
    snapshot: { snapshot_ref: input.snapshotRef, snapshot_at: input.snapshotAt },
    record: input.record,
    plan: null,
    synthesis: null,
    pending_effect: null,
    tool_effect_witnesses: [],
    evidence: {
      prompt_digest: null,
      source_count: 0,
      source_taint: null,
      recall_status: null,
      tool_acl: [...TOOL_PERMISSIONS[input.record.invocation.runtime_binding.trigger]],
      provider_calls: 0,
      total_tokens: 0,
    },
  });
}

export function updateTrustedRunV2State(
  state: TrustedRunV2State,
  patch: Partial<
    Pick<
      TrustedRunV2State,
      'record' | 'plan' | 'synthesis' | 'pending_effect' | 'tool_effect_witnesses' | 'evidence'
    >
  >,
): TrustedRunV2State {
  return parseTrustedRunV2State({ ...state, ...patch });
}

export function parseTrustedRunV2State(value: unknown): TrustedRunV2State {
  return trustedRunV2StateSchema.parse(value);
}

export function v2CompletedToolCheckpoints(
  state: TrustedRunV2State,
): readonly Extract<RuntimeToolCheckpoint, { status: 'completed' }>[] {
  return state.record.tool_checkpoints.filter(
    (checkpoint): checkpoint is Extract<RuntimeToolCheckpoint, { status: 'completed' }> =>
      checkpoint.status === 'completed',
  );
}

// A settled rejected receipt crossed the adapter boundary just as a successful checkpoint did,
// but it is never replayable into a prompt. Callers that audit Governor facts use this set,
// while result replay uses v2CompletedToolCheckpoints.
export function v2SettledToolCheckpoints(
  state: TrustedRunV2State,
): readonly TrustedRunV2SettledToolCheckpoint[] {
  return state.record.tool_checkpoints.filter(
    (checkpoint): checkpoint is TrustedRunV2SettledToolCheckpoint =>
      checkpoint.status === 'completed' ||
      (checkpoint.status === 'blocked' && checkpoint.effect_receipt !== undefined),
  );
}

export function v2OpaqueRef(
  prefix: 'pln' | 'syn' | 'call' | 'arg' | 'res' | 'aud' | 'eff' | 'idk',
  digest: string,
): string {
  if (!DIGEST.test(digest)) throw new Error('trusted V2 opaque references require a SHA-256 digest');
  return runtimeOperationalRefSchema.parse(`${prefix}_${digest.slice(0, 32)}`);
}

export function v2CheckpointGuards(input: {
  argumentTaint: SourceTaint;
  resultTaint: SourceTaint;
}): {
  args_schema: 'validated';
  result_schema: 'validated';
  acl: 'allowed';
  approval: 'not_required';
  argument_taint: SourceTaint;
  result_taint: SourceTaint;
  taint_gate: 'passed';
  sanitisation: 'passed';
  size: 'within_limit';
} {
  return {
    args_schema: 'validated',
    result_schema: 'validated',
    acl: 'allowed',
    approval: 'not_required',
    argument_taint: input.argumentTaint,
    result_taint: input.resultTaint,
    taint_gate: 'passed',
    sanitisation: 'passed',
    size: 'within_limit',
  };
}
