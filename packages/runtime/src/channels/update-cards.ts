import type { CalendarChange, GoogleClient } from '../connectors/google';
import { localIso } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
type WatchKey = 'calendar_since' | 'mail_since';
export const changeLines = (changes: readonly Change[]): string => changes.map((change) => `- ${change.source} ${change.kind}: ${change.detail}`).join('\n');

export type Change = Readonly<{ source: 'calendar' | 'mail'; kind: 'added' | 'changed' | 'cancelled' | 'new'; detail: string }>;

export const updateBook = (sql: Sql) => {
  sql.exec('CREATE TABLE IF NOT EXISTS watch_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL,
    text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
  const state = (key: string) => sql.exec<{ value: string }>('SELECT value FROM watch_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  const setState = (key: string, value: string) => sql.exec('INSERT INTO watch_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  return {
    since(key: WatchKey): number | null {
      const value = state(key);
      return value === null ? null : Number(value);
    },
    mark(key: WatchKey, now: number): void {
      setState(key, String(now));
    },
    record(day: string, at: number, changes: readonly Change[], text: string | null): void {
      sql.exec('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?, ?, ?, ?, ?)', at, day, JSON.stringify(changes), text, text === null ? 0 : 1);
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
  return { source: 'calendar', kind, detail: JSON.stringify(event) };
};

export const collectChanges = async (book: UpdateBook, google: GoogleClient, now: number): Promise<readonly Change[]> => {
  const calendarSince = book.since('calendar_since');
  const mailSince = book.since('mail_since');
  const calendar = calendarSince === null ? [] : (await google.changedEvents(calendarSince, now, now + 2 * DAY_MS)).map((item) => toChange(item, calendarSince));
  const mail = mailSince === null ? [] : (await google.newMail(mailSince, 10)).map((item): Change => ({ source: 'mail', kind: 'new', detail: JSON.stringify(item) }));
  book.mark('calendar_since', now);
  book.mark('mail_since', now);
  return [...calendar, ...mail];
};
