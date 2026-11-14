import { calendarProposalRequestV1Schema, calendarProposalResponseV1Schema, type CalendarProposalChangeV1 } from '../../../contracts/src/app/calendar-proposal';
import { proposeCalendarChangeArgsSchema, type ProposeCalendarChangeArgs } from '../../../contracts/src/tools/schemas/calendar';
import { GoogleError, sha256Hex } from '../connectors/google';
import { isTimeZone, localDayWindow } from '../health/scores/time';
import type { GoogleAccess } from '../tools/live/google';
import { calendarGuestCount, readCalendar, toEvent } from './app-calendar-day';
import type { ApprovalDesk } from './approvals';

// The owner asks, from the app's calendar, for an event to be added, moved or cancelled. This never writes the calendar:
// it hands the change to the approval desk as Waldo's own propose_calendar_change does, and the desk's calendar_change
// card is the only way it happens. The owner's Durable Object serves it serialized, for the session's owner.
export const APP_CALENDAR_PROPOSALS_PATH = '/app/v1/calendar/proposals';

export type CalendarProposalHost = Readonly<{
  now: () => number;
  timezone: () => string;
  google: GoogleAccess;
  sql: SqlStorage;
  desk: Pick<ApprovalDesk, 'propose'>;
  assertCurrent(): Promise<void>;
}>;

type Refusal = 'invalid_request' | 'event_not_found' | 'not_connected' | 'needs_reconnect' | 'request_reused' | 'too_late' | 'unavailable';
const STATUS: Readonly<Record<Refusal, number>> = { invalid_request: 400, event_not_found: 404, not_connected: 409, needs_reconnect: 409, request_reused: 409, too_late: 409, unavailable: 503 };
const reply = (body: object, status: number) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
// The card's reason line: the owner's own ask, not a judgement of Waldo's.
const REASON = 'You asked for this from your calendar.';
// The desk keeps each proposal's operation ref in its frozen payload. The ref names the request and the change it asked
// for, so the ledger row itself answers a repeat, and a request_id reused for a different change is told apart.
const REF = 'app-calendar';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, inner]) => [key, canonical(inner)])) : value;

type Resolved = Readonly<{ refused: Refusal }> | Readonly<{ args: Record<string, unknown> }>;

// The calendar the day screen reads is the one a change lands on: no account is not_connected, a dead or calendar-less
// grant needs a reconnect.
const connection = async (google: GoogleAccess): Promise<Refusal | null> => {
  const known = google.state ? await google.state() : [];
  if (!known.length) return 'not_connected';
  const calendars = known.filter(account => account.calendar);
  return !calendars.length || calendars.some(account => account.error !== null) || !(await google.client('calendar')) ? 'needs_reconnect' : null;
};

const resolve = async (change: CalendarProposalChangeV1, host: CalendarProposalHost, timezone: string): Promise<Resolved> => {
  const started = (instant: string) => Date.parse(instant) <= host.now();
  if (change.action === 'create') {
    const refused = await connection(host.google);
    if (refused) return { refused };
    if (started(change.start)) return { refused: 'too_late' };
    // Inviting guests is asking Google to email them the invitation; the card says so before the owner approves.
    return { args: { action: 'create', title: change.title, start: change.start, end: change.end, reason: REASON,
      ...(change.location ? { location: change.location } : {}), ...(change.guests ? { attendees: change.guests, send_updates: 'all' } : {}) } };
  }
  // An event id is the server's own, good for the local day it was read for: that day is read again and the id matched.
  const window = localDayWindow(change.day, timezone);
  const read = await readCalendar(host.google, new Date(window.start).toISOString(), new Date(window.end).toISOString());
  if (read.state !== 'available') return { refused: read.state };
  let found: (typeof read.items)[number] | undefined;
  for (const candidate of read.items) if ((await toEvent(candidate.connection, candidate.item))?.id === change.event_id) { found = candidate; break; }
  if (!found) return { refused: 'event_not_found' };
  const { account, item } = found;
  if (change.action === 'move' && (started(change.start) || started(item.start))) return { refused: 'too_late' };
  const title = item.title.trim().slice(0, 200).trim();
  // Guests of a moved or cancelled meeting are told by Google, as its own calendar does; the card says they are emailed.
  return { args: { account, action: change.action, event_id: item.id, reason: REASON, ...(title ? { title } : {}),
    ...(change.action === 'move' ? { start: change.start, end: change.end } : {}), ...(calendarGuestCount(item) > 0 ? { send_updates: 'all' } : {}) } };
};

export const appCalendarProposalRequest = async (request: Request, host: CalendarProposalHost): Promise<Response> => {
  if (request.method !== 'POST') return reply({ error: 'unavailable' }, 405);
  await host.assertCurrent();
  const began = host.now();
  // Only the action and a reason code are logged: never a title, a place, a guest or an event id.
  const log = (ok: boolean, code: string, action?: string) => console.log(JSON.stringify({ hop: 'app_calendar_proposal', ok, ms: host.now() - began, code, ...(action ? { action } : {}) }));
  const refuse = (error: Refusal, action?: string) => { log(false, error, action); return reply({ error }, STATUS[error]); };
  let raw: unknown; try { raw = await request.json(); } catch { return refuse('invalid_request'); }
  const asked = calendarProposalRequestV1Schema.safeParse(raw);
  if (!asked.success) return refuse('invalid_request');
  const { request_id, change } = asked.data, action = change.action;
  const raised = (id: string, code: string) => {
    const body = calendarProposalResponseV1Schema.safeParse({ approval_id: id });
    if (!body.success) return refuse('unavailable', action);
    log(true, code, action);
    return reply(body.data, 201);
  };
  const prefix = `${REF}:${request_id}:`, ref = `${prefix}${(await sha256Hex(JSON.stringify(canonical(change)))).slice(0, 32)}`;
  const prior = host.sql.exec<{ id: string; ref: string; status: string }>(
    "SELECT id, json_extract(payload_json, '$.operation_ref') AS ref, status FROM ledger WHERE kind = 'calendar_change' AND substr(json_extract(payload_json, '$.operation_ref'), 1, ?) = ? ORDER BY created_at LIMIT 1",
    prefix.length, prefix).toArray()[0];
  if (prior) {
    if (prior.ref !== ref) return refuse('request_reused', action);
    // A proposal whose card never reached a surface is not one the owner can open; it is not raised a second time either.
    return prior.status === 'card_unconfirmed' ? refuse('unavailable', action) : raised(prior.id, 'repeat');
  }
  const timezone = host.timezone();
  if (!isTimeZone(timezone)) return refuse('unavailable', action);
  let resolved: Resolved;
  try { resolved = await resolve(change, host, timezone); } catch { return refuse('unavailable', action); }
  if ('refused' in resolved) return refuse(resolved.refused, action);
  const args = proposeCalendarChangeArgsSchema.safeParse(resolved.args);
  if (!args.success) return refuse('invalid_request', action);
  let id: string;
  try {
    // No turn and no run origin: a standing grant never acts on it, so the desk can only raise the card.
    id = await host.desk.propose(args.data as ProposeCalendarChangeArgs, undefined, ref);
  } catch (error) {
    // The event went between the day's read and the desk's own read of it.
    return refuse(error instanceof GoogleError && (error.status === 404 || error.status === 410) ? 'event_not_found' : 'unavailable', action);
  }
  await host.assertCurrent();
  return raised(id, 'raised');
};
