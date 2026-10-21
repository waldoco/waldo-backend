import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAILY_PUSH_BUDGET, type Admission, type DeliveryCandidate } from '@waldo/contracts';
import { computeAdmission } from '../src/delivery-gate/gate';
import { DeliveryGateStore } from '../src/delivery-gate/store';

// The delivery gate's policy, exercised the way its live caller uses it: OwnerDO's calendar-prep
// lane reads class state and the counted budget from `DeliveryGateStore`, decides with
// `computeAdmission`, and commits the decision with `applyAdmission`. These journeys were proved
// before through the retired TracerDO journal/outbox pipeline; here they run on the store and the
// pure gate directly, so the policy stays pinned without that pipeline.

const USER = 'user-delivery-gate-01';
const at = Date.parse;
let seq = 0;

async function withStore(test: (store: DeliveryGateStore, sql: SqlStorage) => void): Promise<void> {
  const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`delivery-gate-admission-${++seq}`));
  await runInDurableObject(stub, (_instance, state) => test(new DeliveryGateStore(state.storage.sql), state.storage.sql));
}

// One admission step: read, decide, commit (or hold), as a trusted caller does inside one transaction.
function admit(store: DeliveryGateStore, user: string, candidate: DeliveryCandidate, now: number): Admission {
  const admission = computeAdmission({
    candidate,
    classState: store.readClassState(user, candidate, now),
    subKindState: candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
      ? store.readSubKindState(user, candidate.push_class, candidate.sub_kind, now)
      : undefined,
    countedSends: store.readBudget(user, now).sends_total,
    now,
  });
  if (admission.verdict === 'hold') store.recordHeld(user, candidate, admission);
  store.applyAdmission(user, candidate, admission, now);
  return admission;
}

const prep = (eventId: string, now: number): DeliveryCandidate => ({
  push_class: 'pre_activity_spot', trigger: 'pre_activity_spot', event_id: eventId, expires_at: now + 30 * 60_000,
});

