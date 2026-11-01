import { calendarDayQueryV1Schema, calendarDayV1Schema, type CalendarDayV1, type CalendarEventV1 } from '../../../contracts/src/app/calendar-day';
import { healthScoreUnavailableReasonV1Schema } from '../../../contracts/src/app/health-ingest';
import { GoogleError, sha256Hex, type CalendarItem, type GoogleClient } from '../connectors/google';
import { isTimeZone, localDayWindow } from '../health/scores/time';
import type { GoogleAccess } from '../tools/live/google';
import { localDayOf } from '../tools/live/health';

// The app's calendar day: the owner's timed events on one local day, read live from the primary calendar of every
// connected Google account, and Form across the day. The owner's Durable Object serves it after the session is checked,
// so the owner is always the session's.
export const APP_CALENDAR_DAY_PATH = '/app/v1/calendar/day';

export type CalendarDayHost = Readonly<{
  now: () => number;
  timezone: () => string;
  google: GoogleAccess;
  // The owner's scores_read answer for the day, or null when the health store could not be asked.
  readScores: (day: string) => Promise<unknown>;
}>;

// The connector's page holds at most 50 events; a day with more than 200 is not served cut short.
const PAGE = 50, PAGES = 4, MAX_EVENTS = PAGE * PAGES;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: 'invalid_request' | 'unavailable', status: number) => reply({ error }, status);
const clip = (text: string | undefined, max: number): string => (text ?? '').trim().slice(0, max).trim();

// A dead grant or one missing the calendar scope needs the owner to reconnect; anything else is a failed read.
const revoked = (error: unknown) => error instanceof GoogleError && (error.status === 401 || (error.status === 403 && error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'));

const readPages = async (client: GoogleClient, from: string, to: string): Promise<readonly CalendarItem[]> => {
  if (!client.calendarPage) return client.events(from, to, MAX_EVENTS, false);
  const events: CalendarItem[] = [];
  let token: string | undefined;
  for (let page = 0; page < PAGES; page += 1) {
    const read = await client.calendarPage('primary', from, to, PAGE, false, token);
    events.push(...read.events);
    if (!read.next_page_token) return events;
    token = read.next_page_token;
  }
  throw new Error('calendar day exceeds the page cap');
};

type CalendarRead = Readonly<{ state: 'not_connected' | 'needs_reconnect' }> | Readonly<{ state: 'available'; items: readonly Readonly<{ connection: string; item: CalendarItem }>[] }>;

// An account that could not be read leaves the day unknown, never shown as free, so one dead grant asks for a reconnect and
// a failed read fails the answer.
const readCalendar = async (google: GoogleAccess, from: string, to: string): Promise<CalendarRead> => {
  const known = google.state ? await google.state() : [];
  if (!known.length) return { state: 'not_connected' };
  const calendars = known.filter(account => account.calendar);
  if (!calendars.length || calendars.some(account => account.error !== null)) return { state: 'needs_reconnect' };
  const items: { connection: string; item: CalendarItem }[] = [];
  for (const account of calendars) {
    const client = await google.client('calendar', undefined, undefined, account.email);
    if (!client) throw new Error('calendar client unavailable');
    try { items.push(...(await readPages(client, from, to)).map(item => ({ connection: account.id, item }))); }
    catch (error) { if (revoked(error)) return { state: 'needs_reconnect' }; throw error; }
  }
  return { state: 'available', items };
};

// What the calendar itself says about an event, and nothing judged: a meeting is an event with guests. Deep work and
// meals need a judgement this read does not make, so they stay 'other'. No pill has a source yet, so none is shown.
const toEvent = async (connection: string, item: CalendarItem): Promise<CalendarEventV1 | null> => {
  if (item.all_day || item.status === 'cancelled') return null;
  const start = Date.parse(item.start), end = Date.parse(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // The connector lists guests other than the owner who have not declined, up to 20; past 20 the full attendee count, less
  // the owner, is the better bound.
  const listed = item.attendee_emails?.length ?? 0;
  const guests = listed >= 20 ? Math.max(listed, (item.attendees ?? 0) - 1) : listed;
  const names = (item.attendee_names ?? []).map(name => clip(name, 80)).filter(Boolean).slice(0, Math.min(3, guests));
  return {
    id: `evt_${(await sha256Hex(`${connection}\n${item.id}`)).slice(0, 32)}`,
    title: clip(item.title, 300) || '(no title)',
    detail: clip(item.location, 300) || null,
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    category: guests > 0 ? 'meeting' : 'other',
    attendees: guests > 0 ? { names, more: guests - names.length } : null,
    badges: [],
  };
};

// No intraday Form has been computed for any day yet, so Form is unavailable. The health store's own reason comes first:
// health that is not linked or not shared is said so, and an answer that cannot be read shares nothing.
const formOf = (scores: unknown): CalendarDayV1['form'] => {
  const answer = scores && typeof scores === 'object' && !Array.isArray(scores) ? scores as Record<string, unknown> : null;
  const said = healthScoreUnavailableReasonV1Schema.safeParse(typeof answer?.unavailable === 'string' ? answer.unavailable : answer?.error);
  return { state: 'unavailable', reason: said.success ? said.data : 'intraday_inputs_unavailable' };
};

export const appCalendarDayRequest = async (request: Request, host: CalendarDayHost): Promise<Response> => {
  if (request.method !== 'GET') return refuse('unavailable', 405);
  const url = new URL(request.url);
  const query = calendarDayQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success || [...url.searchParams.keys()].length !== Object.keys(query.data).length) return refuse('invalid_request', 400);
  const timezone = host.timezone(), started = host.now();
  if (!isTimeZone(timezone)) return refuse('unavailable', 503);
  const day = query.data.day ?? localDayOf(new Date(started), timezone);
  const window = localDayWindow(day, timezone);
  const log = (ok: boolean, code: string, count?: number) => console.log(JSON.stringify({ hop: 'app_calendar_day', ok, ms: host.now() - started, code, ...(count === undefined ? {} : { count }) }));
  let calendar: CalendarRead, scores: unknown;
  try {
    [calendar, scores] = await Promise.all([
      readCalendar(host.google, new Date(window.start).toISOString(), new Date(window.end).toISOString()),
      // The health store's client answers null when it could not be asked; either way Form is unavailable and the day still answers.
      host.readScores(day).catch(() => null).then(answer => { if (answer === null) log(false, 'scores_read_failed'); return answer; }),
    ]);
  } catch { log(false, 'calendar_read_failed'); return refuse('unavailable', 503); }
  const readAt = new Date(host.now()).toISOString();
  const mapped = calendar.state === 'available' ? (await Promise.all(calendar.items.map(({ connection, item }) => toEvent(connection, item)))).filter(event => event !== null) : [];
  // An event can come back on two pages when it moves between reads; the first reading of it is kept.
  const unique = [...new Map(mapped.map(event => [event.id, event] as const).reverse()).values()]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (unique.length > MAX_EVENTS) { log(false, 'too_many_events', unique.length); return refuse('unavailable', 503); }
  const body = calendarDayV1Schema.safeParse({
    day, timezone, compiled_at: readAt, freshness: 'fresh',
    calendar: calendar.state === 'available' ? { state: 'available', read_at: readAt } : { state: calendar.state },
    events: unique, form: formOf(scores),
  });
  if (!body.success) { log(false, 'shape'); return refuse('unavailable', 503); }
  log(true, `calendar_${calendar.state}`, unique.length);
  return reply(body.data);
};
