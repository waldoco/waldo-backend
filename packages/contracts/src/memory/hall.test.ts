// Owning ADRs: ADR-0005 (five typed halls + writer-class ACL amendment), ADR-0046
// (bi-temporal block + inbox provenance fields, decision_log vocabulary), ADR-0037
// (pattern_id chain mechanics), ADR-0006 (inbox staging shape), ADR-0024 (content cap),
// ADR-0049 (taint never escalates trust class).
// Invariant under test: the hall vocabulary is exactly five; the committed block is
// bi-temporal with only the three ADR-0046 states (active / superseded / retired)
// representable; the inbox entry carries adapter-seam-stamped provenance and can never pair
// an 'external' taint with a trust class above 'inferred'; HALL_WRITE_ACL is
// a per-hall writer-class SET whose hallAdmits is the ACL arm dominates() composes.
// Failure mode caught: a sixth hall or boolean-ACL regression, the legacy (non-bi-temporal)
// block shape parsing, a negative validity interval or active-row-with-successor slipping
// through, an external-tainted proposal staging with escalated trust (the
// injection→supersede path ADR-0049 closes), or an ACL edit that silently lets 'inferred'
// supersede facts.
// Note: the DDL-level partial unique index (one active row per user_id + pattern_id) is a
// cross-row invariant a Zod schema cannot express — it is tested at the AuditedDB seam in
// the runtime wave, not here.
import { describe, expect, it } from 'vitest';
import {
  decisionActionSchema,
  decisionLogEntrySchema,
  HALL_WRITE_ACL,
  hallAdmits,
  hallTypeSchema,
  inboxOperationSchema,
  memoryBlockSchema,
  memoryInboxEntrySchema,
} from './hall';
import { dominanceIncomingSchema, dominanceStoredSchema, dominates, trustClassSchema } from './trust';
import type { DominanceAuthority } from './trust';

const baseBlock = {
  id: 'blk-001',
  user_id: 'user-1',
  hall_type: 'facts',
  content: 'wakes at 6:30am on weekdays',
  pattern_id: '9b686cae0708',
  rejection_count: 0,
  decision_log: [
    {
      at: '2026-06-01T10:00:00Z',
      action: 'graduated',
      rationale: 'onboarding claim confirmed in chat',
      source: 'onboarding',
    },
  ],
  rolled_back_from: null,
  confidence: 0.8,
  last_confirmed_at: null,
  created_at: '2026-06-01T10:00:05Z',
  valid_from: '2026-06-01T10:00:00Z',
  valid_to: null,
  superseded_by: null,
  source_trust: 'user_stated',
  source_ref: null,
} as const;

const baseEntry = {
  id: 'inbox-001',
  user_id: 'user-1',
  operation: 'UPDATE',
  hall: 'facts',
  claim: 'user wake time',
  conditions: ['timezone:America/Los_Angeles', 'weekday'],
  content: 'wakes at 7:00am on weekdays',
  proposed_pattern_id: '9b686cae0708',
  observed_at: '2026-06-02T10:00:00Z',
  source_trust: 'user_stated',
  source_ref: null,
  conflict_class: 'user_correction',
  rationale: 'explicit user correction in chat',
  source: 'chat',
  source_taint: null,
  rejected: false,
  rejection_reason: null,
  needs_confirmation: false,
} as const;

describe('hallTypeSchema', () => {
  it('is exactly the five halls, in order', () => {
    expect(hallTypeSchema.options).toEqual([
      'facts',
      'events',
      'discoveries',
      'preferences',
      'advice',
    ]);
  });

  it("rejects 'goals' — the rejected sixth hall gets its own table", () => {
    expect(hallTypeSchema.safeParse('goals').success).toBe(false);
  });

  it('rejects an unknown hall', () => {
    expect(hallTypeSchema.safeParse('notes').success).toBe(false);
  });
});

