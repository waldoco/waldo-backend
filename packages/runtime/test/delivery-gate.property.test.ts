import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import {
  DAILY_PUSH_BUDGET,
  DELIVERY_POLICY,
  type ClassState,
  type DeliveryBudgetTier,
  type DeliveryCandidate,
  type PushClass,
} from '@waldo/contracts';
import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeAdmission } from '../src/delivery-gate/gate';
import type { StartRunInput } from '../src/run-journal/outbox-runtime';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

const USER = 'user-delivery-gate-property';
const FETCH_ALERT = 'fetch_alert';
const PRE_ACTIVITY_SPOT = 'pre_activity_spot';
const ADJUSTMENT = 'adjustment';
const CONSTELLATION_FIRST = 'constellation_first';
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const BASE_DAY = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const PURE_PROPERTY_RUNS = 300;
const RUNTIME_PROPERTY_RUNS = 30;

const SEEDS = {
  countedBudget: 0x1370001,
  exemptInterleaving: 0x1370002,
  dayRollover: 0x1370003,
  cooldown: 0x1370004,
} as const;

type RuntimeStub = DurableObjectStub<TracerDO> & {
  startRun(input: StartRunInput): Promise<string>;
  tickRun(runId: string): Promise<void>;
};

type RuntimeAction = 'adjustment' | 'constellation' | 'consent' | 'fetch' | 'intervention';
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

type CooldownResult = {
  state: string;
  verdict: string | null;
  reason: string | null;
  holdUntil: number | null;
};

beforeEach(() => {
  new FakeSink().reset();
});

let sequence = 0;
function freshRuntimeStub(): RuntimeStub {
  sequence += 1;
  return env.TRACER_DO.get(
    env.TRACER_DO.idFromName(`delivery-gate-property-${sequence}`),
  ) as RuntimeStub;
}

function utcLocalDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

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

function runtimeActionInput(
  action: RuntimeAction,
  index: number,
  occurrenceAt: number,
): StartRunInput {
  switch (action) {
    case 'adjustment':
      return {
        userId: USER,
        trigger: 'handoff_act',
        occurrenceAt,
        candidate: executedAdjustment(alphabeticId('adjustment', index)),
      };
    case 'constellation':
      return {
        userId: USER,
        trigger: 'dreaming_mode',
        occurrenceAt,
        candidate: {
          push_class: CONSTELLATION_FIRST,
          trigger: 'dreaming_mode',
          event_id: alphabeticId('constellation', index),
          expires_at: null,
        },
      };
    case 'consent':
      return {
        userId: USER,
        trigger: 'dreaming_mode',
        occurrenceAt,
        candidate: {
          push_class: 'system_consent',
          trigger: 'dreaming_mode',
          event_id: alphabeticId('consent', index),
          expires_at: null,
        },
      };
    case 'fetch':
      return {
        userId: USER,
        trigger: FETCH_ALERT,
        occurrenceAt,
        candidate: {
          push_class: FETCH_ALERT,
          trigger: FETCH_ALERT,
          event_id: alphabeticId('fetch', index),
          expires_at: null,
        },
      };
    case 'intervention':
      return {
        userId: USER,
        trigger: 'intervention',
        occurrenceAt,
        candidate: {
          push_class: 'intervention_knock',
          trigger: 'intervention',
          event_id: alphabeticId('intervention', index),
          expires_at: null,
        },
      };
  }
}

async function tick(stub: RuntimeStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).tickRun(runId);
  });
}

async function readBudget(
  stub: RuntimeStub,
  localDate: string,
): Promise<{ counted: number; exempt: number }> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ counted: number; exempt: number }>(
        `SELECT COALESCE(sum(sends_total), 0) AS counted,
                COALESCE(sum(exempt_sends), 0) AS exempt
           FROM daily_push_budget
          WHERE user_id = ? AND local_date = ?`,
        USER,
        localDate,
      )
      .one(),
  );
}

