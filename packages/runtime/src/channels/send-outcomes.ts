import { boundForWhatsApp, recordKind } from './proactive-surface';
import { localIso } from './reminders';
import type { FinalRecord } from './telegram-final-outbox';
import type { KnockFailure } from './whatsapp-window';

// Every message Waldo sends first (anything but a reply inside the owner's own turn) ends with one recorded outcome: delivered,
// failed with a short reason code, or unknown (it may have gone out; nothing proves it did). Until then it is waiting, and what
// holds it is read live. The next run reads today's as one section and the app reads them in the day view, so neither Waldo nor
// the owner takes a message for delivered when it was not. A row is keyed by the send's own id, so recording an ending twice
// (a settlement replayed after a restart) writes it once. Codes and kinds only: no message text is kept here.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
export type SendSurface = 'app' | 'whatsapp' | 'telegram' | 'imessage';
export type SendOutcome = 'waiting' | 'delivered' | 'failed' | 'unknown';
export type SendRow = Readonly<{ id: string; kind: string; surface: SendSurface | null; at: number; outcome: SendOutcome; code?: string; endedAt?: number }>;

const PREFIX = 'send_outcome:';
// Two days, so a run just after midnight still reads late yesterday's; at most this many, newest kept.
const KEPT_MS = 48 * 60 * 60_000, KEPT = 200;
const CODE = /^[a-z][a-z0-9_:]{0,63}$/;

// A send Waldo started: not the final of an owner's turn (inbox) and not a reaction to their message.
export const waldoFirst = (record: FinalRecord): boolean => record.inbox === undefined && record.reaction === undefined;
const put = (kv: Kv, row: SendRow, now: number): void => {
  kv.put(`${PREFIX}${row.id}`, row);
  const rows = [...kv.list<SendRow>({ prefix: PREFIX })].sort(([, a], [, b]) => b.at - a.at);
  rows.forEach(([key, kept], index) => { if (index >= KEPT || now - kept.at >= KEPT_MS) kv.delete(key); });
};
const code = (reason: string | undefined): Readonly<{ code?: string }> => reason && CODE.test(reason) ? { code: reason } : {};

// An outbox record that ended. delivered: the surface took every part (and, where it reports arrival, said so); blocked: nothing
// reached the owner, for the record's reason; quarantined: some or all of it may have.
// surface: where the record went (recordSurface), or null when that cannot be told.
export const recordSendEnded = (kv: Kv, record: FinalRecord, surface: SendSurface | null, now: number): void => {
  if (!waldoFirst(record)) return;
  const outcome = record.status === 'delivered' ? 'delivered' : record.status === 'blocked' ? 'failed' : record.status === 'quarantined' ? 'unknown' : null;
  if (!outcome) return;
  put(kv, { id: record.id, kind: recordKind(record), surface, at: record.createdAt, outcome, ...(outcome === 'delivered' ? {} : code(record.failure ?? record.reason)), endedAt: record.deliveredAt ?? now }, now);
};

// A message Waldo wrote straight into the app chat outside a turn: the write is the delivery, recorded in the same transaction.
export const recordAppSend = (kv: Kv, id: string, kind: string, now: number): void =>
  put(kv, { id, kind, surface: 'app', at: now, outcome: 'delivered', endedAt: now }, now);

// What waits in the outbox now, and what holds it: a closed WhatsApp window (with the last knock's failure, if one stands) or
// simply its turn.
const waitingRows = (records: readonly FinalRecord[], whatsappSubject: string | undefined, windowOpen: boolean, knock: KnockFailure | null): SendRow[] =>
  records.filter(record => waldoFirst(record) && (record.status === 'pending' || record.status === 'attempting' || record.status === 'accepted')).map(record => {
    const whatsapp = boundForWhatsApp(record, whatsappSubject);
    const held = record.status === 'accepted' ? 'awaiting_arrival' : whatsapp && !windowOpen ? (knock ? `window_closed:knock_failed:${knock.reason}` : 'window_closed') : undefined;
    return { id: record.id, kind: recordKind(record), surface: whatsapp ? 'whatsapp' : null, at: record.createdAt, outcome: 'waiting', ...(held ? { code: held } : {}) };
  });

