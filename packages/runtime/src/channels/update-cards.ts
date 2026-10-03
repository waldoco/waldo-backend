import { calendarPromptProjection, mailPromptProjection, type CalendarChange, type GoogleClient } from '../connectors/google';
import { localIso } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
type WatchKey = 'calendar_since' | 'mail_since';
export const changeLines = (changes: readonly Change[]): string => changes.map((change) => `- ${change.source} ${change.kind}: ${change.detail}${change.source_ref ? ` [source_ref ${change.source_ref}]` : ''}`).join('\n');

export type Change = Readonly<{ source: 'calendar' | 'mail'; kind: 'added' | 'changed' | 'cancelled' | 'new'; detail: string; source_message_id?: string; source_ref?: string }>;

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
    pushed(id: number, text: string): void { sql.exec('UPDATE update_cards SET text = ?, pushed = 1 WHERE id = ?', text, id); },
    rate(id: number, feedback: 'useful' | 'not useful'): boolean {
      return sql.exec('UPDATE update_cards SET feedback = ? WHERE id = ? AND pushed = 1 RETURNING id', feedback, id).toArray().length > 0;
    },
    feedback(limit = 8): string {
      return sql.exec<{ text: string; feedback: string }>('SELECT text, feedback FROM update_cards WHERE feedback IS NOT NULL ORDER BY at DESC LIMIT ?', limit).toArray()
        .map((row) => `- ${row.feedback}: ${row.text.replace(/\n/g, ' ')}`).join('\n');
    },
    unfolded(timezone: string): string {
      return sql.exec<{ at: number; changes: string; text: string | null }>('SELECT at, changes, text FROM update_cards WHERE folded = 0 ORDER BY at').toArray()
        .map((row) => `[${localIso(row.at, timezone)}] ${row.text ? `sent as update: ${row.text.replace(/\n/g, ' ')}` : 'not sent'}\n${changeLines(JSON.parse(row.changes) as Change[])}`)
        .join('\n');
    },
    fold(upTo: number): void {
      sql.exec('UPDATE update_cards SET folded = 1 WHERE at <= ?', upTo);
    },
  };
};
export type UpdateBook = ReturnType<typeof updateBook>;

const toChange = (item: CalendarChange, since: number): Change => {
  const { status, created, ...event } = item;
  const kind = status === 'cancelled' ? 'cancelled' : Date.parse(created) >= since ? 'added' : 'changed';
  return { source: 'calendar', kind, detail: JSON.stringify(calendarPromptProjection(event)) };
};

export const collectChanges = async (book: UpdateBook, google: GoogleClient, now: number, sourceFollowups = false): Promise<readonly Change[]> => {
  const calendarSince = book.since('calendar_since');
  const mailSince = book.since('mail_since');
  const calendar = calendarSince === null ? [] : (await google.changedEvents(calendarSince, now, now + 2 * DAY_MS)).map((item) => toChange(item, calendarSince));
  const mail = mailSince === null ? [] : (await google.newMail(mailSince, 10)).map((item): Change => {
    const detail = JSON.stringify(mailPromptProjection(item));
    if (!sourceFollowups) return { source: 'mail', kind: 'new', detail };
    const source_ref = `mail:${item.thread_id || item.id}`;
    book.observeMail(source_ref, item.thread_id, Date.parse(item.at), item.id);
    return { source: 'mail', kind: 'new', detail, source_ref, source_message_id: item.id };
  });
  book.mark('calendar_since', now);
  book.mark('mail_since', now);
  return [...calendar, ...mail];
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
