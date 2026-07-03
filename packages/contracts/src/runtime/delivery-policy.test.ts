import { describe, expect, it } from 'vitest';
import {
  agentReachableExemptHasCap,
  admissionSchema,
  deliveryVerdictSchema,
  FETCH_ALERT_POLICY,
  fetchAlertPolicySchema,
} from './delivery-policy';

describe('deliveryVerdict', () => {
  it('is exactly the four verdicts, in order', () => {
    expect(deliveryVerdictSchema.options).toEqual(['send', 'hold', 'degrade', 'drop']);
  });

  it('rejects an out-of-domain verdict', () => {
    expect(deliveryVerdictSchema.safeParse('defer').success).toBe(false);
  });
});

describe('FETCH_ALERT_POLICY', () => {
  it('is a valid policy: exempt, agent-reachable, capped, cooled', () => {
    expect(fetchAlertPolicySchema.safeParse(FETCH_ALERT_POLICY).success).toBe(true);
    expect(FETCH_ALERT_POLICY.budget_exempt).toBe(true);
    expect(FETCH_ALERT_POLICY.daily_cap).toBe(3);
    expect(FETCH_ALERT_POLICY.cooldown_min).toBe(120);
  });

  it('rejects a zero/non-positive cap and a non-exempt policy', () => {
    expect(fetchAlertPolicySchema.safeParse({ ...FETCH_ALERT_POLICY, daily_cap: 0 }).success).toBe(
      false,
    );
    expect(
      fetchAlertPolicySchema.safeParse({ ...FETCH_ALERT_POLICY, budget_exempt: false }).success,
    ).toBe(false);
  });
});

describe('block rule — current, not stale', () => {
  it('every agent-reachable exempt class has a non-null cap', () => {
    expect(agentReachableExemptHasCap(FETCH_ALERT_POLICY)).toBe(true);
  });

  it('does NOT encode the stale "agent_invocable ∩ exempt = ∅" invariant', () => {
    // fetch_alert is simultaneously agent-invocable AND budget-exempt. The stale invariant
    // would forbid that intersection; the current rule permits it as long as a cap exists.
    expect(FETCH_ALERT_POLICY.budget_exempt).toBe(true);
    expect(agentReachableExemptHasCap(FETCH_ALERT_POLICY)).toBe(true);
  });
});

describe('admission', () => {
  it('accepts a well-formed exempt admission stamp', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        stamped: { push_class: 'fetch_alert', is_standalone: false, budget_exempt: true },
      }).success,
    ).toBe(true);
  });

  it('rejects a stamp claiming standalone or non-exempt', () => {
    expect(
      admissionSchema.safeParse({
        verdict: 'send',
        stamped: { push_class: 'fetch_alert', is_standalone: true, budget_exempt: true },
      }).success,
    ).toBe(false);
  });
});
