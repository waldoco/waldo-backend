// Owning ADR: ADR-0068. The implementation-facing current-decision block supersedes the
// pre-ratification body: fetch is exempt-but-counted, defer_next_day is deleted, adjustment
// proposed/executed caps are sub-kind-aware, and proactive trigger bindings are not tool ACLs.
import { describe, expect, it } from 'vitest';
import { channelNameSchema } from '../adapters/channel';
import { triggerTypeSchema } from '../core/trigger';
import {
  admissionSchema,
  agentReachableExemptHasCap,
  DAILY_PUSH_BUDGET,
  DELIVERY_POLICY,
  deliveryCandidateSchema,
  deliveryGateReasonSchema,
  deliveryPolicyRowSchema,
  deliveryVerdictSchema,
  FETCH_ALERT_POLICY,
  fetchAlertPolicySchema,
  heldCandidateSchema,
  pushClassSchema,
  TRIGGER_PUSH_CLASSES,
} from './delivery-policy';

describe('deliveryVerdict', () => {
  it('is exactly the four ratified verdicts, with no defer_next_day', () => {
    expect(deliveryVerdictSchema.options).toEqual(['send', 'hold', 'degrade', 'drop']);
    expect(deliveryVerdictSchema.safeParse('defer_next_day').success).toBe(false);
  });

  it('uses a closed reason vocabulary for every non-send gate verdict', () => {
    expect(deliveryGateReasonSchema.options).toEqual([
      'candidate_expired',
      'class_cap_exhausted',
      'cooldown_active',
      'budget_cap_exhausted',
      'once_ever_already_sent',
    ]);
    expect(deliveryGateReasonSchema.safeParse('quiet maybe').success).toBe(false);
  });
});