describe('decisionActionSchema', () => {
  it('is exactly the six pinned past-tense actions, in order', () => {
    expect(decisionActionSchema.options).toEqual([
      'graduated',
      'rejected',
      'superseded',
      'rolled_back',
      'retired',
      'flagged',
    ]);
  });

  it('rejects a present-tense action', () => {
    expect(decisionActionSchema.safeParse('supersede').success).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(decisionActionSchema.safeParse('promoted').success).toBe(false);
  });
});

describe('decisionLogEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    expect(decisionLogEntrySchema.safeParse(baseBlock.decision_log[0]).success).toBe(true);
  });

  it('rejects an empty rationale', () => {
    expect(
      decisionLogEntrySchema.safeParse({ ...baseBlock.decision_log[0], rationale: '' }).success,
    ).toBe(false);
  });

  it('rejects extra fields — strict object', () => {
    expect(
      decisionLogEntrySchema.safeParse({ ...baseBlock.decision_log[0], reviewer: 'agent' })
        .success,
    ).toBe(false);
  });
});

describe('memoryBlockSchema — terminal-state expressibility', () => {
  it('accepts an active row (valid_to null, no successor)', () => {
    expect(memoryBlockSchema.safeParse(baseBlock).success).toBe(true);
  });

  it('accepts a superseded row (valid_to set, superseded_by points at the successor)', () => {
    expect(
      memoryBlockSchema.safeParse({
        ...baseBlock,
        valid_to: '2026-06-02T10:00:00Z',
        superseded_by: 'blk-002',
      }).success,
    ).toBe(true);
  });

  it('accepts a retired row (valid_to set, superseded_by null — withdrawn, no replacement)', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, valid_to: '2026-06-02T10:00:00Z' }).success,
    ).toBe(true);
  });

  it('rejects an active row pointing at a successor — not one of the three states', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, superseded_by: 'blk-002' }).success).toBe(
      false,
    );
  });
});

describe('memoryBlockSchema — validity interval', () => {
  it('rejects a negative validity interval', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, valid_to: '2026-06-01T09:00:00Z' }).success,
    ).toBe(false);
  });

  it('accepts a zero-length interval — only negative is unrepresentable', () => {
    expect(
      memoryBlockSchema.safeParse({
        ...baseBlock,
        valid_to: '2026-06-01T10:00:00Z',
        superseded_by: 'blk-002',
      }).success,
    ).toBe(true);
  });

  it('compares instants, not strings: a lexicographically-later valid_to that is an earlier instant is rejected', () => {
    // 2026-06-01T12:00:00+05:00 is 07:00:00Z — before valid_from 10:00:00Z, even though the
    // string sorts after it. Naive string comparison would accept this negative interval.
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, valid_to: '2026-06-01T12:00:00+05:00' })
        .success,
    ).toBe(false);
  });
});

describe('memoryBlockSchema — field domains', () => {
  it('drift guard: the legacy waldo-types shape without bi-temporal fields fails parse', () => {
    // The shipped v0.2.0 block had no valid_from/valid_to/superseded_by/source_trust/
    // source_ref — the audit finding ADR-0046 exists to fix. It must never parse again.
    expect(
      memoryBlockSchema.safeParse({
        id: 'blk-001',
        user_id: 'user-1',
        hall_type: 'facts',
        content: 'wakes at 6:30am on weekdays',
        pattern_id: '9b686cae0708',
        rejection_count: 0,
        decision_log: [],
        rolled_back_from: null,
        confidence: 0.8,
        last_confirmed_at: null,
        created_at: '2026-06-01T10:00:05Z',
      }).success,
    ).toBe(false);
  });

  it('accepts a legacy null pattern_id — no supersedence guarantee, still representable', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, pattern_id: null }).success).toBe(true);
  });

  it('rejects an uppercase pattern_id — one canonical representation', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, pattern_id: '9B686CAE0708' }).success,
    ).toBe(false);
  });

  it('accepts content at exactly the ADR-0024 2048-char (2 KB) cap', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, content: 'x'.repeat(2048) }).success,
    ).toBe(true);
  });

  it('rejects content over the 2048-char cap', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, content: 'x'.repeat(2049) }).success,
    ).toBe(false);
  });

  it('rejects empty content', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, content: '' }).success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, confidence: 1.2 }).success).toBe(false);
  });

  it('rejects a negative rejection_count', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, rejection_count: -1 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown source_trust', () => {
    expect(
      memoryBlockSchema.safeParse({ ...baseBlock, source_trust: 'agent_claimed' }).success,
    ).toBe(false);
  });

  it('rejects a decision_log entry with an unknown action', () => {
    expect(
      memoryBlockSchema.safeParse({
        ...baseBlock,
        decision_log: [{ ...baseBlock.decision_log[0], action: 'promoted' }],
      }).success,
    ).toBe(false);
  });

  it('rejects extra fields — strict object', () => {
    expect(memoryBlockSchema.safeParse({ ...baseBlock, hall: 'facts' }).success).toBe(false);
  });
});

