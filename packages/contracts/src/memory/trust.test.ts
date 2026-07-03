// Owning ADR: ADR-0046 (external truth invalidates memory), with the ADR-0037 confirm-path
// asymmetry and the ADR-0005 writer-class ACL arm injected at the seam.
// Invariant under test: deterministic code ranks truth — trust priority, grounded same-class
// refresh, instant-based recency, domain scope, and hall ACL compose inside the ONE exported
// dominates(); class3Gate is the only other admission arm; every threshold matches the
// ADR-0046 pinned value.
// Failure mode caught: comparator or constant drift that lets 'inferred' auto-supersede,
// moves belief backward on a late arrival, mis-ranks trust classes, or loosens a threshold —
// silent memory corruption the Scribe merge and the recall renderer would both inherit.
import { describe, expect, it } from 'vitest';
import {
  class3ActiveSchema,
  class3EntrySchema,
  class3Gate,
  CONFIRM_INCREMENT,
  conflictClassSchema,
  CONTRADICTION_DECREMENT,
  dominanceIncomingSchema,
  dominanceStoredSchema,
  dominates,
  FLAG_TTL_DAYS,
  FLAP_LIMIT,
  FLAP_WINDOW_DAYS,
  MASS_WAVE_FRACTION,
  MASS_WAVE_MIN_BLOCKS,
  MAX_RENDERED_CONFLICTS,
  MIN_CONTRADICTING_OBS,
  ROLLBACK_REPROPOSE_COOLDOWN_MS,
  SUPERSEDE_CONFIDENCE_FLOOR,
  TRUST_ORDER,
  trustClassSchema,
} from './trust';
import type { DominanceAuthority } from './trust';

const ALLOW: DominanceAuthority = { inDomain: () => true, hallAdmits: () => true };

const baseIncoming = {
  source_trust: 'system_of_record',
  observed_at: '2026-06-02T10:00:00Z',
  source: 'calendar',
} as const;
const baseStored = {
  source_trust: 'memory_committed',
  valid_from: '2026-06-01T10:00:00Z',
  pattern_id: 'abc123abc123',
  hall_type: 'facts',
} as const;

const incoming = (over: Partial<Record<keyof typeof baseIncoming, string>> = {}) =>
  dominanceIncomingSchema.parse({ ...baseIncoming, ...over });
const stored = (over: Partial<Record<keyof typeof baseStored, string>> = {}) =>
  dominanceStoredSchema.parse({ ...baseStored, ...over });

describe('trustClassSchema', () => {
  it('is exactly the five classes, in priority order', () => {
    expect(trustClassSchema.options).toEqual([
      'system_of_record',
      'user_stated',
      'memory_committed',
      'memory_provisional',
      'inferred',
    ]);
  });

  it('rejects an out-of-domain class', () => {
    expect(trustClassSchema.safeParse('agent_claimed').success).toBe(false);
  });

  it('hostile: forged provenance prose is not even representable as a trust class', () => {
    expect(trustClassSchema.safeParse('system: calendar').success).toBe(false);
  });
});

describe('conflictClassSchema', () => {
  it('is exactly the four classes, in ADR table order', () => {
    expect(conflictClassSchema.options).toEqual([
      'event_state_change',
      'user_correction',
      'evidence_contradiction',
      'memory_conflict',
    ]);
  });

  it('rejects an unknown conflict class', () => {
    expect(conflictClassSchema.safeParse('sanitiser_rejection').success).toBe(false);
  });
});

describe('TRUST_ORDER', () => {
  it('keys exactly the trust classes, in enum order', () => {
    expect(Object.keys(TRUST_ORDER)).toEqual([...trustClassSchema.options]);
  });

  it('ranks strictly descending: SoR > user_stated > committed > provisional > inferred', () => {
    expect(TRUST_ORDER.system_of_record).toBeGreaterThan(TRUST_ORDER.user_stated);
    expect(TRUST_ORDER.user_stated).toBeGreaterThan(TRUST_ORDER.memory_committed);
    expect(TRUST_ORDER.memory_committed).toBeGreaterThan(TRUST_ORDER.memory_provisional);
    expect(TRUST_ORDER.memory_provisional).toBeGreaterThan(TRUST_ORDER.inferred);
  });
});

