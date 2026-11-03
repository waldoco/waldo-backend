import { describe, expect, it } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { calendarSet, capCalendars, MAX_READ_CALENDARS, readableCalendars } from '../src/channels/calendar-set';
import { calendarChannelsBook, ensureCalendarWatches } from '../src/channels/calendar-watches';
import { verifyCalendarChannel, type CalendarWatch } from '../src/connectors/google-push';
import type { CalendarListItem } from '../src/connectors/google';

// GOOGLE_REALTIME_TRIAGE: one push channel per calendar the owner reads, each renewed on its own. Every id is synthetic.
const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key), map }; };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const SECRET = 'router-secret-fixture-0000000000';
const listed = (id: string, over: Partial<CalendarListItem> = {}): CalendarListItem => ({ id, title: id, access_role: 'reader', primary: false, selected: true, hidden: false, ...over });
const LIST = [listed('owner@example.test', { primary: true, access_role: 'owner' }), listed('team@group.example.test'), listed('holidays@group.v.calendar.example.test'),
  listed('hidden@example.test', { hidden: true }), listed('unselected@example.test', { selected: false }), listed('busy-only@example.test', { access_role: 'freeBusyReader' })];

const LIST_B = [listed('other@example.test', { primary: true, access_role: 'owner' }), listed('club@group.example.test')];

type Fixture = { list: readonly CalendarListItem[] | Error; route?: Error | null; local?: boolean };
const world = (accounts: Record<string, Fixture> = { a1: { list: LIST } }) => {
  const store = kv();
  const started: { account: string; calendarId: string; channelId: string; token: string }[] = [], stopped: string[] = [], dropped: string[] = [], refuse = new Set<string>();
  let n = 0, now = 1_000 * HOUR;
  const proxy = {
    calendarWatch: async (_doName: string, connection: string, input: { channelId: string; token: string; address: string; calendarId?: string }): Promise<CalendarWatch> => {
      const calendarId = input.calendarId ?? 'primary';
      if (refuse.has(`${connection}/${calendarId}`) || refuse.has(calendarId)) throw new Error('google_push_refused');
      started.push({ account: connection, calendarId, channelId: input.channelId, token: input.token });
      return { channelId: input.channelId, resourceId: `res-${input.channelId}`, expiration: now + 7 * DAY };
    },
    stopChannel: async (_doName: string, _connection: string, channel: { channelId: string }) => { stopped.push(channel.channelId); },
  };
  const book = calendarChannelsBook(store), legacy = calendarPushBook(store), set = calendarSet(store);
  const run = () => ensureCalendarWatches({
    book, legacy, set, now, origin: 'https://waldo.example.test', secret: SECRET, doName: 'owner-do', proxy, fetcher: fetch, newId: () => `chan-${n += 1}`,
    accounts: Object.entries(accounts).map(([id, fixture]) => ({ id, local: fixture.local ?? false,
      route: async () => { if (fixture.route instanceof Error) throw fixture.route; return fixture.route === null ? null : { mode: 'proxy' as const, connection: id }; },
      listCalendars: async () => { if (fixture.list instanceof Error) throw fixture.list; return fixture.list; } })),
    dropSource: (account, calendarId) => { dropped.push(`${account}/${calendarId}`); },
  });
  return { store, book, legacy, set, started, stopped, dropped, refuse, run, accounts, at: (ms: number) => { now = ms; }, now: () => now };
};

