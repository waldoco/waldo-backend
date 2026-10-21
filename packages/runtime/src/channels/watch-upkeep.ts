import { googleHas } from '../connectors/google';
import { RETRY_AFTER_FAILURE_MS } from '../connectors/google-push';
import type { Scheduler } from '../scheduler/multiplexer';
import { ensureCalendarWatch, type CalendarPushBook, type CalendarWatchMiss } from './calendar-push';
import { ensureGmailWatch, type GmailPushBook, type GmailWatchMiss } from './gmail-push';
import { localIso } from './reminders';

// Keeps the owner's Gmail watch and Calendar channel started and renewed. This is infrastructure: it sends the owner
// nothing, so it runs whatever their schedule preferences and time-zone state are, and a push it enables reaches the
// owner only through the update sweep and that sweep's own gates.
export const WATCH_UPKEEP_ID = 'google-watch-upkeep';
// How often the books are asked. They decide when a watch is due: a day before it lapses, or six hours after a miss.
export const WATCH_UPKEEP_EVERY_MS = 60 * 60_000;

type Scoped = Readonly<{ scopes: readonly string[] | null }>;
export type WatchGrants = Readonly<{ mail: boolean; calendar: boolean }>;
export const watchGrants = (accounts: readonly Scoped[]): WatchGrants => ({
  mail: accounts.some(account => googleHas(account.scopes, 'mail')),
  calendar: accounts.some(account => googleHas(account.scopes, 'calendar')),
});

// Upkeep exists while a mail or calendar grant does. A first arm runs it at once, so an account connected before upkeep
// existed is watched on the owner object's next wake. `restart` runs it at once for a grant that just changed, even while
// it waits out a retry or a pause. Arming never cancels, so a start-up racing a connect cannot undo it. A row this Worker
// cannot read is left as it is.
export const armWatchUpkeep = async (scheduler: Scheduler, grants: WatchGrants, now: number, restart = false): Promise<void> => {
  if (!grants.mail && !grants.calendar) return;
  const found = scheduler.lookup(WATCH_UPKEEP_ID);
  if (found.state === 'unreadable' || (found.state === 'entry' && !restart)) return;
  await scheduler.schedule({
    id: WATCH_UPKEEP_ID, kind: 'watch_upkeep', payloadRefs: { id: WATCH_UPKEEP_ID }, occurrenceAt: now, dueAt: now,
    recurrence: { type: 'interval', every_ms: WATCH_UPKEEP_EVERY_MS, phase_ms: 0 },
  });
};

// Ends upkeep once no mail or calendar grant is left.
export const endWatchUpkeep = async (scheduler: Scheduler, grants: WatchGrants): Promise<void> => {
  if (!grants.mail && !grants.calendar) await scheduler.cancelReadable(WATCH_UPKEEP_ID);
};

type WatchHop = 'calendar_watch' | 'gmail_watch';
export type WatchUpkeepDeps = Readonly<{
  accounts(): Promise<readonly Scoped[]>;
  cancel(): Promise<void>;
  calendar: Omit<Parameters<typeof ensureCalendarWatch>[0], 'now'>;
  gmail: Omit<Parameters<typeof ensureGmailWatch>[0], 'now'>;
  log(line: Readonly<{ hop: WatchHop; ok: boolean; code: string; ms: number }>): void;
}>;

