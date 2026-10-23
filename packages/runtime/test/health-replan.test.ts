import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarChange, CalendarListItem, FreeBusyResult } from '../src/connectors/google';
import { calendarDemand, forgetDemandDay, type DemandClient } from '../src/health/calendar-demand';
import { HEALTH_RECOMPUTE_WINDOW_MS, healthRecompute } from '../src/health/recompute';
import { touchesDay, type Change } from '../src/channels/update-cards';
import { calendarPromptProjection } from '../src/connectors/google';

// A calendar change re-plans the owner's day through the recompute it asks for. These are its parts: which change can
// move the owner's today, the consent and row it needs before asking, and the cached busy minutes it drops.
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T05:30:00Z'); // 11:00 in Kolkata
const change = (over: Partial<CalendarChange>): Change => {
  const { status = 'confirmed', created = '2026-10-21T05:29:00Z', ...event } = { id: 'e1', title: 'Board prep', start: '2026-10-21T14:00:00+05:30', end: '2026-10-21T15:00:00+05:30', all_day: false, ...over } as CalendarChange;
  return { source: 'calendar', kind: status === 'cancelled' ? 'cancelled' : 'added', detail: JSON.stringify(calendarPromptProjection(event)) };
};

describe('a calendar change that can move the owner\'s today', () => {
  it('is one that overlaps the owner-local day, timed or all-day, and one Google gave no times for', () => {
    expect(touchesDay(change({}), '2026-10-21', TZ)).toBe(true);
    // 23:30 on the 21st in Kolkata is 18:00 UTC; the next morning is not today.
    expect(touchesDay(change({ start: '2026-10-21T18:00:00Z', end: '2026-10-21T18:45:00Z' }), '2026-10-21', TZ)).toBe(true);
    expect(touchesDay(change({ start: '2026-10-22T09:00:00+05:30', end: '2026-10-22T10:00:00+05:30' }), '2026-10-21', TZ)).toBe(false);
    // One that runs past midnight into today counts.
    expect(touchesDay(change({ start: '2026-10-20T23:00:00+05:30', end: '2026-10-21T01:00:00+05:30' }), '2026-10-21', TZ)).toBe(true);
    expect(touchesDay(change({ start: '2026-10-21', end: '2026-10-22', all_day: true }), '2026-10-21', TZ)).toBe(true);
    expect(touchesDay(change({ start: '2026-10-22', end: '2026-10-23', all_day: true }), '2026-10-21', TZ)).toBe(false);
    // Google's all-day end is the day after the last one: yesterday's all-day event ends "today" and is not today's.
    expect(touchesDay(change({ start: '2026-10-20', end: '2026-10-21', all_day: true }), '2026-10-21', TZ)).toBe(false);
    expect(touchesDay(change({ start: '2026-10-19', end: '2026-10-23', all_day: true }), '2026-10-21', TZ)).toBe(true);
    // A cancelled event comes back without times, so it may have been today's.
    expect(touchesDay(change({ status: 'cancelled', start: '', end: '', all_day: true }), '2026-10-21', TZ)).toBe(true);
    expect(touchesDay({ source: 'mail', kind: 'new', detail: '{}' }, '2026-10-21', TZ)).toBe(false);
  });

  it('is read in the owner\'s zone across a DST change', () => {
    // 2026-11-01 in New York runs 04:00Z to 05:00Z the next day (25 hours): 04:30Z on the 2nd is still the 1st.
    expect(touchesDay(change({ start: '2026-11-02T04:30:00Z', end: '2026-11-02T04:50:00Z' }), '2026-11-01', 'America/New_York')).toBe(true);
    expect(touchesDay(change({ start: '2026-11-02T05:00:00Z', end: '2026-11-02T05:30:00Z' }), '2026-11-01', 'America/New_York')).toBe(false);
  });
});

