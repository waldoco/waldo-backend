import { calendarPromptProjection, mailPromptProjection, sha256Hex, type CalendarChange, type CalendarDeltaEvent, type CalendarItem, type GoogleClient, type MailItem, type MailLabelChange } from '../connectors/google';
import { CALENDAR_LAST_SEEN_TABLE_SCHEMA } from '../do-schema';
import { localDayWindow } from '../health/scores/time';
import { localIso } from './reminders';

const DAY_MS = 24 * 60 * 60_000;
const LAST_SEEN_KEPT_MS = 14 * DAY_MS;
// With the day state on, the sweep reads changes to events from a day back to two weeks ahead: Google matches an event by its
// current times, so a meeting moved out of the next two days is otherwise never seen.
const DAY_STATE_BACK_MS = DAY_MS;
const DAY_STATE_AHEAD_MS = 14 * DAY_MS;
// A kept event moved out of that window, ahead or into the past, is read in the year either side of it: Google returns only
// what changed since the last read, and the sweep keeps only events it saw before. One now before the window counts only if it
// was last seen inside it, so a meeting that aged out and was then edited (a late reply, a note) is not news. Never seen: a
// move more than a year either side of the window, and a move of an event no read has kept (one past the day's SEED_EVENTS
// that has not changed since).
const MOVED_OUT_MS = 366 * DAY_MS;
// The events the once-a-day read keeps, soonest first.
const SEED_EVENTS = 250;

type Sql = Pick<SqlStorage, 'exec'>;
type WatchKey = 'calendar_since' | 'mail_since';
// What a calendar change was before it, from what the sweep last saw of the event: never its title, only whether that changed.
export const changeDetail = (change: Change): string => `${change.detail}${change.before ? ` (before: ${JSON.stringify(change.before)})` : ''}`;
export const changeLines = (changes: readonly Change[]): string => changes.map((change) => `- ${change.source} ${change.kind}: ${changeDetail(change)}${change.source_ref ? ` [source_ref ${change.source_ref}]` : ''}`).join('\n');

export type ChangeBefore = Readonly<{ start: string; end: string; all_day: boolean; title_changed: boolean; attendees?: number }>;
// ref: the event or message a reader opens the change by.
// read, archived, starred: what the owner did with a mail already seen. more: how many new mails one read left unopened.
// uid: a calendar event's iCal UID, kept beside the detail (never shown), so a phone change and a Google change to the same
// meeting in one batch are said once.
export type Change = Readonly<{ source: 'calendar' | 'mail'; kind: 'added' | 'changed' | 'cancelled' | 'new' | MailLabelChange['change'] | 'more'; detail: string; source_message_id?: string; source_ref?: string; ref?: string; before?: ChangeBefore; uid?: string }>;
// What the owner did with a mail is context for a judgment, never the reason for one.
export const CONTEXT_KINDS: readonly Change['kind'][] = ['read', 'archived', 'starred'];
// A cursor that moved between the read and its write: the write is rolled back and the next tick reads again.
export class CursorMovedError extends Error { constructor() { super('cursor_moved'); this.name = 'CursorMovedError'; } }
const DELTA_SHOWN_KEPT_MS = 14 * DAY_MS;
// An event as the sweep last saw it.
type SeenEvent = Readonly<{ event_id: string; start: string; end: string; all_day: boolean; title_digest: string; attendees?: number }>;

