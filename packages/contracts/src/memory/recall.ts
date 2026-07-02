import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { episodeHitSchema } from './episode';
import { hallTypeSchema } from './hall';
import {
  dominanceIncomingSchema,
  dominanceStoredSchema,
  dominates,
  MAX_RENDERED_CONFLICTS,
  trustClassSchema,
} from './trust';
import type { DominanceAuthority } from './trust';

// One memory-hit element: the ADR-0031 RecallResult shape plus source_trust, which the
// ADR-0046 union read (committed ∪ sanitised-pending) requires on every hit so the
// deterministic renderer — never the LLM — can tell the legs apart.
export const recallMemoryHitSchema = z.strictObject({
  hall_type: hallTypeSchema,
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
  valid_from: iso8601Schema,
  source_trust: trustClassSchema,
});
export type RecallMemoryHit = z.infer<typeof recallMemoryHitSchema>;

// Verbatim ADR-0031. The evolutions leg returns [] in V1, but the shape is contract now so
// the prompt builder's seam does not move when the leg lights up.
export const evolutionHitSchema = z.strictObject({
  change_type: z.string().min(1),
  change_value: z.unknown(),
  source: z.string().min(1),
});
export type EvolutionHit = z.infer<typeof evolutionHitSchema>;

// Recall fails open (ADR-0031): a retrieval throw returns an empty result and generation
// continues — empty arrays with a populated query_used are a valid value, not an error shape;
// skip triggers pin duration_ms 0. episode_hits reuses the ./episode element — one
// representation shared across both modules.
export const recallResultSchema = z.strictObject({
  memory_hits: z.array(recallMemoryHitSchema),
  episode_hits: z.array(episodeHitSchema),
  evolution_hits: z.array(evolutionHitSchema),
  query_used: z.string().min(1),
  duration_ms: z.int().nonnegative(),
});
export type RecallResult = z.infer<typeof recallResultSchema>;

// The recall seam (ADR-0031): deterministic, injected by the prompt builder into every
// invocation — never a tool the model can forget to call. Ctx is the InvocationContext
// contract owned by a later runtime wave; genericity keeps this a static type rather than a
// Zod schema, like AdapterResult.
export type RecallGateway<Ctx> = (ctx: Ctx, hint?: string) => Promise<RecallResult>;

// agent_logs.recall_status (ADR-0031): Patrol surfaces a health issue when the failed share
// of invocations exceeds 30%.
export const recallStatusSchema = z.enum(['failed', 'partial', 'ok']);
export type RecallStatus = z.infer<typeof recallStatusSchema>;

// Args of the retrieve() gateway leg (ADR-0031: BM25 + temporal, fused by RRF). Default reads
// exclude superseded rows — dead beliefs never enter prompt context (ADR-0046); as_of is the
// point-in-time read (valid_from <= as_of < valid_to) and include_superseded returns full
// chains by pattern_id, with as_of depth bounded by the hot chain until a cold-archive leg
// ships — the Interface is fixed now, the storage tier is Implementation.
export const retrieveArgsSchema = z.strictObject({
  query: z.string().min(1),
  // The fan-out only calls retrieve when the trigger's config selects halls (ADR-0031).
  halls: z.array(hallTypeSchema).min(1),
  limit: z.int().positive(),
  as_of: iso8601Schema.optional(),
  // The default (superseded excluded) has exactly one representation: the key is absent.
  include_superseded: z.literal(true).optional(),
});
export type RetrieveArgs = z.infer<typeof retrieveArgsSchema>;

// One retrieve() hit: the memory-hit fields plus the rank facts of the ADR-0031 fusion —
// FTS5 BM25 rank and temporal-recency rank are 1-based channel positions, rrf_score their
// reciprocal-rank fusion. Ranks are gateway-internal ordering evidence; recall maps hits
// into RecallResult.memory_hits, which carries no ranks (prompt-destined content only).
export const retrieveHitSchema = z.strictObject({
  ...recallMemoryHitSchema.shape,
  bm25_rank: z.int().positive(),
  temporal_rank: z.int().positive(),
  rrf_score: z.number().positive(),
});
export type RetrieveHit = z.infer<typeof retrieveHitSchema>;