describe('the recompute a calendar change asks for', () => {
  const setup = (scores: unknown | (() => Promise<unknown>), now = NOW) => {
    const scheduled: number[] = [], forgotten: string[] = [], asked: string[] = [];
    const recompute = healthRecompute({
      scheduler: { lookup: () => ({ state: 'absent' }), schedule: async input => { scheduled.push(input.dueAt); return null as never; } },
      now: () => now, ownerZone: () => TZ,
      producer: { readSeries: async () => { throw new Error('the ask reads no series'); }, writeContext: async () => { throw new Error('the ask writes nothing'); }, compute: () => { throw new Error('the ask computes nothing'); },
        readScores: async day => { asked.push(day); return typeof scores === 'function' ? (scores as () => Promise<unknown>)() : scores; } },
      forgetDemand: day => { forgotten.push(day); },
    });
    return { recompute, scheduled, forgotten, asked };
  };
  const stored = (day: string) => ({ scores: { day, timezone: TZ, compiled_at: '2026-10-21T05:00:00.000Z', freshness: 'fresh', weight: { zone: 'moderate' } } });

  it('drops today\'s cached busy minutes and asks for one recompute when the owner\'s shared health holds a row for today', async () => {
    const f = setup(stored('2026-10-21'));
    expect(await f.recompute.calendarChanged()).toBe('asked');
    expect([f.asked, f.forgotten, f.scheduled]).toEqual([['2026-10-21'], ['2026-10-21'], [NOW + HEALTH_RECOMPUTE_WINDOW_MS]]);
  });

  it('does nothing when health sharing is off or withdrawn, or no row exists for today, so nothing is begun from the calendar alone', async () => {
    for (const answer of [{ unavailable: 'consent_withdrawn' }, { unavailable: 'consent_required' }, { unavailable: 'no_readings' }, { error: 'not_linked' }, stored('2026-10-20'), null]) {
      const f = setup(answer);
      expect(await f.recompute.calendarChanged()).toBe('no_row');
      expect([f.forgotten, f.scheduled]).toEqual([[], []]);
    }
  });

  it('names today in the owner\'s zone as it is when the change is seen', async () => {
    // 20:00Z is already the 22nd in Kolkata.
    const f = setup(stored('2026-10-22'), Date.parse('2026-10-21T20:00:00Z'));
    expect(await f.recompute.calendarChanged()).toBe('asked');
    expect(f.asked).toEqual(['2026-10-22']);
  });

  it('fails, asking nothing, when the row cannot be read', async () => {
    const f = setup(async () => { throw new Error('health plane 503'); });
    await expect(f.recompute.calendarChanged()).rejects.toThrow('health plane 503');
    expect([f.forgotten, f.scheduled]).toEqual([[], []]);
  });
});

describe('forgetting a day of cached calendar demand', () => {
  const AUTH = 'https://www.googleapis.com/auth/';
  const SCOPES = [`${AUTH}calendar.events`, `${AUTH}calendar.events.freebusy`, `${AUTH}calendar.calendarlist.readonly`];
  it('makes the next read fetch that day again and keeps the other days', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('health-replan-demand')), async (_i, state) => {
      const sql = state.storage.sql;
      // Nothing cached yet: forgetting is a no-op, not an error.
      forgetDemandDay(sql, '2026-10-21', NOW - 60_000);
      const calls: string[] = [];
      const client: DemandClient = {
        async calendarListsPage() { return { items: [{ id: 'primary', title: 'primary', access_role: 'owner', primary: true, selected: true, hidden: false } as CalendarListItem], next_page_token: null, fetched_count: 1, account: null as never, observed_at: new Date(NOW).toISOString() }; },
        async freeBusy(from, to, ids) { calls.push(`${from}..${to}`); return { from, to, calendars: Object.fromEntries(ids.map(id => [id, { busy: [] }])) } as FreeBusyResult; },
      };
      const demand = calendarDemand({ sql, now: () => NOW, accounts: async () => [{ email: 'owner@example.test', scopes: SCOPES, error: null }], client: async () => client });
      const range = { from: '2026-10-19', to: '2026-10-21', timezone: TZ };
      await demand.read(range);
      const first = calls.length;
      await demand.read(range);
      expect(calls.length).toBe(first);
      forgetDemandDay(sql, '2026-10-21', NOW);
      await demand.read(range);
      expect(calls.slice(first)).toEqual([`${new Date(Date.parse('2026-10-20T18:30:00Z')).toISOString()}..${new Date(Date.parse('2026-10-21T18:30:00Z')).toISOString()}`]);
    });
  });

  it('keeps a read that was already in flight when the day was dropped from writing its busy minutes back', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('health-replan-demand-race')), async (_i, state) => {
      const sql = state.storage.sql;
      const calls: string[] = [];
      let clock = NOW, release: (() => void) | null = null, hold = false;
      const client: DemandClient = {
        async calendarListsPage() { return { items: [{ id: 'primary', title: 'primary', access_role: 'owner', primary: true, selected: true, hidden: false } as CalendarListItem], next_page_token: null, fetched_count: 1, account: null as never, observed_at: new Date(clock).toISOString() }; },
        async freeBusy(from, to, ids) {
          calls.push(`${from}..${to}`);
          if (hold) await new Promise<void>(resolve => { release = resolve; });
          return { from, to, calendars: Object.fromEntries(ids.map(id => [id, { busy: [] }])) } as FreeBusyResult;
        },
      };
      const demand = calendarDemand({ sql, now: () => clock, accounts: async () => [{ email: 'owner@example.test', scopes: SCOPES, error: null }], client: async () => client });
      const range = { from: '2026-10-21', to: '2026-10-21', timezone: TZ };
      // A read starts and waits on Google; the calendar changes and today is dropped while it waits.
      hold = true;
      const inFlight = demand.read(range);
      while (!release) await new Promise(resolve => setTimeout(resolve, 1));
      clock = NOW + 60_000;
      forgetDemandDay(sql, '2026-10-21', clock);
      hold = false;
      (release as () => void)();
      await inFlight;
      // The next read, well inside the half hour a fresh today is kept, reads today again.
      clock = NOW + 2 * 60_000;
      const before = calls.length;
      await demand.read(range);
      expect(calls.length).toBe(before + 1);
      // And a read that starts after the drop is kept as usual.
      clock = NOW + 3 * 60_000;
      await demand.read(range);
      expect(calls.length).toBe(before + 1);
    });
  });
});