// Each watch runs on its own. One that throws counts as a failed start, so it waits out the same backoff (a stored state
// it could not read is replaced by that failure) and never keeps the other from running. Only a failure that could not
// be recorded is thrown, after both have run, so the scheduler retries it. A watch without its grant is not tried, and
// with no grant left upkeep ends itself, silently.
export const watchUpkeep = async (deps: WatchUpkeepDeps): Promise<void> => {
  const grants = watchGrants(await deps.accounts());
  if (!grants.mail && !grants.calendar) return deps.cancel();
  let unrecorded: unknown;
  const step = async (hop: WatchHop, granted: boolean, book: Readonly<{ fail(now: number): void }>, ensure: (now: number) => Promise<Readonly<{ ok: boolean; code: string }> | null>) => {
    if (!granted) return;
    const now = Date.now();
    let outcome: Readonly<{ ok: boolean; code: string }> | null;
    try { outcome = await ensure(now); } catch {
      outcome = { ok: false, code: `${hop}_failed` };
      try { book.fail(now); } catch (error) { unrecorded ??= error; }
    }
    if (outcome) deps.log({ hop, ...outcome, ms: Date.now() - now });
  };
  await step('calendar_watch', grants.calendar, deps.calendar.book, async now => {
    const watch = await ensureCalendarWatch({ ...deps.calendar, now });
    return watch === 'started' || watch === 'failed' ? { ok: watch === 'started', code: `calendar_watch_${watch}` } : null;
  });
  await step('gmail_watch', grants.mail, deps.gmail.book, async now => {
    const watch = await ensureGmailWatch({ ...deps.gmail, now });
    return watch === 'fresh' ? null : { ok: watch === 'started', code: typeof watch === 'string' ? `gmail_watch_${watch}` : `gmail_watch_skipped:${watch.skipped}` };
  });
  if (unrecorded !== undefined) throw unrecorded;
};

// A host fact for the owner's turn, built from the books and the connected accounts alone: which push is not running and
// what fixes it. A watch with no grant says nothing (the turn already names features that are not connected), and neither
// does a Calendar start this server could not route, which nothing the owner does would fix. Mail is watched through the
// first connected mail account, so an account connected the older way names itself: reconnecting a different account
// would not move the watch.
export const watchStatusLine = (input: Readonly<{
  accounts: readonly (Scoped & Readonly<{ email: string; refresh_token?: string }>)[];
  gmail: ReturnType<GmailPushBook['miss']>; calendar: ReturnType<CalendarPushBook['miss']>; timezone: string;
}>): string => {
  const grants = watchGrants(input.accounts);
  const at = (ms: number) => localIso(ms, input.timezone).replace('T', ' ');
  const failed = (what: string, miss: Readonly<{ at: number }>) =>
    `${what} are not pushed to Waldo right now: starting that failed at ${at(miss.at)}. Waldo tries again by itself after ${at(miss.at + RETRY_AFTER_FAILURE_MS)}; reconnecting Google can fix it sooner.`;
  const older = input.accounts.filter(account => account.refresh_token && googleHas(account.scopes, 'mail')).map(account => JSON.stringify(account.email));
  const gmail: Readonly<Record<GmailWatchMiss, (miss: Readonly<{ at: number }>) => string>> = {
    failed: miss => failed('New emails', miss),
    local_rail: () => older.length
      ? `New emails are not pushed to Waldo: the mail account ${older.join(' and ')} is connected the older way, which cannot be watched. Reconnecting ${older.length > 1 ? 'those accounts' : 'that account'}, or disconnecting ${older.length > 1 ? 'them' : 'it'} if no longer used, fixes it.`
      : 'New emails are not pushed to Waldo: the mail account is connected the older way, which cannot be watched. Reconnecting Google fixes it.',
    no_mail_grant: () => 'New emails are not pushed to Waldo: no connected Google account allows mail. Connecting Google with mail fixes it.',
  };
  const calendar: Readonly<Record<CalendarWatchMiss, ((miss: Readonly<{ at: number }>) => string) | null>> = {
    failed: miss => failed('Calendar changes', miss),
    skipped: null,
  };
  const lines = [
    grants.mail && input.gmail ? gmail[input.gmail.reason](input.gmail) : null,
    grants.calendar && input.calendar ? calendar[input.calendar.reason]?.(input.calendar) ?? null : null,
  ].filter((line): line is string => line !== null);
  return lines.length ? `Google push status, from the host: ${lines.join(' ')} Mail and calendar still work whenever the owner asks. The owner manages Google in the connections of the app or the console; send_console_link sends a console sign-in link where this chat supports it. Mention this only when it bears on what the owner asks.` : '';
};