// The ADR-0031 hall-selection table is keyed by trigger with brief split per variant — one
// flat key per table row keeps one concept in one representation. pre_activity_spot postdates
// the table and has no ratified row, so it has no key.
export const recallKeySchema = z.enum([
  'brief_morning',
  'brief_midday',
  'brief_evening',
  'brief_event',
  'fetch_alert',
  'patrol',
  'intervention',
  'user_message',
  'handoff_explore',
  'handoff_plan',
  'handoff_act',
  'handoff_replan',
  'dreaming_mode',
]);
export type RecallKey = z.infer<typeof recallKeySchema>;

// Per-trigger fan-out config (ADR-0031). Skip is config-reversible without a code change;
// a skip row selects no fan-out at all, so "skip yet query" is unrepresentable.
export const recallConfigSchema = z
  .strictObject({
    skip: z.boolean(),
    halls: z.array(hallTypeSchema),
    episodes_days: z.int().nonnegative(),
    evolutions: z.boolean(),
  })
  .refine((c) => !c.skip || (c.halls.length === 0 && c.episodes_days === 0 && !c.evolutions), {
    error: 'a skip config must select no halls, episodes, or evolutions',
    path: ['skip'],
  });
export type RecallConfig = z.infer<typeof recallConfigSchema>;

// Pinned per the ADR-0031 hall-selection table. handoff_act skips — execution layer, not
// reasoning; dreaming_mode skips — Dreaming Mode is itself the recall + consolidation pass.
export const RECALL_CONFIG: Readonly<Record<RecallKey, RecallConfig>> = {
  brief_morning: {
    skip: false,
    halls: ['facts', 'events', 'preferences', 'advice'],
    episodes_days: 7,
    evolutions: true,
  },
  brief_midday: { skip: false, halls: ['events', 'preferences'], episodes_days: 1, evolutions: false },
  brief_evening: {
    skip: false,
    halls: ['events', 'discoveries', 'advice'],
    episodes_days: 1,
    evolutions: false,
  },
  brief_event: { skip: false, halls: ['events', 'advice'], episodes_days: 7, evolutions: false },
  fetch_alert: { skip: false, halls: ['facts', 'advice'], episodes_days: 14, evolutions: true },
  patrol: { skip: false, halls: ['events'], episodes_days: 1, evolutions: false },
  intervention: { skip: false, halls: ['facts', 'advice'], episodes_days: 14, evolutions: true },
  user_message: {
    skip: false,
    halls: ['facts', 'events', 'discoveries', 'preferences', 'advice'],
    episodes_days: 30,
    evolutions: true,
  },
  handoff_explore: {
    skip: false,
    halls: ['facts', 'preferences', 'advice'],
    episodes_days: 14,
    evolutions: true,
  },
  handoff_plan: { skip: false, halls: ['preferences', 'advice'], episodes_days: 7, evolutions: false },
  handoff_act: { skip: true, halls: [], episodes_days: 0, evolutions: false },
  handoff_replan: { skip: false, halls: ['events', 'preferences'], episodes_days: 1, evolutions: true },
  dreaming_mode: { skip: true, halls: [], episodes_days: 0, evolutions: false },
};

// The pinned trigger-signal strings of the ADR-0031 query construction. Skip rows carry a
// signal too: query_used is populated even when the fan-out is skipped.
export const TRIGGER_SIGNAL: Readonly<Record<RecallKey, string>> = {
  brief_morning: 'morning briefing waking-up',
  brief_midday: 'midday brief',
  brief_evening: 'evening close day-review',
  brief_event: 'event brief',
  fetch_alert: 'acute stress alert intervention needed',
  patrol: 'background analysis observation',
  intervention: 'overload check-in user-pushing-too-hard',
  user_message: 'user-initiated conversation',
  handoff_explore: 'exploring options for day plan',
  handoff_plan: 'proposing day plan',
  handoff_act: 'executing approved actions',
  handoff_replan: 'mid-day plan adjustment',
  dreaming_mode: 'nightly consolidation reflection',
};

// ~200-token cap at the ADR-0031 4-chars-per-token approximation.
export const RECALL_QUERY_MAX_CHARS = 800;

// Query construction (ADR-0031): trigger signal + health-zone signal + caller hint. The zone
// signal arrives pre-worded from the zone contract — zone words only; a raw physiological
// value never enters the query (ADR-0024 destination rules).
export function buildRecallQuery(key: RecallKey, zoneSignal: string, hint?: string): string {
  return [TRIGGER_SIGNAL[key], zoneSignal, hint ?? '']
    .filter(Boolean)
    .join(' · ')
    .slice(0, RECALL_QUERY_MAX_CHARS);
}

