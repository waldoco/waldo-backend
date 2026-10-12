import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { busyMinutesByDay, calendarDemand, type DemandClient } from '../src/health/calendar-demand';
import { CALENDAR_DEMAND_PATH, readOwnerDemand, verifiedDemandRequest } from '../src/health/calendar-demand-route';
import type { CalendarListItem, FreeBusyResult } from '../src/connectors/google';

let sequence = 0;
const TZ = 'Europe/London';
const NOW = Date.parse('2026-03-20T12:00:00Z');
const MINUTE = 60_000;

type Busy = Readonly<{ calendar: string; start: string; end: string }>;
type FakeAccount = { calendars: Partial<CalendarListItem>[]; busy: Busy[]; errors?: string[] };
const calendar = (id: string, over: Partial<CalendarListItem> = {}): Partial<CalendarListItem> => ({ id, title: id, access_role: 'owner', primary: false, selected: true, hidden: false, ...over });

const fakeClient = (account: FakeAccount, calls: { from: string; to: string; ids: readonly string[] }[]): DemandClient => ({
  async calendarListsPage() {
    return { items: account.calendars as CalendarListItem[], next_page_token: null, fetched_count: account.calendars.length, account: null as never, observed_at: new Date(NOW).toISOString() };
  },
  async freeBusy(from, to, ids) {
    calls.push({ from, to, ids });
    const calendars: Record<string, FreeBusyResult['calendars'][string]> = {};
    for (const id of ids) {
      calendars[id] = {
        busy: account.busy.filter(b => b.calendar === id && Date.parse(b.end) > Date.parse(from) && Date.parse(b.start) < Date.parse(to)).map(({ start, end }) => ({ start, end })),
        ...(account.errors?.includes(id) ? { errors: [{ reason: 'notFound' }] } : {}),
      };
    }
    return { from, to, calendars };
  },
});

const withDemand = <T>(work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`calendar-demand-${sequence++}`)), async (_i, state) => work(state.storage.sql));

const setup = (sql: SqlStorage, accounts: Record<string, FakeAccount>, options: { failing?: string[]; now?: () => number } = {}) => {
  const calls: { from: string; to: string; ids: readonly string[] }[] = [];
  const clock = { now: NOW };
  const demand = calendarDemand({
    sql,
    accounts: async () => Object.keys(accounts).map(email => ({ email, calendar: true, error: options.failing?.includes(email) ? 'invalid_grant' : null })),
    client: async email => (accounts[email] ? fakeClient(accounts[email]!, calls) : null),
    now: options.now ?? (() => clock.now),
  });
  return { demand, calls, clock };
};
const byDay = (answer: Awaited<ReturnType<ReturnType<typeof calendarDemand>['read']>>) =>
  answer.state === 'available' ? Object.fromEntries(answer.days.map(d => [d.day, d.busy_minutes])) : answer;

describe('busy minutes per local day', () => {
  it('counts overlapping blocks from different calendars once', () => {
    const minutes = busyMinutesByDay([
      { start: '2026-03-20T09:00:00Z', end: '2026-03-20T10:00:00Z' },
      { start: '2026-03-20T09:30:00Z', end: '2026-03-20T10:30:00Z' },
      { start: '2026-03-20T14:00:00Z', end: '2026-03-20T14:15:00Z' },
    ], ['2026-03-20'], TZ);
    expect(minutes.get('2026-03-20')).toBe(105);
  });
  it('splits a block across local midnight', () => {
    const minutes = busyMinutesByDay([{ start: '2026-03-20T23:00:00Z', end: '2026-03-21T01:00:00Z' }], ['2026-03-20', '2026-03-21'], TZ);
    expect([minutes.get('2026-03-20'), minutes.get('2026-03-21')]).toEqual([60, 60]);
  });
  it('measures a whole local day as 23 or 25 hours across a clock change', () => {
    const spring = busyMinutesByDay([{ start: '2026-03-28T00:00:00Z', end: '2026-03-31T00:00:00Z' }], ['2026-03-29'], TZ);
    const autumn = busyMinutesByDay([{ start: '2026-10-24T00:00:00Z', end: '2026-10-27T00:00:00Z' }], ['2026-10-25'], TZ);
    expect([spring.get('2026-03-29'), autumn.get('2026-10-25')]).toEqual([23 * 60, 25 * 60]);
  });
  it('gives a day with no busy blocks zero', () => {
    expect(busyMinutesByDay([], ['2026-03-20'], TZ).get('2026-03-20')).toBe(0);
  });
});

