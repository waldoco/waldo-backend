import { calendarPromptProjection, mailPromptProjection, sha256Hex, type CalendarChange, type CalendarItem, type GoogleClient } from '../connectors/google';
import { CALENDAR_LAST_SEEN_TABLE_SCHEMA } from '../do-schema';
import { localDayWindow } from '../health/scores/time';
import { localIso } from './reminders';

const DAY_MS = 24 * 60 * 60_000;
const LAST_SEEN_KEPT_MS = 14 * DAY_MS;
// With the day state on, the sweep reads changes to events from a day back to two weeks ahead: Google matches an event by its
// current times, so a meeting moved out of the next two days is otherwise never seen.
const DAY_STATE_BACK_MS = DAY_MS;
const DAY_STATE_AHEAD_MS = 14 * DAY_MS;
// The events the once-a-day read keeps, soonest first.
const SEED_EVENTS = 250;

type Sql = Pick<SqlStorage, 'exec'>;
type WatchKey = 'calendar_since' | 'mail_since';
// What a calendar change was before it, from what the sweep last saw of the event: never its title, only whether that changed.
export const changeDetail = (change: Change): string => `${change.detail}${change.before ? ` (before: ${JSON.stringify(change.before)})` : ''}`;
export const changeLines = (changes: readonly Change[]): string => changes.map((change) => `- ${change.source} ${change.kind}: ${changeDetail(change)}${change.source_ref ? ` [source_ref ${change.source_ref}]` : ''}`).join('\n');

export type ChangeBefore = Readonly<{ start: string; end: string; all_day: boolean; title_changed: boolean; attendees?: number }>;
// ref: the event or message a reader opens the change by.
export type Change = Readonly<{ source: 'calendar' | 'mail'; kind: 'added' | 'changed' | 'cancelled' | 'new'; detail: string; source_message_id?: string; source_ref?: string; ref?: string; before?: ChangeBefore }>;
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
  const state = (key: string) => sql.exec<{ value: string }>('SELECT value FROM watch_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  const setState = (key: string, value: string) => sql.exec('INSERT INTO watch_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
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
  return { source: 'calendar', kind, detail: JSON.stringify(calendarPromptProjection(event)), ref: `event:${event.id}` };
};

// Whether a change can move the owner's load on one local day: a calendar event that overlaps that day, or one Google
// returned without times (a cancelled event comes back without them, so it may have been that day's).
// A moved event touches the day it left as well as the one it moved to.
export const touchesDay = (change: Change, day: string, timezone: string): boolean => {
  if (change.source !== 'calendar') return false;
  const event = JSON.parse(change.detail) as Partial<Pick<CalendarItem, 'start' | 'end' | 'all_day'>>;
  if (change.before && occupies(change.before, day, timezone)) return true;
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
  seen?: Readonly<{ day: string; seed: readonly SeenEvent[] | null; changed: ReadonlyMap<string, SeenEvent | null> }>;
}>;
const seenOf = async (event: Pick<CalendarItem, 'id' | 'title' | 'start' | 'end' | 'all_day' | 'attendees'>): Promise<SeenEvent> =>
  ({ event_id: event.id, start: event.start, end: event.end, all_day: event.all_day, title_digest: await sha256Hex(event.title), ...(event.attendees === undefined ? {} : { attendees: event.attendees }) });
export const readChanges = async (book: UpdateBook, google: Pick<GoogleClient, 'changedEvents' | 'newMail'>, now: number, sourceFollowups = false,
  dayState?: Readonly<{ day: string; events: GoogleClient['events'] }>): Promise<ChangeRead> => {
  const calendarSince = book.since('calendar_since');
  const mailSince = book.since('mail_since');
  const [from, to] = dayState ? [now - DAY_STATE_BACK_MS, now + DAY_STATE_AHEAD_MS] : [now, now + 2 * DAY_MS];
  const items = calendarSince === null ? [] : await google.changedEvents(calendarSince, from, to);
  const calendar = items.map((item) => toChange(item, calendarSince!));
  const observed: { source_ref: string; thread_id: string; at: number; message_id: string }[] = [];
  const mail = mailSince === null ? [] : (await google.newMail(mailSince, 10)).map((item): Change => {
    const detail = JSON.stringify(mailPromptProjection(item));
    if (!sourceFollowups) return { source: 'mail', kind: 'new', detail, ref: `message:${item.id}` };
    const source_ref = `mail:${item.thread_id || item.id}`;
    observed.push({ source_ref, thread_id: item.thread_id, at: Date.parse(item.at), message_id: item.id });
    return { source: 'mail', kind: 'new', detail, source_ref, source_message_id: item.id };
  });
  if (!dayState) return { changes: [...calendar, ...mail], observed, now };
  const seed = book.seedDue(dayState.day)
    ? await Promise.all((await dayState.events(new Date(from).toISOString(), new Date(to).toISOString(), SEED_EVENTS, true)).map(seenOf)) : null;
  const changed = new Map(await Promise.all(items.map(async (item): Promise<[string, SeenEvent | null]> => [item.id, item.status === 'cancelled' ? null : await seenOf(item)])));
  return { changes: [...calendar, ...mail], observed, now, seen: { day: dayState.day, seed, changed } };
};
// Records what the read observed and moves the watermarks. With the day state it also keeps each event as last seen, and
// returns each calendar change with what the event was before it, read before anything this read saw is kept.
export const writeChanges = (book: UpdateBook, read: ChangeRead): readonly Change[] => {
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
