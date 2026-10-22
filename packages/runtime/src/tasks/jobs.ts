import { type LLMToolTurn, type TaskProfile, type TaskResult } from '@waldo/contracts';
import type { TaintedActionOutcome } from '../channels/approvals';
import { TASK_JOBS_TABLE_SCHEMA } from '../do-schema';
import { carriesTopic, hidesTopic } from '../memory/forget-guard';
import { FORGOTTEN } from '../memory/claims';
import { md5Hex } from '../channels/md5';

// The job book: the owner object's record of every task it handed to a worker and every turn it retries itself. The owner
// object is its only writer and the single retry owner. Every transition compares (id, attempt, lease_token, status), so a
// worker call from an old attempt, a cancelled job or a duplicate report changes nothing and is told it was fenced.

type Sql = Pick<SqlStorage, 'exec'>;
export type JobKind = 'task' | 'retry_turn' | 'approval_replay';
export type JobStatus = 'queued' | 'running' | 'reported' | 'applied' | 'cancelled' | 'parked';
export type JobOutcome = TaskResult['status'];
export type ParkReason = 'crashed' | 'provider_unavailable' | 'uncertain_effect' | 'deadline';
export type CancelReason = 'owner' | 'forgotten';

// A task worker's frozen brief: the words the model wrote in start_task plus the owner's clock, so the worker can reason
// about dates without seeing the conversation.
export type TaskBrief = Readonly<{
  title: string; goal: string; context: string; constraints?: string; done_when: string;
  effort: 'standard' | 'deep'; timezone: string; started_at: number;
}>;
// A turn the brain retries after every provider failed: the owner's message, the chain it belongs to, and the time the
// floor reply promised an answer by.
export type RetryBrief = Readonly<{ message_ref: string; text: string; conversation_ref: string; said_at: number; promised_by: number }>;
// An approval card the owner said yes to, frozen at the decision: the call exactly as the card showed it and the digest
// the card was approved under. The brain runs it once, later, under the job's own run scope.
export type ReplayBrief = Readonly<{ approval_id: string; tool: string; args: Record<string, unknown>; args_digest: string; approved_at: number }>;
export type ReplayOutcome = TaintedActionOutcome;
export type Checkpoint = Readonly<{ turns: readonly LLMToolTurn[] }>;

export type JobRow = Readonly<{
  id: string; kind: JobKind; profile: TaskProfile | null; idempotency_key: string; origin: string; surface: string;
  brief_json: string; brief_digest: string; status: JobStatus; attempt: number; lease_token: string | null; lease_until: number | null;
  crashes: number; deferrals: number; due_at: number | null; deadline_at: number; checkpoint_seq: number; checkpoint_json: string | null; inflight_json: string | null;
  taint: 'external' | null; result_json: string | null; outcome: JobOutcome | null; park_reason: ParkReason | null; cancel_reason: CancelReason | null;
  rounds: number; cost_usd: number; notes_sent: number; last_note_at: number | null; created_at: number; updated_at: number; settled_at: number | null;
}>;
export type TaskTicket = Readonly<{ jobId: string; attempt: number; token: string }>;

// A worker holds its attempt while it keeps calling in: every claim, tool call and checkpoint renews the lease. Two minutes
// covers the longest single call a worker makes (a model round with a large context, or a browser step) with room to spare.
export const TASK_LEASE_MS = 120_000;
// A job that crashed this many times is parked and the owner hears what finished and what is left (pi-durable parks after
// five restarts; a worker here also resumes from its last checkpoint, so three lost attempts already mean something is wrong).
export const TASK_MAX_CRASHES = 3;
// A job may wait hours, such as for a live-view login, but never forever.
export const TASK_DEADLINE_MS = 6 * 60 * 60_000;
// Task workers one owner runs at once. Each makes model calls back to back, so more at once multiplies the owner's spend per
// minute and draws on the same provider rate limits as their chat. A job past this waits in the queue, never refused, and
// starts when a running one reports.
export const TASK_MAX_RUNNING = 3;
// An approved action runs within this time of the approval or not at all: the owner said yes to the page as it was then,
// and a browser step that has waited longer behind other work no longer acts on what they saw.
export const REPLAY_DEADLINE_MS = 30 * 60_000;
// Settled rows kept for the console and audit. Older ones are dropped, newest kept, so an owner who runs tasks for years does
// not grow the object's storage without bound; nothing open is ever dropped.
export const TASK_SETTLED_KEPT = 200;

