import { googleHas, sha256Hex, validFreeBusyCalendar, type GoogleClient } from '../connectors/google';
import { daysBetween, isDay, isTimeZone, localDayWindow, shiftDay } from './scores/time';

// Weight's calendar input: busy minutes per local day from Google free/busy, across every selected calendar of every
// connected account. Only minute counts are kept, never titles, attendees or event ids.
export type DemandClient = Pick<GoogleClient, 'freeBusy' | 'calendarListsPage'>;
export type DemandRequest = Readonly<{ from: string; to: string; timezone: string }>;
// `partial` marks a day read without a calendar Google reported as permanently gone.
export type DemandDay = Readonly<{ day: string; busy_minutes: number | null; partial: boolean }>;
export type DemandAnswer =
  | Readonly<{ state: 'available'; days: readonly DemandDay[] }>
  | Readonly<{ state: 'unavailable'; reason: 'not_connected' | 'no_calendars' | 'scope_gap' | 'provider_error' }>;
export type CalendarDemandDeps = Readonly<{
  sql: SqlStorage;
  accounts: () => Promise<readonly Readonly<{ email: string; scopes: readonly string[] | null; error: string | null }>[]>;
  client: (email: string) => Promise<DemandClient | null>;
  now: () => number;
}>;

const MINUTE_MS = 60_000;
const KEEP_DAYS = 35;
const TODAY_FRESH_MS = 30 * MINUTE_MS;
const CHUNK_DAYS = 7;
const CALENDARS_PER_CALL = 50;
const LIST_PAGES = 4;
// A calendar Google no longer finds is left out and the day is marked partial; any other calendar error is unknown.
const GONE = 'notFound';

const localDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

// Overlapping blocks from different calendars count once.
export const busyMinutesByDay = (busy: readonly Readonly<{ start: string; end: string }>[], days: readonly string[], timeZone: string): Map<string, number> => {
  const merged: [number, number][] = [];
  for (const [start, end] of busy.map(b => [Date.parse(b.start), Date.parse(b.end)] as const).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s < e).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return new Map(days.map(day => {
    const window = localDayWindow(day, timeZone);
    const ms = merged.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, window.end) - Math.max(start, window.start)), 0);
    return [day, Math.round(ms / MINUTE_MS)];
  }));
};

const dayRange = (from: string, to: string): string[] => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => shiftDay(from, i));

