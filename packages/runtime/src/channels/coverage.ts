import type { CoverageFacts } from '../prompt/day-shaping';
import type { DeviceCalendarBook } from './device-calendar';

// The facts the coverage judgment reasons from (CALENDAR_COVERAGE): which accounts are connected and when each calendar was last
// read, whether the phone calendar is shared, and how many events each weekday held over the last two weeks. Counts and times
// only: no title, attendee or calendar id. Whether that looks like the owner's whole day is the model's call.
export const COVERAGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
// Each account's past fortnight is read in one page; a page that fills makes the counts unknown rather than short.
const PAST_EVENTS = 250;
const MAX_ACCOUNTS = 5;

type Account = Readonly<{ id: string; email: string; error: string | null; calendar: boolean }>;
type PastEvent = Readonly<{ start: string; all_day: boolean }>;
export type CoverageDeps = Readonly<{
  now: number; timezone: string;
  accounts(): Promise<readonly Account[]>;
  // When this account's calendars were last read by the update sweep; null when never.
  readAt(accountId: string): number | null;
  // One account's events from `from` to `to`, at most `limit`; null when it cannot be read.
  pastEvents(email: string, from: string, to: string, limit: number): Promise<readonly PastEvent[] | null>;
  // Off when the phone calendar is not offered here.
  phone: Pick<DeviceCalendarBook, 'stored'> | null;
}>;

const weekdayOf = (event: PastEvent, timezone: string): number => {
  const day = event.all_day ? new Date(`${event.start.slice(0, 10)}T12:00:00Z`).getUTCDay()
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(new Date(event.start)));
  return (day + 6) % 7;
};

export const coverageFacts = async (deps: CoverageDeps): Promise<CoverageFacts> => {
  const accounts = await deps.accounts().catch(() => []);
  const calendars = accounts.filter(account => account.calendar && account.error === null).slice(0, MAX_ACCOUNTS);
  const from = new Date(deps.now - COVERAGE_DAYS * DAY_MS).toISOString(), to = new Date(deps.now).toISOString();
  const reads = await Promise.all(calendars.map(account => deps.pastEvents(account.email, from, to, PAST_EVENTS).catch(() => null)));
  const weekdays = calendars.length === 0 || reads.some(read => read === null || read.length >= PAST_EVENTS) ? null : (() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const event of reads.flat() as PastEvent[]) counts[weekdayOf(event, deps.timezone)]! += 1;
    return { counts, days: COVERAGE_DAYS };
  })();
  const stored = deps.phone?.stored().devices ?? [];
  return {
    accounts: accounts.map(account => {
      const read = deps.readAt(account.id);
      return { email: account.email, calendar: account.calendar, failing: account.error !== null, read_minutes_ago: read === null ? null : Math.max(0, Math.floor((deps.now - read) / 60_000)) };
    }),
    phone: deps.phone === null ? { state: 'off' } : stored.length === 0 ? { state: 'not_shared' } : {
      state: 'shared',
      phones: stored.map(device => ({ age_minutes: Math.max(0, Math.floor((deps.now - Date.parse(device.observed_at)) / 60_000)), times_only: device.times_only, complete: device.complete,
        calendars: device.calendars.map(calendar => `${calendar.name ?? 'Unnamed'} (${calendar.account_type})`) })),
    },
    weekdays,
  };
};
