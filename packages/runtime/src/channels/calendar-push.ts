import type { ScheduleEntry } from '@waldo/contracts';
import { BRIEF_SWEEP_ID } from './event-briefs';
import { calendarChannelToken, CALENDAR_PUSH_PATH, startCalendarWatch, stopChannel, watchDue, type CalendarWatch, type CalendarWatchState } from '../connectors/google-push';
import type { McpGoogleResolution } from '../tools/live/mcp';

// The owner's Calendar push channel. A push never carries event data: it pulls the existing update
// sweep forward, so the same quiet hours, preferences, delivery routing and update check apply.
// The 10-minute poll stays as the fallback whenever there is no live channel.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown }>;
type Stored = (CalendarWatch & Readonly<{ connection: string | null; highest: number }>) | Readonly<{ failedAt: number }>;
const KEY = 'calendar_push';
const WAKE_GAP_MS = 60_000;

export const calendarPushBook = (kv: Kv) => {
  const read = () => kv.get<Stored>(KEY) ?? null;
  return {
    state: (): CalendarWatchState | null => {
      const stored = read();
      return stored === null ? null : 'failedAt' in stored ? { failedAt: stored.failedAt } : { channelId: stored.channelId, resourceId: stored.resourceId, expiration: stored.expiration };
    },
    connection: (): string | null | undefined => { const stored = read(); return stored && !('failedAt' in stored) ? stored.connection : undefined; },
    record: (watch: CalendarWatch, connection: string | null) => kv.put(KEY, { ...watch, connection, highest: 0 }),
    fail: (now: number) => kv.put(KEY, { failedAt: now }),
    // A new grant may fix what failed, so the next sweep retries at once. A live channel is left alone: starting
    // another while it lives would deliver every change twice.
    clearFailure: () => { const stored = read(); if (stored && 'failedAt' in stored) kv.delete(KEY); },
    // Message numbers only grow per channel: a repeat or an older number is a redelivery.
    admit: (channelId: string, state: 'sync' | 'exists' | 'not_exists', messageNumber: number): 'wake' | 'ignore' => {
      const stored = read();
      if (!stored || 'failedAt' in stored || stored.channelId !== channelId || messageNumber <= stored.highest) return 'ignore';
      kv.put(KEY, { ...stored, highest: messageNumber });
      return state === 'sync' ? 'ignore' : 'wake';
    },
  };
};
export type CalendarPushBook = ReturnType<typeof calendarPushBook>;

type SweepScheduler = Readonly<{
  lookup(id: string): Readonly<{ state: 'absent' } | { state: 'entry'; entry: ScheduleEntry } | { state: 'unreadable' }>;
  pullForward(id: string, at: number): Promise<boolean>;
}>;

// No sweep means the owner turned these updates off or their zone is not confirmed yet: a push changes nothing then.
export const wakeBriefSweep = async (scheduler: SweepScheduler, now: number): Promise<boolean> => {
  const found = scheduler.lookup(BRIEF_SWEEP_ID);
  if (found.state !== 'entry' || found.entry.status !== 'armed') return false;
  return scheduler.pullForward(BRIEF_SWEEP_ID, Math.max(now, (found.entry.last_fired_at ?? -Infinity) + WAKE_GAP_MS));
};

type WatchProxy = Readonly<{
  calendarWatch(doName: string, connection: string, input: Readonly<{ channelId: string; token: string; address: string }>): Promise<CalendarWatch>;
  stopChannel(doName: string, connection: string, channel: Readonly<{ channelId: string; resourceId: string }>): Promise<void>;
}>;

export const ensureCalendarWatch = async (deps: Readonly<{
  book: CalendarPushBook; now: number; origin: string | null; secret: string | undefined; doName: string | undefined;
  resolve(): Promise<McpGoogleResolution | null>; proxy: WatchProxy | null; fetcher: typeof fetch; newId(): string;
}>): Promise<'fresh' | 'started' | 'failed' | 'skipped'> => {
  const { book, now } = deps;
  if (!watchDue(book.state(), now)) return 'fresh';
  if (!deps.origin || !deps.secret || !deps.doName) return 'skipped';
  try {
    const route = await deps.resolve();
    // Nothing to watch with: wait as after a failure, instead of looking up the grant on every sweep.
    if (route === null || (route.mode === 'proxy' && !deps.proxy)) { book.fail(now); return 'skipped'; }
    const channelId = deps.newId();
    const input = { channelId, token: await calendarChannelToken(deps.secret, deps.doName, channelId), address: new URL(CALENDAR_PUSH_PATH, deps.origin).toString() };
    const watch = route.mode === 'bearer' ? await startCalendarWatch(deps.fetcher, route.token, input) : await deps.proxy!.calendarWatch(deps.doName, route.connection, input);
    const previous = book.state();
    const previousConnection = book.connection();
    book.record(watch, route.mode === 'proxy' ? route.connection : null);
    // The old channel would only expire on its own; stop it on the same grant when there is one.
    if (previous && 'channelId' in previous && previousConnection === (route.mode === 'proxy' ? route.connection : null)) {
      const old = { channelId: previous.channelId, resourceId: previous.resourceId };
      await (route.mode === 'bearer' ? stopChannel(deps.fetcher, route.token, old) : deps.proxy!.stopChannel(deps.doName, route.connection, old)).catch(() => undefined);
    }
    return 'started';
  } catch {
    book.fail(now);
    return 'failed';
  }
};
