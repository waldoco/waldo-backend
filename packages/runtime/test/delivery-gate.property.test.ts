import {
  DAILY_PUSH_BUDGET,
  DELIVERY_POLICY,
  type ClassState,
  type DeliveryBudgetTier,
  type DeliveryCandidate,
  type PushClass,
} from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAdmission } from '../src/delivery-gate/gate';

const FETCH_ALERT = 'fetch_alert';
const PRE_ACTIVITY_SPOT = 'pre_activity_spot';
const ADJUSTMENT = 'adjustment';
const CONSTELLATION_FIRST = 'constellation_first';
const MS_PER_MINUTE = 60_000;
const BASE_DAY = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const PURE_PROPERTY_RUNS = 300;
const SEEDS = { countedBudget: 0x1370001 } as const;

type PolicyAction =
  | 'adjustment'
  | 'brief'
  | 'constellation_first'
  | 'constellation_update'
  | 'fetch_alert'
  | 'intervention_knock'
  | 'pre_activity_spot'
  | 'spot_digest'
  | 'sync_error'
  | 'system_consent';

function alphabeticId(prefix: string, index: number): string {
  let value = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `${prefix}-${suffix}`;
}

function stateFor(pushClass: PushClass, count = 0, lastSentAt: number | null = null): ClassState {
  return { [pushClass]: { count, last_sent_at: lastSentAt } } as ClassState;
}

function executedAdjustment(eventId: string): DeliveryCandidate {
  return {
    push_class: ADJUSTMENT,
    trigger: 'handoff_act',
    event_id: eventId,
    expires_at: null,
    sub_kind: 'executed',
  };
}

function candidateFor(action: PolicyAction, index: number): DeliveryCandidate {
  const eventId = alphabeticId(action, index);
  switch (action) {
    case 'adjustment':
      return executedAdjustment(eventId);
    case 'brief':
      return { push_class: 'brief', trigger: 'brief', event_id: eventId, expires_at: null };
    case 'constellation_first':
      return {
        push_class: 'constellation_first',
        trigger: 'dreaming_mode',
        event_id: eventId,
        expires_at: null,
      };
    case 'constellation_update':
      return {
        push_class: 'constellation_update',
        trigger: 'dreaming_mode',
        event_id: eventId,
        expires_at: null,
      };
    case 'fetch_alert':
      return {
        push_class: FETCH_ALERT,
        trigger: FETCH_ALERT,
        event_id: eventId,
        expires_at: null,
      };
    case 'intervention_knock':
      return {
        push_class: 'intervention_knock',
        trigger: 'intervention',
        event_id: eventId,
        expires_at: null,
      };
    case 'pre_activity_spot':
      return {
        push_class: PRE_ACTIVITY_SPOT,
        trigger: PRE_ACTIVITY_SPOT,
        event_id: eventId,
        expires_at: null,
      };
    case 'spot_digest':
      return {
        push_class: 'spot_digest',
        trigger: 'dreaming_mode',
        event_id: eventId,
        expires_at: null,
      };
    case 'sync_error':
      return {
        push_class: 'sync_error',
        trigger: 'dreaming_mode',
        event_id: eventId,
        expires_at: null,
      };
    case 'system_consent':
      return {
        push_class: 'system_consent',
        trigger: 'dreaming_mode',
        event_id: eventId,
        expires_at: null,
      };
  }
}

function admit(
  candidate: DeliveryCandidate,
  tier: DeliveryBudgetTier,
  countedSends: number,
  classCount = 0,
  lastSentAt: number | null = null,
  subKindState?: { count: number; last_sent_at: number | null },
) {
  return computeAdmission({
    candidate,
    classState: stateFor(candidate.push_class, classCount, lastSentAt),
    subKindState,
    countedSends,
    tier,
    now: BASE_DAY,
  });
}

