import { calendarChannelToken, CALENDAR_PUSH_PATH, startCalendarWatch, stopChannel, watchDue, type CalendarWatch, type CalendarWatchState } from '../connectors/google-push';
import type { CalendarListItem } from '../connectors/google';
import type { McpGoogleResolution } from '../tools/live/mcp';
import type { CalendarPushBook } from './calendar-push';
import { capCalendars, readableCalendars, type CalendarSet } from './calendar-set';

// GOOGLE_REALTIME_TRIAGE: one push channel per calendar the owner reads on each connected account, each started, renewed and
// backed off on its own. The channel's stored row names its account, so a push marks just that calendar to be read; a
// calendar Google will not watch waits out the backoff and is read on the poll meanwhile.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown }>;
type Live = CalendarWatch & Readonly<{ connection: string | null; highest: number }>;
type Entry = Live | Readonly<{ failedAt: number }>;
type Entries = Record<string, Record<string, Entry>>;
const KEY = 'calendar_channels_v1';

export const calendarChannelsBook = (kv: Kv) => {
  const read = (): Entries => kv.get<Entries>(KEY) ?? {};
  const write = (entries: Entries) => kv.put(KEY, entries);
  const live = (entry: Entry | undefined): entry is Live => !!entry && 'channelId' in entry;
  const put = (account: string, calendarId: string, entry: Entry | null) => {
    const entries = read();
    const { [calendarId]: _old, ...rest } = entries[account] ?? {};
    write({ ...entries, [account]: entry === null ? rest : { ...rest, [calendarId]: entry } });
  };
  return {
    accounts: (): readonly string[] => Object.keys(read()),
    calendars: (account: string): readonly string[] => Object.keys(read()[account] ?? {}),
    state: (account: string, calendarId: string): CalendarWatchState | null => {
      const entry = read()[account]?.[calendarId];
      return !entry ? null : live(entry) ? { channelId: entry.channelId, resourceId: entry.resourceId, expiration: entry.expiration } : { failedAt: entry.failedAt };
    },
    live: (account: string, calendarId: string): Live | null => { const entry = read()[account]?.[calendarId]; return live(entry) ? entry : null; },
    record: (account: string, calendarId: string, watch: CalendarWatch, connection: string | null) => put(account, calendarId, { ...watch, connection, highest: 0 }),
    fail: (account: string, calendarId: string, now: number) => put(account, calendarId, { failedAt: now }),
    forget: (account: string, calendarId: string) => put(account, calendarId, null),
    // Forgets an account's channels and hands back the live ones, for the caller to stop while it still can.
    forgetAccount: (account: string): readonly Live[] => {
      const { [account]: gone = {}, ...rest } = read();
      write(rest);
      return Object.values(gone).filter(live);
    },
    // A reconnect may fix what failed: the account's calendars are tried at the next upkeep. Live channels are left alone.
    clearFailures: (account: string) => {
      const entries = read();
      if (entries[account]) write({ ...entries, [account]: Object.fromEntries(Object.entries(entries[account]).filter(([, entry]) => live(entry))) });
    },
    // Each account with a calendar whose start failed, and the earliest such failure.
    failures: (): readonly Readonly<{ account: string; at: number }>[] => Object.entries(read()).flatMap(([account, entries]) => {
      const failed = Object.values(entries).filter((entry): entry is Readonly<{ failedAt: number }> => !live(entry)).map(entry => entry.failedAt);
      return failed.length ? [{ account, at: Math.min(...failed) }] : [];
    }),
    // The calendar a push is for. Message numbers only grow per channel: a repeat or an older number is a redelivery.
    admit: (channelId: string, state: 'sync' | 'exists' | 'not_exists', messageNumber: number): Readonly<{ account: string; calendarId: string }> | null => {
      const entries = read();
      for (const [account, calendars] of Object.entries(entries)) for (const [calendarId, entry] of Object.entries(calendars)) {
        if (!live(entry) || entry.channelId !== channelId) continue;
        if (messageNumber <= entry.highest) return null;
        write({ ...entries, [account]: { ...calendars, [calendarId]: { ...entry, highest: messageNumber } } });
        return state === 'sync' ? null : { account, calendarId };
      }
      return null;
    },
  };
};
export type CalendarChannelsBook = ReturnType<typeof calendarChannelsBook>;

