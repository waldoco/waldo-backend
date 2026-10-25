import { replaceLiteralText, type LLMToolTurn, type TaskProfile, type TaskResult } from '@waldo/contracts';
import { TASK_JOBS_TABLE_SCHEMA } from '../do-schema';
import { FORGOTTEN, projectionValueHolds } from '../memory/claims';
import type { ForgetStore } from '../memory/forget-purge';
import { md5Hex } from '../channels/md5';
import { ClosedRunError } from '../channels/run-effect-scope';

// The job book: the owner object's record of every task it handed to a worker and every turn it retries itself. The owner
// object is its only writer and the single retry owner. Every transition compares (id, attempt, lease_token, status), so a
// worker call from an old attempt, a cancelled job or a duplicate report changes nothing and is told it was fenced.

type Sql = Pick<SqlStorage, 'exec'>;
export type JobKind = 'task' | 'retry_turn';
export type JobStatus = 'queued' | 'running' | 'reported' | 'applied' | 'cancelled' | 'parked';
export type JobOutcome = TaskResult['status'];
export type ParkReason = 'crashed' | 'provider_unavailable' | 'uncertain_effect' | 'deadline' | 'brief_changed';
export type CancelReason = 'owner' | 'forgotten';

// Reader jobs the brain starts on its own schedule, not because the owner asked. Their origin names the job.
export type MachineJob = 'heartbeat' | 'update_sweep' | 'meeting_prep';
export const MACHINE_ORIGIN = 'machine:';
export const isMachine = (row: Pick<JobRow, 'origin'>): boolean => row.origin.startsWith(MACHINE_ORIGIN);
// What a machine job was started on: a digest of its inputs, the scope it holds open (one open job per job and scope), the
// refs of the items it was given, the connection its data came from, the schedule run that started it, and the record its
// data was written to (an update sweep's update_cards row).
export type MachineBrief = Readonly<{
  job: MachineJob; input_digest: string; scope: string; refs: readonly string[];
  source?: Readonly<{ connection_id: string }>; run_id?: string; record_id?: number;
  // Refs whose words the worker was not shown because they carry health values: the brain judges those itself.
  withheld?: readonly string[];
}>;

// A task worker's frozen brief: the words the model wrote in start_task plus the owner's clock, so the worker can reason
// about dates without seeing the conversation. outside_text: the turn that wrote it had read someone else's words, so its
// title is not repeated to the owner as Waldo's own. The job's taint says more: it also turns external once the worker reads.
// A machine job's brief is written by the brain instead, and says so.
export type TaskBrief = Readonly<{
  title: string; goal: string; context: string; done_when: string;
  effort: 'standard' | 'deep'; timezone: string; started_at: number; outside_text?: true; machine?: MachineBrief;
}>;
// A turn the brain retries after every provider failed: the owner's message, the chain it belongs to, and the time the
// floor reply promised an answer by.
export type RetryBrief = Readonly<{ message_ref: string; text: string; conversation_ref: string; said_at: number; promised_by: number }>;
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
// A job is not started or rejoined past its deadline: it parks, and the owner hears it ran out of time, rather than getting
// work or an answer they stopped waiting for. A wake set for the deadline itself fires a little after it, and that last try
// still runs, so the deadline holds after this much grace.
export const JOB_START_GRACE_MS = 5 * 60_000;
// Task workers one owner runs at once. Each makes model calls back to back, so more at once multiplies the owner's spend per
// minute and draws on the same provider rate limits as their chat. A job past this waits in the queue, never refused, and
// starts when a running one reports.
export const TASK_MAX_RUNNING = 3;
// Tasks one owner has open (queued, running or with a report pending), and tasks one turn starts. Each task is paid worker
// time and a later message to the owner; a runaway or injected turn could otherwise start them by the dozen. Past either
// cap start_task refuses and says what to do instead; the brain's own retries of owner messages are not counted.
export const TASK_MAX_OPEN = 10;
export const TASK_MAX_PER_TURN = 3;
// Settled rows kept for the console and audit. Older ones are dropped, newest kept, so an owner who runs tasks for years does
// not grow the object's storage without bound; nothing open is ever dropped.
export const TASK_SETTLED_KEPT = 200;
// Machine jobs one owner runs at once, apart from the owner's task slots. Each trigger holds at most one open job per job
// and scope, but meeting prep's scope is one meeting, so a dense calendar would otherwise start a worker per meeting at once,
// each spending model calls in parallel. The rest wait in the queue and start as running ones report.
export const MACHINE_MAX_RUNNING = 2;
// Settled machine jobs are kept apart from the owner's, so a day of background checks never evicts the owner's task
// history: the newest MACHINE_SETTLED_KEPT, and every one settled within MACHINE_SETTLED_KEPT_MS.
export const MACHINE_SETTLED_KEPT = 50;
export const MACHINE_SETTLED_KEPT_MS = 48 * 60 * 60_000;