async function readJournal(
  stub: RuntimeStub,
  runId: string,
): Promise<{ state: string; verdict: string | null; reason: string | null; outboxRows: number }> {
  return runInDurableObject(stub, (_instance, state) => {
    const journal = state.storage.sql
      .exec<{ state: string; verdict: string | null; reason: string | null }>(
        'SELECT state, verdict, gate_reason AS reason FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    const outboxRows = state.storage.sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
      .one().n;
    return { ...journal, outboxRows };
  });
}

async function fetchAfterCrossDateCooldown(deltaMinutes: number): Promise<CooldownResult> {
  const runtime = freshRuntimeStub();
  const lastSentAt = Date.UTC(2026, 0, 1, 23, 59, 0, 0);
  const occurrenceAt = lastSentAt + deltaMinutes * MS_PER_MINUTE;
  await runInDurableObject(runtime, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
       VALUES (?, ?, ?, 1, ?)`,
      USER,
      utcLocalDate(lastSentAt),
      FETCH_ALERT,
      lastSentAt,
    );
  });
  const runId = await runtime.startRun({
    userId: USER,
    trigger: FETCH_ALERT,
    occurrenceAt,
    candidate: {
      push_class: FETCH_ALERT,
      trigger: FETCH_ALERT,
      event_id: 'cross-date-fetch',
      expires_at: null,
    },
  });
  await tick(runtime, runId);
  return runInDurableObject(runtime, (_instance, state) => {
    const journal = state.storage.sql
      .exec<{ state: string; verdict: string | null; reason: string | null }>(
        'SELECT state, verdict, gate_reason AS reason FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    const held = state.storage.sql
      .exec<{ hold_until: number }>('SELECT hold_until FROM held_candidates WHERE event_id = ?', 'cross-date-fetch')
      .toArray()[0];
    return { ...journal, holdUntil: held?.hold_until ?? null };
  });
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

  it('keeps pre_activity_spot capped at two even for Pro Max', () => {
    const admissions = [0, 1, 2].map((classCount) =>
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

    expect(admissions.slice(0, 2).every((admission) => admission.verdict === 'send')).toBe(true);
    expect(admissions[2]).toMatchObject({ verdict: 'hold', reason: 'class_cap_exhausted' });
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
      { ...candidateFor('pre_activity_spot', 0), expires_at: expiresAt },
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

  it(`does not charge counted budget for exempt runtime interleavings (seed ${SEEDS.exemptInterleaving})`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<RuntimeAction>(
            'adjustment',
            'constellation',
            'consent',
            'fetch',
            'intervention',
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (actions) => {
          new FakeSink().reset();
          const runtime = freshRuntimeStub();
          for (const [index, action] of actions.entries()) {
            const occurrenceAt = BASE_DAY + index * 121 * MS_PER_MINUTE;
            const runId = await runtime.startRun(runtimeActionInput(action, index, occurrenceAt));
            await tick(runtime, runId);
          }

          const budget = await readBudget(runtime, utcLocalDate(BASE_DAY));
          const countedActions = actions.filter((action) => action === 'adjustment').length;
          const expectedExempt =
            Math.min(actions.filter((action) => action === 'fetch').length, 3) +
            Math.min(actions.filter((action) => action === 'intervention').length, 2) +
            Math.min(actions.filter((action) => action === 'constellation').length, 1) +
            actions.filter((action) => action === 'consent').length;
          expect(budget).toEqual({
            counted: Math.min(countedActions, DAILY_PUSH_BUDGET.pro),
            exempt: expectedExempt,
          });
        },
      ),
      { seed: SEEDS.exemptInterleaving, numRuns: RUNTIME_PROPERTY_RUNS },
    );
  });

  it(`keeps once-ever and counted state separated across UTC days (seed ${SEEDS.dayRollover})`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 45 }), async (dayOffset) => {
        new FakeSink().reset();
        const runtime = freshRuntimeStub();
        const firstAt = BASE_DAY + 12 * 60 * MS_PER_MINUTE;
        const nextAt = firstAt + dayOffset * MS_PER_DAY;
        const firstDate = utcLocalDate(firstAt);
        const nextDate = utcLocalDate(nextAt);
        await runInDurableObject(runtime, (_instance, state) => {
          state.storage.sql.exec(
            'INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, 3)',
            USER,
            firstDate,
          );
        });

        const firstConstellation = await runtime.startRun({
          userId: USER,
          trigger: 'dreaming_mode',
          occurrenceAt: firstAt,
          candidate: {
            push_class: CONSTELLATION_FIRST,
            trigger: 'dreaming_mode',
            event_id: 'constellation-first-day-one',
            expires_at: null,
          },
        });
        await tick(runtime, firstConstellation);

        const nextDayAdjustment = await runtime.startRun({
          userId: USER,
          trigger: 'handoff_act',
          occurrenceAt: nextAt,
          candidate: executedAdjustment('next-day-adjustment'),
        });
        await tick(runtime, nextDayAdjustment);

        const nextDayConstellation = await runtime.startRun({
          userId: USER,
          trigger: 'dreaming_mode',
          occurrenceAt: nextAt,
          candidate: {
            push_class: CONSTELLATION_FIRST,
            trigger: 'dreaming_mode',
            event_id: 'constellation-first-next-day',
            expires_at: null,
          },
        });
        await tick(runtime, nextDayConstellation);

        expect(await readBudget(runtime, firstDate)).toMatchObject({ counted: 3 });
        expect(await readBudget(runtime, nextDate)).toMatchObject({ counted: 1 });
        expect(await readJournal(runtime, nextDayConstellation)).toEqual({
          state: 'FAILED',
          verdict: 'drop',
          reason: 'once_ever_already_sent',
          outboxRows: 0,
        });
      }),
      { seed: SEEDS.dayRollover, numRuns: RUNTIME_PROPERTY_RUNS },
    );
  });

  it('allows a cross-date fetch at exactly its cooldown boundary', async () => {
    const result = await fetchAfterCrossDateCooldown(120);
    expect(result).toEqual({ state: 'DONE', verdict: 'send', reason: null, holdUntil: null });
  });

  it(`keeps cross-date fetch cooldowns monotone (seed ${SEEDS.cooldown})`, async () => {
    const lastSentAt = Date.UTC(2026, 0, 1, 23, 59, 0, 0);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 180 }), async (deltaMinutes) => {
        const result = await fetchAfterCrossDateCooldown(deltaMinutes);
        if (deltaMinutes < 120) {
          expect(result).toEqual({
            state: 'FAILED',
            verdict: 'hold',
            reason: 'cooldown_active',
            holdUntil: lastSentAt + 120 * MS_PER_MINUTE,
          });
          return;
        }
        expect(result).toEqual({ state: 'DONE', verdict: 'send', reason: null, holdUntil: null });
      }),
      { seed: SEEDS.cooldown, numRuns: RUNTIME_PROPERTY_RUNS },
    );
  });
});
