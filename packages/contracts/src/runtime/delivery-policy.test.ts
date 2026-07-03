// Owning ADR: ADR-0068 (canonical delivery-policy table — one typed table governs every
// proactive send: class × channel × budget × standalone × quiet-hours × collapse × priority).
// Invariants under test: the 10-member push-class enum in ADR order; the DeliveryPolicyRow shape;
// DELIVERY_POLICY as the single representation with per-class values pinned; the CURRENT block rule
// "every agent-reachable exempt class carries a non-null cap" (NOT the stale "agent_invocable ∩
// exempt = ∅"); TRIGGER_PUSH_CLASSES binding only proactive agent emitters; the widened admission
// with a stamp that cannot lie about its class's exemption/standalone.
// Failure modes caught: a dropped/renamed push class, a row whose budget/cap/priority drifts from
// the ADR table, a system (non-agent) class reachable from a trigger, an admission stamp claiming a
// false exemption, and the fetch_alert sliver drifting from its canonical DELIVERY_POLICY row.
import { describe, expect, it } from 'vitest';
import { channelNameSchema } from '../adapters/channel';
import { triggerTypeSchema } from '../core/trigger';
import {
  admissionSchema,
  agentReachableExemptHasCap,
  DAILY_PUSH_BUDGET,
  DELIVERY_POLICY,
  deliveryPolicyRowSchema,
  deliveryVerdictSchema,
  FETCH_ALERT_POLICY,
  fetchAlertPolicySchema,
  pushClassSchema,
  TRIGGER_PUSH_CLASSES,
} from './delivery-policy';

describe('deliveryVerdict', () => {
  it('is exactly the four verdicts, in order — no defer_next_day (current block drops it)', () => {
    expect(deliveryVerdictSchema.options).toEqual(['send', 'hold', 'degrade', 'drop']);
  });

  it('rejects the ADR-sketch defer_next_day verdict — dropped by the current block', () => {
    expect(deliveryVerdictSchema.safeParse('defer_next_day').success).toBe(false);
  });
});

describe('pushClass enum (ADR-0068)', () => {
  it('is exactly the ten push classes, in ADR table order', () => {
    expect(pushClassSchema.options).toEqual([
      'brief',
      'fetch_alert',
      'adjustment',
      'pre_activity_spot',
      'constellation_first',
      'constellation_update',
      'spot_digest',
      'intervention_knock',
      'sync_error',
      'system_consent',
    ]);
  });

  it('has grown past the fetch_alert-only literal it started as', () => {
    expect(pushClassSchema.safeParse('brief').success).toBe(true);
    expect(pushClassSchema.safeParse('system_consent').success).toBe(true);
    expect(pushClassSchema.safeParse('defer').success).toBe(false);
  });
});