function admitSequence(tier: DeliveryBudgetTier, actions: readonly PolicyAction[]) {
  let countedSends = 0;
  let adjustmentCount = 0;
  let adjustmentLastSentAt: number | null = null;
  const classCounts: Partial<Record<PushClass, number>> = {};
  const classLastSentAt: Partial<Record<PushClass, number>> = {};
  const eventLastSentAt = new Map<string, number>();

  const admissions = actions.map((action, index) => {
    const candidate = candidateFor(action, index);
    const policy = DELIVERY_POLICY[candidate.push_class];
    const lastSentAt =
      policy.cooldown_scope === 'event'
        ? (eventLastSentAt.get(candidate.event_id) ?? null)
        : (classLastSentAt[candidate.push_class] ?? null);
    const admission = admit(
      candidate,
      tier,
      countedSends,
      classCounts[candidate.push_class] ?? 0,
      lastSentAt,
      candidate.push_class === ADJUSTMENT
        ? { count: adjustmentCount, last_sent_at: adjustmentLastSentAt }
        : undefined,
    );

    if (admission.verdict === 'send' || admission.verdict === 'degrade') {
      classCounts[candidate.push_class] = (classCounts[candidate.push_class] ?? 0) + 1;
      classLastSentAt[candidate.push_class] = BASE_DAY;
      if (policy.cooldown_scope === 'event') {
        eventLastSentAt.set(candidate.event_id, BASE_DAY);
      }
      if (candidate.push_class === ADJUSTMENT) {
        adjustmentCount += 1;
        adjustmentLastSentAt = BASE_DAY;
      }
      if (admission.budget_charged) countedSends += 1;
    }
    return admission;
  });

  return { admissions, countedSends };
}

describe('DeliveryGate fast-check properties', () => {
  it(`caps arbitrary in-day policy sequences at their tier budget (seed ${SEEDS.countedBudget})`, () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DeliveryBudgetTier>('pro', 'pro_max'),
        fc.array(
          fc.constantFrom<PolicyAction>(
            'adjustment',
            'brief',
            'constellation_first',
            'constellation_update',
            'fetch_alert',
            'intervention_knock',
            'pre_activity_spot',
            'spot_digest',
            'sync_error',
            'system_consent',
          ),
          { maxLength: 40 },
        ),
        (tier, arbitraryActions) => {
          const cap = DAILY_PUSH_BUDGET[tier];
          const boundaryActions = Array.from(
            { length: cap + 1 },
            () => 'adjustment' as const,
          );
          const { admissions, countedSends } = admitSequence(tier, [
            ...arbitraryActions,
            ...boundaryActions,
          ]);
          const boundaryAdmissions = admissions.slice(arbitraryActions.length);

          expect(countedSends).toBe(cap);
          expect(countedSends).toBeLessThanOrEqual(cap);
          // The arbitrary prefix can consume any part of the budget. cap + 1 eligible counted
          // candidates must still fill the remaining capacity and leave the final one degraded.
          expect(boundaryAdmissions.at(-1)).toMatchObject({
            verdict: 'degrade',
            reason: 'budget_cap_exhausted',
            budget_charged: false,
          });
        },
      ),
      { seed: SEEDS.countedBudget, numRuns: PURE_PROPERTY_RUNS },
    );
  });

  it('admits five eligible Pro Max candidates and degrades the sixth', () => {
    let countedSends = 0;
    const admissions = Array.from({ length: 6 }, (_unused, index) => {
      const admission = admit(
        executedAdjustment(alphabeticId('pro-max', index)),
        'pro_max',
        countedSends,
      );
      if (admission.budget_charged) countedSends += 1;
      return admission;
    });

    expect(
      admissions
        .slice(0, 5)
        .every((admission) => admission.verdict === 'send' && admission.budget_charged),
    ).toBe(true);
    expect(admissions[5]).toMatchObject({
      verdict: 'degrade',
      reason: 'budget_cap_exhausted',
      budget_charged: false,
    });
    expect(countedSends).toBe(5);
  });

  it('leaves pre_activity_spot uncapped and uncooled: whether a meeting gets a note is the model\'s call', () => {
    const admissions = [0, 1, 2, 5].map((classCount) =>
      admit(
        {
          push_class: PRE_ACTIVITY_SPOT,
          trigger: PRE_ACTIVITY_SPOT,
          event_id: alphabeticId('pro-max-spot', classCount),
          expires_at: null,
        },
        'pro_max',
        0,
        classCount,
      ),
    );

    expect(admissions.every((admission) => admission.verdict === 'send')).toBe(true);
  });

  it('preserves the candidate expiration in lifetime-drop and daily-cap-hold stamps', () => {
    const expiresAt = BASE_DAY + 24 * 60 * MS_PER_MINUTE;
    const onceEver = admit(
      { ...candidateFor('constellation_first', 0), expires_at: expiresAt },
      'pro',
      0,
      1,
    );
    const dailyCap = admit(
      { ...candidateFor('intervention_knock', 0), expires_at: expiresAt },
      'pro_max',
      0,
      2,
    );

    expect(onceEver).toMatchObject({
      verdict: 'drop',
      reason: 'once_ever_already_sent',
      stamped: { expires_at: expiresAt },
    });
    expect(dailyCap).toMatchObject({
      verdict: 'hold',
      reason: 'class_cap_exhausted',
      stamped: { expires_at: expiresAt },
    });
  });
});