describe('pushClass enum', () => {
  it('pins the ten ADR-0068 push classes in table order', () => {
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
});

describe('deliveryPolicyRow shape', () => {
  const fetch = DELIVERY_POLICY.fetch_alert;

  it('accepts a canonical row and rejects unknown keys', () => {
    expect(deliveryPolicyRowSchema.safeParse(fetch).success).toBe(true);
    expect(deliveryPolicyRowSchema.safeParse({ ...fetch, push_class: 'fetch_alert' }).success).toBe(
      false,
    );
  });

  it('makes cap scope explicit instead of inferring lifetime behavior from a class name', () => {
    expect(
      deliveryPolicyRowSchema.safeParse({ ...fetch, cap_scope: 'utc_day' }).success,
    ).toBe(true);
    expect(
      deliveryPolicyRowSchema.safeParse({ ...fetch, cap_scope: 'lifetime' }).success,
    ).toBe(true);
    expect(
      deliveryPolicyRowSchema.safeParse({ ...fetch, cap_scope: 'lifetime', daily_cap: null })
        .success,
    ).toBe(false);
    expect(
      deliveryPolicyRowSchema.safeParse({ ...fetch, cap_scope: 'calendar_week' }).success,
    ).toBe(false);
  });

  it('defaults a legacy row without cap scope to the daily authority', () => {
    const { cap_scope: _capScope, ...legacyFetch } = fetch;

    expect(deliveryPolicyRowSchema.parse(legacyFetch).cap_scope).toBe('utc_day');
  });

  it('pins budget, quiet-hours, priority, and cooldown vocabularies', () => {
    expect(deliveryPolicyRowSchema.safeParse({ ...fetch, budget: 'free' }).success).toBe(false);
    expect(deliveryPolicyRowSchema.safeParse({ ...fetch, quiet_hours: 'allow' }).success).toBe(
      false,
    );
    expect(deliveryPolicyRowSchema.safeParse({ ...fetch, priority: 8 }).success).toBe(false);
    expect(deliveryPolicyRowSchema.safeParse({ ...fetch, cooldown_scope: 'daily' }).success).toBe(
      false,
    );
  });

  it("requires proposed adjustment sub-caps to stay bounded", () => {
    const adjustment = DELIVERY_POLICY.adjustment;
    expect(adjustment.sub_caps).not.toBeNull();
    expect(
      deliveryPolicyRowSchema.safeParse({
        ...adjustment,
        sub_caps: {
          proposed: { daily_cap: null, cooldown_min: 60 },
          executed: adjustment.sub_caps?.executed,
        },
      }).success,
    ).toBe(false);
  });
});

describe('DELIVERY_POLICY', () => {
  it('covers every push class exactly once and every row parses', () => {
    expect(Object.keys(DELIVERY_POLICY).sort()).toEqual([...pushClassSchema.options].sort());
    for (const row of Object.values(DELIVERY_POLICY)) {
      expect(deliveryPolicyRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('pins fetch_alert as exempt-but-counted with its own cap and cooldown', () => {
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
      cap_scope: 'utc_day',
      cooldown_min: 120,
      cooldown_scope: 'class',
      agent_invocable: true,
      sub_caps: null,
    });
    expect(agentReachableExemptHasCap(DELIVERY_POLICY.fetch_alert)).toBe(true);
  });

  it('pins brief as never-APNs and counted without decrementing APNs spend', () => {
    expect(DELIVERY_POLICY.brief.apns).toBe(false);
    expect(DELIVERY_POLICY.brief.budget).toBe('counted');
    expect(DELIVERY_POLICY.brief.priority).toBeNull();
    expect(DELIVERY_POLICY.brief.daily_cap).toBe(3);
  });

  it('models adjustment sub-kinds: proposed capped, executed uncapped', () => {
    expect(DELIVERY_POLICY.adjustment.daily_cap).toBeNull();
    expect(DELIVERY_POLICY.adjustment.sub_caps).toEqual({
      proposed: { daily_cap: 3, cooldown_min: 60 },
      executed: { daily_cap: null, cooldown_min: null },
    });
  });

  it('keeps system_consent exempt with no cap because it is not agent-invocable', () => {
    expect(DELIVERY_POLICY.system_consent.budget).toBe('exempt');
    expect(DELIVERY_POLICY.system_consent.daily_cap).toBeNull();
    expect(DELIVERY_POLICY.system_consent.agent_invocable).toBe(false);
    expect(agentReachableExemptHasCap(DELIVERY_POLICY.system_consent)).toBe(true);
  });

  it('declares constellation_first as the single lifetime-capped class', () => {
    for (const [pushClass, policy] of Object.entries(DELIVERY_POLICY)) {
      expect(policy.cap_scope).toBe(pushClass === 'constellation_first' ? 'lifetime' : 'utc_day');
    }
  });

  it('carries sync_error escalation as row data', () => {
    expect(DELIVERY_POLICY.sync_error.budget).toBe('counted');
    expect(DELIVERY_POLICY.sync_error.exempt_after_h).toBe(6);
    expect(DELIVERY_POLICY.sync_error.cooldown_scope).toBe('event');
  });
});

describe('cooldown_scope', () => {
  it('keeps exactly pre_activity_spot and sync_error event-scoped', () => {
    const eventScoped = pushClassSchema.options.filter(
      (pushClass) => DELIVERY_POLICY[pushClass].cooldown_scope === 'event',
    );
    expect(eventScoped.sort()).toEqual(['pre_activity_spot', 'sync_error']);
  });
});

describe('block rule — every agent-reachable exempt class has a positive cap', () => {
  it('holds across the whole table', () => {
    for (const row of Object.values(DELIVERY_POLICY)) {
      expect(agentReachableExemptHasCap(row)).toBe(true);
    }
  });

  it('would reject an agent-reachable exempt row with no cap', () => {
    expect(agentReachableExemptHasCap({ ...DELIVERY_POLICY.fetch_alert, daily_cap: null })).toBe(
      false,
    );
  });
});

describe('TRIGGER_PUSH_CLASSES', () => {
  it('covers every trigger type', () => {
    expect(Object.keys(TRIGGER_PUSH_CLASSES).sort()).toEqual([...triggerTypeSchema.options].sort());
  });

  it('binds only agent-invocable classes and no system classes', () => {
    for (const pushClass of Object.values(TRIGGER_PUSH_CLASSES).flat()) {
      expect(DELIVERY_POLICY[pushClass].agent_invocable).toBe(true);
    }
  });

  it('treats user_message as reactive, outside the proactive delivery gate', () => {
    expect(TRIGGER_PUSH_CLASSES.user_message).toEqual([]);
  });

  it('binds adjustment only to proactive adjustment emitters', () => {
    expect(TRIGGER_PUSH_CLASSES.handoff_act).toEqual(['adjustment']);
    expect(TRIGGER_PUSH_CLASSES.pre_activity_spot).toEqual(['pre_activity_spot', 'adjustment']);
  });
});

describe('tier caps', () => {
  it('pins Pro to 3 and Pro Max to 5, with no fetch-reservation constant', () => {
    expect(DAILY_PUSH_BUDGET).toEqual({ pro: 3, pro_max: 5 });
    expect(DAILY_PUSH_BUDGET).not.toHaveProperty('fetch_reserved');
  });
});

describe('FETCH_ALERT_POLICY tracer sliver', () => {
  it('is valid and does not drift from DELIVERY_POLICY.fetch_alert', () => {
    expect(fetchAlertPolicySchema.safeParse(FETCH_ALERT_POLICY).success).toBe(true);
    expect(FETCH_ALERT_POLICY.budget_exempt).toBe(DELIVERY_POLICY.fetch_alert.budget === 'exempt');
    expect(FETCH_ALERT_POLICY.daily_cap).toBe(DELIVERY_POLICY.fetch_alert.daily_cap);
    expect(FETCH_ALERT_POLICY.cooldown_min).toBe(DELIVERY_POLICY.fetch_alert.cooldown_min);
  });
});

describe('deliveryCandidate', () => {
  it('accepts the gate-owned candidate envelope and rejects content', () => {
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        confidence: 0.81,
        expires_at: 2_000,
      }).success,
    ).toBe(true);
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        body: 'send this',
      }).success,
    ).toBe(false);
  });

  it('requires sub_kind only for adjustment candidates', () => {
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'adjustment',
        trigger: 'handoff_act',
        event_id: 'adjustment-1',
        sub_kind: 'proposed',
      }).success,
    ).toBe(true);
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'adjustment',
        trigger: 'handoff_act',
        event_id: 'adjustment-1',
      }).success,
    ).toBe(false);
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        sub_kind: 'proposed',
      }).success,
    ).toBe(false);
  });
});

