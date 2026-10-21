import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { busyMinutesByDay, calendarDemand, demandCode, type DemandClient } from '../src/health/calendar-demand';
import { CALENDAR_DEMAND_PATH, readOwnerDemand, verifiedDemandRequest } from '../src/health/calendar-demand-route';
import type { CalendarListItem, FreeBusyResult } from '../src/connectors/google';

let sequence = 0;
const TZ = 'Europe/London';
const NOW = Date.parse('2026-03-20T12:00:00Z');
const MINUTE = 60_000;

const AUTH = 'https://www.googleapis.com/auth/';
// What a consent from the current dialog grants for the calendar: events, free/busy and the calendar list.
const CALENDAR_SCOPES = [`${AUTH}calendar.events`, `${AUTH}calendar.events.freebusy`, `${AUTH}calendar.calendarlist.readonly`];

type Busy = Readonly<{ calendar: string; start: string; end: string }>;
// `failing` calendars answer with a transient error, `gone` calendars with Google's notFound.
type FakeAccount = { calendars: Partial<CalendarListItem>[]; busy: Busy[]; failing?: string[]; gone?: string[]; scopes?: readonly string[] | null };
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
        ...(account.failing?.includes(id) ? { errors: [{ reason: 'backendError' }] } : account.gone?.includes(id) ? { errors: [{ reason: 'notFound' }] } : {}),
      };
    }
    return { from, to, calendars };
  },
});

const withDemand = <T>(work: (sql: SqlStorage) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`calendar-demand-${sequence++}`)), async (_i, state) => work(state.storage.sql));

