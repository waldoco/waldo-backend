import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { patternIdSchema } from './pattern-id';

// Priority order is the contract (ADR-0046): memory is a cache of compiled understanding,
// never authoritative over the system that owns the underlying state. 'memory_provisional'
// exists only on the inbox leg of the union read; 'memory_committed' is the comparison class
// only for blocks whose provenance is Waldo's own compilation.
export const trustClassSchema = z.enum([
  'system_of_record',
  'user_stated',
  'memory_committed',
  'memory_provisional',
  'inferred',
]);
export type TrustClass = z.infer<typeof trustClassSchema>;

// Rank lookup for dominates(). Only the ordering is contract — re-ranking is a constant
// change here; the priority principle is the hard-to-reverse part (ADR-0046).
export const TRUST_ORDER: Readonly<Record<TrustClass, number>> = {
  system_of_record: 4,
  user_stated: 3,
  memory_committed: 2,
  memory_provisional: 1,
  inferred: 0,
};

export const conflictClassSchema = z.enum([
  'event_state_change',
  'user_correction',
  'evidence_contradiction',
  'memory_conflict',
]);
export type ConflictClass = z.infer<typeof conflictClassSchema>;

// ADR-0046 pinned thresholds. The confirm/contradict asymmetry (+0.05 vs -0.15) is
// deliberate: one disconfirming observation carries more information than one confirming
// observation for an already-believed pattern. The confirm bump caps confidence at 1.0
// (ADR-0037 exact-duplicate path).
export const CONFIRM_INCREMENT = 0.05;
export const CONTRADICTION_DECREMENT = 0.15;
export const SUPERSEDE_CONFIDENCE_FLOOR = 0.5;
export const MIN_CONTRADICTING_OBS = 3;
// FLAP_LIMIT supersedences on one pattern_id within FLAP_WINDOW_DAYS freeze auto-supersede:
// a flapping source is a data-quality incident, not a belief update (ADR-0046).
export const FLAP_LIMIT = 3;
export const FLAP_WINDOW_DAYS = 7;
// After a rollback, a content-identical re-proposal on that pattern_id is suppressed for
// 24h so a wrong SoR read cannot instantly re-supersede (ADR-0046).
export const ROLLBACK_REPROPOSE_COOLDOWN_MS = 86_400_000;
export const FLAG_TTL_DAYS = 14;
export const MAX_RENDERED_CONFLICTS = 2;
// A sweep whose proposals would close more than MASS_WAVE_FRACTION (minimum
// MASS_WAVE_MIN_BLOCKS) of one source's active blocks freezes as a single flagged incident:
// empty-success wipes (sync-token reset, 200-empty provider bug) look like mass cancellation
// and must not walk through class-1 auto-supersede (ADR-0046).
export const MASS_WAVE_FRACTION = 0.2;
export const MASS_WAVE_MIN_BLOCKS = 5;

// The minimal facts dominance needs from an incoming proposal. source_trust and observed_at
// are stamped by the code path at the adapter seam — never content-derived, never
// model-supplied; an agent-originated update is 'inferred' regardless of what its text
// asserts about its own provenance (ADR-0046).
export const dominanceIncomingSchema = z.strictObject({
  source_trust: trustClassSchema,
  observed_at: iso8601Schema,
  source: z.string().min(1),
});
export type DominanceIncoming = z.infer<typeof dominanceIncomingSchema>;

// The stored side compares on preserved provenance: a block born from a calendar event stays
// system_of_record after the merge (ADR-0046).
export const dominanceStoredSchema = z.strictObject({
  source_trust: trustClassSchema,
  valid_from: iso8601Schema,
  pattern_id: patternIdSchema,
  hall_type: z.string().min(1),
});
export type DominanceStored = z.infer<typeof dominanceStoredSchema>;

// Domain authority and the per-hall writer-class ACL live behind their own seams (the domain
// map at the adapter layer; HALL_WRITE_ACL in memory/hall.ts), so the comparator takes them
// as injected predicates and stays the single implementation of the composition. Function-
// bearing, so a static type rather than a Zod schema, like AdapterResult.
export type DominanceAuthority = {
  inDomain: (source: string, patternId: string) => boolean;
  hallAdmits: (hallType: string, trust: TrustClass) => boolean;
};

// Same-class refresh is restricted to grounded classes — the world can move again (second
// calendar move, repeat verified correction) but 'inferred' never refreshes itself (ADR-0046).
const GROUNDED_SAME_CLASS: ReadonlySet<TrustClass> = new Set(['system_of_record', 'user_stated']);

// The ONE comparator (ADR-0046): the Scribe merge guard and the recall renderer call this
// same function, so the renderer can never promise a supersede the merge will refuse.
// The LLM never ranks truth.
export function dominates(
  incoming: DominanceIncoming,
  stored: DominanceStored,
  authority: DominanceAuthority,
): boolean {
  const outranks =
    TRUST_ORDER[incoming.source_trust] > TRUST_ORDER[stored.source_trust] ||
    (incoming.source_trust === stored.source_trust &&
      GROUNDED_SAME_CLASS.has(incoming.source_trust));
  return (
    outranks &&
    // Recency guard compares instants, not strings: iso8601 admits non-UTC offsets, so
    // lexicographic order can disagree with time order. Belief never moves backward — a late
    // arrival fails here and backfills as a closed historical link (ADR-0046).
    Date.parse(incoming.observed_at) > Date.parse(stored.valid_from) &&
    authority.inDomain(incoming.source, stored.pattern_id) &&
    authority.hallAdmits(stored.hall_type, incoming.source_trust)
  );
}

// Dreaming Mode stamps the contradiction evidence count on the entry it stages; confidence
// lives on the stored active block (ADR-0046).
export const class3EntrySchema = z.strictObject({
  conflict_class: conflictClassSchema.nullable(),
  contradicting_observations: z.int().nonnegative(),
});
export type Class3Entry = z.infer<typeof class3EntrySchema>;

export const class3ActiveSchema = z.strictObject({
  confidence: z.number().min(0).max(1),
});
export type Class3Active = z.infer<typeof class3ActiveSchema>;

// The deliberate second admission arm of the merge guard (ADR-0046): a class-3 replacement
// is agent-worded, stamps 'inferred', and can never dominate — it is admitted only when the
// stored pattern has crossed the evidence thresholds. One contradicting observation only
// decrements confidence — noise is not refutation. The successor stays 'inferred': a
// corrected hypothesis is still a hypothesis.
export function class3Gate(entry: Class3Entry, active: Class3Active): boolean {
  return (
    entry.conflict_class === 'evidence_contradiction' &&
    active.confidence < SUPERSEDE_CONFIDENCE_FLOOR &&
    entry.contradicting_observations >= MIN_CONTRADICTING_OBS
  );
}