describe('every calendar the owner reads', () => {
  it('reads the selected, visible calendars whose events can be listed, the primary by its alias', () => {
    expect(readableCalendars(LIST)).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
  });

  it('caps the calendars read across every account, each primary first', () => {
    const many = (prefix: string, count: number) => ['primary', ...Array.from({ length: count }, (_, i) => `${prefix}${i}@group.example.test`)];
    const capped = capCalendars([['a1', many('a', 15)], ['b2', many('b', 15)], ['c3', ['primary']]]);
    expect(Object.values(capped).flat()).toHaveLength(MAX_READ_CALENDARS);
    expect(Object.entries(capped).map(([account, ids]) => [account, ids[0]])).toEqual([['a1', 'primary'], ['b2', 'primary'], ['c3', 'primary']]);
    expect(capped.a1).toHaveLength(16);
    expect(capped.b2).toHaveLength(3);
  });

  it('golden: starts one channel per read calendar, each with its own signed token naming the owner', async () => {
    const w = world();
    expect(await w.run()).toMatchObject({ started: 3, failed: 0 });
    expect(w.started.map(start => start.calendarId)).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
    expect(new Set(w.started.map(start => start.channelId)).size).toBe(3);
    for (const start of w.started) expect(await verifyCalendarChannel(SECRET, start.token, start.channelId)).toBe('owner-do');
    expect(w.set.calendars('a1')).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
    expect(await w.run()).toMatchObject({ started: 0, fresh: 3 });
  });

  it('a calendar Google will not watch fails alone, is polled meanwhile, and is tried again after the backoff', async () => {
    const w = world();
    w.refuse.add('holidays@group.v.calendar.example.test');
    expect(await w.run()).toMatchObject({ started: 2, failed: 1 });
    expect(w.book.failures()).toEqual([{ account: 'a1', at: w.now() }]);
    w.at(w.now() + HOUR);
    expect(await w.run()).toMatchObject({ started: 0, failed: 0 });
    w.refuse.clear();
    w.at(w.now() + 6 * HOUR);
    expect(await w.run()).toMatchObject({ started: 1 });
    expect(w.book.failures()).toEqual([]);
  });

  it('renews each channel a day before it lapses and stops the one it replaces', async () => {
    const w = world();
    await w.run();
    w.at(w.now() + 6 * DAY + HOUR);
    expect(await w.run()).toMatchObject({ started: 3 });
    expect(w.stopped).toEqual(['chan-1', 'chan-2', 'chan-3']);
  });

  it('a calendar the owner stops reading is stopped, forgotten and its source dropped', async () => {
    const w = world();
    await w.run();
    w.accounts.a1!.list = LIST.slice(0, 2);
    expect(await w.run()).toMatchObject({ stopped: 1 });
    expect(w.stopped).toEqual(['chan-3']);
    expect(w.dropped).toEqual(['a1/holidays@group.v.calendar.example.test']);
    expect(w.book.admit('chan-3', 'exists', 5)).toBeNull();
  });

  it('keeps the last set when the calendar list cannot be read', async () => {
    const w = world();
    await w.run();
    w.accounts.a1!.list = new Error('google 503');
    expect(await w.run()).toMatchObject({ fresh: 3, stopped: 0 });
  });

  it('takes over the live primary channel the older watch started, for the account it was started on', async () => {
    const w = world({ a1: { list: LIST }, b2: { list: LIST_B } });
    w.legacy.record({ channelId: 'legacy-1', resourceId: 'legacy-res', expiration: w.now() + 5 * DAY }, 'b2');
    expect(await w.run()).toMatchObject({ started: 4 });
    expect(w.started.filter(start => start.account === 'b2').map(start => start.calendarId)).toEqual(['club@group.example.test']);
    expect(w.legacy.state()).toBeNull();
    expect(w.book.admit('legacy-1', 'exists', 4)).toEqual({ account: 'b2', calendarId: 'primary' });
  });
});

describe('every connected account', () => {
  it('watches each account on its own channels, and a push names the account and calendar it is for', async () => {
    const w = world({ a1: { list: LIST }, b2: { list: LIST_B } });
    expect(await w.run()).toMatchObject({ started: 5, failed: 0 });
    expect(w.started.map(start => `${start.account}/${start.calendarId}`)).toEqual(['a1/primary', 'a1/team@group.example.test',
      'a1/holidays@group.v.calendar.example.test', 'b2/primary', 'b2/club@group.example.test']);
    expect(w.book.admit('chan-4', 'exists', 1)).toEqual({ account: 'b2', calendarId: 'primary' });
    expect(w.book.admit('chan-1', 'exists', 1)).toEqual({ account: 'a1', calendarId: 'primary' });
  });

  it('one account Google refuses fails alone; the other is watched', async () => {
    const w = world({ a1: { list: LIST, route: new Error('invalid_grant') }, b2: { list: LIST_B } });
    expect(await w.run()).toMatchObject({ started: 2, failed: 3 });
    expect(w.book.failures()).toEqual([{ account: 'a1', at: w.now() }]);
    expect(w.started.every(start => start.account === 'b2')).toBe(true);
  });

  it('an account no longer read has its channels forgotten and its sources dropped; the other keeps its own', async () => {
    const w = world({ a1: { list: LIST }, b2: { list: LIST_B } });
    await w.run();
    delete w.accounts.a1;
    expect(await w.run()).toMatchObject({ started: 0, fresh: 2 });
    expect(w.book.accounts()).toEqual(['b2']);
    expect(w.dropped).toEqual(['a1/primary', 'a1/team@group.example.test', 'a1/holidays@group.v.calendar.example.test']);
    expect(w.book.admit('chan-1', 'exists', 1)).toBeNull();
    expect(w.book.admit('chan-4', 'exists', 1)).toEqual({ account: 'b2', calendarId: 'primary' });
  });

  it('forgetting an account hands back its live channels to stop', async () => {
    const w = world({ a1: { list: LIST }, b2: { list: LIST_B } });
    await w.run();
    expect(w.book.forgetAccount('b2').map(live => live.channelId)).toEqual(['chan-4', 'chan-5']);
    expect(w.book.accounts()).toEqual(['a1']);
  });
});

describe('push admission per channel', () => {
  it('wakes once per new message on each live channel; the handshake and unknown channels never wake', async () => {
    const w = world();
    await w.run();
    expect(w.book.admit('chan-2', 'exists', 2)).toEqual({ account: 'a1', calendarId: 'team@group.example.test' });
    expect(w.book.admit('chan-2', 'exists', 2)).toBeNull();
    expect(w.book.admit('chan-1', 'exists', 1)).toEqual({ account: 'a1', calendarId: 'primary' });
    expect(w.book.admit('chan-3', 'sync', 1)).toBeNull();
    expect(w.book.admit('chan-9', 'exists', 9)).toBeNull();
  });
});