type WatchProxy = Readonly<{
  calendarWatch(doName: string, connection: string, input: Readonly<{ channelId: string; token: string; address: string; calendarId?: string }>): Promise<CalendarWatch>;
  stopChannel(doName: string, connection: string, channel: Readonly<{ channelId: string; resourceId: string }>): Promise<void>;
}>;
// A calendar-scoped account to watch: how to reach Google as it (a throw is a failed start for each calendar due), whether it
// is held the older way (a raw token in this object), and its calendar list (null or a throw keeps its set as it was).
export type WatchAccount = Readonly<{ id: string; local: boolean; route(): Promise<McpGoogleResolution | null>; listCalendars(): Promise<readonly CalendarListItem[] | null> }>;
export type WatchesOutcome = Readonly<{ started: number; failed: number; fresh: number; stopped: number }> | 'skipped';

export const ensureCalendarWatches = async (deps: Readonly<{
  book: CalendarChannelsBook; legacy: CalendarPushBook; set: CalendarSet; now: number;
  origin: string | null; secret: string | undefined; doName: string | undefined;
  proxy: WatchProxy | null; fetcher: typeof fetch; newId(): string;
  // The calendar-scoped accounts read, in connect order.
  accounts: readonly WatchAccount[];
  // A calendar no longer read loses its sync token, so a later return starts from a fresh baseline.
  dropSource(account: string, calendarId: string): void;
}>): Promise<WatchesOutcome> => {
  const { book, now, accounts } = deps;
  if (!deps.origin || !deps.secret || !deps.doName) return 'skipped';
  const lists = await Promise.all(accounts.map(account => account.listCalendars().catch(() => null)));
  deps.set.set(capCalendars(accounts.map((account, i) => [account.id, lists[i] ? readableCalendars(lists[i]) : deps.set.calendars(account.id)])));
  // The older watch's primary channel moves here once, to the account it was started on, so that calendar is never watched
  // twice; the older book is left empty, and starts its own channel again if the switch goes back off.
  const legacy = deps.legacy.handOver();
  const heir = legacy && accounts.find(account => legacy.connection === null ? account.local : account.id === legacy.connection);
  if (legacy && heir && !book.live(heir.id, 'primary')) book.record(heir.id, 'primary', legacy, legacy.connection);
  let started = 0, failed = 0, fresh = 0, stopped = 0;
  for (const account of accounts) {
    const calendars = deps.set.calendars(account.id);
    const due = calendars.filter(id => watchDue(book.state(account.id, id), now));
    const stale = book.calendars(account.id).filter(id => !calendars.includes(id));
    fresh += calendars.length - due.length;
    if (!due.length && !stale.length) continue;
    let route: McpGoogleResolution | null;
    try { route = await account.route(); } catch {
      for (const calendarId of due) book.fail(account.id, calendarId, now);
      failed += due.length;
      route = null;
    }
    const usable = route !== null && (route.mode === 'bearer' || deps.proxy !== null) ? route : null;
    const connection = usable?.mode === 'proxy' ? usable.connection : null;
    const stop = async (channel: Live) => {
      if (!usable || channel.connection !== connection) return;
      const old = { channelId: channel.channelId, resourceId: channel.resourceId };
      await (usable.mode === 'bearer' ? stopChannel(deps.fetcher, usable.token, old) : deps.proxy!.stopChannel(deps.doName!, usable.connection, old)).catch(() => undefined);
    };
    if (usable) for (const calendarId of due) {
      const previous = book.live(account.id, calendarId);
      try {
        const channelId = deps.newId();
        const input = { channelId, token: await calendarChannelToken(deps.secret, deps.doName, channelId), address: new URL(CALENDAR_PUSH_PATH, deps.origin).toString() };
        const watch = usable.mode === 'bearer' ? await startCalendarWatch(deps.fetcher, usable.token, input, calendarId) : await deps.proxy!.calendarWatch(deps.doName, usable.connection, { ...input, calendarId });
        book.record(account.id, calendarId, watch, connection);
        started += 1;
        if (previous) await stop(previous);
      } catch {
        book.fail(account.id, calendarId, now);
        failed += 1;
      }
    }
    for (const calendarId of stale) {
      const previous = book.live(account.id, calendarId);
      book.forget(account.id, calendarId);
      deps.dropSource(account.id, calendarId);
      if (previous) { await stop(previous); stopped += 1; }
    }
  }
  // An account no longer read (disconnected, its calendar scope gone, or past the account cap): its channels are forgotten,
  // so their pushes wake nothing, and lapse on their own; a disconnect stops them first.
  for (const account of book.accounts().filter(id => !accounts.some(known => known.id === id))) {
    for (const calendarId of book.calendars(account)) deps.dropSource(account, calendarId);
    book.forgetAccount(account);
  }
  return { started, failed, fresh, stopped };
};
