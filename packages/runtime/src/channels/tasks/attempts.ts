import type { ToolName } from '@waldo/contracts';

type Sql = Pick<SqlStorage, 'exec'>;

// One running step per item: the item revision it started from, the schedule entry that will run its next attempt, and
// for a delegated step the task and tools it was given. A step the runner armed itself has no task of its own: it is
// composed from the book's rows, which do not change, so the book stays the one copy of that text.
export type TaskStep = Readonly<{
  item_id: string; responsibility_id: string; revision: number; task: string | null;
  tools: readonly ToolName[] | null; schedule_id: string; armed_at: number;
}>;
export type AttemptStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'uncertain';
export type Attempt = Readonly<{
  id: string; item_id: string; revision: number; attempt: number; started_at: number; ended_at: number | null;
  status: AttemptStatus; effects_dispatched: 0 | 1; summary: string | null; run_id: string | null;
}>;

type StepRow = Omit<TaskStep, 'tools'> & { tools: string | null };

// The step journal: every attempt at a step is a row, written before the attempt's work starts and settled once.
// effects_dispatched turns 1 before any tool that is not a safe read runs, which is what decides whether an
// interrupted attempt may run again.
export const attemptJournal = (sql: Sql, deps: Readonly<{ newId(): string; now(): number }>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS responsibility_item_steps (
    item_id TEXT PRIMARY KEY, responsibility_id TEXT NOT NULL, revision INTEGER NOT NULL, task TEXT,
    tools TEXT, schedule_id TEXT NOT NULL, armed_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS responsibility_item_attempts (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, revision INTEGER NOT NULL, attempt INTEGER NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
    effects_dispatched INTEGER NOT NULL DEFAULT 0, summary TEXT, run_id TEXT)`);
  sql.exec('CREATE INDEX IF NOT EXISTS responsibility_item_attempts_item_idx ON responsibility_item_attempts (item_id, revision, attempt)');

  return {
    arm(step: Omit<TaskStep, 'armed_at'>): void {
      sql.exec(`INSERT INTO responsibility_item_steps (item_id, responsibility_id, revision, task, tools, schedule_id, armed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET responsibility_id = excluded.responsibility_id, revision = excluded.revision, task = excluded.task,
          tools = excluded.tools, schedule_id = excluded.schedule_id, armed_at = excluded.armed_at`,
      step.item_id, step.responsibility_id, step.revision, step.task, step.tools === null ? null : JSON.stringify(step.tools), step.schedule_id, deps.now());
    },
    rearm(itemId: string, scheduleId: string): void {
      sql.exec('UPDATE responsibility_item_steps SET schedule_id = ?, armed_at = ? WHERE item_id = ?', scheduleId, deps.now(), itemId);
    },
    step(itemId: string): TaskStep | null {
      const row = sql.exec<StepRow>('SELECT * FROM responsibility_item_steps WHERE item_id = ?', itemId).toArray()[0];
      return row ? { ...row, tools: row.tools === null ? null : JSON.parse(row.tools) as ToolName[] } : null;
    },
    stepsOf(responsibilityId: string): readonly Pick<TaskStep, 'item_id' | 'schedule_id'>[] {
      return sql.exec<{ item_id: string; schedule_id: string }>('SELECT item_id, schedule_id FROM responsibility_item_steps WHERE responsibility_id = ?', responsibilityId).toArray();
    },
    // Attempts at this revision of the step, oldest first; a re-armed revision starts its count again.
    attempts(itemId: string, revision: number): readonly Attempt[] {
      return sql.exec<Attempt>('SELECT * FROM responsibility_item_attempts WHERE item_id = ? AND revision = ? ORDER BY attempt', itemId, revision).toArray();
    },
    begin(itemId: string, revision: number, attempt: number, runId: string | null): Attempt {
      const id = `a${deps.newId()}`;
      sql.exec("INSERT INTO responsibility_item_attempts (id, item_id, revision, attempt, started_at, status, run_id) VALUES (?, ?, ?, ?, ?, 'running', ?)",
        id, itemId, revision, attempt, deps.now(), runId);
      return sql.exec<Attempt>('SELECT * FROM responsibility_item_attempts WHERE id = ?', id).one();
    },
    markEffects(id: string): void {
      sql.exec('UPDATE responsibility_item_attempts SET effects_dispatched = 1 WHERE id = ?', id);
    },
    effectsDispatched: (id: string): boolean =>
      sql.exec<{ e: number }>('SELECT effects_dispatched AS e FROM responsibility_item_attempts WHERE id = ?', id).toArray()[0]?.e === 1,
    // Settles a running attempt exactly once; an attempt already settled keeps what it recorded.
    settle(id: string, status: Exclude<AttemptStatus, 'running'>, summary: string): boolean {
      return sql.exec("UPDATE responsibility_item_attempts SET status = ?, summary = ?, ended_at = ? WHERE id = ? AND status = 'running'",
        status, summary.slice(0, 200), deps.now(), id).rowsWritten > 0;
    },
  };
};
export type AttemptJournal = ReturnType<typeof attemptJournal>;
