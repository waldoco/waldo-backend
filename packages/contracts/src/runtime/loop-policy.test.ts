import { describe, expect, it } from 'vitest';
import {
  LOOP_POLICIES,
  admissionVerdictSchema,
  admit,
  autonomyLevelSchema,
  killFlagScopeSchema,
  isNoProgress,
  loopDispositionSchema,
  loopInvocationSchema,
  loopKillFlagSchema,
  loopPolicySchema,
  loopProgressRowSchema,
  loopToolObservationSchema,
  loopTypeSchema,
  lookupLoopPolicy,
  outboundTextPassesArt9Floor,
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

  it('registers the six proactive loops and the bounded active-chat lane', () => {
    expect(Object.keys(LOOP_POLICIES).sort()).toEqual([
      'brief',
      'chat',
      'dreaming',
      'fetch',
      'intervention',
      'patrol',
      'pre_activity_spot',
    ]);
    expect(LOOP_POLICIES.chat).toEqual({
      name: 'chat',
      loop_type: 'chat',
      priority_tier: 'routine',
      max_tokens_per_run: 12_000,
      max_subagent_spawns_per_run: 0,
      max_iterations_per_run: 3,
      kill_flag_scope: 'loop',
      socket_residency: 'active-chat-only',
      egress_gated: true,
      autonomy_level: 'L0',
      cooldown_min: 0,
    });
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

  it('admits the bounded chat policy through the same Governor contract', () => {
    expect(admit(lookupLoopPolicy('chat'))).toBe('admit');
  });
});

describe('loop progress no-progress guard', () => {
  it('accepts bounded progress counters and rejects impossible counts', () => {
    expect(
      loopProgressRowSchema.safeParse({
        loop_name: 'patrol',
        occurrence_id: 'occ-1',
        call_count: 10,
        unique_param_hashes: 2,
        successes: 1,
        updated_at: 1_000,
      }).success,
    ).toBe(true);
    expect(
      loopProgressRowSchema.safeParse({
        loop_name: 'patrol',
        occurrence_id: 'occ-1',
        call_count: 1,
        unique_param_hashes: 2,
        successes: 0,
        updated_at: 1_000,
      }).success,
    ).toBe(false);
  });

  it('requires low diversity and low success before declaring no progress', () => {
    const stuck = {
      loop_name: 'patrol',
      occurrence_id: 'occ-1',
      call_count: 10,
      unique_param_hashes: 1,
      successes: 0,
      updated_at: 1_000,
    };
    expect(isNoProgress(stuck, 0.2, 0.2)).toBe(true);
    expect(isNoProgress({ ...stuck, successes: 8 }, 0.2, 0.2)).toBe(false);
    expect(isNoProgress({ ...stuck, unique_param_hashes: 8 }, 0.2, 0.2)).toBe(false);
  });
});

describe('loop tool observation and kill flag', () => {
  const hash = 'a'.repeat(64);

  it('accepts SHA-256 observation hashes', () => {
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'read_memory',
        canonical_params_hash: hash,
        result_hash: hash,
      }).success,
    ).toBe(true);
  });

  it('rejects bad hashes and unknown tools', () => {
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'read_memory',
        canonical_params_hash: 'x',
        result_hash: hash,
      }).success,
    ).toBe(false);
    expect(
      loopToolObservationSchema.safeParse({
        tool_name: 'made_up_tool',
        canonical_params_hash: hash,
        result_hash: hash,
      }).success,
    ).toBe(false);
  });

  it('accepts loop and global kill flags', () => {
    expect(
      loopKillFlagSchema.safeParse({
        scope: 'global',
        loop_name: null,
        active: true,
        updated_at: 1_000,
      }).success,
    ).toBe(true);
  });
});

describe('outbound Art-9 floor', () => {
  it('blocks current-main raw health value families before external delivery', () => {
    expect(outboundTextPassesArt9Floor('HRV 42 and slept 5.5h')).toBe(false);
    expect(outboundTextPassesArt9Floor('heart rate: 110 bpm')).toBe(false);
    expect(outboundTextPassesArt9Floor('body_weight: "82"')).toBe(false);
    expect(outboundTextPassesArt9Floor('blood pressure 140/90')).toBe(false);
    expect(outboundTextPassesArt9Floor('active_energy_kcal: 450')).toBe(false);
  });

  it('allows zone-word summaries', () => {
    expect(outboundTextPassesArt9Floor('Recovery looks compromised; keep the morning quiet.')).toBe(
      true,
    );
  });
});

describe('loopInvocation', () => {
  it('binds loop execution to an existing trigger and occurrence id', () => {
    expect(
      loopInvocationSchema.safeParse({
        trigger: 'fetch_alert',
        loop_name: 'fetch-loop',
        occurrence_id: 'occ-1',
      }).success,
    ).toBe(true);
  });
});
