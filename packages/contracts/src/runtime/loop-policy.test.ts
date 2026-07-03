import { describe, expect, it } from 'vitest';
import {
  LOOP_POLICIES,
  admissionVerdictSchema,
  admit,
  autonomyLevelSchema,
  killFlagScopeSchema,
  loopDispositionSchema,
  loopPolicySchema,
  loopTypeSchema,
  lookupLoopPolicy,
  priorityTierRank,
  priorityTierSchema,
  socketResidencySchema,
  type LoopPolicy,
} from './loop-policy';

// ADR-0074: governor admission is admit|deny, distinct from the ADR-0068 delivery verdict.
// Catches a drift that conflates the two seams (e.g. adding 'send'/'hold' to the governor).
describe('governor verdict', () => {
  it('is exactly admit | deny', () => {
    expect(admissionVerdictSchema.options).toEqual(['admit', 'deny']);
  });

  it('rejects a delivery verdict leaking into the governor seam', () => {
    expect(admissionVerdictSchema.safeParse('send').success).toBe(false);
    expect(admissionVerdictSchema.safeParse('defer').success).toBe(false);
  });
});

// ADR-0074 §Context: seven loops, and a loop is not a trigger. Catches a reintroduced
// triggerTypeSchema reuse (handoff_*/pre_brief_sweep/fetch_alert are triggers, never loop types).
describe('loop type', () => {
  it('is exactly the seven ADR-0074 loops', () => {
    expect(loopTypeSchema.options).toEqual([
      'fetch',
      'intervention',
      'pre_activity_spot',
      'brief',
      'patrol',
      'dreaming',
      'chat',
    ]);
  });

  it('rejects trigger types that are not loops', () => {
    expect(loopTypeSchema.safeParse('handoff_explore').success).toBe(false);
    expect(loopTypeSchema.safeParse('pre_brief_sweep').success).toBe(false);
    expect(loopTypeSchema.safeParse('fetch_alert').success).toBe(false);
  });
});

// ADR-0074 §Move1.1: acute-health-first arbiter precedence. The golden order fetch < intervention
// < pre_activity_spot < brief < routine is the whole point of the arbiter — this fails if a tier is
// reordered, renamed, or the two routine loops stop collapsing into 'routine'.
describe('priority arbiter', () => {
  it('is exactly the five ADR-0074 tiers', () => {
    expect(priorityTierSchema.options).toEqual([
      'fetch',
      'intervention',
      'pre_activity_spot',
      'brief',
      'routine',
    ]);
  });

  it('ranks acute-health-first, routine last (total order)', () => {
    expect(priorityTierRank).toEqual({
      fetch: 1,
      intervention: 2,
      pre_activity_spot: 3,
      brief: 4,
      routine: 5,
    });
    const ordered = [...priorityTierSchema.options].sort(
      (a, b) => priorityTierRank[a] - priorityTierRank[b],
    );
    expect(ordered).toEqual(['fetch', 'intervention', 'pre_activity_spot', 'brief', 'routine']);
  });

  it('has a rank for every tier and no extras', () => {
    expect(Object.keys(priorityTierRank).sort()).toEqual([...priorityTierSchema.options].sort());
  });
});

// ADR-0074 vocabulary enums pinned so a downstream producer cannot invent a scope/residency/level.
describe('governor enums', () => {
  it('kill scope is loop | global', () => {
    expect(killFlagScopeSchema.options).toEqual(['loop', 'global']);
  });

  it('socket residency is active-chat-only | none', () => {
    expect(socketResidencySchema.options).toEqual(['active-chat-only', 'none']);
  });

  it('autonomy ladder is L0..L3 (ADR-0074 §Move2)', () => {
    expect(autonomyLevelSchema.options).toEqual(['L0', 'L1', 'L2', 'L3']);
  });

  it('disposition is the four ADR-0074 §Move1.3 terminal states', () => {
    expect(loopDispositionSchema.options).toEqual([
      'converged',
      'couldnt_converge',
      'killed',
      'no_progress',
    ]);
  });
});

const validPolicy: LoopPolicy = {
  name: 'fetch',
  loop_type: 'fetch',
  priority_tier: 'fetch',
  max_tokens_per_run: 16_000,
  max_subagent_spawns_per_run: 0,
  max_iterations_per_run: 8,
  kill_flag_scope: 'loop',
  socket_residency: 'none',
  egress_gated: true,
  autonomy_level: 'L0',
  cooldown_min: 120,
};

// ADR-0074 §manifest: the 11-field LoopPolicy record. Catches a dropped field, an extra field
// (strict), a non-positive budget (an unbounded loop), or a bad enum member.
describe('loopPolicy manifest', () => {
  it('accepts a full valid policy', () => {
    expect(loopPolicySchema.safeParse(validPolicy).success).toBe(true);
  });

  it('rejects a missing manifest field', () => {
    const { priority_tier: _omit, ...missing } = validPolicy;
    expect(loopPolicySchema.safeParse(missing).success).toBe(false);
  });

  it('rejects an unknown field (strict — a misunderstood policy is not silently accepted)', () => {
    expect(loopPolicySchema.safeParse({ ...validPolicy, admit: true }).success).toBe(false);
  });

  it('rejects a non-positive per-run budget — an unbounded loop must not validate', () => {
    expect(loopPolicySchema.safeParse({ ...validPolicy, max_tokens_per_run: 0 }).success).toBe(
      false,
    );
    expect(
      loopPolicySchema.safeParse({ ...validPolicy, max_iterations_per_run: 0 }).success,
    ).toBe(false);
  });

  it('rejects an out-of-domain enum value', () => {
    expect(loopPolicySchema.safeParse({ ...validPolicy, autonomy_level: 'L4' }).success).toBe(
      false,
    );
    expect(loopPolicySchema.safeParse({ ...validPolicy, priority_tier: 'chat' }).success).toBe(
      false,
    );
  });
});

// The registry is the source of truth the runtime Governor reads. Each entry must be a real,
// schema-valid policy (non-vacuous), and its key must match its own loop_type.
describe('LOOP_POLICIES registry', () => {
  it('every registered entry is a valid policy whose key matches its loop_type', () => {
    for (const [key, policy] of Object.entries(LOOP_POLICIES)) {
      expect(loopPolicySchema.safeParse(policy).success).toBe(true);
      expect(policy?.loop_type).toBe(key);
    }
  });

  it('collapses the two routine loops into the routine tier', () => {
    expect(LOOP_POLICIES.patrol?.priority_tier).toBe('routine');
    expect(LOOP_POLICIES.dreaming?.priority_tier).toBe('routine');
  });

  it('registers the six proactive loops but leaves chat an open decision', () => {
    expect(Object.keys(LOOP_POLICIES).sort()).toEqual([
      'brief',
      'dreaming',
      'fetch',
      'intervention',
      'patrol',
      'pre_activity_spot',
    ]);
    expect('chat' in LOOP_POLICIES).toBe(false);
  });
});

// ADR-0074 §null: a loop with no LoopPolicy is denied — fail-closed, no unbounded loop ships.
// This is the load-bearing safety invariant of the whole seam.
describe('fail-closed admission', () => {
  it('denies a null policy', () => {
    expect(admit(null)).toBe('deny');
  });

  it('admits a registered loop', () => {
    expect(admit(lookupLoopPolicy('fetch'))).toBe('admit');
  });

  it('denies an unregistered / open-decision loop (chat) fail-closed', () => {
    expect(lookupLoopPolicy('chat')).toBeNull();
    expect(admit(lookupLoopPolicy('chat'))).toBe('deny');
  });
});