const OUTCOMES: ReadonlySet<string> = new Set(['waiting', 'delivered', 'failed', 'unknown']);
const wellFormed = (row: SendRow): boolean => typeof row?.id === 'string' && typeof row.kind === 'string' && OUTCOMES.has(row.outcome);
// spokeSince: whether the owner has written to Waldo, on any surface, since a time; with it a delivered send says so.
export type SendsDeps = Readonly<{ kv: Kv; records: readonly FinalRecord[]; whatsappSubject?: string; windowOpen: boolean; knock: KnockFailure | null; timezone: string; now: number; spokeSince?(at: number): boolean }>;
// Today's Waldo-first sends in the owner's day, oldest first: those that ended, then those still waiting.
export const sendsToday = (deps: SendsDeps): SendRow[] => {
  const day = localIso(deps.now, deps.timezone).slice(0, 10), today = (at: number) => localIso(at, deps.timezone).startsWith(day);
  const ended = [...deps.kv.list<SendRow>({ prefix: PREFIX })].map(([, row]) => row).filter(wellFormed);
  const endedIds = new Set(ended.map(row => row.id));
  // A row or record with no usable time (written by an older version, or malformed) is left out rather than thrown on.
  return [...ended, ...waitingRows(deps.records, deps.whatsappSubject, deps.windowOpen, deps.knock).filter(row => !endedIds.has(row.id))]
    .filter(row => Number.isSafeInteger(row.at) && row.at > 0 && today(row.at)).sort((a, b) => a.at - b.at);
};

// The app's day view: newest first, at most APP_SENT_TODAY_MAX_V1, with total counting all of today's. No internal id leaves.
export const sentTodayPage = (rows: readonly SendRow[], max: number) => ({
  items: [...rows].reverse().slice(0, max).map(row => ({ kind: row.kind, surface: row.surface, at: row.at, outcome: row.outcome, ...(row.code && row.outcome !== 'delivered' ? { code: row.code } : {}) })),
  total: rows.length,
});

const SURFACE_NAME: Readonly<Record<SendSurface, string>> = { app: 'the app', whatsapp: 'WhatsApp', telegram: 'Telegram', imessage: 'iMessage' };
const said = (row: SendRow, spokeSince?: (at: number) => boolean): string => row.outcome === 'delivered'
  ? `delivered${spokeSince ? spokeSince(row.endedAt ?? row.at) ? '; the owner has written since' : '; no word from the owner since' : ''}`
  : row.outcome === 'waiting' ? `waiting${row.code ? ` (${row.code})` : ''}`
    : `${row.outcome === 'failed' ? 'failed' : 'unknown, it may not have arrived'}${row.code ? ` (${row.code})` : ''}`;
// One host fact for the next run: what Waldo already sent today on its own, and what became of each: how it ended and, once
// delivered, whether the owner has written since. With no daily count, this is what the
// model judges the next unasked message by. Kinds, times, surfaces and codes only, never the words, which stay in their chat.
export const sendsTodaySection = (deps: SendsDeps): string => {
  const rows = sendsToday(deps);
  if (!rows.length) return '';
  const clock = (at: number) => localIso(at, deps.timezone).slice(11, 16);
  return ['Messages Waldo sent first today (not replies), oldest first, and what became of each. An answer to what the owner asked is marked; the rest Waldo sent unasked:',
    ...rows.map(row => `- ${clock(row.at)} ${row.kind === 'answer' ? 'answer to what the owner asked,' : row.kind.replace(/_/g, ' ')}${row.surface ? ` to ${SURFACE_NAME[row.surface]}` : ''}: ${said(row, deps.spokeSince)}`)].join('\n');
};