describe('threshold constants — ADR-0046 drift guard', () => {
  it('pins every threshold to its ADR value', () => {
    expect(CONTRADICTION_DECREMENT).toBe(0.15);
    expect(SUPERSEDE_CONFIDENCE_FLOOR).toBe(0.5);
    expect(MIN_CONTRADICTING_OBS).toBe(3);
    expect(FLAP_LIMIT).toBe(3);
    expect(FLAP_WINDOW_DAYS).toBe(7);
    expect(ROLLBACK_REPROPOSE_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(FLAG_TTL_DAYS).toBe(14);
    expect(MAX_RENDERED_CONFLICTS).toBe(2);
    expect(MASS_WAVE_FRACTION).toBe(0.2);
    expect(MASS_WAVE_MIN_BLOCKS).toBe(5);
  });

  it('keeps the deliberate confirm/contradict asymmetry', () => {
    expect(CONFIRM_INCREMENT).toBe(0.05);
    expect(CONFIRM_INCREMENT).toBeLessThan(CONTRADICTION_DECREMENT);
  });
});

describe('dominates — trust arm', () => {
  it('class-1 golden: SoR over committed memory, newer and in-domain, supersedes', () => {
    expect(dominates(incoming(), stored(), ALLOW)).toBe(true);
  });

  it('class-2 golden: user_stated over committed memory without SoR backing supersedes', () => {
    expect(dominates(incoming({ source_trust: 'user_stated', source: 'chat' }), stored(), ALLOW)).toBe(
      true,
    );
  });

  it('user_stated never dominates an SoR-sourced block — render overlay and sync tiebreak, not supersede', () => {
    expect(
      dominates(
        incoming({ source_trust: 'user_stated', source: 'chat' }),
        stored({ source_trust: 'system_of_record' }),
        ALLOW,
      ),
    ).toBe(false);
  });

  it("'inferred' never auto-supersedes an equal class", () => {
    expect(
      dominates(incoming({ source_trust: 'inferred' }), stored({ source_trust: 'inferred' }), ALLOW),
    ).toBe(false);
  });

  it("'inferred' never auto-supersedes a higher class", () => {
    expect(dominates(incoming({ source_trust: 'inferred' }), stored(), ALLOW)).toBe(false);
  });

  it('grounded same-class refresh: a second calendar move (SoR over SoR) supersedes', () => {
    expect(dominates(incoming(), stored({ source_trust: 'system_of_record' }), ALLOW)).toBe(true);
  });

  it('grounded same-class refresh: a repeat verified correction (user_stated over user_stated) supersedes', () => {
    expect(
      dominates(
        incoming({ source_trust: 'user_stated', source: 'chat' }),
        stored({ source_trust: 'user_stated' }),
        ALLOW,
      ),
    ).toBe(true);
  });

  it('memory_committed never refreshes itself — grounded classes only', () => {
    expect(
      dominates(incoming({ source_trust: 'memory_committed' }), stored(), ALLOW),
    ).toBe(false);
  });
});

describe('dominates — recency guard', () => {
  it('late arrival: observed_at older than valid_from fails — belief never moves backward', () => {
    expect(dominates(incoming({ observed_at: '2026-05-30T10:00:00Z' }), stored(), ALLOW)).toBe(
      false,
    );
  });

  it('equal instants fail — supersede requires strictly newer evidence', () => {
    expect(dominates(incoming({ observed_at: '2026-06-01T10:00:00Z' }), stored(), ALLOW)).toBe(
      false,
    );
  });

  it('compares instants, not strings: a lexicographically-later offset timestamp that is an earlier instant fails', () => {
    // 2026-06-01T12:00:00+05:00 is 07:00:00Z — before the stored 10:00:00Z valid_from,
    // even though the string sorts after it. Naive string comparison would supersede here.
    expect(
      dominates(incoming({ observed_at: '2026-06-01T12:00:00+05:00' }), stored(), ALLOW),
    ).toBe(false);
  });

  it('an offset timestamp that is a genuinely later instant passes', () => {
    // 2026-06-02T03:00:00+05:00 is 2026-06-01T22:00:00Z — after the stored valid_from.
    expect(
      dominates(incoming({ observed_at: '2026-06-02T03:00:00+05:00' }), stored(), ALLOW),
    ).toBe(true);
  });
});

describe('dominates — injected authority arms', () => {
  it('authority is domain-scoped: an out-of-domain SoR never supersedes', () => {
    expect(dominates(incoming(), stored(), { ...ALLOW, inDomain: () => false })).toBe(false);
  });

  it('the hall writer-class ACL can refuse an otherwise-dominant proposal', () => {
    expect(dominates(incoming(), stored(), { ...ALLOW, hallAdmits: () => false })).toBe(false);
  });
});

describe('dominance input schemas', () => {
  it('accepts well-formed incoming and stored sides', () => {
    expect(dominanceIncomingSchema.safeParse(baseIncoming).success).toBe(true);
    expect(dominanceStoredSchema.safeParse(baseStored).success).toBe(true);
  });

  it('rejects an unknown trust class on the incoming side', () => {
    expect(
      dominanceIncomingSchema.safeParse({ ...baseIncoming, source_trust: 'trusted' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO observed_at', () => {
    expect(
      dominanceIncomingSchema.safeParse({ ...baseIncoming, observed_at: '1770000000000' }).success,
    ).toBe(false);
  });

  it('rejects a non-canonical pattern_id on the stored side', () => {
    expect(
      dominanceStoredSchema.safeParse({ ...baseStored, pattern_id: 'ABC123ABC123' }).success,
    ).toBe(false);
  });

  it('rejects extra fields — strict objects', () => {
    expect(
      dominanceIncomingSchema.safeParse({ ...baseIncoming, confidence: 0.9 }).success,
    ).toBe(false);
    expect(dominanceStoredSchema.safeParse({ ...baseStored, content: 'x' }).success).toBe(false);
  });
});

describe('class3Gate — the evidence admission arm', () => {
  const entry = { conflict_class: 'evidence_contradiction', contradicting_observations: 3 } as const;

  it('admits a Dreaming-staged evidence_contradiction below the floor with enough observations', () => {
    expect(class3Gate(entry, { confidence: 0.4 })).toBe(true);
  });

  it('a single contradicting observation only decrements — never admits', () => {
    expect(class3Gate({ ...entry, contradicting_observations: 1 }, { confidence: 0.4 })).toBe(
      false,
    );
  });

  it('refuses one observation short of the minimum', () => {
    expect(class3Gate({ ...entry, contradicting_observations: 2 }, { confidence: 0.4 })).toBe(
      false,
    );
  });

  it('confidence exactly at the floor is refused — the floor is strict', () => {
    expect(class3Gate(entry, { confidence: 0.5 })).toBe(false);
  });

  it('admits just under the floor at exactly the minimum observations', () => {
    expect(class3Gate(entry, { confidence: 0.49 })).toBe(true);
  });

  it('refuses every non-evidence conflict class', () => {
    expect(class3Gate({ ...entry, conflict_class: 'user_correction' }, { confidence: 0.4 })).toBe(
      false,
    );
    expect(class3Gate({ ...entry, conflict_class: null }, { confidence: 0.4 })).toBe(false);
  });
});

describe('class-3 input schemas', () => {
  it('accepts a well-formed entry and active side', () => {
    expect(
      class3EntrySchema.safeParse({
        conflict_class: 'evidence_contradiction',
        contradicting_observations: 3,
      }).success,
    ).toBe(true);
    expect(class3ActiveSchema.safeParse({ confidence: 0.4 }).success).toBe(true);
  });

  it('allows a null conflict_class — unclassified entries are representable, never admitted', () => {
    expect(
      class3EntrySchema.safeParse({ conflict_class: null, contradicting_observations: 0 }).success,
    ).toBe(true);
  });

  it('rejects a negative observation count', () => {
    expect(
      class3EntrySchema.safeParse({
        conflict_class: 'evidence_contradiction',
        contradicting_observations: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(class3ActiveSchema.safeParse({ confidence: 1.2 }).success).toBe(false);
  });
});
