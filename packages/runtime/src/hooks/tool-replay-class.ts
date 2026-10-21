import type { ToolName } from '@waldo/contracts';
import { toolRecordColumn, type ToolReplayRow } from '../tools/records';

export type { ToolReplayClass, ToolReplayRow } from '../tools/records';

// Each tool's replay class, kept in its tool record with the basis for it.
// No runtime caller of replayDecision yet: owner-path wiring waits on a durable per-call intent record.
export const TOOL_REPLAY_CLASS: Readonly<Record<ToolName, ToolReplayRow>> = toolRecordColumn('replay');

// What a retried tool call may do, from its class and what a durable intent record shows about the earlier attempt.
//  unseen              no record of an earlier attempt: run.
//  settled             the earlier attempt finished with a stored result: reuse it, never run again.
//  started_unsettled   an earlier attempt began and its outcome was never stored (crash window).
// Decision for started_unsettled: safe_read and provider_idempotent run again (same key collapses at the store);
// reconcilable_write must look the effect up first; non_replayable_uncertain never runs again and the owner is told it may or may not have happened.
export type PriorCall = 'unseen' | 'settled' | 'started_unsettled';
export type ReplayDecision = 'run' | 'reuse_result' | 'reconcile_first' | 'refuse_uncertain';
export const replayDecision = (tool: ToolName, prior: PriorCall): ReplayDecision => {
  if (prior === 'unseen') return 'run';
  if (prior === 'settled') return 'reuse_result';
  switch (TOOL_REPLAY_CLASS[tool].replay) {
    case 'safe_read': case 'provider_idempotent': return 'run';
    case 'reconcilable_write': return 'reconcile_first';
    case 'non_replayable_uncertain': return 'refuse_uncertain';
  }
};