export type CreateJob = Readonly<{
  kind: JobKind; profile: TaskProfile | null; idempotencyKey: string; origin: string; surface: string;
  brief: TaskBrief | RetryBrief; dueAt: number; deadlineAt: number;
  // A job born tainted: a retried turn whose original carried someone else's words.
  taint?: 'external' | null;
}>;
export type Fenced = 'fenced';

const OPEN: readonly JobStatus[] = ['queued', 'running', 'reported'];
const SETTLED = "status IN ('applied', 'cancelled', 'parked')";
const MACHINE_ROW = `origin LIKE '${MACHINE_ORIGIN}%'`;
// What a settled row keeps of its brief: a task's title (cancel_task names it) and start time, a retry's references and
// times. The goal, the context and the owner's message are dropped with the job's progress; the digest stays as the record
// of what the job was given.
const TITLE_KEPT = 80;
// A brief can be unreadable (one an older build's literal replace cut across the JSON's own quotes); it keeps nothing, so
// neither a settle nor the trim fails on it.
const settledBrief = (row: Pick<JobRow, 'kind' | 'brief_json'>): string => {
  try {
    if (row.kind === 'retry_turn') return JSON.stringify({ ...(JSON.parse(row.brief_json) as RetryBrief), text: '' });
    const { title, started_at, outside_text } = JSON.parse(row.brief_json) as TaskBrief;
    return JSON.stringify({ title: title.slice(0, TITLE_KEPT), started_at, ...(outside_text ? { outside_text } : {}) });
  } catch {
    return '{}';
  }
};
// The texts a forget names, longest first: redacting a shorter text first would cut a longer one that contains it into a
// fragment. A stored value carries one when the forget purge job's readback says so: raw, spelled by an escape, or in a decoded
// JSON string or key.
const forgetTopics = (texts: readonly string[]) => [...new Set(texts.map(text => text.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
const carriesAny = (topics: readonly string[]) => (value: string | null) => value !== null && topics.some(topic => projectionValueHolds(value, topic));
type Copies = Pick<JobRow, 'id' | 'status' | 'brief_json' | 'checkpoint_json' | 'result_json'>;
const copies = (sql: Sql): Copies[] => sql.exec<Copies>('SELECT id, status, brief_json, checkpoint_json, result_json FROM task_jobs').toArray();
const columns = (row: Copies) => [row.brief_json, row.checkpoint_json, row.result_json];
type LostAttempt = Readonly<{ id: string; crashes: number; deadline_at: number; inflight_json: string | null }>;
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

export const jobBook = (sql: Sql, deps: Readonly<{ now(): number; newId(): string; newToken(): string }>) => {
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
  // An attempt lost while an effect that cannot be replayed was in flight parks at once: the effect may or may not have
  // happened, and running it again blind could do it twice. Answers whether the job parked.
  const endAttempt = ({ id, crashes, deadline_at, inflight_json }: LostAttempt, now: number): boolean => {
    const reason: ParkReason | null = inflight_json !== null ? 'uncertain_effect' : now >= deadline_at ? 'deadline' : crashes + 1 >= TASK_MAX_CRASHES ? 'crashed' : null;
    sql.exec(
      reason !== null
        ? `UPDATE task_jobs SET status = 'reported', outcome = 'failed', park_reason = ?, crashes = crashes + 1, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`
        : `UPDATE task_jobs SET status = 'queued', crashes = crashes + 1, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      ...(reason !== null ? [reason] : []), now, now, id,
    );
    return reason !== null;
  };
  const park = (id: string, reason: ParkReason, outcome: JobOutcome = 'failed'): boolean => {
    const now = deps.now();
    return sql.exec(
      `UPDATE task_jobs SET status = 'reported', outcome = ?, park_reason = ?, lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`, outcome, reason, now, now, id,
    ).rowsWritten > 0;
  };

  const byKey = (key: string): JobRow | null => sql.exec<JobRow>('SELECT * FROM task_jobs WHERE idempotency_key = ?', key).toArray()[0] ?? null;

  return {
    get,
    byKey,
    // Tasks the model started that are still open, and those the turn `origin` started in any state.
    taskCounts(origin: string): Readonly<{ open: number; fromTurn: number }> {
      const row = sql.exec<{ open: number; from_turn: number }>(
        `SELECT COALESCE(SUM(status IN (${placeholders(OPEN)})), 0) AS open, COALESCE(SUM(origin = ?), 0) AS from_turn FROM task_jobs WHERE kind = 'task' AND NOT ${MACHINE_ROW}`, ...OPEN, origin,
      ).toArray()[0];
      return { open: row?.open ?? 0, fromTurn: row?.from_turn ?? 0 };
    },
    // Intent before I/O: the row is written before any worker starts. The same idempotency key (a replayed turn's tool call)
    // returns the job it already made instead of making a second one.
    create(input: CreateJob): Readonly<{ job: JobRow; created: boolean }> {
      const existing = byKey(input.idempotencyKey);
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
         WHERE id = ? AND status = 'queued' AND deadline_at + ? >= ? RETURNING attempt`, token, now + TASK_LEASE_MS, now, id, JOB_START_GRACE_MS, now,
      ).toArray()[0];
      if (row) return { jobId: id, attempt: row.attempt, token };
      const late = get(id);
      if (late?.status === 'queued' && late.deadline_at + JOB_START_GRACE_MS < now) park(id, 'deadline');
      return null;
    },
    // Intent before an effect that cannot be replayed: the call is recorded on the job before it runs, and cleared only by
    // the checkpoint or report that records its result. Until then the worker's own copy of the result is the only one, so an
    // attempt lost in between is known to have left the effect uncertain.
    beginEffect(ticket: TaskTicket, call: Readonly<{ tool: string; call_id: string }>): boolean {
      return renew(ticket, ', inflight_json = ?', JSON.stringify({ ...call, at: deps.now() }));
    },
    // A step refused before its handler ran (the taint gate, a hook, its schema) left nothing uncertain: its intent goes.
    endEffect(ticket: TaskTicket): boolean {
      return renew(ticket, ', inflight_json = NULL');
    },
    // A worker (re)joining its attempt: the lease renews, and the job's brief and last checkpoint come back. A rejoin while
    // an effect is still recorded in flight means the worker lost the effect's result, so the job parks instead.
    claim(ticket: TaskTicket): JobRow | Fenced | 'parked' {
      if (!renew(ticket)) return 'fenced';
      const row = get(ticket.jobId)!;
      const reason: ParkReason | null = row.inflight_json !== null ? 'uncertain_effect' : deps.now() > row.deadline_at + JOB_START_GRACE_MS ? 'deadline' : null;
      if (reason === null) return row;
      return park(row.id, reason) ? 'parked' : 'fenced';
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
      return renew(ticket, ', checkpoint_seq = ?, checkpoint_json = ?, inflight_json = NULL, rounds = rounds + ?, cost_usd = cost_usd + ?', seq, JSON.stringify(checkpoint), spend.rounds, spend.costUsd) ? 'ok' : 'fenced';
    },
    // Apply-once by job id: only the attempt holding the lease can report, once. A second report from the same attempt is a
    // duplicate; one from any other attempt or after a cancel is fenced and discarded.
    report(ticket: TaskTicket, result: TaskResult, spend: Readonly<{ rounds: number; costUsd: number }>): 'accepted' | 'duplicate' | Fenced {
      const now = deps.now();
      const written = sql.exec(
        `UPDATE task_jobs SET status = 'reported', result_json = ?, outcome = ?, lease_token = NULL, lease_until = NULL, due_at = ?, inflight_json = NULL,
           rounds = rounds + ?, cost_usd = cost_usd + ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
        JSON.stringify(result), result.status, now, spend.rounds, spend.costUsd, now, ticket.jobId, ticket.attempt, ticket.token,
      ).rowsWritten;
      if (written > 0) return 'accepted';
      const row = get(ticket.jobId);
      return row && row.attempt === ticket.attempt && (row.status === 'reported' || row.status === 'applied') ? 'duplicate' : 'fenced';
    },
    // No provider could answer: the attempt ends without counting as a crash, and the job waits for its next try. A next
    // try past the deadline parks the job instead; a try at the deadline is the last one. An effect still recorded in flight
    // was never checkpointed, so the next try could not know it happened: the job parks.
    defer(ticket: TaskTicket, dueAt: number, spend: Readonly<{ rounds: number; costUsd: number }>): 'deferred' | 'parked' | Fenced {
      const row = current(ticket);
      if (!row) return 'fenced';
      const now = deps.now();
      if (dueAt > row.deadline_at || row.inflight_json !== null) {
        return sql.exec(
          `UPDATE task_jobs SET status = 'reported', outcome = 'failed', park_reason = ?, lease_token = NULL, lease_until = NULL, due_at = ?,
             deferrals = deferrals + 1, rounds = rounds + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?`,
          row.inflight_json !== null ? 'uncertain_effect' : 'provider_unavailable', now, spend.rounds, spend.costUsd, now, ticket.jobId, ticket.attempt, ticket.token,
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
      // A busy job past its deadline ends too: its call then finds the attempt gone and is fenced.
      const lapsed = sql.exec<LostAttempt>(
        "SELECT id, crashes, deadline_at, inflight_json FROM task_jobs WHERE status = 'running' AND lease_until < ?", now,
      ).toArray().filter(({ id, deadline_at }) => !busy.has(id) || now >= deadline_at);
      return lapsed.map((row) => ({ id: row.id, parked: endAttempt(row, now) }));
    },
    // The attempt's own worker came back while an earlier invocation of it may still be served (a re-fired alarm). The
    // attempt ends as if lost, so every later call from either invocation is fenced and a new attempt resumes from the
    // checkpoint; a step already recorded in flight parks it.
    abandon(ticket: TaskTicket): boolean | Fenced {
      const row = sql.exec<LostAttempt>(
        "SELECT id, crashes, deadline_at, inflight_json FROM task_jobs WHERE id = ? AND status = 'running' AND attempt = ? AND lease_token = ?",
        ticket.jobId, ticket.attempt, ticket.token,
      ).toArray()[0];
      return row ? endAttempt(row, deps.now()) : 'fenced';
    },
    // A job the brain itself parks (a retry whose promised time came, an effect that cannot be replayed, a changed brief).
    park,
    // The owner is no longer admitted: running attempts (all, or job `id`'s) end without counting as a crash, and wait in the
    // queue until the owner is admitted again; one with an effect in flight parks, as a lost attempt would. Answers the ids.
    suspend(id?: string): readonly string[] {
      const now = deps.now();
      const running = sql.exec<Pick<JobRow, 'id' | 'inflight_json'>>(
        `SELECT id, inflight_json FROM task_jobs WHERE status = 'running'${id === undefined ? '' : ' AND id = ?'}`, ...(id === undefined ? [] : [id]),
      ).toArray();
      for (const row of running) {
        if (row.inflight_json !== null) park(row.id, 'uncertain_effect');
        else sql.exec("UPDATE task_jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, due_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", now, now, row.id);
      }
      return running.map((row) => row.id);
    },
    // The cancellation fence: the token is cleared in the same write that settles the job, so every later call from the
    // worker is fenced and a result that arrives late is discarded. A forget's cancel keeps the brief for the redaction that
    // follows it in the same call (forget below); the next trim drops the rest.
    cancel(id: string, reason: CancelReason): boolean {
      const now = deps.now();
      const row = get(id);
      if (!row || !OPEN.includes(row.status)) return false;
      return sql.exec(
        `UPDATE task_jobs SET status = 'cancelled', cancel_reason = ?, lease_token = NULL, lease_until = NULL, due_at = NULL, brief_json = ?, checkpoint_json = NULL, result_json = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders(OPEN)})`, reason, reason === 'forgotten' ? row.brief_json : settledBrief(row), now, now, id, ...OPEN,
      ).rowsWritten > 0;
    },
    // A reported job that the owner heard about. Parked jobs settle as parked; the rest as applied. The checkpoint, which
    // only a resumed attempt needs, the result, which only the apply turn reads, and the brief's text are dropped once the
    // job is settled: they hold what the owner and the worker wrote and read, and a settled row is kept for the console and
    // audit.
    settle(id: string): boolean {
      const now = deps.now();
      const row = get(id);
      if (row?.status !== 'reported') return false;
      return sql.exec(
        `UPDATE task_jobs SET status = CASE WHEN park_reason IS NULL THEN 'applied' ELSE 'parked' END, due_at = NULL, brief_json = ?, checkpoint_json = NULL, result_json = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND status = 'reported'`, settledBrief(row), now, now, id,
      ).rowsWritten > 0;
    },
    // Runs as the commit of a progress note's delivery: a job that stopped running since writes no row, and the throw rolls
    // the queued note back with it.
    noteSent(id: string): void {
      if (sql.exec("UPDATE task_jobs SET notes_sent = notes_sent + 1, last_note_at = ?, updated_at = ? WHERE id = ? AND status = 'running'", deps.now(), deps.now(), id).rowsWritten === 0) throw new ClosedRunError();
    },
    open: (): readonly JobRow[] => sql.exec<JobRow>(`SELECT * FROM task_jobs WHERE status IN (${placeholders(OPEN)}) ORDER BY created_at`, ...OPEN).toArray(),
    running: (): readonly JobRow[] => sql.exec<JobRow>("SELECT * FROM task_jobs WHERE status = 'running' ORDER BY created_at").toArray(),
    // The owner's task slots. A machine job never takes one: the owner did not start it, and must never wait behind it.
    runningTasks: (): number => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM task_jobs WHERE status = 'running' AND kind = 'task' AND NOT ${MACHINE_ROW}`).toArray()[0]?.n ?? 0,
    runningMachine: (): number => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM task_jobs WHERE status = 'running' AND ${MACHINE_ROW}`).toArray()[0]?.n ?? 0,
    // The open machine job of a job and scope, if any.
    openMachine: (job: MachineJob, scope: string): JobRow | null => sql.exec<JobRow>(
      `SELECT * FROM task_jobs WHERE origin = ? AND status IN (${placeholders(OPEN)}) AND json_extract(brief_json, '$.machine.scope') = ? ORDER BY created_at LIMIT 1`,
      `${MACHINE_ORIGIN}${job}`, ...OPEN, scope,
    ).toArray()[0] ?? null,
    // The owner turned a machine job off: its open jobs are cancelled. Answers the ids, for their workers to be fenced.
    cancelMachine(job: MachineJob): readonly string[] {
      return sql.exec<{ id: string }>(`SELECT id FROM task_jobs WHERE origin = ? AND status IN (${placeholders(OPEN)})`, `${MACHINE_ORIGIN}${job}`, ...OPEN)
        .toArray().filter(row => this.cancel(row.id, 'owner')).map(row => row.id);
    },
    // Work the brain owes now: queued attempts whose time came, and reported jobs not yet applied.
    due: (): readonly JobRow[] => sql.exec<JobRow>(
      "SELECT * FROM task_jobs WHERE status IN ('queued', 'reported') AND due_at <= ? ORDER BY due_at, created_at", deps.now(),
    ).toArray(),
    // Intent before a report's apply turn, which holds the owner's tools: a reported row still carrying it was lost partway
    // through that turn (applyInterrupted), and the lane does not run the turn again.
    beginApply(id: string): boolean {
      return sql.exec("UPDATE task_jobs SET inflight_json = ? WHERE id = ? AND status = 'reported'", JSON.stringify({ turn: 'task_report', at: deps.now() }), id).rowsWritten > 0;
    },
    // An apply turn that ended in this pass without a reply (closed partway) left no turn in flight.
    endApply(id: string): boolean {
      return sql.exec("UPDATE task_jobs SET inflight_json = NULL WHERE id = ? AND status = 'reported'", id).rowsWritten > 0;
    },
    // An apply that could not run (no model to write the report) waits like a deferred attempt; it failed in this pass, so it
    // left no turn in flight. updated_at keeps the time the job was reported, which bounds how long its apply is retried.
    postpone(id: string, dueAt: number): boolean {
      return sql.exec("UPDATE task_jobs SET due_at = ?, deferrals = deferrals + 1, inflight_json = NULL WHERE id = ? AND status = 'reported'", dueAt, id).rowsWritten > 0;
    },
    // The next moment the brain has something to do: a queued job's due time, a running attempt's lease end, or now for a report.
    // While every task slot is taken, a queued task waits for a report rather than its due time. A job in `busy` has a call
    // running in the brain, which renews its lease when it returns; until then its lapsed lease is looked at again a lease
    // from now, not at once, so a long step does not keep the alarm firing.
    // machineFull holds queued machine jobs the same way, behind MACHINE_MAX_RUNNING.
    nextDue(slotsFull = false, busy: ReadonlySet<string> = new Set(), machineFull = false): number | null {
      const held = [...busy];
      const row = sql.exec<{ next: number | null }>(
        `SELECT MIN(CASE WHEN status = 'running' AND id IN (${placeholders(held)}) THEN MAX(lease_until, ?) WHEN status = 'running' THEN lease_until ELSE due_at END) AS next
         FROM task_jobs WHERE status IN (${placeholders(OPEN)}) AND NOT (? AND status = 'queued' AND kind = 'task' AND NOT ${MACHINE_ROW}) AND NOT (? AND status = 'queued' AND ${MACHINE_ROW})`,
        ...held, deps.now() + TASK_LEASE_MS, ...OPEN, slotsFull ? 1 : 0, machineFull ? 1 : 0,
      ).toArray()[0];
      return row?.next ?? null;
    },
    // Owner forget: open jobs whose brief, progress or result carries a forgotten text are cancelled, since their worker holds
    // a copy; then the text leaves the brief, progress and result of every row. Only after the cancel, so no open job is ever
    // rewritten under its worker. A settled copy the literal redaction cannot rewrite (an escape that spells the text, a key)
    // is dropped from the row: a settled row needs none of it. Answers the jobs cancelled, for the caller to fence, and how
    // many copies remain, counting each running task.
    forget(texts: readonly string[]): Readonly<{ cancelled: readonly string[]; remaining: number }> {
      const topics = forgetTopics(texts);
      if (!topics.length) return { cancelled: [], remaining: 0 };
      const holds = carriesAny(topics);
      const cancelled = copies(sql).filter(row => OPEN.includes(row.status) && columns(row).some(holds) && this.cancel(row.id, 'forgotten')).map(row => row.id);
      const redact = (text: string) => topics.reduce((value, topic) => replaceLiteralText(value, topic, FORGOTTEN), text);
      const rewrite = (value: string) => {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { return redact(value); }
        return JSON.stringify(parsed, (_key, leaf: unknown) => (typeof leaf === 'string' ? redact(leaf) : leaf));
      };
      for (const row of copies(sql)) {
        for (const column of ['brief_json', 'checkpoint_json', 'result_json'] as const) {
          const value = row[column];
          if (!holds(value)) continue;
          const next = rewrite(value!);
          const kept = holds(next) && !OPEN.includes(row.status) ? (column === 'brief_json' ? '{}' : null) : next;
          sql.exec(`UPDATE task_jobs SET ${column} = ? WHERE id = ?`, kept, row.id);
        }
      }
      // A running worker may hold the text in memory without any row showing it, so each running task counts as a copy
      // until it stops: the topic stays held, and the brain refuses a checkpoint that would write it back.
      const unseen = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs WHERE status = 'running' AND kind = 'task'").toArray()[0]?.n ?? 0;
      const remaining = copies(sql).reduce((count, row) => count + columns(row).filter(holds).length, unseen);
      return { cancelled, remaining };
    },
    // TTL sweep: a settled row still holding its whole brief (a forget's cancel, a row settled before briefs were dropped)
    // keeps only what a settled row keeps; the owner's settled rows past the newest TASK_SETTLED_KEPT are dropped, and machine
    // rows past their own.
    trim(): number {
      const whole = sql.exec<Pick<JobRow, 'id' | 'kind' | 'brief_json'>>(
        `SELECT id, kind, brief_json FROM task_jobs WHERE ${SETTLED}
           AND (NOT json_valid(brief_json) OR json_type(brief_json, '$.goal') IS NOT NULL OR (kind = 'retry_turn' AND json_extract(brief_json, '$.text') <> ''))`,
      ).toArray();
      for (const row of whole) sql.exec('UPDATE task_jobs SET brief_json = ? WHERE id = ?', settledBrief(row), row.id);
      const owner = sql.exec(
        `DELETE FROM task_jobs WHERE ${SETTLED} AND NOT ${MACHINE_ROW}
           AND id NOT IN (SELECT id FROM task_jobs WHERE ${SETTLED} AND NOT ${MACHINE_ROW} ORDER BY settled_at DESC LIMIT ?)`, TASK_SETTLED_KEPT,
      ).rowsWritten;
      return owner + sql.exec(
        `DELETE FROM task_jobs WHERE ${SETTLED} AND ${MACHINE_ROW} AND settled_at < ?
           AND id NOT IN (SELECT id FROM task_jobs WHERE ${SETTLED} AND ${MACHINE_ROW} ORDER BY settled_at DESC LIMIT ?)`, deps.now() - MACHINE_SETTLED_KEPT_MS, MACHINE_SETTLED_KEPT,
      ).rowsWritten;
    },
  };
};
export type JobBook = ReturnType<typeof jobBook>;
// Whether this storage has a job book, asked without opening one (which creates the table).
export const jobsKept = (sql: Sql): boolean =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_jobs'").toArray().length > 0;
// Whether any of these values carries one of the texts, by the forget store's own predicate: what a job is written from is
// held to the same reading the purge cleans by.
export const carriesForgotten = (texts: readonly string[], values: readonly (string | null)[]): boolean => {
  const topics = forgetTopics(texts);
  return topics.length > 0 && values.some(carriesAny(topics));
};

// Whether a forget of these texts would change the job book, asked without opening one: the forget tool counts a task that
// carries the text as memory it touched.
export const jobsCarry = (sql: Sql, texts: readonly string[]): boolean => {
  const topics = forgetTopics(texts);
  return topics.length > 0 && jobsKept(sql) && copies(sql).some(row => columns(row).some(carriesAny(topics)));
};

// The forget purge job's store for task jobs (memory/forget-purge.ts). One transaction cancels the open jobs that carry a text,
// fences their attempts and withdraws their errands' cards (cancelled), and redacts every row; a fence that throws rolls it
// all back, so the job's retry cancels and fences again. Storage with no job book has nothing to clean and gets none made.
export const taskJobsForgetStore = (deps: Readonly<{ sql: Sql; transaction: <T>(work: () => T) => T; book: () => JobBook; cancelled: (id: string) => void }>): ForgetStore => ({
  name: 'task_jobs',
  run: (texts) => (!jobsKept(deps.sql) ? 0 : deps.transaction(() => {
    const { cancelled, remaining } = deps.book().forget(texts);
    for (const id of cancelled) deps.cancelled(id);
    return remaining;
  })),
});

export const taskBrief = (row: JobRow): TaskBrief => JSON.parse(row.brief_json) as TaskBrief;
export const retryBrief = (row: JobRow): RetryBrief => JSON.parse(row.brief_json) as RetryBrief;
export const jobCheckpoint = (row: JobRow): Checkpoint => row.checkpoint_json === null ? { turns: [] } : JSON.parse(row.checkpoint_json) as Checkpoint;
// A reported row's intent is its apply turn's (a worker's in-flight step, kept on a parked row, names a tool instead).
export const applyInterrupted = (row: Pick<JobRow, 'status' | 'inflight_json'>): boolean =>
  row.status === 'reported' && row.inflight_json !== null && (JSON.parse(row.inflight_json) as { turn?: unknown }).turn === 'task_report';
export const jobResult = (row: JobRow): TaskResult | null => row.result_json === null ? null : JSON.parse(row.result_json) as TaskResult;
