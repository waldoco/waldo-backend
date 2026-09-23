import {
  RECALL_CONFIG,
  episodeHitSchema,
  recallMemoryHitSchema,
  recallResultSchema,
  taintStampSchema,
  type CanaryTokens,
  type NarrativeContext,
  type RecallKey,
  type RecallResult,
  type SourceTaint,
  type TrustedInvocationEnvelope,
  type TriggerType,
} from '@waldo/contracts';
import { RecallSecurityHalt } from '../recall/gateway';
import {
  attestSnapshot,
  recordWithKeys,
  snapshotContextSource,
  snapshotData,
} from './admission';
import { stableJson } from './canonical';
import {
  ContextRecallFailClosedError,
  ContextRecallUnavailableError,
  ContextSourceUnavailableError,
  FailClosed,
} from './faults';
import { ProvenanceCollector } from './provenance';
import { preparePromptSourceText } from './source-sanitisation';
import type {
  ContextRecallGateway,
  ContextRecallSnapshot,
  LocalOwnerBinding,
  RuntimeOwnedContextInputs,
} from './types';

const MAX_RECALL_MEMORY_HITS = 5;
const MAX_RECALL_EPISODE_HITS = 3;
const MAX_RECALL_ITEM_CHARS = 2_000;

export async function loadRecall(
  gateway: ContextRecallGateway,
  owner: LocalOwnerBinding,
  recallKey: RecallKey | undefined,
  zone: NarrativeContext['zone'] | undefined,
  hint: string | undefined,
  inputs: RuntimeOwnedContextInputs,
  provenance: ProvenanceCollector,
): Promise<ContextRecallSnapshot> {
  let response: unknown;
  try {
    response = await gateway.recall({
      owner,
      recall_key: recallKey,
      zone,
      hint,
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
      canary_tokens: inputs.canary_tokens,
    });
  } catch (error) {
    if (error instanceof ContextRecallFailClosedError || error instanceof RecallSecurityHalt) {
      throw new FailClosed('recall_integrity');
    }
    if (error instanceof ContextRecallUnavailableError || error instanceof ContextSourceUnavailableError) {
      response = emptyFailedRecall(owner, inputs);
    } else {
      throw error;
    }
  }
  let raw: unknown;
  try {
    // A failed retrieval is the single fail-open case. A response that cannot be snapshotted is
    // a corrupt adapter payload, not a retrieval outage, so it must never degrade to empty recall.
    raw = snapshotData(response);
  } catch {
    throw new FailClosed('recall_integrity');
  }
  const snapshot = recordWithKeys(
    raw,
    ['principal_ref', 'tenant_ref', 'snapshot', 'status', 'result', 'source', 'capability'],
    'recall_integrity',
  );
  const result = recallResultSchema.safeParse(snapshot.result);
  if (!result.success || snapshot.capability !== 'owner_bound_local_temporal_snapshot') {
    throw new FailClosed('recall_integrity');
  }
  if (
    snapshot.principal_ref !== owner.principal_ref ||
    snapshot.tenant_ref !== owner.tenant_ref
  ) {
    throw new FailClosed('recall_integrity');
  }
  const attestation = attestSnapshot(snapshot.snapshot, inputs, provenance, 'recall', 'recall_integrity');
  if (!isRecallStatus(snapshot.status)) throw new FailClosed('recall_integrity');
  const skipAllowed = recallKey === undefined || (recallKey !== undefined && RECALL_CONFIG[recallKey].skip);
  if (snapshot.status === 'skipped' && !skipAllowed) throw new FailClosed('recall_integrity');
  if (snapshot.status !== 'skipped' && skipAllowed) throw new FailClosed('recall_integrity');
  if (snapshot.status === 'failed') {
    if (!emptyRecall(result.data) || snapshot.source !== null) throw new FailClosed('recall_integrity');
    return Object.freeze({
      principal_ref: owner.principal_ref,
      tenant_ref: owner.tenant_ref,
      snapshot: attestation,
      status: 'failed',
      result: result.data,
      source: null,
      capability: 'owner_bound_local_temporal_snapshot',
    });
  }
  if (snapshot.status === 'skipped') {
    if (!emptyRecall(result.data) || snapshot.source !== null) throw new FailClosed('recall_integrity');
    return Object.freeze({
      principal_ref: owner.principal_ref,
      tenant_ref: owner.tenant_ref,
      snapshot: attestation,
      status: 'skipped',
      result: result.data,
      source: null,
      capability: 'owner_bound_local_temporal_snapshot',
    });
  }
  if (snapshot.status !== 'partial' || snapshot.source === null) {
    throw new FailClosed('recall_integrity');
  }
  if (result.data.episode_hits.length !== 0 || result.data.evolution_hits.length !== 0) {
    throw new FailClosed('recall_integrity');
  }
  const source = snapshotContextSource(snapshot.source, 'recall_integrity');
  const admitted = admitRecallResult(result.data, source.source_taint, inputs.canary_tokens);
  provenance.add(
    source,
    { source_kind: 'recall', scope: 'principal' },
    stableJson(admitted),
    attestation.revision_ref,
  );
  return Object.freeze({
    principal_ref: owner.principal_ref,
    tenant_ref: owner.tenant_ref,
    snapshot: attestation,
    status: snapshot.status,
    result: admitted,
    source,
    capability: 'owner_bound_local_temporal_snapshot',
  });
}