export const updateBook = (sql: Sql) => {
  sql.exec('CREATE TABLE IF NOT EXISTS observed_mail (source_ref TEXT PRIMARY KEY, thread_id TEXT NOT NULL, observed_at INTEGER NOT NULL, message_id TEXT NOT NULL, judged INTEGER NOT NULL DEFAULT 0, update_id INTEGER, attached INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS watch_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL,
    text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
  try {
    sql.exec('ALTER TABLE update_cards ADD COLUMN feedback TEXT');
  } catch {
    // column already exists
  }
  // When the card reached the owner, and the Main chat row it became when that was the app: an id and a time, never text.
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(update_cards)').toArray().map(column => column.name));
  if (!columns.has('delivered_at')) sql.exec('ALTER TABLE update_cards ADD COLUMN delivered_at INTEGER');
  if (!columns.has('app_row')) sql.exec('ALTER TABLE update_cards ADD COLUMN app_row TEXT');
  for (const statement of CALENDAR_LAST_SEEN_TABLE_SCHEMA) sql.exec(statement);
  // What the delta reads last reported of each message and event: a message once, an event as the version last shown, so an
  // overlap is reported once and a change back to an earlier version is news again.
  sql.exec('CREATE TABLE IF NOT EXISTS google_delta_shown (key TEXT PRIMARY KEY, version TEXT NOT NULL, shown_at INTEGER NOT NULL)');
  const state = (key: string) => sql.exec<{ value: string }>('SELECT value FROM watch_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  const setState = (key: string, value: string) => sql.exec('INSERT INTO watch_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  // The triage turn's interrupts on one owner-local day: how many, and when the last went (whatever its day, for the cooldown).
  const interrupts = (day: string): Readonly<{ count: number; last: number | null }> => {
    const stored = state('triage_interrupts');
    const parsed = stored === null ? null : JSON.parse(stored) as { day: string; count: number; last: number };
    return parsed?.day === day ? { count: parsed.count, last: parsed.last } : { count: 0, last: parsed?.last ?? null };
  };
  return {
    observeMail(source_ref: string, thread_id: string, at: number, message_id = source_ref): void {
      sql.exec('INSERT INTO observed_mail (source_ref, thread_id, observed_at, message_id) VALUES (?, ?, ?, ?) ON CONFLICT (source_ref) DO UPDATE SET observed_at = excluded.observed_at, message_id = excluded.message_id, judged = 0, update_id = NULL WHERE observed_mail.message_id != excluded.message_id AND observed_mail.observed_at <= excluded.observed_at', source_ref, thread_id, at, message_id);
    },
    pendingMail(): readonly Change[] {
      return sql.exec<{ source_ref: string; detail: string; source_message_id: string }>(`SELECT m.source_ref, json_extract(j.value, '$.detail') AS detail, m.message_id AS source_message_id
        FROM observed_mail m JOIN update_cards c ON c.id = m.update_id, json_each(c.changes) j
        WHERE m.judged = 0 AND json_extract(j.value, '$.source_ref') = m.source_ref AND json_extract(j.value, '$.source_message_id') = m.message_id
        ORDER BY m.observed_at LIMIT 3`).toArray().map(row => ({ source: 'mail', kind: 'new', ...row }));
    },
    judgedMail(changes: readonly Change[]): void {
      for (const change of changes) if (change.source_ref) sql.exec('UPDATE observed_mail SET judged = 1 WHERE source_ref = ? AND message_id = ?', change.source_ref, change.source_message_id ?? change.source_ref);
    },
    // A sweep job's changes: the new ones it recorded (mail with a source comes back through its pending row instead), and
    // the pending mail among its refs recorded no later than it. Mail recorded after the job was written is not the job's.
    jobChanges(recordId: number, refs: readonly string[]): readonly Change[] {
      const own = sql.exec<{ changes: string }>('SELECT changes FROM update_cards WHERE id = ?', recordId).toArray()[0];
      const changes = own ? (JSON.parse(own.changes) as Change[]).filter(change => !(change.source === 'mail' && change.source_ref)) : [];
      if (!refs.length) return changes;
      return [...changes, ...sql.exec<{ source_ref: string; detail: string; source_message_id: string }>(`SELECT m.source_ref, json_extract(j.value, '$.detail') AS detail, m.message_id AS source_message_id
        FROM observed_mail m JOIN update_cards c ON c.id = m.update_id, json_each(c.changes) j
        WHERE m.judged = 0 AND m.update_id <= ? AND m.source_ref IN (${refs.map(() => '?').join(', ')})
          AND json_extract(j.value, '$.source_ref') = m.source_ref AND json_extract(j.value, '$.source_message_id') = m.message_id
        ORDER BY m.observed_at`, recordId, ...refs).toArray().map((row): Change => ({ source: 'mail', kind: 'new', ...row }))];
    },
    // The job judged its pending mail, by the same bound.
    judgedJob(recordId: number, refs: readonly string[]): void {
      if (refs.length) sql.exec(`UPDATE observed_mail SET judged = 1 WHERE judged = 0 AND update_id <= ? AND source_ref IN (${refs.map(() => '?').join(', ')})`, recordId, ...refs);
    },
    pruneMail(now: number): void {
      sql.exec('DELETE FROM observed_mail WHERE attached = 0 AND observed_at < ?', now - 7 * DAY_MS);
    },
    since(key: WatchKey): number | null {
      const value = state(key);
      return value === null ? null : Number(value);
    },
    mark(key: WatchKey, now: number): void {
      setState(key, String(now));
    },
    // Each delta source ('mail:<account>', 'cal:<account>:<calendar>'): its cursor (a history id or a sync token), when it was
    // last read, and the push waiting on it (when the push came).
    cursor(source: string): string | null { return state(`cursor:${source}`); },
    moveCursor(source: string, from: string | null, to: string): void {
      if (state(`cursor:${source}`) !== from) throw new CursorMovedError();
      setState(`cursor:${source}`, to);
    },
    readAt(source: string): number | null { const value = state(`read:${source}`); return value === null ? null : Number(value); },
    pendingAt(source: string): string | null { return state(`pending:${source}`); },
    pend(source: string, at: number): void { setState(`pending:${source}`, String(at)); },
    sourceDue(source: string, now: number): boolean {
      const read = state(`read:${source}`);
      return read === null || state(`pending:${source}`) !== null || now - Number(read) >= SOURCE_POLL_MS;
    },
    // A push that came while the read ran is still waiting: only the one the read began with is cleared.
    markRead(source: string, at: number, pending: string | null): void {
      setState(`read:${source}`, String(at));
      if (pending !== null) sql.exec('DELETE FROM watch_state WHERE key = ? AND value = ?', `pending:${source}`, pending);
    },
    // Forgets a source: a calendar no longer read, or each source of an account the owner disconnected.
    dropSource(source: string): void {
      for (const kind of ['cursor', 'read', 'pending']) sql.exec('DELETE FROM watch_state WHERE key = ?', `${kind}:${source}`);
    },
    dropAccount(account: string): void {
      for (const kind of ['cursor', 'read', 'pending']) {
        sql.exec('DELETE FROM watch_state WHERE key = ?', `${kind}:${mailSource(account)}`);
        sql.exec('DELETE FROM watch_state WHERE substr(key, 1, ?) = ?', `${kind}:cal:${account}:`.length, `${kind}:cal:${account}:`);
      }
    },
    // Keeps each key's version as shown, and answers which keys are news: never shown, or shown as another version.
    // A version read again keeps its row fresh, so it does not age out while it is still being read.
    shown(keys: readonly DeltaKey[], at: number): ReadonlySet<string> {
      const fresh = new Set(keys.filter(({ key, version }) => {
        const was = sql.exec<{ version: string }>('SELECT version FROM google_delta_shown WHERE key = ?', key).toArray()[0]?.version;
        sql.exec('INSERT INTO google_delta_shown (key, version, shown_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET version = excluded.version, shown_at = excluded.shown_at', key, version, at);
        return was !== version;
      }).map(({ key }) => key));
      sql.exec('DELETE FROM google_delta_shown WHERE shown_at < ?', at - DELTA_SHOWN_KEPT_MS);
      return fresh;
    },
    seen(key: string): boolean { return sql.exec('SELECT 1 FROM google_delta_shown WHERE key = ?', key).toArray().length > 0; },
    // What a mail was when it was recorded: its detail, read back to say which mail the owner read, archived or starred.
    mailDetail(messageId: string): string | null {
      return sql.exec<{ detail: string }>(`SELECT json_extract(j.value, '$.detail') AS detail FROM update_cards c, json_each(c.changes) j
        WHERE json_extract(j.value, '$.source') = 'mail' AND json_extract(j.value, '$.kind') = 'new'
          AND (json_extract(j.value, '$.ref') = ? OR json_extract(j.value, '$.source_message_id') = ?) ORDER BY c.id DESC LIMIT 1`, `message:${messageId}`, messageId).toArray()[0]?.detail ?? null;
    },
    record(day: string, at: number, changes: readonly Change[], text: string | null): number {
      const id = sql.exec<{ id: number }>('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?, ?, ?, ?, ?) RETURNING id', at, day, JSON.stringify(changes), text, text === null ? 0 : 1).one().id;
      for (const change of changes) if (change.source_ref) sql.exec('UPDATE observed_mail SET update_id = ? WHERE source_ref = ? AND message_id = ? AND update_id IS NULL', id, change.source_ref, change.source_message_id ?? change.source_ref);
      return id;
    },
    pushed(id: number, text: string, at: number): void { sql.exec('UPDATE update_cards SET text = ?, pushed = 1, delivered_at = ? WHERE id = ?', text, at, id); },
    linked(id: number, appRow: string): void { sql.exec('UPDATE update_cards SET app_row = ? WHERE id = ?', appRow, id); },
    // The update cards delivered on one local day, newest first. A card delivered before delivery times were kept is not listed.
    delivered(day: string): readonly Readonly<{ app_row: string | null; delivered_at: number }>[] {
      return sql.exec<{ app_row: string | null; delivered_at: number }>(
        'SELECT app_row, delivered_at FROM update_cards WHERE day = ? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC, id DESC', day,
      ).toArray();
    },
    rate(id: number, feedback: 'useful' | 'not useful'): boolean {
      return sql.exec('UPDATE update_cards SET feedback = ? WHERE id = ? AND pushed = 1 RETURNING id', feedback, id).toArray().length > 0;
    },
    feedback(limit = 8): string {
      return sql.exec<{ text: string; feedback: string }>('SELECT text, feedback FROM update_cards WHERE feedback IS NOT NULL ORDER BY at DESC LIMIT ?', limit).toArray()
        .map((row) => `- ${row.feedback}: ${row.text.replace(/\n/g, ' ')}`).join('\n');
    },
    // A row a sweep job wrote with no new changes of its own (it judged earlier mail) and that sent nothing says nothing.
    unfolded(timezone: string): string {
      return sql.exec<{ at: number; changes: string; text: string | null }>("SELECT at, changes, text FROM update_cards WHERE folded = 0 AND (text IS NOT NULL OR changes != '[]') ORDER BY at").toArray()
        .map((row) => `[${localIso(row.at, timezone)}] ${row.text ? `sent as update: ${row.text.replace(/\n/g, ' ')}` : 'not sent'}\n${changeLines(JSON.parse(row.changes) as Change[])}`)
        .join('\n');
    },
    // The rows recorded after `at`, oldest first, read without folding them: the nightly source pass keeps its own mark.
    recordedAfter(at: number, limit: number): readonly Readonly<{ at: number; changes: readonly Change[] }>[] {
      return sql.exec<{ at: number; changes: string }>("SELECT at, changes FROM update_cards WHERE at > ? AND changes != '[]' ORDER BY at LIMIT ?", at, limit).toArray()
        .map((row) => ({ at: row.at, changes: JSON.parse(row.changes) as Change[] }));
    },
    // Whether the owner's day moved after `at` for a meeting with `people`: a calendar change that touches `day`, or new mail
    // from one of them. Other mail leaves the meeting as it was judged.
    changedSince(at: number, day: string, timezone: string, people: readonly string[]): boolean {
      const senders = new Set(people.map(person => person.toLowerCase()));
      // The address in a From header, "Name <address>" or the bare address, compared whole.
      const senderOf = (from: unknown) => { const header = String(from ?? '').trim(); return (/<([^<>]+)>$/.exec(header)?.[1] ?? header).trim().toLowerCase(); };
      return sql.exec<{ changes: string }>("SELECT changes FROM update_cards WHERE at > ? AND changes != '[]' ORDER BY at LIMIT 50", at).toArray()
        .some(row => (JSON.parse(row.changes) as Change[]).some(change => change.source === 'mail'
          ? senders.has(senderOf((JSON.parse(change.detail) as { from?: unknown }).from))
          : touchesDay(change, day, timezone)));
    },
    // The triage turn chose to note this batch only: the next main card does not carry it.
    noted(recordId: number): void { sql.exec('UPDATE update_cards SET folded = 1 WHERE id = ?', recordId); },
    interrupts,
    interrupted(day: string, at: number): void {
      setState('triage_interrupts', JSON.stringify({ day, count: interrupts(day).count + 1, last: at }));
    },
    fold(upTo: number): void {
      sql.exec('UPDATE update_cards SET folded = 1 WHERE at <= ?', upTo);
    },
    // The last-seen events are read in full once per owner day, and kept up to date from every change in between.
    seedDue(day: string): boolean { return state('calendar_seen_day') !== day; },
    lastSeen(eventId: string): SeenEvent | null {
      const row = sql.exec<{ start_at: string; end_at: string; all_day: number; title_digest: string; attendees: number | null }>(
        'SELECT start_at, end_at, all_day, title_digest, attendees FROM calendar_last_seen WHERE event_id = ?', eventId).toArray()[0];
      return row ? { event_id: eventId, start: row.start_at, end: row.end_at, all_day: row.all_day === 1, title_digest: row.title_digest, ...(row.attendees === null ? {} : { attendees: row.attendees }) } : null;
    },
    see(event: SeenEvent, at: number): void {
      sql.exec(`INSERT INTO calendar_last_seen (event_id, start_at, end_at, all_day, title_digest, attendees, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (event_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at, all_day = excluded.all_day,
          title_digest = excluded.title_digest, attendees = excluded.attendees, seen_at = excluded.seen_at`,
        event.event_id, event.start, event.end, event.all_day ? 1 : 0, event.title_digest, event.attendees ?? null, at);
    },
    unsee(eventId: string): void { sql.exec('DELETE FROM calendar_last_seen WHERE event_id = ?', eventId); },
    seeded(day: string, now: number): void {
      setState('calendar_seen_day', day);
      sql.exec('DELETE FROM calendar_last_seen WHERE seen_at < ?', now - LAST_SEEN_KEPT_MS);
    },
  };
};
export type UpdateBook = ReturnType<typeof updateBook>;

const toChange = (item: CalendarChange, since: number): Change => {
  const { status, created, ...event } = item;
  const kind = status === 'cancelled' ? 'cancelled' : Date.parse(created) >= since ? 'added' : 'changed';
  return { source: 'calendar', kind, detail: JSON.stringify(calendarPromptProjection(event)), ref: `event:${event.id}`, ...(event.ical_uid ? { uid: event.ical_uid } : {}) };
};

// Whether a change can move the owner's load on one local day: a calendar event that overlaps that day, or one Google
// returned without times (a cancelled event comes back without them, so it may have been that day's).
// A moved event touches the day it left as well as the one it moved to.
export const touchesDay = (change: Change, day: string, timezone: string): boolean => {
  if (change.source !== 'calendar') return false;
  const event = JSON.parse(change.detail) as Partial<Pick<CalendarItem, 'start' | 'end' | 'all_day'>> & Readonly<{ series?: true }>;
  if (event.series || (change.before && occupies(change.before, day, timezone))) return true;
  if (!event.start || !event.end) return !change.before;
  return occupies({ start: event.start, end: event.end, all_day: event.all_day ?? false }, day, timezone);
};
const occupies = (event: Readonly<{ start: string; end: string; all_day: boolean }>, day: string, timezone: string): boolean => {
  if (event.all_day) return event.start.slice(0, 10) <= day && day < event.end.slice(0, 10);
  const start = Date.parse(event.start), end = Date.parse(event.end), window = localDayWindow(day, timezone);
  return !Number.isFinite(start) || !Number.isFinite(end) || (start < window.end && end > window.start);
};

// What changed since the watermarks, read with no write: the caller records the changes, the mail it observed and the new
// watermarks in one transaction, so a stop between the read and the write leaves the window to be read again.
export type ChangeRead = Readonly<{
  changes: readonly Change[]; now: number;
  observed: readonly Readonly<{ source_ref: string; thread_id: string; at: number; message_id: string }>[];
  // With the day state: the owner day, the day's full read of events when it was due, and each changed event as it is now
  // (null when it was cancelled), by id.
  // seedCapped: the day's read reached its cap, so the latest events in the window are not kept and their changes carry no before.
  seen?: Readonly<{ day: string; seed: readonly SeenEvent[] | null; seedCapped: boolean; changed: ReadonlyMap<string, SeenEvent | null> }>;
  // With the delta reads: each change's dedupe key (null: never deduped), the cursors to move, the sources read (with the
  // push that was waiting on each when its read began), and what each source did.
  delta?: Readonly<{ keys: readonly (DeltaKey | null)[]; cursors: readonly CursorMove[]; reads: readonly SourceRead[]; codes: readonly DeltaCode[] }>;
}>;
type CursorMove = Readonly<{ key: string; from: string | null; to: string }>;
// A message is keyed by its id alone; an event by its id, with what the owner is shown of it as the version.
type DeltaKey = Readonly<{ key: string; version: string }>;
// at: when the source was read up to (null: this read). A source that failed before any read keeps the watermark it would
// have read its gap from, since the shared watermark moves on without it.
type SourceRead = Readonly<{ source: string; pending: string | null; at: number | null }>;
// What a delta read did, as a bounded code for logs: never an id, an address or a calendar name.
export type DeltaCode = `${'mail' | 'calendar'}_${'baseline' | 'rebased' | 'capped' | 'delta_failed' | 'read_failed'}`;
// One connected Google account the delta reads: its client, the calendars it reads by Google id, and whether its mail is read.
// Cursors, read times and waiting pushes are kept per source, so no two accounts share one.
export type DeltaAccount = Readonly<{ id: string; email: string; google: DeltaGoogle; calendars: readonly string[]; mail: boolean }>;
// followups: the address a mail follow-up reads its thread through. Mail from another account is never a follow-up source,
// since its thread would be read in the wrong mailbox.
export type DeltaSource = Readonly<{ accounts: readonly DeltaAccount[]; followups?: string }>;
type DeltaGoogle = Pick<GoogleClient, 'newMail' | 'mailDelta' | 'calendarDelta' | 'changedEventsPage'>;
export const mailSource = (account: string) => `mail:${account}`;
export const calendarSource = (account: string, calendarId: string) => `cal:${account}:${calendarId}`;
// A source no push woke is read on the poll, at most this often; a push marks it to be read on the next tick.
export const SOURCE_POLL_MS = 9 * 60_000;
// What one tick reads the older way, for a calendar the delta could not read: a few pages of the window since its last read.
const WINDOW_PAGES = 4;
// A calendar cursor that holds this, and when, instead of a sync token: its baseline was past the page cap.
const CAPPED = 'capped:';
// The kept title only answers whether it changed. It is an HMAC under a random key made once for the owner's object and kept in
// its own storage, never logged or exported, so a short, guessable title can't be recovered from it by hashing a dictionary.
const TITLE_KEY = 'calendar_title_key_v1';
type TitleKeyStore = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
export type TitleDigest = (title: string) => Promise<string>;
export const titleDigester = (kv: TitleKeyStore): TitleDigest => {
  let key: Promise<CryptoKey> | undefined;
  return async (title) => {
    key ??= (() => {
      let raw = kv.get<string>(TITLE_KEY);
      if (raw === undefined) { raw = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); kv.put(TITLE_KEY, raw); }
      const bytes = Uint8Array.from(raw.match(/../g)!, pair => parseInt(pair, 16));
      return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
    const mac = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(title));
    return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
};
const seenOf = (digest: TitleDigest) => async (event: Pick<CalendarItem, 'id' | 'title' | 'start' | 'end' | 'all_day' | 'attendees'>): Promise<SeenEvent> =>
  ({ event_id: event.id, start: event.start, end: event.end, all_day: event.all_day, title_digest: await digest(event.title), ...(event.attendees === undefined ? {} : { attendees: event.attendees }) });
export const readChanges = async (book: UpdateBook, google: Pick<GoogleClient, 'changedEvents' | 'newMail'> & Partial<DeltaGoogle>, now: number, sourceFollowups = false,
  dayState?: Readonly<{ day: string; events: GoogleClient['events']; titleDigest: TitleDigest }>, delta?: DeltaSource): Promise<ChangeRead> => {
  const calendarSince = book.since('calendar_since');
  const mailSince = book.since('mail_since');
  const [from, to] = dayState ? [now - DAY_STATE_BACK_MS, now + DAY_STATE_AHEAD_MS] : [now, now + 2 * DAY_MS];
  const found = delta ? await readDelta(book, delta, { calendarSince, mailSince, from, to, now }) : null;
  let items: readonly CalendarChange[], mailItems: readonly MailItem[];
  if (found) ({ items, mail: mailItems } = found);
  else {
    const window = calendarSince === null ? [] : await google.changedEvents(calendarSince, from, to);
    const ids = new Set(window.map(item => item.id));
    const left = (item: CalendarChange) => {
      const last = book.lastSeen(item.id);
      const beforeWindow = Date.parse(item.end) <= from;
      return last !== null && (!beforeWindow || Date.parse(last.end) > from);
    };
    const movedOut = dayState && calendarSince !== null
      ? (await google.changedEvents(calendarSince, from - MOVED_OUT_MS, to + MOVED_OUT_MS)).filter(item => !ids.has(item.id) && left(item)) : [];
    items = [...window, ...movedOut];
    mailItems = mailSince === null ? [] : await google.newMail(mailSince, 10);
  }
  // With the delta reads a change names the owner's account it came from, so a reply or a card can act from that account.
  const withAccount = (detail: object, account: string | undefined) => JSON.stringify(account === undefined ? detail : { ...detail, account });
  const calendar = items.map((item) => {
    const change = toChange(item, calendarSince ?? now);
    return found ? { ...change, detail: withAccount(JSON.parse(change.detail) as object, found.eventAccounts.get(item.id)) } : change;
  });
  const observed: { source_ref: string; thread_id: string; at: number; message_id: string }[] = [];
  const mail = mailItems.map((item): Change => {
    const detail = withAccount(mailPromptProjection(item), found?.mailAccounts.get(item.id));
    if (!sourceFollowups || (found && found.mailAccounts.get(item.id) !== delta?.followups)) return { source: 'mail', kind: 'new', detail, ref: `message:${item.id}` };
    const source_ref = `mail:${item.thread_id || item.id}`;
    observed.push({ source_ref, thread_id: item.thread_id, at: Date.parse(item.at), message_id: item.id });
    return { source: 'mail', kind: 'new', detail, source_ref, source_message_id: item.id };
  });
  const changes = [...calendar, ...mail, ...(found?.after ?? [])];
  const deltaFields = found ? { delta: { keys: [...found.eventKeys, ...mailItems.map(item => ({ key: `msg:${item.id}`, version: '' })), ...(found.after.map(() => null))], cursors: found.cursors, reads: found.reads, codes: found.codes } } : {};
  if (!dayState) return { changes, observed, now, ...deltaFields };
  const seed = book.seedDue(dayState.day)
    ? await Promise.all((await dayState.events(new Date(from).toISOString(), new Date(to).toISOString(), SEED_EVENTS, true)).map(seenOf(dayState.titleDigest))) : null;
  const changed = new Map(await Promise.all(items.map(async (item): Promise<[string, SeenEvent | null]> => [item.id, item.status === 'cancelled' ? null : await seenOf(dayState.titleDigest)(item)])));
  return { changes, observed, now, seen: { day: dayState.day, seed, seedCapped: (seed?.length ?? 0) >= SEED_EVENTS, changed }, ...deltaFields };
};

// The delta reads, account by account: each calendar it reads from its sync token, then its mailbox from its history id. A source
// is read when a push marked it or the poll finds it due. A source whose cursor is new or re-based, or whose delta cannot be
// read, reads its gap once the older way since its own last read; a source whose read fails moves no cursor, and the overlap
// that follows is deduped, so nothing is lost or said twice. One account, or one calendar, that cannot be read holds no other
// back: only when every source due fails does the tick fail, with nothing moved.
const readDelta = async (book: UpdateBook, delta: DeltaSource,
  window: Readonly<{ calendarSince: number | null; mailSince: number | null; from: number; to: number; now: number }>) => {
  const cursors: CursorMove[] = [], codes: DeltaCode[] = [], reads: SourceRead[] = [], after: Change[] = [];
  const events = new Map<string, CalendarChange | CalendarDeltaEvent>(), eventAccounts = new Map<string, string>();
  const mail = new Map<string, MailItem>(), mailAccounts = new Map<string, string>();
  // Google lists changes in no time window: only events in the read window are news, and an event the owner was shown that
  // moved out of it or was cancelled. A recurring series is news wherever its first instance falls.
  const inWindow = (event: CalendarDeltaEvent) => event.series === true || book.lastSeen(event.id) !== null
    || (event.status !== 'cancelled' && Date.parse(event.end) > window.from && Date.parse(event.start) < window.to);
  let due = 0, done = 0, firstFailure: unknown;
  // What is stored when a source's read begins, before any I/O: the write moves its cursor, and clears its push, only if
  // each still holds this.
  const read = async (source: string, since: number | null, body: (held: string | null, since: number | null, moves: CursorMove[]) => Promise<void>, failed: DeltaCode) => {
    if (!book.sourceDue(source, window.now)) return;
    due += 1;
    const held = book.cursor(source), pending = book.pendingAt(source), readAt = book.readAt(source), moves: CursorMove[] = [];
    try {
      await body(held, readAt ?? since, moves);
      cursors.push(...moves);
      reads.push({ source, pending, at: null });
      done += 1;
    } catch (error) {
      codes.push(failed);
      firstFailure ??= error;
      if (readAt === null && since !== null) reads.push({ source, pending: null, at: since });
    }
  };
  for (const account of delta.accounts) {
    const { google } = account;
    // The same meeting sits on each invited account's calendar under one event id: it is read once, from the first account,
    // unless another account holds the invite still to answer.
    const keep = (event: CalendarChange | CalendarDeltaEvent) => {
      const held = events.get(event.id);
      if (held && !(('invite' in event && event.invite) && !('invite' in held && held.invite))) return;
      events.set(event.id, event);
      eventAccounts.set(event.id, account.email);
    };
    for (const calendarId of account.calendars) await read(calendarSource(account.id, calendarId), window.calendarSince, async (held, since, moves) => {
      const key = calendarSource(account.id, calendarId);
      // A baseline past the page cap is tried again a day later, not on every tick; meanwhile the calendar is read the older way.
      const cappedAt = held?.startsWith(CAPPED) ? Number(held.slice(CAPPED.length)) : null;
      const token = cappedAt === null ? held : null;
      let gap = true;
      try {
        const found = cappedAt !== null && window.now - cappedAt < DAY_MS ? null : await google.calendarDelta!(calendarId, token, window.from);
        if (found === null || found.state === 'capped') {
          codes.push('calendar_capped');
          if (found) moves.push({ key, from: held, to: `${CAPPED}${window.now}` });
        } else {
          moves.push({ key, from: held, to: found.sync_token });
          if (found.state === 'delta') { gap = false; for (const event of found.events) if (inWindow(event)) keep(event); }
          else codes.push(token === null ? 'calendar_baseline' : 'calendar_rebased');
        }
      } catch { codes.push('calendar_delta_failed'); }
      if (!gap || since === null) return;
      let page: string | undefined;
      for (let i = 0; i < WINDOW_PAGES; i += 1) {
        const found = await google.changedEventsPage!(calendarId, since, window.from, window.to, 50, page);
        found.events.forEach(keep);
        if (!found.next_page_token) break;
        page = found.next_page_token;
      }
    }, 'calendar_read_failed');
    if (account.mail) await read(mailSource(account.id), window.mailSince, async (held, since, moves) => {
      let added: readonly MailItem[] | null = null, labels: readonly MailLabelChange[] = [], leftOut = 0;
      try {
        const found = await google.mailDelta!(held, 20);
        moves.push({ key: mailSource(account.id), from: held, to: found.history_id });
        if (found.state === 'delta') ({ added, labels, left_out: leftOut } = found);
        else codes.push(found.state === 'capped' ? 'mail_capped' : held === null ? 'mail_baseline' : 'mail_rebased');
      } catch { codes.push('mail_delta_failed'); }
      added ??= since === null ? [] : await google.newMail(since, 10);
      for (const item of added) if (!mail.has(item.id)) { mail.set(item.id, item); mailAccounts.set(item.id, account.email); }
      for (const label of labels) {
        const seen = added.find(item => item.id === label.message_id);
        if (!seen && !book.seen(`msg:${label.message_id}`)) continue;
        after.push({ source: 'mail', kind: label.change, detail: seen ? JSON.stringify({ ...mailPromptProjection(seen), account: account.email }) : book.mailDetail(label.message_id) ?? '{}', ref: `message:${label.message_id}` });
      }
      if (leftOut) after.push({ source: 'mail', kind: 'more', detail: JSON.stringify({ more_messages: leftOut, account: account.email }) });
    }, 'mail_read_failed');
  }
  // An outage, not one source: the tick fails as before and nothing moves. A tick with nothing due reads nothing.
  if (due > 0 && done === 0) throw firstFailure;
  const items = [...events.values()];
  // The key is the event id, and its version what the owner is shown of it in a form every account's copy shares, so a change is
  // said once whichever account reads it, and a change back to an earlier version is said again. Left out: each copy's own
  // etag, link and reply, the guest names (each copy leaves out its own account), and the times' offset (each calendar
  // gives its own), which are compared as instants.
  const instant = (time: string | undefined) => time ? Date.parse(time) : null;
  const eventKeys = await Promise.all(items.map(async (event) => ({ key: `evt:${event.id}`, version: (await sha256Hex(JSON.stringify([event.status,
    instant(event.start), instant(event.end), event.all_day, event.title, event.location ?? null, event.description ?? null, event.attendees ?? null,
    event.recurring_event_id ?? null, instant(event.original_start), 'series' in event ? event.series ?? null : null]))).slice(0, 32) })));
  return { items, mail: [...mail.values()], after, cursors, reads, codes, eventKeys, eventAccounts, mailAccounts };
};
// Records what the read observed and moves the watermarks. With the day state it also keeps each event as last seen, and
// returns each calendar change with what the event was before it, read before anything this read saw is kept.
export const writeChanges = (book: UpdateBook, read: ChangeRead): readonly Change[] => {
  if (read.delta) {
    for (const move of read.delta.cursors) book.moveCursor(move.key, move.from, move.to);
    for (const source of read.delta.reads) book.markRead(source.source, source.at ?? read.now, source.pending);
    const keys = read.delta.keys;
    const fresh = book.shown(keys.filter((key): key is DeltaKey => key !== null), read.now);
    // A key seen twice in one read is new only once.
    const counted = new Set<string>();
    read = { ...read, changes: read.changes.filter((_change, index) => {
      const key = keys[index]?.key ?? null;
      if (key === null) return true;
      if (!fresh.has(key) || counted.has(key)) return false;
      counted.add(key);
      return true;
    }), observed: read.observed.filter(mail => fresh.has(`msg:${mail.message_id}`)) };
  }
  for (const mail of read.observed) book.observeMail(mail.source_ref, mail.thread_id, mail.at, mail.message_id);
  book.mark('calendar_since', read.now);
  book.mark('mail_since', read.now);
  const { seen } = read;
  if (!seen) return read.changes;
  const befores = new Map([...seen.changed.keys()].map(id => [id, book.lastSeen(id)]));
  if (seen.seed) {
    for (const event of seen.seed) book.see(event, read.now);
    book.seeded(seen.day, read.now);
  }
  for (const [id, event] of seen.changed) if (event) book.see(event, read.now); else book.unsee(id);
  return read.changes.map((change): Change => {
    const id = change.source === 'calendar' && change.ref?.startsWith('event:') ? change.ref.slice('event:'.length) : null;
    const was = id === null ? null : befores.get(id);
    if (!was) return change;
    const now = seen.changed.get(id!);
    return { ...change, before: { start: was.start, end: was.end, all_day: was.all_day, title_changed: !!now && now.title_digest !== was.title_digest,
      ...(was.attendees === undefined ? {} : { attendees: was.attendees }) } };
  });
};

// One candidate, one existing responder turn, one frozen owner-only intent. The
// ten-minute update lane also calls this when there is no new inbox mail.
export const reviewMailFollowup = async (deps: Readonly<{
  loops: import('./loops').LoopBook;
  now: number;
  timezone: string;
  allowed: boolean;
  ledger(): Promise<string>;
  prompt(text: string): Promise<string>;
  enqueue(text: string, receipt: import('./telegram-final-outbox').MailFollowupReceipt): Promise<void>;
}>): Promise<boolean> => {
  if (!deps.allowed) return false;
  const loop = deps.loops.reviewDue(localIso(deps.now + 60 * 60_000, deps.timezone).slice(0, 16), deps.timezone, deps.now)[0];
  if (!loop?.source_ref || !loop.due) return false;
  const { mailFollowupPrompt, SKIP_UPDATE } = await import('../prompt/update-cards');
  const text = (await deps.prompt(mailFollowupPrompt(localIso(deps.now, deps.timezone), loop, await deps.ledger()))).trim();
  const receipt = { loopId: loop.id, due: loop.due, sourceRef: loop.source_ref, timezone: deps.timezone, messageId: loop.source_message_id! };
  if (!deps.loops.reviewEligible(receipt, deps.timezone)) return false;
  if (!text || text === SKIP_UPDATE) { deps.loops.reviewSkipped(receipt, deps.now); return false; }
  await deps.enqueue(text, receipt);
  return true;
};
