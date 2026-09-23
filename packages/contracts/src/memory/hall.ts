import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { claimKeySchema, patternIdSchema } from './pattern-id';
import { isExternalSourceTaint, MEMORY_BLOCK_CONTENT_MAX, sourceTaintSchema } from './sanitise';
import { conflictClassSchema, trustClassSchema } from './trust';
import type { TrustClass } from './trust';

// Exactly five halls (ADR-0005, MemPalace shape). Goals are NOT a hall — they carry
// lifecycle + progress columns halls lack, so they get their own table (rejected option).
export const hallTypeSchema = z.enum(['facts', 'events', 'discoveries', 'preferences', 'advice']);
export type HallType = z.infer<typeof hallTypeSchema>;

// Pinned past-tense, extending ADR-0037's vocabulary with 'retired' + 'flagged' — one
// concept, one representation (ADR-0046).
export const decisionActionSchema = z.enum([
  'graduated',
  'rejected',
  'superseded',
  'rolled_back',
  'retired',
  'flagged',
]);
export type DecisionAction = z.infer<typeof decisionActionSchema>;

export const decisionLogEntrySchema = z.strictObject({
  at: iso8601Schema,
  action: decisionActionSchema,
  rationale: z.string().min(1),
  source: z.string().min(1),
});
export type DecisionLogEntry = z.infer<typeof decisionLogEntrySchema>;

// ADR-0024 caps memory-block bodies at 2 KB; the sanitiser rejects oversize at the inbox
// write seam, and the schema makes the cap unrepresentable to skip.
const memoryContentSchema = z.string().min(1).max(MEMORY_BLOCK_CONTENT_MAX);

// The committed bi-temporal row (ADR-0046, forcing the ADR-0037/0005 mechanics into types).
// valid_from/valid_to are validity time set from the evidence's observed_at — never merge
// time — so late-arriving data lands at measurement time and "what was true" vs "what Waldo
// believed" (created_at, transaction time) stay separately answerable. Terminal states:
// active = valid_to null; superseded = valid_to set + superseded_by → successor; retired =
// valid_to set + superseded_by null. Supersedence and retirement are the only mutations of a
// committed block — no row DELETE ever (ADR-0037); exactly one active row per
// (user_id, pattern_id) is the DDL's partial unique index plus Scribe as single writer.
export const memoryBlockSchema = z
  .strictObject({
    id: z.string().min(1),
    user_id: z.string().min(1),
    hall_type: hallTypeSchema,
    content: memoryContentSchema,
    // Nullable only for legacy rows predating ADR-0037: claim + conditions are not
    // reconstructable from content, so retroactive computation is unsupported.
    pattern_id: patternIdSchema.nullable(),
    rejection_count: z.int().nonnegative(),
    decision_log: z.array(decisionLogEntrySchema),
    // Rollback is roll-forward (ADR-0037): the new row points back at the row it closed;
    // the old row is never reopened, so history stays monotonic.
    rolled_back_from: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
    last_confirmed_at: iso8601Schema.nullable(),
    created_at: iso8601Schema,
    valid_from: iso8601Schema,
    valid_to: iso8601Schema.nullable(),
    superseded_by: z.string().min(1).nullable(),
    // Preserved provenance (ADR-0046): a block born from a calendar event stays
    // system_of_record after the merge — the stored side of dominates() compares on this.
    source_trust: trustClassSchema,
    // Opaque provenance pointer (calendar event id, provider row date, message id) — what
    // conflict detection diffs against. An id, never a raw value.
    source_ref: z.string().min(1).nullable(),
  })
  // Instants, not strings: iso8601 admits non-UTC offsets, so lexicographic order can lie.
  .refine((b) => b.valid_to === null || Date.parse(b.valid_to) >= Date.parse(b.valid_from), {
    error: 'a negative validity interval is unrepresentable',
    path: ['valid_to'],
  })
  .refine((b) => b.superseded_by === null || b.valid_to !== null, {
    error: 'an active row cannot point at a successor',
    path: ['superseded_by'],
  });
export type MemoryBlock = z.infer<typeof memoryBlockSchema>;