export type CreateJob = Readonly<{
  kind: JobKind; profile: TaskProfile | null; idempotencyKey: string; origin: string; surface: string;
  brief: TaskBrief | RetryBrief | ReplayBrief; dueAt: number; deadlineAt: number;
  // A job born tainted: a retried turn whose original carried someone else's words.
  taint?: 'external' | null;
}>;
export type Fenced = 'fenced';

const OPEN: readonly JobStatus[] = ['queued', 'running', 'reported'];
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

export const jobBook = (sql: Sql, deps: Readonly<{ now(): number; newId(): string; newToken(): string }>) => {
  // A table an earlier build created does not admit approval replays; it is rebuilt with the same columns and rows in this
  // synchronous block, which the storage commits as one transaction.
  const made = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_jobs'").toArray()[0]?.sql;
  if (made !== undefined && !made.includes("'approval_replay'")) {
    sql.exec('DROP INDEX IF EXISTS task_jobs_open');
    sql.exec('ALTER TABLE task_jobs RENAME TO task_jobs_before_replay');
    for (const statement of TASK_JOBS_TABLE_SCHEMA) sql.exec(statement);
    sql.exec('INSERT INTO task_jobs SELECT * FROM task_jobs_before_replay');
    sql.exec('DROP TABLE task_jobs_before_replay');
  }
  for (const statement of TASK_JOBS_TABLE_SCHEMA) sql.exec(statement);
  const get = (id: string): JobRow | null => sql.exec<JobRow>('SELECT * FROM task_jobs WHERE id = ?', id).toArray()[0] ?? null;
  // The ticket is current only for the attempt that holds the lease; anything else is an old, cancelled or finished attempt.
  const current = (ticket: TaskTicket): JobRow | null => {
    const row = get(ticket.jobId);
    return row && row.status === 'running' && row.attempt === ticket.attempt && row.lease_token === ticket.token ? row : null;
  };
  const renew = (ticket: TaskTicket, extra = '', ...values: SqlStorageValue[]): boolean => sql.exec(
    `UPDATE task_jobs SET lease_until = ?, updated_at = ?${extra} WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
    deps.now() + TASK_LEASE_MS, deps.now(), ...values, ticket.jobId, ticket.attempt, ticket.token,
  ).rowsWritten > 0;

  // Apply-once by job id: only the attempt holding the lease can report, once. A second report from the same attempt is a
  // duplicate; one from any other attempt or after a cancel is fenced and discarded.
  const finish = (ticket: TaskTicket, resultJson: string, outcome: JobOutcome, spend: Readonly<{ rounds: number; costUsd: number }>): 'accepted' | 'duplicate' | Fenced => {
    const now = deps.now();
    const written = sql.exec(
      `UPDATE task_jobs SET status = 'reported', result_json = ?, outcome = ?, inflight_json = NULL, lease_token = NULL, lease_until = NULL, due_at = ?,
         rounds = rounds + ?, cost_usd = cost_usd + ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
      resultJson, outcome, now, spend.rounds, spend.costUsd, now, ticket.jobId, ticket.attempt, ticket.token,
    ).rowsWritten;
    if (written > 0) return 'accepted';
    const row = get(ticket.jobId);
    return row && row.attempt === ticket.attempt && (row.status === 'reported' || row.status === 'applied') ? 'duplicate' : 'fenced';
  };

  return {
    get,
    byKey: (key: string): JobRow | null => sql.exec<JobRow>('SELECT * FROM task_jobs WHERE idempotency_key = ?', key).toArray()[0] ?? null,
    // Intent before I/O: the row is written before any worker starts. The same idempotency key (a replayed turn's tool call)
    // returns the job it already made instead of making a second one.
    create(input: CreateJob): Readonly<{ job: JobRow; created: boolean }> {
      const existing = sql.exec<JobRow>('SELECT * FROM task_jobs WHERE idempotency_key = ?', input.idempotencyKey).toArray()[0];
      if (existing) return { job: existing, created: false };
      const now = deps.now();
      const id = `job_${deps.newId()}`;
      // The digest freezes the brief: a claim of a brief that no longer matches it is refused. MD5 is enough here, since it
      // guards against the row changing under the job, not against an adversary, and it is synchronous.
      const briefJson = JSON.stringify(input.brief);
      sql.exec(
        `INSERT INTO task_jobs (id, kind, profile, idempotency_key, origin, surface, brief_json, brief_digest, status, taint, due_at, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        id, input.kind, input.profile, input.idempotencyKey, input.origin, input.surface, briefJson, md5Hex(briefJson),
        input.taint ?? null, input.dueAt, input.deadlineAt, now, now,
      );
      return { job: get(id)!, created: true };
    },
    // Starts the next attempt of a queued job: a new attempt number and token fence every earlier attempt out.
    startAttempt(id: string): TaskTicket | null {
      const token = deps.newToken();
      const now = deps.now();
      const row = sql.exec<{ attempt: number }>(
        `UPDATE task_jobs SET status = 'running', attempt = attempt + 1, lease_token = ?, lease_until = ?, due_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'queued' RETURNING attempt`, token, now + TASK_LEASE_MS, now, id,
      ).toArray()[0];
      return row ? { jobId: id, attempt: row.attempt, token } : null;
    },
    // Intent before an effect that cannot be replayed: the call is recorded on the job before it runs and cleared after,
    // so an attempt lost mid-call is known to have left the effect uncertain.
    beginEffect(ticket: TaskTicket, call: Readonly<{ tool: string; call_id: string }>): boolean {
      return renew(ticket, ', inflight_json = ?', JSON.stringify({ ...call, at: deps.now() }));
    },
    endEffect(ticket: TaskTicket): boolean {
      return renew(ticket, ', inflight_json = NULL');
    },
    // A worker (re)joining its attempt: the lease renews, and the job's brief and last checkpoint come back.
    claim(ticket: TaskTicket): JobRow | Fenced {
      if (!renew(ticket)) return 'fenced';
      return get(ticket.jobId)!;
    },
    // Every brain-side tool call renews the lease and records whether the job has read external content.
    touch(ticket: TaskTicket, taint: 'external' | null): boolean {
      return taint === 'external' ? renew(ticket, ", taint = 'external'") : renew(ticket);
    },
    // A checkpoint lands only in order: a stale or repeated sequence number (a worker replaying its alarm) is a no-op.
    checkpoint(ticket: TaskTicket, seq: number, checkpoint: Checkpoint, spend: Readonly<{ rounds: number; costUsd: number }>): 'ok' | 'stale' | Fenced {
      const row = current(ticket);
      if (!row) return 'fenced';
      if (seq <= row.checkpoint_seq) return renew(ticket) ? 'stale' : 'fenced';
      return renew(ticket, ', checkpoint_seq = ?, checkpoint_json = ?, rounds = rounds + ?, cost_usd = cost_usd + ?', seq, JSON.stringify(checkpoint), spend.rounds, spend.costUsd) ? 'ok' : 'fenced';
    },
    report(ticket: TaskTicket, result: TaskResult, spend: Readonly<{ rounds: number; costUsd: number }>): 'accepted' | 'duplicate' | Fenced {
      return finish(ticket, JSON.stringify(result), result.status, spend);
    },
    // An approved action's attempt ends with what its replay established. The intent marker is cleared in the same write,
    // so the job is never both reported and in flight.
    reportReplay(ticket: TaskTicket, outcome: ReplayOutcome): 'accepted' | 'duplicate' | Fenced {
      return finish(ticket, JSON.stringify(outcome), REPLAY_JOB_OUTCOME[outcome.status], { rounds: 0, costUsd: 0 });
    },
    // No provider could answer: the attempt ends without counting as a crash, and the job waits for its next try. A next
    // try past the deadline parks the job instead; a try at the deadline is the last one.
    defer(ticket: TaskTicket, dueAt: number, spend: Readonly<{ rounds: number; costUsd: number }>): 'deferred' | 'parked' | Fenced {
      const row = current(ticket);
      if (!row) return 'fenced';
      const now = deps.now();
      if (dueAt > row.deadline_at) {
        return sql.exec(
          `UPDATE task_jobs SET status = 'reported', outcome = 'failed', park_reason = 'provider_unavailable', lease_token = NULL, lease_until = NULL, due_at = ?,
             deferrals = deferrals + 1, rounds = rounds + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
          now, spend.rounds, spend.costUsd, now, ticket.jobId, ticket.attempt, ticket.token,
        ).rowsWritten > 0 ? 'parked' : 'fenced';
      }
      return sql.exec(
        `UPDATE task_jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, due_at = ?, deferrals = deferrals + 1,
           rounds = rounds + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
        dueAt, spend.rounds, spend.costUsd, now, ticket.jobId, ticket.attempt, ticket.token,
      ).rowsWritten > 0 ? 'deferred' : 'fenced';
    },
    // Attempts whose worker stopped calling in. Each lost attempt counts as a crash: the job goes back to the queue to resume
    // from its last checkpoint, or, after TASK_MAX_CRASHES, is parked for the owner to hear about. Past its deadline a job
    // parks whatever the count.
    // `busy` names jobs whose tool call the brain is running now: their worker is waiting on it, not lost.
    lapse(busy: ReadonlySet<string> = new Set()): readonly Readonly<{ id: string; parked: boolean }>[] {
      const now = deps.now();
      const lapsed = sql.exec<{ id: string; crashes: number; deadline_at: number; inflight_json: string | null }>(
        "SELECT id, crashes, deadline_at, inflight_json FROM task_jobs WHERE status = 'running' AND lease_until < ?", now,
      ).toArray().filter(({ id }) => !busy.has(id));
      return lapsed.map(({ id, crashes, deadline_at, inflight_json }) => {
        // An attempt lost while an effect that cannot be replayed was in flight parks at once: the effect may or may not
        // have happened, and running it again blind could do it twice.
        const reason: ParkReason | null = inflight_json !== null ? 'uncertain_effect' : now >= deadline_at ? 'deadline' : crashes + 1 >= TASK_MAX_CRASHES ? 'crashed' : null;
        const parked = reason !== null;
        sql.exec(
          parked
            ? `UPDATE task_jobs SET status = 'reported', outcome = 'failed', park_reason = ?, crashes = crashes + 1, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`
            : `UPDATE task_jobs SET status = 'queued', crashes = crashes + 1, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
          ...(parked ? [reason] : []), now, now, id,
        );
        return { id, parked };
      });
    },
    // A job the brain itself parks (a retry whose promised time came, an effect that cannot be replayed).
    park(id: string, reason: ParkReason, outcome: JobOutcome = 'failed'): boolean {
      const now = deps.now();
      return sql.exec(
        `UPDATE task_jobs SET status = 'reported', outcome = ?, park_reason = ?, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`, outcome, reason, now, now, id,
      ).rowsWritten > 0;
    },
    // The cancellation fence: the token is cleared in the same write that settles the job, so every later call from the
    // worker is fenced and a result that arrives late is discarded.
    cancel(id: string, reason: CancelReason): boolean {
      const now = deps.now();
      return sql.exec(
        `UPDATE task_jobs SET status = 'cancelled', cancel_reason = ?, lease_token = NULL, lease_until = NULL, due_at = NULL, checkpoint_json = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders(OPEN)})`, reason, now, now, id, ...OPEN,
      ).rowsWritten > 0;
    },
    // A reported job that the owner heard about. Parked jobs settle as parked; the rest as applied. The checkpoint, which
    // only a resumed attempt needs, is dropped once the job is settled.
    settle(id: string): boolean {
      const now = deps.now();
      return sql.exec(
        `UPDATE task_jobs SET status = CASE WHEN park_reason IS NULL THEN 'applied' ELSE 'parked' END, due_at = NULL, checkpoint_json = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND status = 'reported'`, now, now, id,
      ).rowsWritten > 0;
    },
    noteSent(id: string): void {
      sql.exec('UPDATE task_jobs SET notes_sent = notes_sent + 1, last_note_at = ?, updated_at = ? WHERE id = ?', deps.now(), deps.now(), id);
    },
    open: (): readonly JobRow[] => sql.exec<JobRow>(`SELECT * FROM task_jobs WHERE status IN (${placeholders(OPEN)}) ORDER BY created_at`, ...OPEN).toArray(),
    running: (): readonly JobRow[] => sql.exec<JobRow>("SELECT * FROM task_jobs WHERE status = 'running' ORDER BY created_at").toArray(),
    replaying: (): boolean => sql.exec("SELECT 1 FROM task_jobs WHERE status = 'running' AND kind = 'approval_replay' LIMIT 1").toArray().length > 0,
    runningTasks: (): number => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs WHERE status = 'running' AND kind = 'task'").toArray()[0]?.n ?? 0,
    // Work the brain owes now: queued attempts whose time came, and reported jobs not yet applied.
    due: (): readonly JobRow[] => sql.exec<JobRow>(
      "SELECT * FROM task_jobs WHERE status IN ('queued', 'reported') AND due_at <= ? ORDER BY due_at, created_at", deps.now(),
    ).toArray(),
    // An apply that could not run (no model to write the report) waits like a deferred attempt. updated_at keeps the time
    // the job was reported, which bounds how long its apply is retried.
    postpone(id: string, dueAt: number): boolean {
      return sql.exec("UPDATE task_jobs SET due_at = ?, deferrals = deferrals + 1 WHERE id = ? AND status = 'reported'", dueAt, id).rowsWritten > 0;
    },
    // The next moment the brain has something to do: a queued job's due time, a running attempt's lease end, or now for a report.
    // While every task slot is taken, a queued task waits for a report rather than its due time; so does a queued replay
    // while another replay runs.
    nextDue(slotsFull = false, replayRunning = false): number | null {
      const row = sql.exec<{ next: number | null }>(
        `SELECT MIN(CASE status WHEN 'running' THEN lease_until ELSE due_at END) AS next
         FROM task_jobs WHERE status IN (${placeholders(OPEN)}) AND NOT (? AND status = 'queued' AND kind = 'task')
           AND NOT (? AND status = 'queued' AND kind = 'approval_replay')`, ...OPEN, slotsFull ? 1 : 0, replayRunning ? 1 : 0,
      ).toArray()[0];
      return row?.next ?? null;
    },
    // Owner forget: open jobs whose brief, progress or result carries a forgotten text are cancelled, since their worker
    // holds a copy. The text itself is redacted from every row by the memory purge, which lists this table among its
    // literal-redacted stores and reads it back. A purge that ran first leaves its marker where the text was, and that
    // job's worker still holds the original, so the marker cancels it too.
    forget(texts: readonly string[]): readonly string[] {
      const topics = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
      if (!topics.length) return [];
      const holds = (value: string | null) => value !== null && (value.includes(FORGOTTEN) || topics.some(topic => carriesTopic(value, topic) || hidesTopic(value, topic)));
      return sql.exec<Pick<JobRow, 'id' | 'brief_json' | 'checkpoint_json' | 'result_json'>>(
        `SELECT id, brief_json, checkpoint_json, result_json FROM task_jobs WHERE status IN (${placeholders(OPEN)})`, ...OPEN,
      ).toArray().filter(row => [row.brief_json, row.checkpoint_json, row.result_json].some(holds) && this.cancel(row.id, 'forgotten')).map(row => row.id);
    },
    // TTL sweep: settled rows past the newest TASK_SETTLED_KEPT are dropped.
    trim(): number {
      return sql.exec(
        `DELETE FROM task_jobs WHERE status IN ('applied', 'cancelled', 'parked')
           AND id NOT IN (SELECT id FROM task_jobs WHERE status IN ('applied', 'cancelled', 'parked') ORDER BY settled_at DESC LIMIT ?)`, TASK_SETTLED_KEPT,
      ).rowsWritten;
    },
  };
};
export type JobBook = ReturnType<typeof jobBook>;