export function recallKeyFor(
  trigger: TriggerType,
  variant: TrustedInvocationEnvelope['runtime_binding']['variant'],
): RecallKey | undefined {
  if (trigger === 'brief') return variant === null ? undefined : `brief_${variant}`;
  switch (trigger) {
    case 'fetch_alert':
    case 'patrol':
    case 'intervention':
    case 'user_message':
    case 'handoff_explore':
    case 'handoff_plan':
    case 'handoff_act':
    case 'handoff_replan':
    case 'dreaming_mode':
      return trigger;
    case 'pre_brief_sweep':
    case 'pre_activity_spot':
      return undefined;
  }
}

function admitRecallResult(
  value: RecallResult,
  taint: SourceTaint,
  canaries: CanaryTokens,
): RecallResult {
  if (
    value.memory_hits.length > MAX_RECALL_MEMORY_HITS ||
    value.episode_hits.length > MAX_RECALL_EPISODE_HITS ||
    value.evolution_hits.length > 0 ||
    value.memory_hits.some((hit) => hit.content.length > MAX_RECALL_ITEM_CHARS) ||
    value.episode_hits.some((hit) => hit.summary.length > MAX_RECALL_ITEM_CHARS)
  ) {
    throw new FailClosed('recall_integrity');
  }
  const memory_hits = value.memory_hits.map((hit) => {
    const parsed = recallMemoryHitSchema.safeParse(hit);
    if (!parsed.success) throw new FailClosed('recall_integrity');
    if (
      !taintStampSchema.safeParse({
        source_trust: parsed.data.source_trust,
        source_taint: taint,
      }).success
    ) {
      throw new FailClosed('recall_integrity');
    }
    return {
      ...parsed.data,
      content: preparePromptSourceText(parsed.data.content, taint, canaries),
    };
  });
  const episode_hits = value.episode_hits.map((hit) => {
    const parsed = episodeHitSchema.safeParse(hit);
    if (!parsed.success) throw new FailClosed('recall_integrity');
    return {
      ...parsed.data,
      summary: preparePromptSourceText(parsed.data.summary, taint, canaries),
    };
  });
  return recallResultSchema.parse({ ...value, memory_hits, episode_hits });
}

function emptyRecall(value: RecallResult): boolean {
  return (
    value.memory_hits.length === 0 &&
    value.episode_hits.length === 0 &&
    value.evolution_hits.length === 0
  );
}

function emptyFailedRecall(
  owner: LocalOwnerBinding,
  inputs: RuntimeOwnedContextInputs,
): ContextRecallSnapshot {
  return {
    principal_ref: owner.principal_ref,
    tenant_ref: owner.tenant_ref,
    snapshot: {
      snapshot_ref: inputs.snapshot_ref,
      snapshot_at: inputs.snapshot_at,
      revision_ref: 'rev_00000000000000000000000000000000',
    },
    status: 'failed',
    result: {
      memory_hits: [],
      episode_hits: [],
      evolution_hits: [],
      query_used: 'recall unavailable',
      duration_ms: 0,
    },
    source: null,
    capability: 'owner_bound_local_temporal_snapshot',
  };
}

function isRecallStatus(value: unknown): value is ContextRecallSnapshot['status'] {
  return value === 'partial' || value === 'failed' || value === 'skipped';
}
