import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DeliveryCandidate } from '@waldo/contracts';
import { computeAdmission } from '../src/delivery-gate/gate';
import { DeliveryGateStore } from '../src/delivery-gate/store';
import { nextDailyLocalOccurrence } from '../src/scheduler/multiplexer';

const prep: DeliveryCandidate = { push_class: 'pre_activity_spot', trigger: 'pre_activity_spot', event_id: 'local-day-prep' };
const adjustment: DeliveryCandidate = { push_class: 'adjustment', trigger: 'handoff_act', event_id: 'local-adjustment', sub_kind: 'proposed' };
const at = Date.parse;
let seq = 0;
const withStore = async (test: (store: DeliveryGateStore) => void) => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName(`local-delivery-day-${++seq}`)), async (_instance, state) => test(new DeliveryGateStore(state.storage.sql)));
};

describe('trusted owner-local delivery day', () => {
  it('keys every daily counter to IST midnight, not UTC midnight', async () => {
    await withStore(store => {
      const before = at('2026-10-03T18:29:59Z');
      const after = before + 1000;
      store.incrementClassState('owner', 'adjustment', before, 'Asia/Kolkata');
      store.incrementSubKindState('owner', 'adjustment', 'proposed', before, 'Asia/Kolkata');
      store.incrementCountedBudget('owner', before, 'Asia/Kolkata');
      store.incrementExemptBudget('owner', before, 'Asia/Kolkata');
      expect(store.readBudget('owner', before, 'Asia/Kolkata')).toMatchObject({ local_date: '2026-10-03', sends_total: 1, exempt_sends: 1 });
      expect(store.readBudget('owner', after, 'Asia/Kolkata')).toMatchObject({ local_date: '2026-10-04', sends_total: 0, exempt_sends: 0 });
      expect(store.readClassState('owner', adjustment, after, 'Asia/Kolkata').adjustment).toEqual({ count: 0, last_sent_at: before });
      expect(store.readSubKindState('owner', 'adjustment', 'proposed', after, 'Asia/Kolkata')).toEqual({ count: 0, last_sent_at: before });
      store.incrementCountedBudget('owner', after, 'Asia/Kolkata');
      expect(store.readBudget('owner', at('2026-10-04T00:00:00Z'), 'Asia/Kolkata').sends_total).toBe(1);
    });
  });
  it('threads timezone through counted and exempt applyAdmission writes', async () => {
    await withStore(store => {
      const now = at('2026-10-03T20:00:00Z');
      const admit = (candidate: DeliveryCandidate) => computeAdmission({ candidate, classState: {}, countedSends: 0, now, timezone: 'Asia/Kolkata' });
      store.applyAdmission('owner', adjustment, admit(adjustment), now, 'Asia/Kolkata');
      const fetch: DeliveryCandidate = { push_class: 'fetch_alert', trigger: 'fetch_alert', event_id: 'fetch' };
      store.applyAdmission('owner', fetch, admit(fetch), now, 'Asia/Kolkata');
      expect(store.readBudget('owner', now, 'Asia/Kolkata')).toMatchObject({ local_date: '2026-10-04', sends_total: 1, exempt_sends: 1 });
      expect(store.readSubKindState('owner', 'adjustment', 'proposed', now, 'Asia/Kolkata').count).toBe(1);
      expect(store.readClassState('owner', fetch, now, 'Asia/Kolkata').fetch_alert?.count).toBe(1);
    });
  });
  it('preserves lifetime sums and event cooldown across local midnight', async () => {
    await withStore(store => {
      const before = at('2026-10-03T18:29:59Z');
      const first: DeliveryCandidate = { push_class: 'constellation_first', trigger: 'dreaming_mode', event_id: 'first' };
      store.incrementClassState('owner', first.push_class, before, 'Asia/Kolkata');
      store.incrementClassState('owner', first.push_class, before + 1000, 'Asia/Kolkata');
      expect(store.readClassState('owner', first, before + 1000, 'Asia/Kolkata').constellation_first?.count).toBe(2);
      store.applyAdmission('owner', prep, computeAdmission({ candidate: prep, classState: {}, countedSends: 0, now: before }), before, 'Asia/Kolkata');
      const next = before + 1000;
      const state = store.readClassState('owner', prep, next, 'Asia/Kolkata');
      expect(state.pre_activity_spot).toEqual({ count: 0, last_sent_at: before });
      expect(computeAdmission({ candidate: prep, classState: state, countedSends: 0, now: next, timezone: 'Asia/Kolkata' })).toMatchObject({ verdict: 'hold', reason: 'cooldown_active', hold_until: before + 60 * 60_000 });
    });
  });
  it('retains UTC default signatures and historical rows', async () => {
    await withStore(store => {
      const now = at('2026-10-03T23:59:59Z');
      store.incrementClassState('legacy', prep.push_class, now);
      store.incrementCountedBudget('legacy', now);
      store.incrementExemptBudget('legacy', now);
      expect(store.readBudget('legacy', now)).toMatchObject({ local_date: '2026-10-03', sends_total: 1, exempt_sends: 1 });
      expect(store.readBudget('legacy', now + 1000)).toMatchObject({ local_date: '2026-10-04', sends_total: 0 });
      expect(store.readBudget('legacy', now).sends_total).toBe(1);
      expect(store.readClassState('legacy', prep, now).pre_activity_spot?.count).toBe(1);
    });
  });
  it.each([
    ['Asia/Kolkata', '2026-10-03T18:00:00Z', '2026-10-03T18:30:00Z'],
    ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    ['America/Sao_Paulo', '2018-11-03T12:00:00Z', '2018-11-04T03:00:00Z'],
    ['Pacific/Apia', '2011-12-29T12:00:00Z', '2011-12-30T10:00:00Z'],
  ])('holds class cap until next valid local day in %s from %s', (timezone, now, expected) => {
    const result = computeAdmission({ candidate: prep, classState: { pre_activity_spot: { count: 2, last_sent_at: null } }, countedSends: 0, now: at(now), timezone });
    expect(result).toMatchObject({ verdict: 'hold', reason: 'class_cap_exhausted', hold_until: at(expected) });
  });
  it('exports the existing gap/skipped-day-safe recurrence helper', () => {
    expect(nextDailyLocalOccurrence('00:00', 'America/Sao_Paulo', at('2018-11-03T12:00:00Z'))).toBe(at('2018-11-04T03:00:00Z'));
    expect(nextDailyLocalOccurrence('00:00', 'Pacific/Apia', at('2011-12-29T12:00:00Z'))).toBe(at('2011-12-30T10:00:00Z'));
  });
  it('retains UTC cap boundary when timezone is omitted', () => {
    expect(computeAdmission({ candidate: prep, classState: { pre_activity_spot: { count: 2, last_sent_at: null } }, countedSends: 0, now: at('2026-10-03T18:00:00Z') }).hold_until).toBe(at('2026-10-04T00:00:00Z'));
  });
});