describe('inboxOperationSchema', () => {
  it('is exactly the three ADR-0006 operations, in order', () => {
    expect(inboxOperationSchema.options).toEqual(['ADD', 'UPDATE', 'DELETE']);
  });

  it('rejects an out-of-DDL operation', () => {
    expect(inboxOperationSchema.safeParse('MERGE').success).toBe(false);
  });
});

describe('memoryInboxEntrySchema', () => {
  it('accepts a well-formed user-correction proposal', () => {
    expect(memoryInboxEntrySchema.safeParse(baseEntry).success).toBe(true);
  });

  it('allows a null conflict_class — non-conflicting proposals are representable', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, conflict_class: null }).success,
    ).toBe(true);
  });

  it('requires proposed_pattern_id — supersedence dedupe has no fallback', () => {
    const { proposed_pattern_id: _dropped, ...withoutPatternId } = baseEntry;
    expect(memoryInboxEntrySchema.safeParse(withoutPatternId).success).toBe(false);
  });

  it('rejects a valued sentence as claim — the Art-9 wall holds at the staging seam', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, claim: 'user wakes at 6:30am' }).success,
    ).toBe(false);
  });

  it('rejects an epoch timestamp as observed_at — validity time is ISO-8601', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, observed_at: '1770000000000' }).success,
    ).toBe(false);
  });

  it("accepts the pinned 'external' taint on an 'inferred' proposal", () => {
    expect(
      memoryInboxEntrySchema.safeParse({
        ...baseEntry,
        source_taint: 'external',
        source_trust: 'inferred',
      }).success,
    ).toBe(true);
  });

  it("rejects every trust class above 'inferred' when tainted — tainted content never escalates trust class", () => {
    for (const trust of trustClassSchema.options.filter((c) => c !== 'inferred')) {
      expect(
        memoryInboxEntrySchema.safeParse({
          ...baseEntry,
          source_taint: 'external',
          source_trust: trust,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects an unpinned taint literal', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, source_taint: 'internal' }).success,
    ).toBe(false);
  });

  it('rejects a sanitiser rejection without its reason code', () => {
    expect(memoryInboxEntrySchema.safeParse({ ...baseEntry, rejected: true }).success).toBe(
      false,
    );
  });

  it('accepts a sanitiser rejection carrying its reason code', () => {
    expect(
      memoryInboxEntrySchema.safeParse({
        ...baseEntry,
        rejected: true,
        rejection_reason: 'health_value_leak',
      }).success,
    ).toBe(true);
  });

  it('rejects a reason code on an accepted entry', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, rejection_reason: 'oversize' }).success,
    ).toBe(false);
  });

  it('rejects an empty condition string', () => {
    expect(memoryInboxEntrySchema.safeParse({ ...baseEntry, conditions: [''] }).success).toBe(
      false,
    );
  });

  it('rejects content over the 2048-char cap', () => {
    expect(
      memoryInboxEntrySchema.safeParse({ ...baseEntry, content: 'x'.repeat(2049) }).success,
    ).toBe(false);
  });

  it('rejects extra fields — strict object', () => {
    expect(memoryInboxEntrySchema.safeParse({ ...baseEntry, confidence: 1 }).success).toBe(
      false,
    );
  });
});

