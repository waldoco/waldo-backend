import type { OwnerClock } from '../tools/live/get-context';

// A5b (BUILD_PLAN_2026-09-25: "Background task tracking - tasks table, trace hops, console
// list"). Every background execution - a delegate_task child, a reminder/loop/standing-order
// fire, a proactive beat - records one row. parent_id carries the trace hop: a child run
// points at the turn or run that spawned it, so the console can show what came from what.
// Summaries are one-line outcomes written by the runner itself, never provider text.
export const RUN_KINDS = ['delegate_task', 'reminder', 'loop', 'standing_order', 'heartbeat', 'brief', 'event'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type BackgroundRun = Readonly<{
  id: string;
  kind: RunKind;
  status: RunStatus;
  summary: string | null;
  parent_id: string | null;
  started_at: number;
  ended_at: number | null;
}>;

export type RunBook = Readonly<{
  start(kind: RunKind, parentId: string | null): BackgroundRun;
  finish(id: string, status: Exclude<RunStatus, 'running'>, summary: string): boolean;
  list(limit: number): readonly BackgroundRun[];
  listPage(limit: number, before?: number): { rows: readonly BackgroundRun[]; next: number | null };
  byId(id: string): BackgroundRun | null;
}>;

type Sql = Pick<SqlStorage, 'exec'>;

// Runs are audit residue, not operational state: the oldest rows trim past the cap so a chatty
// loop can never grow the table without bound. The console list reads the newest page.
export const MAX_RUN_ROWS = 500;

export const runBook = (sql: Sql, clock: OwnerClock, newId: () => string): RunBook => {
  sql.exec(`CREATE TABLE IF NOT EXISTS background_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT,
    parent_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER)`);
  return {
    start(kind, parentId) {
      const run: BackgroundRun = {
        id: `bg:${newId()}`, kind, status: 'running', summary: null,
        parent_id: parentId, started_at: clock.now().getTime(), ended_at: null,
      };
      sql.exec(
        'INSERT INTO background_runs (id, kind, status, summary, parent_id, started_at, ended_at) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
        run.id, run.kind, run.status, run.parent_id, run.started_at,
      );
      sql.exec(
        'DELETE FROM background_runs WHERE id NOT IN (SELECT id FROM background_runs ORDER BY started_at DESC LIMIT ?)',
        MAX_RUN_ROWS,
      );
      return run;
    },
    finish(id, status, summary) {
      // Provider-free residue: the runner's own classification plus its one-line outcome, and
      // the summary is hard-capped so a verbose failure can never flood the console list.
      return sql.exec(
        'UPDATE background_runs SET status = ?, summary = ?, ended_at = ? WHERE id = ?',
        status, summary.slice(0, 200), clock.now().getTime(), id,
      ).rowsWritten > 0;
    },
    list: (limit) =>
      sql.exec<BackgroundRun>('SELECT * FROM background_runs ORDER BY started_at DESC LIMIT ?', limit).toArray(),
    // B9 dashboard bar: cursor page, same convention as the trace book - `before` is the
    // oldest started_at the caller holds; `next` is null when the page ran out.
    listPage: (limit, before) => {
      const rows = sql.exec<BackgroundRun>('SELECT * FROM background_runs WHERE (?1 IS NULL OR started_at < ?1) ORDER BY started_at DESC LIMIT ?2', before ?? null, limit + 1).toArray();
      return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.started_at : null };
    },
    byId: (id) => sql.exec<BackgroundRun>('SELECT * FROM background_runs WHERE id = ?', id).toArray()[0] ?? null,
  };
};