describe('calendar demand', () => {
  const range = { from: '2026-03-18', to: '2026-03-20', timezone: TZ };

  it('sums the selected, visible calendars of every connected account, and queries no other calendar', () => withDemand(async sql => {
    const { demand, calls } = setup(sql, {
      'work@example.com': { calendars: [calendar('work'), calendar('team', { selected: false })], busy: [{ calendar: 'work', start: '2026-03-19T09:00:00Z', end: '2026-03-19T10:00:00Z' }, { calendar: 'team', start: '2026-03-19T15:00:00Z', end: '2026-03-19T16:00:00Z' }] },
      'home@example.com': { calendars: [calendar('home')], busy: [{ calendar: 'home', start: '2026-03-19T09:30:00Z', end: '2026-03-19T11:00:00Z' }] },
    });
    expect(byDay(await demand.read(range))).toEqual({ '2026-03-18': 0, '2026-03-19': 120, '2026-03-20': 0 });
    expect(calls.flatMap(c => c.ids).sort()).toEqual(['home', 'work']);
  }));

  it('is unavailable with no calendar connection, and forgets what it had cached', () => withDemand(async sql => {
    const accounts: Record<string, FakeAccount> = { 'work@example.com': { calendars: [calendar('work')], busy: [] } };
    const { demand } = setup(sql, accounts);
    await demand.read(range);
    expect(sql.exec('SELECT COUNT(*) AS n FROM calendar_demand').one().n).toBeGreaterThan(0);
    delete accounts['work@example.com'];
    expect(await demand.read(range)).toEqual({ state: 'unavailable', reason: 'not_connected' });
    expect(sql.exec('SELECT COUNT(*) AS n FROM calendar_demand').one().n).toBe(0);
  }));

  it('serves nothing, cached or not, while a connected account needs reconnecting', () => withDemand(async sql => {
    const accounts = { 'work@example.com': { calendars: [calendar('work')], busy: [] } };
    await setup(sql, accounts).demand.read(range);
    expect(await setup(sql, accounts, { failing: ['work@example.com'] }).demand.read(range)).toEqual({ state: 'unavailable', reason: 'provider_error' });
  }));

  it('is unavailable when no calendar is selected, rather than reporting a free day', () => withDemand(async sql => {
    const { demand } = setup(sql, { 'work@example.com': { calendars: [calendar('work', { selected: false })], busy: [] } });
    expect(await demand.read(range)).toEqual({ state: 'unavailable', reason: 'no_calendars' });
  }));

  it('reports a day it could not read as unknown, never as free, and does not cache it', () => withDemand(async sql => {
    const account = { calendars: [calendar('work'), calendar('shared')], busy: [{ calendar: 'work', start: '2026-03-19T09:00:00Z', end: '2026-03-19T10:00:00Z' }], errors: ['shared'] };
    const { demand, calls } = setup(sql, { 'work@example.com': account });
    expect(byDay(await demand.read(range))).toEqual({ '2026-03-18': null, '2026-03-19': null, '2026-03-20': null });
    account.errors = [];
    expect(byDay(await demand.read(range))).toEqual({ '2026-03-18': 0, '2026-03-19': 60, '2026-03-20': 0 });
    expect(calls.length).toBe(2);
  }));

  it('reuses past days, and refreshes today only after 30 minutes', () => withDemand(async sql => {
    const { demand, calls, clock } = setup(sql, { 'work@example.com': { calendars: [calendar('work')], busy: [] } });
    await demand.read(range);
    clock.now = NOW + 29 * MINUTE;
    await demand.read(range);
    expect(calls.length).toBe(1);
    clock.now = NOW + 31 * MINUTE;
    await demand.read(range);
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ from: '2026-03-20T00:00:00.000Z', to: '2026-03-21T00:00:00.000Z' });
  }));

  it('reads again when the calendar selection or the time zone changes', () => withDemand(async sql => {
    const account = { calendars: [calendar('work')], busy: [] };
    const { demand, calls } = setup(sql, { 'work@example.com': account });
    await demand.read(range);
    account.calendars = [calendar('work'), calendar('team')];
    await demand.read(range);
    await demand.read({ ...range, timezone: 'Asia/Kolkata' });
    expect(calls.map(c => c.ids.length)).toEqual([1, 2, 2]);
  }));

  it('asks for at most seven days and fifty calendars per call', () => withDemand(async sql => {
    const many = Array.from({ length: 60 }, (_, i) => calendar(`c${i}`));
    const { demand, calls } = setup(sql, { 'work@example.com': { calendars: many, busy: [] } });
    const answer = await demand.read({ from: '2026-02-18', to: '2026-03-20', timezone: TZ });
    expect(answer.state === 'available' && answer.days.length).toBe(31);
    expect(calls.every(c => c.ids.length <= 50 && Date.parse(c.to) - Date.parse(c.from) <= 7 * 86_400_000 + 3_600_000)).toBe(true);
    expect(new Set(calls.flatMap(c => c.ids)).size).toBe(60);
  }));

  it('keeps no day older than 35 days', () => withDemand(async sql => {
    const { demand, clock } = setup(sql, { 'work@example.com': { calendars: [calendar('work')], busy: [] } });
    await demand.read({ from: '2026-02-18', to: '2026-03-20', timezone: TZ });
    clock.now = NOW + 10 * 86_400_000;
    await demand.read({ from: '2026-03-29', to: '2026-03-30', timezone: TZ });
    expect(sql.exec<{ day: string }>('SELECT MIN(day) AS day FROM calendar_demand').one().day >= '2026-02-23').toBe(true);
  }));

  it('refuses a range it was not built for', () => withDemand(async sql => {
    const { demand } = setup(sql, { 'work@example.com': { calendars: [calendar('work')], busy: [] } });
    for (const bad of [{ ...range, from: '2026-03-21' }, { ...range, timezone: 'Mars/Base' }, { ...range, from: '2026-01-01' }, { ...range, to: '2026-03-21' }, { ...range, from: 'yesterday' }]) {
      await expect(demand.read(bad)).rejects.toThrow('invalid demand range');
    }
  }));
});