export const calendarDemand = (deps: CalendarDemandDeps) => {
  const { sql } = deps;
  sql.exec(`CREATE TABLE IF NOT EXISTS calendar_demand (
    day TEXT NOT NULL, timezone TEXT NOT NULL, calendars TEXT NOT NULL, busy_minutes INTEGER NOT NULL, partial INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (day, timezone, calendars))`);

  const selectedCalendars = async (client: DemandClient): Promise<string[] | null> => {
    if (!client.calendarListsPage) return null;
    const ids: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const listed = await client.calendarListsPage(250, false, token);
      ids.push(...listed.items.filter(item => item.selected && !item.hidden).map(item => item.id));
      if (!listed.next_page_token) return ids;
      token = listed.next_page_token;
    }
    return null;
  };

  // Every account's selected calendars for one stretch of days. A calendar the provider could not read makes the whole
  // stretch unknown, since an unread calendar is not a free one; only a calendar reported gone is left out.
  const fetchStretch = async (sources: readonly Readonly<{ client: DemandClient; ids: readonly string[] }>[], days: readonly string[], timezone: string): Promise<Readonly<{ minutes: Map<string, number>; partial: boolean }> | null> => {
    const from = new Date(localDayWindow(days[0]!, timezone).start).toISOString();
    const to = new Date(localDayWindow(days.at(-1)!, timezone).end).toISOString();
    const busy: { start: string; end: string }[] = [];
    let partial = false;
    try {
      for (const { client, ids } of sources) {
        for (let i = 0; i < ids.length; i += CALENDARS_PER_CALL) {
          const batch = ids.slice(i, i + CALENDARS_PER_CALL);
          const observed = await client.freeBusy(from, to, batch, timezone);
          for (const id of batch) {
            const row = observed.calendars?.[id];
            if (!validFreeBusyCalendar(row)) return null;
            if (row.errors?.length) {
              if (!row.errors.every(error => error.reason === GONE)) return null;
              partial = true;
              continue;
            }
            busy.push(...row.busy);
          }
        }
      }
    } catch {
      return null;
    }
    return { minutes: busyMinutesByDay(busy, days, timezone), partial };
  };

  return {
    async read({ from, to, timezone }: DemandRequest): Promise<DemandAnswer> {
      const now = deps.now();
      if (!isDay(from) || !isDay(to) || !isTimeZone(timezone)) throw new Error('invalid demand range');
      const today = localDay(now, timezone);
      if (from > to || to > today || daysBetween(from, today) >= KEEP_DAYS) throw new Error('invalid demand range');

      const accounts = (await deps.accounts()).filter(account => (['calendar', 'availability', 'calendar_list'] as const).some(feature => googleHas(account.scopes, feature)));
      if (!accounts.length) {
        sql.exec('DELETE FROM calendar_demand');
        return { state: 'unavailable', reason: 'not_connected' };
      }
      if (accounts.some(account => account.error)) return { state: 'unavailable', reason: 'provider_error' };
      // The read uses free/busy and the calendar list. An account with calendar access but not both cannot be read.
      if (accounts.some(account => !googleHas(account.scopes, 'availability') || !googleHas(account.scopes, 'calendar_list'))) return { state: 'unavailable', reason: 'scope_gap' };
      const listed: { email: string; client: DemandClient; ids: string[] }[] = [];
      try {
        for (const account of accounts) {
          const client = await deps.client(account.email);
          const ids = client && await selectedCalendars(client);
          if (!client || !ids) return { state: 'unavailable', reason: 'provider_error' };
          listed.push({ email: account.email, client, ids });
        }
      } catch {
        return { state: 'unavailable', reason: 'provider_error' };
      }
      const sources = listed.filter(source => source.ids.length > 0);
      if (!sources.length) return { state: 'unavailable', reason: 'no_calendars' };

      // The cache is keyed by the exact calendar set, so changing the selection or the zone reads again.
      const calendars = await sha256Hex(listed.map(source => `${source.email}\n${[...source.ids].sort().join('\n')}`).sort().join('\n\n'));
      sql.exec('DELETE FROM calendar_demand WHERE day < ? OR timezone <> ? OR calendars <> ?', shiftDay(today, -KEEP_DAYS), timezone, calendars);
      // A past day is final only once it was read after it ended; today is read again after 30 minutes.
      const cached = new Map(sql.exec<{ day: string; busy_minutes: number; partial: number; fetched_at: number }>(
        'SELECT day, busy_minutes, partial, fetched_at FROM calendar_demand WHERE timezone = ? AND calendars = ? AND day BETWEEN ? AND ?', timezone, calendars, from, to,
      ).toArray().filter(row => (row.day < today ? row.fetched_at >= localDayWindow(row.day, timezone).end : now - row.fetched_at < TODAY_FRESH_MS))
        .map(row => [row.day, { busy_minutes: row.busy_minutes, partial: row.partial === 1 }]));

      const days = dayRange(from, to);
      const missing = days.filter(day => !cached.has(day));
      const found = new Map<string, Readonly<{ busy_minutes: number | null; partial: boolean }>>(cached);
      for (let i = 0; i < missing.length;) {
        // A stretch is consecutive missing days, at most seven.
        const stretch = [missing[i]!];
        while (stretch.length < CHUNK_DAYS && missing[i + stretch.length] === shiftDay(stretch.at(-1)!, 1)) stretch.push(missing[i + stretch.length]!);
        i += stretch.length;
        const read = await fetchStretch(sources, stretch, timezone);
        for (const day of stretch) {
          const value = read?.minutes.get(day) ?? null, partial = read?.partial ?? false;
          found.set(day, { busy_minutes: value, partial });
          if (value !== null) sql.exec('INSERT OR REPLACE INTO calendar_demand (day, timezone, calendars, busy_minutes, partial, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', day, timezone, calendars, value, partial ? 1 : 0, now);
        }
      }
      return { state: 'available', days: days.map(day => ({ day, busy_minutes: found.get(day)?.busy_minutes ?? null, partial: found.get(day)?.partial ?? false })) };
    },
  };
};

// One bounded, content-free reason code per read.
export const demandCode = (answer: DemandAnswer): string =>
  answer.state === 'unavailable' ? answer.reason
    : answer.days.some(day => day.busy_minutes === null) ? 'days_unknown' : answer.days.some(day => day.partial) ? 'calendar_left_out' : 'complete';