describe('admission', () => {
  it('accepts a well-formed exempt admission stamp', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        reason: null,
        channels: ['apns', 'telegram', 'in_app'],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: {
          push_class: 'fetch_alert',
          is_standalone: false,
          budget_exempt: true,
          expires_at: null,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects budget charge on an exempt class and stamp lies', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        reason: null,
        channels: ['apns'],
        collapse_id: 'stack',
        budget_charged: true,
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: true },
      }).success,
    ).toBe(false);
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        reason: null,
        channels: ['apns'],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: false },
      }).success,
    ).toBe(false);
  });

  it('requires hold_until for held admissions and valid channel names', () => {
    expect(channelNameSchema.safeParse('in_app').success).toBe(true);
    expect(
      admissionSchema.safeParse({
        verdict: 'hold',
        reason: 'cooldown_active',
        channels: [],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: { push_class: 'adjustment', is_standalone: false, budget_exempt: false },
      }).success,
    ).toBe(false);
  });

  it('requires reasons for non-send admissions and forbids reasons on sends', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'degrade',
        reason: 'budget_cap_exhausted',
        channels: ['telegram', 'in_app'],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: { push_class: 'pre_activity_spot', is_standalone: false, budget_exempt: false },
      }).success,
    ).toBe(true);
    expect(
      admissionSchema.safeParse({
        verdict: 'drop',
        reason: null,
        channels: [],
        collapse_id: null,
        budget_charged: false,
        stamped: { push_class: 'constellation_first', is_standalone: true, budget_exempt: true },
      }).success,
    ).toBe(false);
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        reason: 'cooldown_active',
        channels: ['apns'],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: true },
      }).success,
    ).toBe(false);
  });
});

describe('heldCandidate', () => {
  it('stores the idempotent re-admission payload with hold and expiry times', () => {
    expect(
      heldCandidateSchema.safeParse({
        event_id: 'spot-1',
        push_class: 'pre_activity_spot',
        candidate: {
          push_class: 'pre_activity_spot',
          trigger: 'pre_activity_spot',
          event_id: 'spot-1',
          expires_at: 2_000,
        },
        hold_until: 1_500,
        expires_at: 2_000,
      }).success,
    ).toBe(true);
  });

  it('rejects a held row whose class disagrees with its frozen candidate', () => {
    expect(
      heldCandidateSchema.safeParse({
        event_id: 'spot-1',
        push_class: 'adjustment',
        candidate: {
          push_class: 'pre_activity_spot',
          trigger: 'pre_activity_spot',
          event_id: 'spot-1',
        },
        hold_until: 1_500,
        expires_at: null,
      }).success,
    ).toBe(false);
  });
});
