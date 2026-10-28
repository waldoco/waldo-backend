import type { OwnerClock } from '../tools/live/get-context';

// A5b (BUILD_PLAN_2026-09-25: "Background task tracking - tasks table, trace hops, console
// list"). Every background execution - a delegate_task child, a reminder/loop/standing-order
// fire, a proactive beat - records one row. parent_id carries the trace hop: a child run
// points at the turn or run that spawned it, so the console can show what came from what.
// Summaries are one-line outcomes written by the runner itself, never provider text.
// nightly is the night's memory pass and its catch-ups; health_trigger is the health check that may raise one change.
export const RUN_KINDS = ['delegate_task', 'reminder', 'loop', 'standing_order', 'heartbeat', 'brief', 'event', 'nightly', 'health_trigger'] as const;
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
  latestActivity(): BackgroundRun | null;
  listPage(limit: number, before?: number): { rows: readonly BackgroundRun[]; next: number | null };
  byId(id: string): BackgroundRun | null;
  // The runs started in [from, to), oldest first, at most limit, with how many there were. complete is false when the
  // oldest rows were trimmed past the cap after the window opened, so some of its runs may be gone.
  between(from: number, to: number, limit: number): { rows: readonly BackgroundRun[]; total: number; complete: boolean };
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
    latestActivity: () => sql.exec<BackgroundRun>(
      'SELECT * FROM background_runs ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT 1',
    ).toArray()[0] ?? null,
    // B9 dashboard bar: cursor page, same convention as the trace book - `before` is the
    // oldest started_at the caller holds; `next` is null when the page ran out.
    listPage: (limit, before) => {
      const rows = sql.exec<BackgroundRun>('SELECT * FROM background_runs WHERE (?1 IS NULL OR started_at < ?1) ORDER BY started_at DESC LIMIT ?2', before ?? null, limit + 1).toArray();
      return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.started_at : null };
    },
    byId: (id) => sql.exec<BackgroundRun>('SELECT * FROM background_runs WHERE id = ?', id).toArray()[0] ?? null,
    between: (from, to, limit) => {
      const kept = sql.exec<{ count: number; oldest: number | null }>('SELECT COUNT(*) AS count, MIN(started_at) AS oldest FROM background_runs').one();
      return {
        rows: sql.exec<BackgroundRun>('SELECT * FROM background_runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at, id LIMIT ?', from, to, limit).toArray(),
        total: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM background_runs WHERE started_at >= ? AND started_at < ?', from, to).one().count,
        complete: kept.count < MAX_RUN_ROWS || (kept.oldest !== null && kept.oldest <= from),
      };
    },
  };
};

// How a recorded job's run settles: the line for a job that threw, and the status and line for each outcome it returned.
export type RunSummary<Outcome> = Readonly<{ threw: string; settled(outcome: Outcome): Readonly<{ status: 'completed' | 'failed'; summary: string }> }>;
export const NIGHTLY_RUN: RunSummary<'done' | 'more' | 'failed' | 'capped'> = {
  threw: 'memory pass failed',
  settled: outcome => ({
    done: { status: 'completed', summary: 'memory pass finished' },
    more: { status: 'completed', summary: 'memory pass read part of the backlog; a catch-up follows' },
    capped: { status: 'completed', summary: 'memory pass stopped at the day\'s limit; the rest waits' },
    failed: { status: 'failed', summary: 'memory pass did not finish; a catch-up follows' },
  } as const)[outcome],
};
// The trigger does not report its outcome to its caller, so its run says only that it ran.
export const HEALTH_TRIGGER_RUN: RunSummary<void> = { threw: 'health check stopped with an error', settled: () => ({ status: 'completed', summary: 'health check ran' }) };

// A scheduled job recorded as one run, settled by what it returned; a job that throws is recorded failed and still throws.
export const recordedRun = <Entry extends { id: string }, Outcome>(
  runs: Pick<RunBook, 'start' | 'finish'>, kind: RunKind, summary: RunSummary<Outcome>, job: (entry: Entry) => Promise<Outcome>,
) => async (entry: Entry): Promise<void> => {
  const run = runs.start(kind, entry.id);
  let outcome: Outcome;
  try { outcome = await job(entry); } catch (error) { runs.finish(run.id, 'failed', summary.threw); throw error; }
  const settled = summary.settled(outcome);
  runs.finish(run.id, settled.status, settled.summary);
};