describe('calendar demand route', () => {
  const SECRET = 'fictional-router-secret';
  const range = { from: '2026-03-18', to: '2026-03-20', timezone: TZ };
  // The Worker's request, captured instead of sent.
  const signed = async (doName = 'owner-a') => {
    let sent!: Request;
    const owners = { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => { sent = request; return Response.json({ state: 'unavailable', reason: 'not_connected' }); } }) };
    expect(await readOwnerDemand(owners, SECRET, doName, range)).toEqual({ state: 'unavailable', reason: 'not_connected' });
    return sent;
  };
  const resend = async (request: Request, over: { headers?: Record<string, string>; body?: unknown; method?: string } = {}) =>
    new Request(request.url, { method: over.method ?? request.method, headers: { ...Object.fromEntries(request.headers), ...over.headers }, ...((over.method ?? request.method) === 'POST' ? { body: over.body === undefined ? await request.text() : JSON.stringify(over.body) } : {}) });
  const isOwnerA = (name: string) => name === 'owner-a';

  it('accepts the Worker\'s own request for this owner and range', async () => {
    const request = await signed();
    expect(new URL(request.url).pathname).toBe(CALENDAR_DEMAND_PATH);
    expect(await verifiedDemandRequest(request, SECRET, isOwnerA)).toEqual(range);
  });

  it('refuses a forged, re-addressed, widened or unsigned request', async () => {
    const cases = {
      forged: await resend(await signed(), { headers: { 'x-waldo-demand-sig': '0'.repeat(64) } }),
      otherOwner: await signed('owner-b'),
      widened: await resend(await signed(), { body: { ...range, from: '2026-02-20' } }),
      otherZone: await resend(await signed(), { body: { ...range, timezone: 'Asia/Kolkata' } }),
      wrongMethod: await resend(await signed(), { method: 'GET' }),
    };
    for (const [label, request] of Object.entries(cases)) expect([label, await verifiedDemandRequest(request, SECRET, isOwnerA)]).toEqual([label, null]);
    expect(await verifiedDemandRequest(await signed(), undefined, isOwnerA)).toBeNull();
    expect(await verifiedDemandRequest(await signed(), 'another-secret', isOwnerA)).toBeNull();
  });
});