// A conflict pair is one pattern_id appearing on both legs of the ADR-0046 union read. Each
// leg carries its dominance facts plus what rendering needs; ordering and tags are computed
// by the same dominates() the Scribe merge uses — the LLM never picks the winner.
export const conflictPendingSchema = z.strictObject({
  ...dominanceIncomingSchema.shape,
  content: z.string().min(1),
});
export type ConflictPending = z.infer<typeof conflictPendingSchema>;

// source names the system-of-record whose next sync tiebreaks a user-stated overlay;
// last_synced_at is that source's last successful sync — null when unknown, which forecloses
// the freshness overlay (fail conservative; the pair still renders).
export const conflictCommittedSchema = z.strictObject({
  ...dominanceStoredSchema.shape,
  content: z.string().min(1),
  source: z.string().min(1),
  last_synced_at: iso8601Schema.nullable(),
});
export type ConflictCommitted = z.infer<typeof conflictCommittedSchema>;

export const conflictPairSchema = z.strictObject({
  pending: conflictPendingSchema,
  committed: conflictCommittedSchema,
});
export type ConflictPair = z.infer<typeof conflictPairSchema>;

const CONSULTED_MARKER = '[Consulted memory before acting]';

// The three deterministic pair outcomes (ADR-0046 union read). Only a proposal the merge
// would actually auto-supersede earns the stale tag — comparator unity means the renderer
// can never promise a supersede the merge will refuse. The committed block is never hidden.
function renderConflictPair(pair: ConflictPair, authority: DominanceAuthority): string {
  const { pending, committed } = pair;
  if (dominates(pending, committed, authority)) {
    return `  - ${pending.content}\n  - [stale — superseding update pending] ${committed.content}`;
  }
  if (
    pending.source_trust === 'user_stated' &&
    committed.source_trust === 'system_of_record' &&
    committed.last_synced_at !== null &&
    Date.parse(pending.observed_at) > Date.parse(committed.last_synced_at)
  ) {
    return `  - [user-reported — awaiting ${committed.source} sync] ${pending.content}\n  - [last synced ${committed.last_synced_at}] ${committed.content}`;
  }
  return `  - ${committed.content}\n  - [provisional] ${pending.content}`;
}

// Memory fencing (ADR-0031): every recall block is wrapped in <recall> with the
// consulted-memory marker — informational context, never instructions (defence-in-depth with
// the sanitiser's instruction-pattern check, ADR-0024). Open conflict pairs are capped at
// MAX_RENDERED_CONFLICTS, most recent first by the pending leg's observed_at (ADR-0046);
// flag expiry after FLAG_TTL_DAYS happens where flags live, not here.
export function renderRecall(
  result: RecallResult,
  conflicts: readonly ConflictPair[],
  authority: DominanceAuthority,
): string {
  const pairs = [...conflicts]
    .sort((a, b) => Date.parse(b.pending.observed_at) - Date.parse(a.pending.observed_at))
    .slice(0, MAX_RENDERED_CONFLICTS);

  if (
    result.memory_hits.length === 0 &&
    result.episode_hits.length === 0 &&
    result.evolution_hits.length === 0 &&
    pairs.length === 0
  ) {
    return `<recall>\n${CONSULTED_MARKER}\nNo relevant memory or history surfaced for this context.\n</recall>`;
  }

  const sections: string[] = [CONSULTED_MARKER];

  if (result.memory_hits.length > 0) {
    sections.push(`\nMemory blocks (${result.memory_hits.length}):`);
    for (const m of result.memory_hits) {
      sections.push(`  - [${m.hall_type}] (conf: ${m.confidence.toFixed(2)}) ${m.content}`);
    }
  }

  if (result.episode_hits.length > 0) {
    sections.push(`\nEpisodes (${result.episode_hits.length}):`);
    for (const e of result.episode_hits) {
      sections.push(`  - [${e.date}] ${e.summary}`);
    }
  }

  if (result.evolution_hits.length > 0) {
    sections.push(`\nUnapplied behavioral evolutions (${result.evolution_hits.length}):`);
    for (const ev of result.evolution_hits) {
      sections.push(`  - ${ev.change_type}: ${JSON.stringify(ev.change_value)}`);
    }
  }

  if (pairs.length > 0) {
    sections.push(`\nOpen conflicts (${pairs.length}):`);
    for (const pair of pairs) {
      sections.push(renderConflictPair(pair, authority));
    }
  }

  return `<recall>\n${sections.join('\n')}\n</recall>`;
}