describe('delivery gate admission through the store', () => {
  it('charges counted budget for pre_activity_spot without exempt telemetry', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T09:00:00Z');
      const candidate = prep('meeting-01', now);
      expect(admit(store, USER, candidate, now)).toMatchObject({ verdict: 'send', reason: null, budget_charged: true });
      expect(store.readClassState(USER, candidate, now).pre_activity_spot?.count).toBe(1);
      expect(store.readBudget(USER, now)).toMatchObject({ sends_total: 1, exempt_sends: 0 });
      expect(store.readExemptTelemetry(USER, 'pre_activity_spot').exempt_sends).toBe(0);
    });
  });

  it('scopes pre_activity_spot cooldown by event id while class count still accumulates', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T09:00:00Z');
      expect(admit(store, USER, prep('meeting-a', now), now).verdict).toBe('send');
      // The same event inside its cooldown holds; a different event is not held by it.
      const repeat = admit(store, USER, prep('meeting-a', now + 60_000), now + 60_000);
      expect(repeat).toMatchObject({ verdict: 'hold', reason: 'cooldown_active', hold_until: now + 60 * 60_000 });
      expect(admit(store, USER, prep('meeting-b', now + 60_000), now + 60_000).verdict).toBe('send');
      expect(store.readClassState(USER, prep('meeting-b', now), now).pre_activity_spot?.count).toBe(2);
      expect(store.readBudget(USER, now).sends_total).toBe(2);
      expect(store.readHeld(USER, 'meeting-a')).toMatchObject({ push_class: 'pre_activity_spot', hold_until: repeat.hold_until });
    });
  });

  it('admits the same event again exactly when its cooldown ends, not a millisecond before', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T09:00:00Z');
      const cooldownEnd = now + 60 * 60_000;
      expect(admit(store, USER, prep('meeting-repeat', now), now).verdict).toBe('send');
      expect(admit(store, USER, prep('meeting-repeat', cooldownEnd - 1), cooldownEnd - 1)).toMatchObject({ verdict: 'hold', reason: 'cooldown_active', hold_until: cooldownEnd });
      expect(admit(store, USER, prep('meeting-repeat', cooldownEnd), cooldownEnd)).toMatchObject({ verdict: 'send', reason: null });
    });
  });

  it('never holds a candidate with no prior send for cooldown, whatever the clock reads', () => {
    for (const now of [0, 1, 60 * 60_000 - 1]) {
      const candidate: DeliveryCandidate = { push_class: 'pre_activity_spot', trigger: 'pre_activity_spot', event_id: 'first-ever', expires_at: null };
      expect(computeAdmission({ candidate, classState: {}, countedSends: 0, now })).toMatchObject({ verdict: 'send', reason: null });
    }
  });

  it('does not let one trusted owner scope hold or exhaust another tenant', async () => {
    await withStore((store, sql) => {
      const now = at('2026-01-01T09:00:00Z');
      const first = 'own_71b9f4c6d2e8a5037b1e96c4f0a82d5b';
      const second = 'own_c48e1a6d59b203f7e4c9180a6d2b5f73';
      sql.exec('INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, ?)', first, '2026-01-01', DAILY_PUSH_BUDGET.pro);
      // The first tenant is at the counted cap: it degrades, yet still records the shared event's cooldown.
      expect(admit(store, first, prep('shared-tenant-event', now), now)).toMatchObject({ verdict: 'degrade', budget_charged: false });
      // A principal-only scope would hold the second tenant on the shared event and degrade the distinct one.
      expect(admit(store, second, prep('shared-tenant-event', now), now)).toMatchObject({ verdict: 'send', budget_charged: true });
      expect(admit(store, second, prep('second-tenant-budget-event', now), now)).toMatchObject({ verdict: 'send', budget_charged: true });
      expect(store.readBudget(first, now).sends_total).toBe(DAILY_PUSH_BUDGET.pro);
      expect(store.readBudget(second, now).sends_total).toBe(2);
      const cooldowns = sql.exec<{ user_id: string; event_id: string }>(
        'SELECT user_id, event_id FROM event_cooldowns WHERE push_class = ? ORDER BY user_id, event_id', 'pre_activity_spot').toArray();
      expect(cooldowns).toEqual([
        { user_id: first, event_id: 'shared-tenant-event' },
        { user_id: second, event_id: 'second-tenant-budget-event' },
        { user_id: second, event_id: 'shared-tenant-event' },
      ]);
    });
  });

  it('sends brief without charging APNs budget or exempt telemetry', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T07:00:00Z');
      const brief: DeliveryCandidate = { push_class: 'brief', trigger: 'brief', event_id: 'brief-morning', expires_at: null };
      expect(admit(store, USER, brief, now)).toMatchObject({ verdict: 'send', reason: null, budget_charged: false });
      expect(store.readClassState(USER, brief, now).brief?.count).toBe(1);
      expect(store.readBudget(USER, now)).toMatchObject({ sends_total: 0, exempt_sends: 0 });
      expect(store.readExemptTelemetry(USER, 'brief').exempt_sends).toBe(0);
    });
  });

  it('keeps intervention_knock exempt and capped at two sends', async () => {
    await withStore((store) => {
      const first = at('2026-01-01T09:00:00Z');
      const knock = (eventId: string): DeliveryCandidate => ({ push_class: 'intervention_knock', trigger: 'intervention', event_id: eventId, expires_at: null });
      expect(admit(store, USER, knock('intervention-01'), first).verdict).toBe('send');
      expect(admit(store, USER, knock('intervention-02'), first + 60_000).verdict).toBe('send');
      const third = admit(store, USER, knock('intervention-03'), first + 120_000);
      expect(third).toMatchObject({ verdict: 'hold', reason: 'class_cap_exhausted', hold_until: at('2026-01-02T00:00:00Z') });
      expect(store.readClassState(USER, knock('x'), first).intervention_knock?.count).toBe(2);
      expect(store.readExemptTelemetry(USER, 'intervention_knock').exempt_sends).toBe(2);
      expect(store.readBudget(USER, first)).toMatchObject({ sends_total: 0, exempt_sends: 2 });
      expect(store.readHeld(USER, 'intervention-03')).not.toBeNull();
    });
  });

  it('drops repeated constellation_first instead of holding a once-ever milestone, across local dates', async () => {
    await withStore((store, sql) => {
      const milestone = (eventId: string): DeliveryCandidate => ({ push_class: 'constellation_first', trigger: 'dreaming_mode', event_id: eventId, expires_at: null });
      expect(admit(store, USER, milestone('constellation-01'), at('2026-01-01T09:00:00Z')).verdict).toBe('send');
      expect(admit(store, USER, milestone('constellation-02'), at('2026-01-01T10:00:00Z'))).toMatchObject({ verdict: 'drop', reason: 'once_ever_already_sent' });
      expect(admit(store, USER, milestone('constellation-03'), at('2026-01-02T09:00:00Z'))).toMatchObject({ verdict: 'drop', reason: 'once_ever_already_sent' });
      expect(store.readHeld(USER, 'constellation-02')).toBeNull();
      const perDay = sql.exec<{ local_date: string; count: number }>(
        'SELECT local_date, count FROM class_state WHERE user_id = ? AND push_class = ? ORDER BY local_date', USER, 'constellation_first').toArray();
      expect(perDay).toEqual([{ local_date: '2026-01-01', count: 1 }]);
    });
  });

  it('applies the adjustment proposed sub-cap without capping executed adjustments', async () => {
    await withStore((store) => {
      const first = at('2026-01-01T09:00:00Z');
      const adjustment = (eventId: string, subKind: 'proposed' | 'executed'): DeliveryCandidate => ({
        push_class: 'adjustment', trigger: 'handoff_act', event_id: eventId, sub_kind: subKind, expires_at: null,
      });
      expect(admit(store, USER, adjustment('adjustment-proposed-01', 'proposed'), first).verdict).toBe('send');
      expect(admit(store, USER, adjustment('adjustment-proposed-02', 'proposed'), first + 60_000)).toMatchObject({ verdict: 'hold', reason: 'cooldown_active' });
      expect(admit(store, USER, adjustment('adjustment-executed-01', 'executed'), first + 120_000)).toMatchObject({ verdict: 'send', reason: null });
      expect(store.readClassState(USER, adjustment('x', 'executed'), first).adjustment?.count).toBe(2);
      expect(store.readSubKindState(USER, 'adjustment', 'proposed', first).count).toBe(1);
      expect(store.readSubKindState(USER, 'adjustment', 'executed', first).count).toBe(1);
      expect(store.readBudget(USER, first)).toMatchObject({ sends_total: 2, exempt_sends: 0 });
    });
  });

  it('degrades counted classes without charging budget when the Pro cap is full', async () => {
    await withStore((store, sql) => {
      const now = at('2026-01-01T09:00:00Z');
      sql.exec('INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, 3)', USER, '2026-01-01');
      const admission = admit(store, USER, prep('meeting-budget-full', now), now);
      expect(admission).toMatchObject({ verdict: 'degrade', reason: 'budget_cap_exhausted', budget_charged: false });
      expect(admission.channels).not.toContain('apns');
      expect(store.readClassState(USER, prep('meeting-budget-full', now), now).pre_activity_spot?.count).toBe(1);
      expect(store.readBudget(USER, now)).toMatchObject({ sends_total: 3, exempt_sends: 0 });
    });
  });

  it('drops an expired candidate before any counter mutates', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T09:00:00Z');
      const expired: DeliveryCandidate = { ...prep('meeting-expired', now), expires_at: now };
      expect(admit(store, USER, expired, now)).toMatchObject({ verdict: 'drop', reason: 'candidate_expired' });
      expect(store.readClassState(USER, expired, now).pre_activity_spot?.count).toBe(0);
      expect(store.readBudget(USER, now)).toMatchObject({ sends_total: 0, exempt_sends: 0 });
      expect(store.readHeld(USER, 'meeting-expired')).toBeNull();
    });
  });

  it('scopes the counted budget and class daily caps by UTC local date by default', async () => {
    await withStore((store, sql) => {
      const dayOne = at('2026-01-01T23:59:00Z');
      const dayTwo = at('2026-01-02T00:01:00Z');
      sql.exec('INSERT INTO daily_push_budget (user_id, local_date, sends_total) VALUES (?, ?, 3)', USER, '2026-01-01');
      sql.exec("INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at) VALUES (?, '2026-01-01', 'intervention_knock', 2, NULL)", USER);
      const knock: DeliveryCandidate = { push_class: 'intervention_knock', trigger: 'intervention', event_id: 'knock-next-day', expires_at: null };
      expect(admit(store, USER, prep('meeting-day-one', dayOne), dayOne)).toMatchObject({ verdict: 'degrade' });
      expect(admit(store, USER, prep('meeting-day-two', dayTwo), dayTwo)).toMatchObject({ verdict: 'send', budget_charged: true });
      expect(admit(store, USER, knock, dayTwo)).toMatchObject({ verdict: 'send' });
      expect(store.readBudget(USER, dayOne).sends_total).toBe(3);
      expect(store.readBudget(USER, dayTwo).sends_total).toBe(1);
      expect(store.readClassState(USER, knock, dayTwo).intervention_knock?.count).toBe(1);
    });
  });

  it('refuses to record a non-held admission and deletes a held candidate on request', async () => {
    await withStore((store) => {
      const now = at('2026-01-01T09:00:00Z');
      const candidate = prep('meeting-held', now);
      const send = computeAdmission({ candidate, classState: {}, countedSends: 0, now });
      expect(() => store.recordHeld(USER, candidate, send)).toThrow('recordHeld requires a held admission');
      const hold = computeAdmission({ candidate, classState: { pre_activity_spot: { count: 0, last_sent_at: now } }, countedSends: 0, now });
      store.recordHeld(USER, candidate, hold);
      expect(store.readHeld(USER, 'meeting-held')).toMatchObject({ event_id: 'meeting-held', hold_until: now + 60 * 60_000 });
      store.deleteHeld(USER, 'meeting-held');
      expect(store.readHeld(USER, 'meeting-held')).toBeNull();
    });
  });
});
