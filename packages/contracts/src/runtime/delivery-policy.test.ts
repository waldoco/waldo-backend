import { describe, expect, it } from 'vitest';
import {
  admissionSchema,
  agentReachableExemptHasCap,
  DAILY_PUSH_BUDGET,
  DELIVERY_POLICY,
  deliveryBudgetTierSchema,
  deliveryCandidateSchema,
  deliveryPolicyRowSchema,
  deliveryVerdictSchema,
  FETCH_ALERT_POLICY,
  fetchAlertPolicySchema,
  heldCandidateSchema,
  pushClassSchema,
  TRIGGER_PUSH_CLASSES,
  triggerPushClassesSchema,
} from './delivery-policy';
import { triggerTypeSchema } from '../core/trigger';

describe('deliveryVerdict', () => {
  it('is exactly the four ratified verdicts, with no defer_next_day', () => {
    expect(deliveryVerdictSchema.options).toEqual(['send', 'hold', 'degrade', 'drop']);
    expect(deliveryVerdictSchema.safeParse('defer_next_day').success).toBe(false);
  });
});

describe('pushClass', () => {
  it('pins the ADR-0068 proactive classes in order', () => {
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

describe('DELIVERY_POLICY', () => {
  it('covers every push class exactly once and every row parses', () => {
    expect(Object.keys(DELIVERY_POLICY).sort()).toEqual([...pushClassSchema.options].sort());
    for (const row of Object.values(DELIVERY_POLICY)) {
      expect(deliveryPolicyRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('pins fetch_alert as exempt-but-class-capped and telemetry-counted', () => {
    expect(fetchAlertPolicySchema.safeParse(FETCH_ALERT_POLICY).success).toBe(true);
    expect(DELIVERY_POLICY.fetch_alert.budget_exempt).toBe(true);
    expect(DELIVERY_POLICY.fetch_alert.counts_apns_budget).toBe(false);
    expect(DELIVERY_POLICY.fetch_alert.class_cap_per_day).toBe(3);
    expect(DELIVERY_POLICY.fetch_alert.cooldown_min).toBe(120);
    expect(agentReachableExemptHasCap(DELIVERY_POLICY.fetch_alert)).toBe(true);
  });

  it('pins brief as never-APNs, while pre_activity_spot counts against budget', () => {
    expect(DELIVERY_POLICY.brief.apns).toBe(false);
    expect(DELIVERY_POLICY.brief.counts_apns_budget).toBe(false);
    expect(DELIVERY_POLICY.pre_activity_spot.apns).toBe(true);
    expect(DELIVERY_POLICY.pre_activity_spot.counts_apns_budget).toBe(true);
  });

  it('keeps system classes out of agent invocation', () => {
    for (const cls of [
      'constellation_first',
      'constellation_update',
      'spot_digest',
      'intervention_knock',
      'sync_error',
      'system_consent',
    ] as const) {
      expect(DELIVERY_POLICY[cls].agent_invocable).toBe(false);
    }
  });

  it('rejects an exempt row that tries to decrement the counted APNs budget', () => {
    expect(
      deliveryPolicyRowSchema.safeParse({
        ...DELIVERY_POLICY.fetch_alert,
        counts_apns_budget: true,
      }).success,
    ).toBe(false);
  });
});

describe('daily push budget', () => {
  it('pins Pro to 3 and Pro Max to 5, with no free delivery tier', () => {
    expect(deliveryBudgetTierSchema.options).toEqual(['pro', 'pro_max']);
    expect(DAILY_PUSH_BUDGET).toEqual({ pro: 3, pro_max: 5 });
  });
});

describe('TRIGGER_PUSH_CLASSES', () => {
  it('covers every trigger and parses', () => {
    expect(Object.keys(TRIGGER_PUSH_CLASSES).sort()).toEqual([...triggerTypeSchema.options].sort());
    expect(triggerPushClassesSchema.safeParse(TRIGGER_PUSH_CLASSES).success).toBe(true);
  });

  it('binds agent-invocable classes to live triggers and excludes system classes', () => {
    expect(TRIGGER_PUSH_CLASSES.fetch_alert).toEqual(['fetch_alert']);
    expect(TRIGGER_PUSH_CLASSES.brief).toEqual(['brief']);
    expect(TRIGGER_PUSH_CLASSES.pre_activity_spot).toEqual(['pre_activity_spot']);
    expect(TRIGGER_PUSH_CLASSES.user_message).toEqual(['adjustment']);
    expect(Object.values(TRIGGER_PUSH_CLASSES).flat()).not.toContain('intervention_knock');
    expect(Object.values(TRIGGER_PUSH_CLASSES).flat()).not.toContain('system_consent');
  });
});

describe('deliveryCandidate', () => {
  it('accepts a trigger-owned candidate with optional confidence and expiry', () => {
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        confidence: 0.81,
        expires_at: 2_000,
      }).success,
    ).toBe(true);
  });

  it('rejects invalid confidence and extra content', () => {
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        confidence: 1.5,
      }).success,
    ).toBe(false);
    expect(
      deliveryCandidateSchema.safeParse({
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-1',
        body: 'send this',
      }).success,
    ).toBe(false);
  });
});

describe('admission', () => {
  it('accepts a well-formed exempt admission stamp', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
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

  it('rejects budget charge on an exempt class', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        channels: ['apns'],
        collapse_id: 'stack',
        budget_charged: true,
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: true },
      }).success,
    ).toBe(false);
  });

  it('requires hold_until for held admissions', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'hold',
        channels: [],
        collapse_id: 'stack',
        budget_charged: false,
        stamped: { push_class: 'adjustment', is_standalone: false, budget_exempt: false },
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
});
