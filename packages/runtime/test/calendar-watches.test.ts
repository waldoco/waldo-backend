import { describe, expect, it } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { calendarSet, readableCalendars } from '../src/channels/calendar-set';
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

const world = (list: readonly CalendarListItem[] | Error = LIST) => {
  const store = kv();
  const started: { calendarId: string; channelId: string; token: string }[] = [], stopped: string[] = [], dropped: string[] = [], refuse = new Set<string>();
  let n = 0, now = 1_000 * HOUR;
  const proxy = {
    calendarWatch: async (_doName: string, _connection: string, input: { channelId: string; token: string; address: string; calendarId?: string }): Promise<CalendarWatch> => {
      const calendarId = input.calendarId ?? 'primary';
      if (refuse.has(calendarId)) throw new Error('google_push_refused');
      started.push({ calendarId, channelId: input.channelId, token: input.token });
      return { channelId: input.channelId, resourceId: `res-${input.channelId}`, expiration: now + 7 * DAY };
    },
    stopChannel: async (_doName: string, _connection: string, channel: { channelId: string }) => { stopped.push(channel.channelId); },
  };
  const book = calendarChannelsBook(store), legacy = calendarPushBook(store), set = calendarSet(store);
  const run = () => ensureCalendarWatches({
    book, legacy, set, now, origin: 'https://waldo.example.test', secret: SECRET, doName: 'owner-do', proxy, fetcher: fetch,
    resolve: async () => ({ mode: 'proxy', connection: 'conn-1' }) as never, newId: () => `chan-${n += 1}`,
    listCalendars: async () => { if (list instanceof Error) throw list; return list; }, dropCursor: id => { dropped.push(id); },
  });
  return { store, book, legacy, set, started, stopped, dropped, refuse, run, at: (ms: number) => { now = ms; }, now: () => now };
};

describe('every calendar the owner reads', () => {
  it('reads the selected, visible calendars whose events can be listed, the primary by its alias', () => {
    expect(readableCalendars(LIST)).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
  });

  it('golden: starts one channel per read calendar, each with its own signed token naming the owner', async () => {
    const w = world();
    expect(await w.run()).toMatchObject({ started: 3, failed: 0 });
    expect(w.started.map(start => start.calendarId)).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
    expect(new Set(w.started.map(start => start.channelId)).size).toBe(3);
    for (const start of w.started) expect(await verifyCalendarChannel(SECRET, start.token, start.channelId)).toBe('owner-do');
    expect(w.set.calendars()).toEqual(['primary', 'team@group.example.test', 'holidays@group.v.calendar.example.test']);
    expect(await w.run()).toMatchObject({ started: 0, fresh: 3 });
  });

  it('a calendar Google will not watch fails alone, is polled meanwhile, and is tried again after the backoff', async () => {
    const w = world();
    w.refuse.add('holidays@group.v.calendar.example.test');
    expect(await w.run()).toMatchObject({ started: 2, failed: 1 });
    w.at(w.now() + HOUR);
    expect(await w.run()).toMatchObject({ started: 0, failed: 0 });
    w.refuse.clear();
    w.at(w.now() + 6 * HOUR);
    expect(await w.run()).toMatchObject({ started: 1 });
  });

  it('renews each channel a day before it lapses and stops the one it replaces', async () => {
    const w = world();
    await w.run();
    w.at(w.now() + 6 * DAY + HOUR);
    expect(await w.run()).toMatchObject({ started: 3 });
    expect(w.stopped).toEqual(['chan-1', 'chan-2', 'chan-3']);
  });

  it('a calendar the owner stops reading is stopped, forgotten and its cursor dropped', async () => {
    const w = world();
    await w.run();
    const narrowed = world(LIST.slice(0, 2));
    for (const [key, value] of w.store.map) narrowed.store.map.set(key, value);
    expect(await narrowed.run()).toMatchObject({ stopped: 1 });
    expect(narrowed.stopped).toEqual(['chan-3']);
    expect(narrowed.dropped).toEqual(['holidays@group.v.calendar.example.test']);
    expect(narrowed.book.admit('chan-3', 'exists', 5)).toBe('ignore');
  });

  it('keeps the last set when the calendar list cannot be read', async () => {
    const w = world();
    await w.run();
    const failing = world(new Error('google 503'));
    for (const [key, value] of w.store.map) failing.store.map.set(key, value);
    expect(await failing.run()).toMatchObject({ fresh: 3, stopped: 0 });
  });

  it('takes over the live primary channel the older watch started, so primary is never watched twice', async () => {
    const w = world();
    w.legacy.record({ channelId: 'legacy-1', resourceId: 'legacy-res', expiration: w.now() + 5 * DAY }, 'conn-1');
    expect(await w.run()).toMatchObject({ started: 2 });
    expect(w.started.map(start => start.calendarId)).not.toContain('primary');
    expect(w.legacy.state()).toBeNull();
    expect(w.book.admit('legacy-1', 'exists', 4)).toBe('wake');
  });
});

describe('push admission per channel', () => {
  it('wakes once per new message on each live channel; the handshake and unknown channels never wake', async () => {
    const w = world();
    await w.run();
    expect(w.book.admit('chan-2', 'exists', 2)).toBe('wake');
    expect(w.book.admit('chan-2', 'exists', 2)).toBe('ignore');
    expect(w.book.admit('chan-1', 'exists', 1)).toBe('wake');
    expect(w.book.admit('chan-3', 'sync', 1)).toBe('ignore');
    expect(w.book.admit('chan-9', 'exists', 9)).toBe('ignore');
  });
});
