import type { HealthWakeReason } from '../health/wakes';

// GENERAL_WAKE: the one inbox of what has come in since Waldo last looked. Every event that may matter (a body fact the code
// computed, a phone that moved, mail and calendar changes, the owner opening the app) lands here and brings the wake forward;
// events that arrive close together are merged into the one wake that reads them all. Code never decides an event does not
// matter: whether any of it is worth acting on is the wake's judgment. A row is one kind and ref, with how many times it came
// and when it last did, so the inbox stays one short list whatever arrives. Rows carry codes, never readings or text from mail.
type Sql = SqlStorage;
export type InboxKind = 'health' | 'place' | 'changes' | 'app_open';
export type InboxRow = Readonly<{ kind: InboxKind; ref: string; first_at: number; last_at: number; count: number }>;

// Events that arrive within this window of each other are read by one wake. It is the time a burst takes to settle (several
// uploads of one night, a move and an arrival, a run of mail), not a judgment of what matters.
export const WAKE_MERGE_MS = 2 * 60_000;

const exists = (sql: Sql) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'wake_inbox'").one().n > 0;

export const wakeInboxBook = (sql: Sql) => ({
  add(kind: InboxKind, ref: string, at: number): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS wake_inbox (kind TEXT NOT NULL, ref TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      count INTEGER NOT NULL, PRIMARY KEY (kind, ref))`);
    sql.exec(`INSERT INTO wake_inbox (kind, ref, first_at, last_at, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (kind, ref) DO UPDATE SET last_at = MAX(last_at, excluded.last_at), count = count + 1`, kind, ref, at, at);
  },
  pending(): readonly InboxRow[] {
    return exists(sql) ? sql.exec<InboxRow>('SELECT kind, ref, first_at, last_at, count FROM wake_inbox ORDER BY first_at, kind, ref').toArray() : [];
  },
  // A wake that read the inbox settles what it read: rows that came again after it looked stay for the next wake.
  settle(readAt: number): void {
    if (exists(sql)) sql.exec('DELETE FROM wake_inbox WHERE last_at <= ?', readAt);
  },
});

const HEALTH_WORDS: Readonly<Record<HealthWakeReason, string>> = {
  zone_change: 'one of their body zones moved (recovery, form or weight)',
  sleep_debt_building: 'their sleep debt is building',
  driver_appeared: 'a new factor appeared in their body read',
  driver_far: 'a factor in their body read is far from their usual',
  load_jump: 'their training load jumped',
  workout_ended: 'a workout just ended',
};
const PLACE_WORDS: Readonly<Record<string, string>> = {
  place_moved: 'one of their phones moved to another time zone or city',
  arrived_home: 'their phone says they just arrived home',
  arrived_gym: 'their phone says they just arrived at the gym',
};
const words = (row: InboxRow): string => row.kind === 'health' ? `Body: ${HEALTH_WORDS[row.ref as HealthWakeReason] ?? 'their body read changed'}.`
  : row.kind === 'place' ? `Place: ${PLACE_WORDS[row.ref] ?? 'their phone\'s place changed'}.`
  : row.kind === 'changes' ? 'Mail or calendar: changes came in (listed under what changed).'
  : 'The owner opened the app.';

// What brought this wake, oldest first, with how many times each came and when; the wake reads the body itself with its tools.
export const inboxSection = (rows: readonly InboxRow[], at: (ms: number) => string): string =>
  rows.length ? `[What came in since Waldo last looked, oldest first]\n${rows.map(row => `- ${at(row.first_at)}${row.count > 1 ? ` (${row.count} times, last ${at(row.last_at)})` : ''}: ${words(row)}`).join('\n')}` : '';