export const taskBrief = (row: JobRow): TaskBrief => JSON.parse(row.brief_json) as TaskBrief;
export const retryBrief = (row: JobRow): RetryBrief => JSON.parse(row.brief_json) as RetryBrief;
export const replayBrief = (row: JobRow): ReplayBrief => JSON.parse(row.brief_json) as ReplayBrief;
export const replayOutcome = (row: JobRow): ReplayOutcome | null => row.result_json === null ? null : JSON.parse(row.result_json) as ReplayOutcome;
// The job's outcome column for a replay: a refusal before the tool ran is a blocked job; an unknown outcome is a failed one,
// and the card keeps the replay's own word for it.
const REPLAY_JOB_OUTCOME = { done: 'done', rejected: 'blocked', failed: 'failed', uncertain: 'failed' } as const satisfies Record<ReplayOutcome['status'], JobOutcome>;
// The key an approval's replay job is written under: one job per card, whatever decides it how often.
export const replayKey = (approvalId: string): string => `approval:${approvalId}`;
export const jobCheckpoint = (row: JobRow): Checkpoint => row.checkpoint_json === null ? { turns: [] } : JSON.parse(row.checkpoint_json) as Checkpoint;
export const jobResult = (row: JobRow): TaskResult | null => row.result_json === null ? null : JSON.parse(row.result_json) as TaskResult;