const setup = (sql: SqlStorage, accounts: Record<string, FakeAccount>, options: { failing?: string[]; now?: () => number } = {}) => {
  const calls: { from: string; to: string; ids: readonly string[] }[] = [];
  const clients: string[] = [];
  const clock = { now: NOW };
  const demand = calendarDemand({
    sql,
    accounts: async () => Object.entries(accounts).map(([email, account]) => ({ email, scopes: account.scopes === undefined ? CALENDAR_SCOPES : account.scopes, error: options.failing?.includes(email) ? 'invalid_grant' : null })),
    client: async email => { clients.push(email); return accounts[email] ? fakeClient(accounts[email]!, calls) : null; },
    now: options.now ?? (() => clock.now),
  });
  return { demand, calls, clients, clock };
};
type Answer = Awaited<ReturnType<ReturnType<typeof calendarDemand>['read']>>;
const byDay = (answer: Answer) => answer.state === 'available' ? Object.fromEntries(answer.days.map(d => [d.day, d.busy_minutes])) : answer;
const partialDays = (answer: Answer) => answer.state === 'available' ? answer.days.filter(d => d.partial).map(d => d.day) : answer;

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
    const answer = await demand.read(range);
    expect(byDay(answer)).toEqual({ '2026-03-18': 0, '2026-03-19': 120, '2026-03-20': 0 });
    expect([partialDays(answer), demandCode(answer)]).toEqual([[], 'complete']);
    expect(calls.flatMap(c => c.ids).sort()).toEqual(['home', 'work']);
  }));

  it('reads an account that granted free/busy and the calendar list without event access', () => withDemand(async sql => {
    const { demand } = setup(sql, { 'work@example.com': { calendars: [calendar('work')], busy: [{ calendar: 'work', start: '2026-03-19T09:00:00Z', end: '2026-03-19T10:00:00Z' }], scopes: CALENDAR_SCOPES.slice(1) } });
    expect(byDay(await demand.read(range))).toMatchObject({ '2026-03-19': 60 });
  }));

  it('is unknown, not free, when a calendar account lacks free/busy or the calendar list', () => withDemand(async sql => {
    const cases: Record<string, readonly string[] | null> = { eventsOnly: CALENDAR_SCOPES.slice(0, 1), noList: CALENDAR_SCOPES.slice(0, 2), legacyGrant: null };
    for (const [label, scopes] of Object.entries(cases)) {
      const { demand, clients } = setup(sql, { 'work@example.com': { calendars: [calendar('work')], busy: [], scopes }, 'home@example.com': { calendars: [calendar('home')], busy: [] } });
      expect([label, await demand.read(range), clients]).toEqual([label, { state: 'unavailable', reason: 'scope_gap' }, []]);
    }
  }));

  it('leaves a mail-only account out of the read', () => withDemand(async sql => {
    const mailOnly = { calendars: [calendar('mail')], busy: [], scopes: [`${AUTH}gmail.readonly`] };
    expect(await setup(sql, { 'mail@example.com': mailOnly }).demand.read(range)).toEqual({ state: 'unavailable', reason: 'not_connected' });
    const { demand, clients } = setup(sql, { 'mail@example.com': mailOnly, 'work@example.com': { calendars: [calendar('work')], busy: [] } });
    expect((await demand.read(range)).state).toBe('available');
    expect(clients).toEqual(['work@example.com']);
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
    const account: FakeAccount = { calendars: [calendar('work'), calendar('shared')], busy: [{ calendar: 'work', start: '2026-03-19T09:00:00Z', end: '2026-03-19T10:00:00Z' }], failing: ['shared'] };
    const { demand, calls } = setup(sql, { 'work@example.com': account });
    const unread = await demand.read(range);
    expect([byDay(unread), demandCode(unread)]).toEqual([{ '2026-03-18': null, '2026-03-19': null, '2026-03-20': null }, 'days_unknown']);
    account.failing = [];
    expect(byDay(await demand.read(range))).toEqual({ '2026-03-18': 0, '2026-03-19': 60, '2026-03-20': 0 });
    expect(calls.length).toBe(2);
  }));

  it('leaves out a calendar Google reports gone, and says so on every day it covers', () => withDemand(async sql => {
    const account: FakeAccount = { calendars: [calendar('work'), calendar('old')], busy: [{ calendar: 'work', start: '2026-03-19T09:00:00Z', end: '2026-03-19T10:00:00Z' }], gone: ['old'] };
    const { demand, calls } = setup(sql, { 'work@example.com': account });
    const first = await demand.read(range);
    expect([byDay(first), partialDays(first), demandCode(first)]).toEqual([{ '2026-03-18': 0, '2026-03-19': 60, '2026-03-20': 0 }, ['2026-03-18', '2026-03-19', '2026-03-20'], 'calendar_left_out']);
    expect(partialDays(await demand.read(range))).toEqual(['2026-03-18', '2026-03-19', '2026-03-20']);
    expect(calls.length).toBe(1);
  }));

  it('still treats a stretch as unknown when a gone calendar sits beside one that failed', () => withDemand(async sql => {
    const { demand } = setup(sql, { 'work@example.com': { calendars: [calendar('work'), calendar('old'), calendar('shared')], busy: [], gone: ['old'], failing: ['shared'] } });
    expect(byDay(await demand.read(range))).toEqual({ '2026-03-18': null, '2026-03-19': null, '2026-03-20': null });
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

  it('reads a day again once it has ended if it was cached while still today, so later edits land', () => withDemand(async sql => {
    const account: FakeAccount = { calendars: [calendar('work')], busy: [] };
    const { demand, calls, clock } = setup(sql, { 'work@example.com': account });
    await demand.read(range);
    account.busy = [{ calendar: 'work', start: '2026-03-20T15:00:00Z', end: '2026-03-20T16:00:00Z' }];
    clock.now = Date.parse('2026-03-21T10:00:00Z');
    const later = { ...range, from: '2026-03-19', to: '2026-03-21' };
    expect(byDay(await demand.read(later))).toEqual({ '2026-03-19': 0, '2026-03-20': 60, '2026-03-21': 0 });
    expect(calls[1]).toMatchObject({ from: '2026-03-20T00:00:00.000Z', to: '2026-03-22T00:00:00.000Z' });
    clock.now = Date.parse('2026-03-22T09:00:00Z');
    await demand.read({ ...range, from: '2026-03-20', to: '2026-03-22' });
    expect(calls[2]).toMatchObject({ from: '2026-03-21T00:00:00.000Z', to: '2026-03-23T00:00:00.000Z' });
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
      reAddressed: await resend(await signed('owner-b'), { headers: { 'x-waldo-do-name': 'owner-a' } }),
      widened: await resend(await signed(), { body: { ...range, from: '2026-02-20' } }),
      otherZone: await resend(await signed(), { body: { ...range, timezone: 'Asia/Kolkata' } }),
      wrongMethod: await resend(await signed(), { method: 'GET' }),
    };
    for (const [label, request] of Object.entries(cases)) expect([label, await verifiedDemandRequest(request, SECRET, isOwnerA)]).toEqual([label, null]);
    expect(await verifiedDemandRequest(await signed(), undefined, isOwnerA)).toBeNull();
    expect(await verifiedDemandRequest(await signed(), 'another-secret', isOwnerA)).toBeNull();
  });
});