describe('deliveryPolicyRow shape', () => {
  const base = DELIVERY_POLICY.fetch_alert;

  it('accepts a canonical row', () => {
    expect(deliveryPolicyRowSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an unknown key (strictObject)', () => {
    expect(deliveryPolicyRowSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it('rejects a priority outside 1..7', () => {
    expect(deliveryPolicyRowSchema.safeParse({ ...base, priority: 8 }).success).toBe(false);
    expect(deliveryPolicyRowSchema.safeParse({ ...base, priority: 0 }).success).toBe(false);
  });

  it('rejects a non-positive daily_cap and a budget outside the enum', () => {
    expect(deliveryPolicyRowSchema.safeParse({ ...base, daily_cap: 0 }).success).toBe(false);
    expect(deliveryPolicyRowSchema.safeParse({ ...base, budget: 'free' }).success).toBe(false);
  });

  it('requires a cooldown_scope in the class|event enum', () => {
    expect(deliveryPolicyRowSchema.safeParse({ ...base, cooldown_scope: undefined }).success).toBe(
      false,
    );
    expect(deliveryPolicyRowSchema.safeParse({ ...base, cooldown_scope: 'daily' }).success).toBe(
      false,
    );
  });

  it("rejects a sub-capped row whose 'proposed' sub-kind is uncapped — the spam surface must stay bounded", () => {
    const adj = DELIVERY_POLICY.adjustment;
    expect(deliveryPolicyRowSchema.safeParse(adj).success).toBe(true);
    expect(
      deliveryPolicyRowSchema.safeParse({
        ...adj,
        sub_caps: { proposed: { daily_cap: null, cooldown_min: 60 }, executed: adj.sub_caps!.executed },
      }).success,
    ).toBe(false);
  });
});

describe('DELIVERY_POLICY — the single representation', () => {
  it('carries a row for every push class', () => {
    expect(Object.keys(DELIVERY_POLICY).sort()).toEqual([...pushClassSchema.options].sort());
  });

  it('every row is a valid DeliveryPolicyRow', () => {
    for (const row of Object.values(DELIVERY_POLICY)) {
      expect(deliveryPolicyRowSchema.safeParse(row).success).toBe(true);
    }
  });

  // Golden rows — the canonical values a runtime reads. Pinned so a table edit is a visible diff.
  it('fetch_alert is the exempt-but-capped, P1, reserved-slot class (current block, not ADR row-43 "counted")', () => {
    expect(DELIVERY_POLICY.fetch_alert).toEqual({
      apns: true,
      telegram: true,
      feed: true,
      budget: 'exempt',
      exempt_after_h: null,
      is_standalone: false,
      quiet_hours: 'bypass_high_confidence',
      priority: 1,
      daily_cap: 3,
      cooldown_min: 120,
      cooldown_scope: 'class',
      agent_invocable: true,
      sub_caps: null,
    });
  });

  it('brief has no APNs leg, is counted (never decrements), and does not compete', () => {
    expect(DELIVERY_POLICY.brief.apns).toBe(false);
    expect(DELIVERY_POLICY.brief.budget).toBe('counted');
    expect(DELIVERY_POLICY.brief.priority).toBeNull();
    expect(DELIVERY_POLICY.brief.daily_cap).toBe(3);
  });

  it('adjustment caps live in sub_caps: proposed is capped (the ADR spam surface), executed is deliberately uncapped', () => {
    expect(DELIVERY_POLICY.adjustment.daily_cap).toBeNull();
    expect(DELIVERY_POLICY.adjustment.sub_caps).toEqual({
      proposed: { daily_cap: 3, cooldown_min: 60 },
      executed: { daily_cap: null, cooldown_min: null },
    });
  });

  it('system_consent is exempt with a null cap AND is not agent-invocable — the shape the invariant qualifier protects', () => {
    expect(DELIVERY_POLICY.system_consent.budget).toBe('exempt');
    expect(DELIVERY_POLICY.system_consent.daily_cap).toBeNull();
    expect(DELIVERY_POLICY.system_consent.agent_invocable).toBe(false);
  });

  it('sync_error escalates via exempt_after_h, not a gate special-case', () => {
    expect(DELIVERY_POLICY.sync_error.budget).toBe('counted');
    expect(DELIVERY_POLICY.sync_error.exempt_after_h).toBe(6);
  });
});

describe('cooldown_scope (ADR-0068 2026-06-27 ratified required field)', () => {
  it('the two event-scoped rows are exactly pre_activity_spot (per meeting) and sync_error (per connector)', () => {
    const eventScoped = pushClassSchema.options.filter(
      (c) => DELIVERY_POLICY[c].cooldown_scope === 'event',
    );
    expect(eventScoped.sort()).toEqual(['pre_activity_spot', 'sync_error']);
  });

  it('every other class is class-scoped', () => {
    for (const c of pushClassSchema.options) {
      if (c !== 'pre_activity_spot' && c !== 'sync_error') {
        expect(DELIVERY_POLICY[c].cooldown_scope).toBe('class');
      }
    }
  });
});

describe('block rule — every agent-reachable exempt class has a non-null cap (current, not stale ∅)', () => {
  it('holds across the whole table', () => {
    for (const row of Object.values(DELIVERY_POLICY)) {
      expect(agentReachableExemptHasCap(row)).toBe(true);
    }
  });

  it('has a real witness: fetch_alert is simultaneously agent-invocable, exempt, and capped', () => {
    // Non-vacuity: the stale "agent_invocable ∩ exempt = ∅" invariant would forbid this row. The
    // current rule permits it precisely because the cap exists.
    const f = DELIVERY_POLICY.fetch_alert;
    expect(f.agent_invocable && f.budget === 'exempt' && f.daily_cap !== null).toBe(true);
    expect(agentReachableExemptHasCap(f)).toBe(true);
  });

  it('the agent_invocable qualifier is load-bearing: system_consent is exempt with a null cap yet passes', () => {
    // If the invariant dropped the agent_invocable conjunct it would FAIL system_consent (exempt,
    // null cap). It passes only because system_consent is not agent-reachable — proving the
    // qualifier matters and the rule is not "every exempt class has a cap".
    const c = DELIVERY_POLICY.system_consent;
    expect(c.budget === 'exempt' && c.daily_cap === null).toBe(true);
    expect(c.agent_invocable).toBe(false);
    expect(agentReachableExemptHasCap(c)).toBe(true);
  });

  it('would flag a hypothetical agent-reachable exempt row with no cap', () => {
    expect(
      agentReachableExemptHasCap({ ...DELIVERY_POLICY.fetch_alert, daily_cap: null }),
    ).toBe(false);
  });
});

describe('TRIGGER_PUSH_CLASSES — proactive agent emitters only', () => {
  it('binds every trigger type', () => {
    expect(Object.keys(TRIGGER_PUSH_CLASSES).sort()).toEqual([...triggerTypeSchema.options].sort());
  });

  it('binds only agent-invocable classes — no system class is reachable from any trigger', () => {
    for (const classes of Object.values(TRIGGER_PUSH_CLASSES)) {
      for (const c of classes) {
        expect(DELIVERY_POLICY[c].agent_invocable).toBe(true);
      }
    }
  });

  it('the six non-agent-invocable classes appear in NO trigger binding', () => {
    const bound = new Set(Object.values(TRIGGER_PUSH_CLASSES).flat());
    for (const c of pushClassSchema.options) {
      if (!DELIVERY_POLICY[c].agent_invocable) {
        expect(bound.has(c)).toBe(false);
      }
    }
  });

  it('the agent classes bind to their emitters; adjustment to the proactive propose_schedule holders', () => {
    expect(TRIGGER_PUSH_CLASSES.brief).toEqual(['brief']);
    expect(TRIGGER_PUSH_CLASSES.fetch_alert).toEqual(['fetch_alert']);
    expect(TRIGGER_PUSH_CLASSES.handoff_act).toEqual(['adjustment']);
    expect(TRIGGER_PUSH_CLASSES.pre_activity_spot).toEqual(['pre_activity_spot', 'adjustment']);
  });

  it('user_message binds nothing — reactive conversations are out of the proactive gate (ADR-0068)', () => {
    // user_message holds propose_schedule + execute_action in its ACL, but it is a reactive
    // trigger; binding push classes to tool-ACL membership would wrongly let it emit adjustment.
    expect(TRIGGER_PUSH_CLASSES.user_message).toEqual([]);
  });
});

describe('tier caps', () => {
  it('Pro 3 / Pro Max 5, one integer apart (ADR-0016)', () => {
    expect(DAILY_PUSH_BUDGET).toEqual({ pro: 3, pro_max: 5 });
  });

  it('carries no fetch-reservation constant — the ghost-slot rule was retired at ratification', () => {
    // ADR-0068 2026-06-27: "the old ghost-slot / fetch-reservation rule is retired." fetch_alert is
    // now budget-exempt with its own class cap, so no reserved counted slot exists to encode.
    expect(DAILY_PUSH_BUDGET).not.toHaveProperty('fetch_reserved');
  });
});

describe('FETCH_ALERT_POLICY — the tracer sliver, single-sourced from DELIVERY_POLICY.fetch_alert', () => {
  it('is a valid, exempt, capped, cooled fetch policy', () => {
    expect(fetchAlertPolicySchema.safeParse(FETCH_ALERT_POLICY).success).toBe(true);
    expect(FETCH_ALERT_POLICY.budget_exempt).toBe(true);
    expect(FETCH_ALERT_POLICY.daily_cap).toBe(3);
    expect(FETCH_ALERT_POLICY.cooldown_min).toBe(120);
  });

  it('rejects a zero cap and a non-exempt policy', () => {
    expect(fetchAlertPolicySchema.safeParse({ ...FETCH_ALERT_POLICY, daily_cap: 0 }).success).toBe(
      false,
    );
    expect(
      fetchAlertPolicySchema.safeParse({ ...FETCH_ALERT_POLICY, budget_exempt: false }).success,
    ).toBe(false);
  });

  it('never drifts from its canonical DELIVERY_POLICY row', () => {
    // Two representations exist only because the tracer needs a non-null daily_cap for its `<`
    // comparison; this pins them together until SLICE-3 migrates the tracer to read the row directly.
    const row = DELIVERY_POLICY.fetch_alert;
    expect(FETCH_ALERT_POLICY.budget_exempt).toBe(row.budget === 'exempt');
    expect(FETCH_ALERT_POLICY.daily_cap).toBe(row.daily_cap);
    expect(FETCH_ALERT_POLICY.cooldown_min).toBe(row.cooldown_min);
  });
});

describe('admission — widened, with a stamp that cannot lie about its class', () => {
  const fetchStamp = { push_class: 'fetch_alert', is_standalone: false, budget_exempt: true } as const;

  it('accepts a well-formed fetch_alert admission with no channel legs yet (tracer shape)', () => {
    expect(admissionSchema.safeParse({ verdict: 'send', stamped: fetchStamp }).success).toBe(true);
  });

  it('accepts the widened fields: surviving channels, a collapse id, and a hold_until', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'hold',
        channels: ['apns', 'telegram', 'in_app'],
        collapse_id: 'stack',
        hold_until: '2026-07-03T22:00:00Z',
        stamped: fetchStamp,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown channel leg', () => {
    expect(
      admissionSchema.safeParse({ verdict: 'send', channels: ['sms'], stamped: fetchStamp }).success,
    ).toBe(false);
  });

  it('accepts a standalone system class stamp (constellation_first: standalone + exempt)', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        stamped: { push_class: 'constellation_first', is_standalone: true, budget_exempt: true },
      }).success,
    ).toBe(true);
  });

  it('rejects a stamp lying about exemption — fetch_alert stamped non-exempt', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: false },
      }).success,
    ).toBe(false);
  });

  it('rejects a stamp lying about standalone — a stacking class stamped standalone', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        stamped: { push_class: 'fetch_alert', is_standalone: true, budget_exempt: true },
      }).success,
    ).toBe(false);
  });
});
