import { calendarChannelToken, CALENDAR_PUSH_PATH, startCalendarWatch, stopChannel, watchDue, type CalendarWatch, type CalendarWatchState } from '../connectors/google-push';
import type { CalendarListItem } from '../connectors/google';
import type { McpGoogleResolution } from '../tools/live/mcp';
import type { CalendarPushBook } from './calendar-push';
import { readableCalendars, type CalendarSet } from './calendar-set';

// GOOGLE_REALTIME_TRIAGE: one push channel per calendar the owner reads, each started, renewed and backed off on its own. A
// push still only wakes the update sweep, which reads every calendar from its sync token; a calendar Google will not watch
// waits out the backoff and is read on the 10-minute poll meanwhile.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown }>;
type Live = CalendarWatch & Readonly<{ connection: string | null; highest: number }>;
type Entry = Live | Readonly<{ failedAt: number }>;
const KEY = 'calendar_channels_v1';

export const calendarChannelsBook = (kv: Kv) => {
  const read = (): Record<string, Entry> => kv.get<Record<string, Entry>>(KEY) ?? {};
  const write = (entries: Record<string, Entry>) => kv.put(KEY, entries);
  const live = (entry: Entry | undefined): entry is Live => !!entry && 'channelId' in entry;
  return {
    calendars: (): readonly string[] => Object.keys(read()),
    state: (calendarId: string): CalendarWatchState | null => {
      const entry = read()[calendarId];
      return !entry ? null : live(entry) ? { channelId: entry.channelId, resourceId: entry.resourceId, expiration: entry.expiration } : { failedAt: entry.failedAt };
    },
    live: (calendarId: string): Live | null => { const entry = read()[calendarId]; return live(entry) ? entry : null; },
    record: (calendarId: string, watch: CalendarWatch, connection: string | null) => write({ ...read(), [calendarId]: { ...watch, connection, highest: 0 } }),
    fail: (calendarId: string, now: number) => write({ ...read(), [calendarId]: { failedAt: now } }),
    forget: (calendarId: string) => { const { [calendarId]: _gone, ...rest } = read(); write(rest); },
    // Message numbers only grow per channel: a repeat or an older number is a redelivery.
    admit: (channelId: string, state: 'sync' | 'exists' | 'not_exists', messageNumber: number): 'wake' | 'ignore' => {
      const entries = read();
      const found = Object.entries(entries).find(([, entry]) => live(entry) && entry.channelId === channelId);
      if (!found || !live(found[1]) || messageNumber <= found[1].highest) return 'ignore';
      write({ ...entries, [found[0]]: { ...found[1], highest: messageNumber } });
      return state === 'sync' ? 'ignore' : 'wake';
    },
  };
};
export type CalendarChannelsBook = ReturnType<typeof calendarChannelsBook>;

type WatchProxy = Readonly<{
  calendarWatch(doName: string, connection: string, input: Readonly<{ channelId: string; token: string; address: string; calendarId?: string }>): Promise<CalendarWatch>;
  stopChannel(doName: string, connection: string, channel: Readonly<{ channelId: string; resourceId: string }>): Promise<void>;
}>;
export type WatchesOutcome = Readonly<{ started: number; failed: number; fresh: number; stopped: number }> | 'skipped';

export const ensureCalendarWatches = async (deps: Readonly<{
  book: CalendarChannelsBook; legacy: CalendarPushBook; set: CalendarSet; now: number;
  origin: string | null; secret: string | undefined; doName: string | undefined;
  resolve(): Promise<McpGoogleResolution | null>; proxy: WatchProxy | null; fetcher: typeof fetch; newId(): string;
  // The owner's calendar list; null or a throw keeps the set as it was.
  listCalendars(): Promise<readonly CalendarListItem[] | null>;
  // A calendar no longer read loses its sync token, so a later return starts from a fresh baseline.
  dropCursor(calendarId: string): void;
}>): Promise<WatchesOutcome> => {
  const { book, now } = deps;
  if (!deps.origin || !deps.secret || !deps.doName) return 'skipped';
  const route = await deps.resolve();
  if (route === null || (route.mode === 'proxy' && !deps.proxy)) return 'skipped';
  const connection = route.mode === 'proxy' ? route.connection : null;
  const listed = await deps.listCalendars().catch(() => null);
  if (listed) deps.set.set(readableCalendars(listed));
  const calendars = deps.set.calendars();
  // The older watch's primary channel moves here once, so the primary calendar is never watched twice; the older book is left
  // empty, and starts its own channel again if the switch goes back off.
  const legacy = deps.legacy.handOver();
  if (legacy && !book.live('primary')) book.record('primary', legacy, legacy.connection);
  const stop = async (channel: Readonly<{ channelId: string; resourceId: string; connection: string | null }>) => {
    if (channel.connection !== connection) return;
    const old = { channelId: channel.channelId, resourceId: channel.resourceId };
    await (route.mode === 'bearer' ? stopChannel(deps.fetcher, route.token, old) : deps.proxy!.stopChannel(deps.doName!, route.connection, old)).catch(() => undefined);
  };
  let started = 0, failed = 0, fresh = 0, stopped = 0;
  for (const calendarId of calendars) {
    if (!watchDue(book.state(calendarId), now)) { fresh += 1; continue; }
    const previous = book.live(calendarId);
    try {
      const channelId = deps.newId();
      const input = { channelId, token: await calendarChannelToken(deps.secret, deps.doName, channelId), address: new URL(CALENDAR_PUSH_PATH, deps.origin).toString() };
      const watch = route.mode === 'bearer' ? await startCalendarWatch(deps.fetcher, route.token, input, calendarId) : await deps.proxy!.calendarWatch(deps.doName, route.connection, { ...input, calendarId });
      book.record(calendarId, watch, connection);
      started += 1;
      if (previous) await stop(previous);
    } catch {
      book.fail(calendarId, now);
      failed += 1;
    }
  }
  for (const calendarId of book.calendars().filter(id => !calendars.includes(id))) {
    const previous = book.live(calendarId);
    book.forget(calendarId);
    deps.dropCursor(calendarId);
    if (previous) { await stop(previous); stopped += 1; }
  }
  return { started, failed, fresh, stopped };
};