describe('HALL_WRITE_ACL', () => {
  it('keys exactly the five halls, in enum order', () => {
    expect(Object.keys(HALL_WRITE_ACL)).toEqual([...hallTypeSchema.options]);
  });

  it('is a writer-class SET per hall — never the legacy boolean map', () => {
    for (const hall of hallTypeSchema.options) {
      expect(HALL_WRITE_ACL[hall]).toBeInstanceOf(Set);
    }
  });

  it('facts: grounded classes only — immutable against user/LLM writes, supersedable by truth', () => {
    expect([...HALL_WRITE_ACL.facts].sort()).toEqual(['system_of_record', 'user_stated']);
  });

  it('events: the same grounded pair', () => {
    expect([...HALL_WRITE_ACL.events].sort()).toEqual(['system_of_record', 'user_stated']);
  });

  it('discoveries: scribe-compiled only', () => {
    expect([...HALL_WRITE_ACL.discoveries]).toEqual(['inferred']);
  });

  it('preferences: user_stated only — no external system owns a preference', () => {
    expect([...HALL_WRITE_ACL.preferences]).toEqual(['user_stated']);
  });

  it('advice: agent-with-evidence only', () => {
    expect([...HALL_WRITE_ACL.advice]).toEqual(['inferred']);
  });

  it('no hall admits the leg/provenance classes memory_provisional or memory_committed', () => {
    for (const hall of hallTypeSchema.options) {
      expect(HALL_WRITE_ACL[hall].has('memory_provisional')).toBe(false);
      expect(HALL_WRITE_ACL[hall].has('memory_committed')).toBe(false);
    }
  });
});

describe('hallAdmits', () => {
  it('admits a system_of_record proposal into facts', () => {
    expect(hallAdmits('facts', 'system_of_record')).toBe(true);
  });

  it("refuses an 'inferred' proposal into facts", () => {
    expect(hallAdmits('facts', 'inferred')).toBe(false);
  });

  it('refuses a system_of_record proposal into preferences', () => {
    expect(hallAdmits('preferences', 'system_of_record')).toBe(false);
  });

  it('fails closed on an unknown hall name', () => {
    expect(hallAdmits('goals', 'system_of_record')).toBe(false);
  });
});

describe('hallAdmits as the dominates() ACL arm', () => {
  const authority: DominanceAuthority = { inDomain: () => true, hallAdmits };
  const sorIncoming = dominanceIncomingSchema.parse({
    source_trust: 'system_of_record',
    observed_at: '2026-06-02T10:00:00Z',
    source: 'calendar',
  });
  const userIncoming = dominanceIncomingSchema.parse({
    source_trust: 'user_stated',
    observed_at: '2026-06-02T10:00:00Z',
    source: 'chat',
  });
  const factsStored = dominanceStoredSchema.parse({
    source_trust: 'memory_committed',
    valid_from: '2026-06-01T10:00:00Z',
    pattern_id: '9b686cae0708',
    hall_type: 'facts',
  });
  const discoveryStored = dominanceStoredSchema.parse({
    source_trust: 'inferred',
    valid_from: '2026-06-01T10:00:00Z',
    pattern_id: 'a91f4d72c8e3',
    hall_type: 'discoveries',
  });

  it('a system_of_record contradiction supersedes a committed fact through the seam', () => {
    expect(dominates(sorIncoming, factsStored, authority)).toBe(true);
  });

  it('the ACL arm is load-bearing: user_stated outranks an inferred discovery yet never dominates it — discoveries change only via the class-3 gate', () => {
    expect(dominates(userIncoming, discoveryStored, authority)).toBe(false);
  });

  it("an 'inferred' proposal never dominates a fact — both the trust arm and the ACL refuse", () => {
    const inferredIncoming = dominanceIncomingSchema.parse({
      source_trust: 'inferred',
      observed_at: '2026-06-02T10:00:00Z',
      source: 'agent',
    });
    expect(dominates(inferredIncoming, factsStored, authority)).toBe(false);
  });
});