// ADR-0006 DDL vocabulary for staged proposals.
export const inboxOperationSchema = z.enum(['ADD', 'UPDATE', 'DELETE']);
export type InboxOperation = z.infer<typeof inboxOperationSchema>;

// The staging leg (ADR-0006): tools never write memory_blocks — every proposal transits this
// inbox, sanitised at write time, and reads same-day as 'memory_provisional' on the union
// read. The inbox is process-and-remove, except needs_confirmation flags, which render as
// open conflict pairs and collapse into the block's decision_log after FLAG_TTL_DAYS — a
// named, bounded amendment to the process-and-remove rule (ADR-0046). source_trust,
// observed_at and conflict_class are stamped by the code path at the adapter seam — never
// content-derived, never model-supplied: an agent-originated proposal is 'inferred'
// regardless of what its text asserts (ADR-0046).
export const memoryInboxEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    user_id: z.string().min(1),
    operation: inboxOperationSchema,
    hall: hallTypeSchema,
    // The value-free claim key — pattern_id derives from it, so the Art-9 wall holds at the
    // staging seam too (ADR-0037 amendment).
    claim: claimKeySchema,
    conditions: z.array(z.string().min(1)),
    content: memoryContentSchema,
    proposed_pattern_id: patternIdSchema,
    // Validity time of the evidence — valid_from is set from this at merge, never now()
    // (ADR-0046, refining ADR-0037).
    observed_at: iso8601Schema,
    source_trust: trustClassSchema,
    source_ref: z.string().min(1).nullable(),
    conflict_class: conflictClassSchema.nullable(),
    rationale: z.string().min(1),
    source: z.string().min(1),
    // 'external' is the only pinned taint (ADR-0049): tainted content never escalates trust
    // class and always queues; null = no external origin.
    source_taint: sourceTaintSchema,
    // A sanitiser failure marks rejected + reason and is never retried (ADR-0024); the
    // reason-code vocabulary is owned by the sanitiser seam and carried opaquely here.
    rejected: z.boolean(),
    rejection_reason: z.string().min(1).nullable(),
    needs_confirmation: z.boolean(),
  })
  .refine((e) => e.rejected === (e.rejection_reason !== null), {
    error: 'rejected and rejection_reason travel together',
    path: ['rejection_reason'],
  })
  // ADR-0049: whatever provenance an external-tainted proposal asserts, it lands 'inferred' —
  // which never dominates — so the injection→supersede path is unrepresentable at this seam.
  .refine((e) => !isExternalSourceTaint(e.source_taint) || e.source_trust === 'inferred', {
    error: 'tainted content never escalates trust class',
    path: ['source_trust'],
  });
export type MemoryInboxEntry = z.infer<typeof memoryInboxEntrySchema>;

// Per-hall writer-class set (ADR-0046 v0.2.1 callout), replacing ADR-0005's boolean ACL,
// which could not express "immutable against user/LLM writes yet supersedable by truth".
// A security boundary only because Scribe is the single writer (ADR-0006). facts: the
// ADR-0005 amendment's exact pin — grounded classes only, through the Scribe seam. events:
// the same grounded pair (the calendar/mailbox own event state; a verified user correction
// is the class-2 path). preferences: no external system owns a preference — user_stated
// only. discoveries (scribe-only) and advice (agent-with-evidence) are Waldo-compiled:
// proposals stamp 'inferred', which never passes dominates(), so their supersedence flows
// exclusively through the class-3 evidence gate (ADR-0046).
export const HALL_WRITE_ACL: Readonly<Record<HallType, ReadonlySet<TrustClass>>> = {
  facts: new Set(['system_of_record', 'user_stated']),
  events: new Set(['system_of_record', 'user_stated']),
  discoveries: new Set(['inferred']),
  preferences: new Set(['user_stated']),
  advice: new Set(['inferred']),
};

// The hall ACL arm of dominates() (ADR-0046): the Scribe merge guard and the recall renderer
// inject this same predicate, so neither can admit a writer class the other would refuse.
// Unknown hall names fail closed.
export function hallAdmits(hallType: string, trust: TrustClass): boolean {
  const hall = hallTypeSchema.safeParse(hallType);
  return hall.success && HALL_WRITE_ACL[hall.data].has(trust);
}
