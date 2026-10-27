import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { TASK_JOBS_TABLE_SCHEMA } from '../src/do-schema';
import { jobBook, jobCheckpoint, jobResult, JOB_START_GRACE_MS, TASK_LEASE_MS, TASK_MAX_CRASHES, taskBrief, type CreateJob, type RetryBrief, type TaskBrief } from '../src/tasks/jobs';

// The job book on real Durable Object SQLite. Each case drives one recovery path of the job protocol and checks that the
// row ends where the protocol says, and that a call from the wrong attempt changes nothing.
let seq = 0;
const withBook = async <T,>(work: (book: ReturnType<typeof jobBook>, clock: { at: number }, sql: SqlStorage) => T | Promise<T>): Promise<T> => {
  const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-jobs-${seq += 1}`));
  return runInDurableObject(stub, async (_instance, state) => {
    const clock = { at: 1_800_000_000_000 };
    let n = 0;
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    return work(book, clock, state.storage.sql);
  });
};

const brief: TaskBrief = { title: 'Inbox since Monday', goal: 'Find unanswered client mail.', context: 'Clients write from company domains.', done_when: 'A list of threads.', effort: 'standard', timezone: 'Europe/London', started_at: 1_800_000_000_000 };
const job = (key = 'turn-1:call-1', extra: Partial<CreateJob> = {}): CreateJob => ({
  kind: 'task', profile: 'reader', idempotencyKey: key, origin: 'tg-1', surface: 'app', brief, dueAt: 1_800_000_000_000, deadlineAt: 1_800_000_000_000 + 3_600_000, ...extra,
});
const result: TaskResult = { status: 'done', summary: 'Three threads wait on you.', findings: [{ text: 'Asha asked for the quote.', source_ref: 'gmail:1' }], proposals: [], left: [] };
const spend = { rounds: 1, costUsd: 0.01 };
const turn = (n: number) => ({ call: { call_id: `c${n}`, name: 'search_communication', arguments: '{}' }, output: `page ${n}` });

describe('task job book', () => {
  it('a table an earlier build made, which does not admit approval replays, is rebuilt with its rows kept', async () => {
    const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-jobs-${seq += 1}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql, deps = { now: () => 1_800_000_000_000, newId: () => crypto.randomUUID().slice(0, 12), newToken: () => crypto.randomUUID() };
      for (const statement of TASK_JOBS_TABLE_SCHEMA) sql.exec(statement.replace("'task', 'retry_turn', 'approval_replay'", "'task', 'retry_turn'"));
      const before = jobBook(sql, deps).create(job()).job;
      expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'task_jobs'").one().sql).toContain("'approval_replay'");
      const book = jobBook(sql, deps);
      expect(book.get(before.id)).toEqual(before);
      expect(book.create(job('approval:p1', { kind: 'approval_replay', profile: null })).job.kind).toBe('approval_replay');
      expect(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'task_jobs%' ORDER BY name").toArray().map(row => row.name)).toEqual(['task_jobs', 'task_jobs_open']);
    });
  });

  it('writes the job before any I/O, once per idempotency key', async () => {
    await withBook((book) => {
      const first = book.create(job());
      const again = book.create(job());
      expect(first.created).toBe(true);
      expect(again).toEqual({ job: first.job, created: false });
      expect(first.job).toMatchObject({ status: 'queued', attempt: 0, lease_token: null, kind: 'task', profile: 'reader' });
      expect(first.job.id).toMatch(/^job_[0-9a-f]{12}$/);
      expect(JSON.parse(first.job.brief_json)).toEqual(brief);
    });
  });

  it('a started attempt holds a lease; claim and tool calls renew it', async () => {
    await withBook((book, clock) => {
      const { job: row } = book.create(job());
      const ticket = book.startAttempt(row.id)!;
      expect(ticket).toMatchObject({ jobId: row.id, attempt: 1 });
      expect(book.startAttempt(row.id)).toBeNull();
      clock.at += 60_000;
      expect(book.claim(ticket)).toMatchObject({ status: 'running', lease_until: clock.at + TASK_LEASE_MS });
      clock.at += 60_000;
      expect(book.touch(ticket, 'external')).toBe(true);
      expect(book.get(row.id)).toMatchObject({ taint: 'external', lease_until: clock.at + TASK_LEASE_MS });
    });
  });

  it('a worker crash mid-job: the lapsed attempt goes back to the queue and resumes from its last checkpoint', async () => {
    await withBook((book, clock) => {
      const { job: row } = book.create(job());
      const first = book.startAttempt(row.id)!;
      expect(book.checkpoint(first, 1, { turns: [turn(1)] }, spend)).toBe('ok');
      clock.at += TASK_LEASE_MS + 1;
      expect(book.lapse()).toEqual([{ id: row.id, parked: false }]);
      expect(book.get(row.id)).toMatchObject({ status: 'queued', crashes: 1, lease_token: null, rounds: 1 });
      const second = book.startAttempt(row.id)!;
      expect(second.attempt).toBe(2);
      const claimed = book.claim(second);
      expect(typeof claimed !== 'string' && jobCheckpoint(claimed).turns).toEqual([turn(1)]);
    });
  });

  it('lease expiry with a late result: the old attempt is fenced and its result discarded', async () => {
    await withBook((book, clock) => {
      const { job: row } = book.create(job());
      const first = book.startAttempt(row.id)!;
      clock.at += TASK_LEASE_MS + 1;
      book.lapse();
      const second = book.startAttempt(row.id)!;
      expect(book.report(first, { ...result, summary: 'late' }, spend)).toBe('fenced');
      expect(book.checkpoint(first, 5, { turns: [turn(9)] }, spend)).toBe('fenced');
      expect(book.claim(first)).toBe('fenced');
      expect(book.touch(first, null)).toBe(false);
      expect(book.report(second, result, spend)).toBe('accepted');
      expect(jobResult(book.get(row.id)!)).toEqual(result);
    });
  });

  it('a duplicate report is a no-op that says so', async () => {
    await withBook((book) => {
      const { job: row } = book.create(job());
      const ticket = book.startAttempt(row.id)!;
      expect(book.report(ticket, result, spend)).toBe('accepted');
      expect(book.report(ticket, { ...result, summary: 'second' }, spend)).toBe('duplicate');
      expect(jobResult(book.get(row.id)!)?.summary).toBe(result.summary);
      expect(book.get(row.id)!.rounds).toBe(1);
      expect(book.settle(row.id)).toBe(true);
      expect(book.settle(row.id)).toBe(false);
      expect(book.report(ticket, result, spend)).toBe('duplicate');
      expect(book.get(row.id)).toMatchObject({ status: 'applied', checkpoint_json: null });
    });
  });

  it('a replayed checkpoint sequence is stale and keeps the newer checkpoint', async () => {
    await withBook((book) => {
      const { job: row } = book.create(job());
      const ticket = book.startAttempt(row.id)!;
      expect(book.checkpoint(ticket, 2, { turns: [turn(1), turn(2)] }, spend)).toBe('ok');
      expect(book.checkpoint(ticket, 1, { turns: [turn(1)] }, spend)).toBe('stale');
      expect(jobCheckpoint(book.get(row.id)!).turns).toHaveLength(2);
      expect(book.get(row.id)!.rounds).toBe(1);
    });
  });

  it(`after ${TASK_MAX_CRASHES} lost attempts the job parks with what it had`, async () => {
    await withBook((book, clock) => {
      const { job: row } = book.create(job());
      for (let crash = 1; crash <= TASK_MAX_CRASHES; crash += 1) {
        book.startAttempt(row.id);
        clock.at += TASK_LEASE_MS + 1;
        expect(book.lapse()).toEqual([{ id: row.id, parked: crash === TASK_MAX_CRASHES }]);
      }
      expect(book.get(row.id)).toMatchObject({ status: 'reported', park_reason: 'crashed', outcome: 'failed', crashes: TASK_MAX_CRASHES });
      expect(book.settle(row.id)).toBe(true);
      expect(book.get(row.id)!.status).toBe('parked');
    });
  });

  it('the provider down on retry defers without counting a crash, and parks at the deadline', async () => {
    await withBook((book, clock) => {
      const { job: row } = book.create(job());
      const first = book.startAttempt(row.id)!;
      expect(book.defer(first, clock.at + 120_000, spend)).toBe('deferred');
      expect(book.get(row.id)).toMatchObject({ status: 'queued', crashes: 0, deferrals: 1, due_at: clock.at + 120_000 });
      expect(book.due()).toEqual([]);
      clock.at += 120_000;
      expect(book.due().map(due => due.id)).toEqual([row.id]);
      const second = book.startAttempt(row.id)!;
      expect(book.defer(second, row.deadline_at + 1, spend)).toBe('parked');
      expect(book.get(row.id)).toMatchObject({ status: 'reported', park_reason: 'provider_unavailable', crashes: 0, deferrals: 2 });
    });
  });

  it('cancellation fences every later call and a late result is discarded', async () => {
    await withBook((book) => {
      const { job: row } = book.create(job());
      const ticket = book.startAttempt(row.id)!;
      book.checkpoint(ticket, 1, { turns: [turn(1)] }, spend);
      expect(book.cancel(row.id, 'owner')).toBe(true);
      expect(book.cancel(row.id, 'owner')).toBe(false);
      expect(book.report(ticket, result, spend)).toBe('fenced');
      expect(book.claim(ticket)).toBe('fenced');
      expect(book.get(row.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner', checkpoint_json: null, result_json: null, lease_token: null });
      expect(book.startAttempt(row.id)).toBeNull();
    });
  });

  it('a settled or cancelled job keeps only its title and times of the brief: the goal, context and the owner\'s message go', async () => {
    await withBook((book) => {
      const outside = { ...brief, context: 'Asha\'s mail says the Lisbon deal closes Friday.', outside_text: true as const };
      const reported = book.create(job('k1', { brief: outside })).job;
      book.report(book.startAttempt(reported.id)!, result, spend);
      expect(book.settle(reported.id)).toBe(true);
      const cancelled = book.create(job('k2', { taint: 'external' })).job;
      expect(book.cancel(cancelled.id, 'owner')).toBe(true);
      const retryBrief: RetryBrief = { message_ref: 'm-1', text: 'Move my 4pm with Asha to 5pm.', conversation_ref: 'chain-1', said_at: 1_800_000_000_000, promised_by: 1_800_001_800_000 };
      const retry = book.create(job('k3', { kind: 'retry_turn', profile: null, brief: retryBrief })).job;
      expect(book.park(retry.id, 'deadline')).toBe(true);
      expect(book.settle(retry.id)).toBe(true);
      for (const before of [reported, cancelled, retry]) {
        const after = book.get(before.id)!;
        expect(after.brief_json).not.toMatch(/Lisbon|unanswered client mail|company domains|4pm/);
        expect(after).toMatchObject({ profile: before.profile, brief_digest: before.brief_digest, origin: before.origin, taint: before.taint });
      }
      expect(JSON.parse(book.get(reported.id)!.brief_json)).toEqual({ title: brief.title, started_at: brief.started_at, outside_text: true });
      expect(taskBrief(book.get(cancelled.id)!).title).toBe(brief.title);
      expect(JSON.parse(book.get(retry.id)!.brief_json)).toEqual({ ...retryBrief, text: '' });
    });
  });

  it('a forget cancels the job and redacts its brief in the same call; the next trim drops the rest', async () => {
    await withBook((book) => {
      const { job: row } = book.create(job('k1', { brief: { ...brief, context: 'Asha said "the Lisbon trip" is off.' } }));
      expect(book.forget(['Lisbon trip'])).toEqual({ cancelled: [row.id], remaining: 0 });
      expect(book.get(row.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
      expect(taskBrief(book.get(row.id)!).context).toBe('Asha said "the [forgotten]" is off.');
      book.trim();
      expect(JSON.parse(book.get(row.id)!.brief_json)).toEqual({ title: brief.title, started_at: brief.started_at });
      expect(book.get(row.id)!.brief_digest).toBe(row.brief_digest);
    });
  });

  it('a settled brief left unreadable keeps none of it after the trim', async () => {
    await withBook((book, _clock, sql) => {
      const { job: row } = book.create(job());
      sql.exec("UPDATE task_jobs SET brief_json = replace(brief_json, 'Monday\",\"goal', 'Monday') WHERE id = ?", row.id);
      expect(() => JSON.parse(book.get(row.id)!.brief_json)).toThrow();
      expect(book.forget(['unanswered client mail'])).toEqual({ cancelled: [row.id], remaining: 0 });
      book.trim();
      expect(book.get(row.id)).toMatchObject({ status: 'cancelled', brief_json: '{}' });
    });
  });

  it('owner forget mid-job: open jobs carrying the text are cancelled, others keep running, settled rows stay settled', async () => {
    await withBook((book) => {
      const carrying = book.create(job('k1', { brief: { ...brief, context: 'Asha said "the Lisbon trip" is off.' } })).job;
      const other = book.create(job('k2')).job;
      const finished = book.create(job('k3')).job;
      const ticket = book.startAttempt(finished.id)!;
      book.report(ticket, { ...result, findings: [{ text: 'Mail about the lisbon trip.' }] }, spend);
      book.settle(finished.id);
      expect(book.forget(['Lisbon trip'])).toEqual({ cancelled: [carrying.id], remaining: 0 });
      expect(book.get(carrying.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
      expect(book.get(other.id)!.status).toBe('queued');
      expect(book.get(finished.id)!.status).toBe('applied');
      expect(book.forget(['  '])).toEqual({ cancelled: [], remaining: 0 });
    });
  });

  it('a forget leaves no copy in the brief, checkpoint or result of any row: a job mid-run, a reported one, and a row an older build settled whole', async () => {
    await withBook((book, _clock, sql) => {
      const running = book.create(job('k1')).job;
      book.checkpoint(book.startAttempt(running.id)!, 1, { turns: [{ ...turn(1), output: 'Mail about the Lisbon trip, page 1' }] }, spend);
      const reported = book.create(job('k2')).job;
      book.report(book.startAttempt(reported.id)!, { ...result, summary: 'The Lisbon trip is booked.' }, spend);
      const old = book.create(job('k3')).job;
      book.cancel(old.id, 'owner');
      // What a build that kept a settled row's progress and result left behind.
      sql.exec('UPDATE task_jobs SET brief_json = ?, checkpoint_json = ?, result_json = ? WHERE id = ?',
        JSON.stringify({ ...brief, title: 'Plan the Lisbon trip' }), JSON.stringify({ turns: [{ ...turn(2), output: 'lisbon trip hotels' }] }),
        JSON.stringify({ ...result, summary: 'Lisbon trip: two hotels.' }), old.id);
      const other = book.create(job('k4')).job;
      const out = book.forget(['Lisbon trip']);
      expect(out).toEqual({ cancelled: [running.id, reported.id], remaining: 0 });
      for (const id of [running.id, reported.id]) expect(book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
      expect(book.get(old.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
      for (const column of ['brief_json', 'checkpoint_json', 'result_json']) {
        expect(JSON.stringify(sql.exec(`SELECT ${column} FROM task_jobs`).toArray()), column).not.toMatch(/lisbon trip/i);
      }
      expect(jobCheckpoint(book.get(old.id)!).turns[0]!.output).toBe('[forgotten] hotels');
      expect(jobResult(book.get(old.id)!)!.summary).toBe('[forgotten]: two hotels.');
      expect(book.get(other.id)).toMatchObject({ status: 'queued', brief_json: JSON.stringify(brief) });
    });
  });

  it('a forget reaches machine jobs like the owner\'s: open and reported ones are cancelled, and no machine row keeps the text', async () => {
    await withBook((book, _clock, sql) => {
      const machine = (key: string, context: string, block: NonNullable<TaskBrief['machine']>): CreateJob =>
        job(key, { origin: `machine:${block.job}`, brief: { ...brief, title: 'Background check', context, machine: block } });
      const open = book.create(machine('m1', 'Due: check how the Lisbon trip call went.', { job: 'heartbeat', input_digest: 'd1', scope: 'owner', refs: ['loop:1'] })).job;
      const reported = book.create(machine('m2', 'Mail since the last sweep.', { job: 'update_sweep', input_digest: 'd2', scope: 'owner', refs: ['mail:1'], record_id: 7 })).job;
      book.report(book.startAttempt(reported.id)!, { ...result, findings: [{ text: 'Asha wrote about the Lisbon trip.' }] }, spend);
      expect(book.openMachine('heartbeat', 'owner')!.id).toBe(open.id);
      expect(book.forget(['Lisbon trip'])).toEqual({ cancelled: [open.id, reported.id], remaining: 0 });
      expect(book.get(open.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
      expect(book.openMachine('heartbeat', 'owner')).toBeNull();
      expect(JSON.stringify(sql.exec('SELECT brief_json, checkpoint_json, result_json FROM task_jobs').toArray())).not.toMatch(/lisbon trip/i);
      expect(taskBrief(book.get(open.id)!).machine).toEqual({ job: 'heartbeat', input_digest: 'd1', scope: 'owner', refs: ['loop:1'] });
    });
  });

  // A running worker may hold a forgotten text only in memory (P2c): its rows cannot show it, so the forget is not settled
  // while the task runs, and the held topic fences the worker's next checkpoint (task-brain). Once it stops, it settles.
  it('a forget is not settled while a task runs, even when no row carries the text; it settles once the task stops', async () => {
    await withBook((book) => {
      const running = book.create(job('k1')).job;
      const ticket = book.startAttempt(running.id)!;
      const retry = book.create(job('k2', { kind: 'retry_turn', profile: null, brief: { message_ref: 'm', text: 'hi', conversation_ref: 'c', said_at: 1, promised_by: 2 } })).job;
      book.startAttempt(retry.id);
      expect(book.forget(['Project Falcon'])).toEqual({ cancelled: [], remaining: 1 });
      expect(book.get(running.id)!.status).toBe('running');
      book.report(ticket, result, spend);
      expect(book.forget(['Project Falcon'])).toEqual({ cancelled: [], remaining: 0 });
    });
  });

  it('an open job that only carries a marker is not cancelled: no forget rewrites an open job, so the marker is the owner\'s words', async () => {
    await withBook((book) => {
      const marked = book.create(job('k1', { brief: { ...brief, context: 'The [forgotten] thread is closed.' } })).job;
      expect(book.forget(['Lisbon trip'])).toEqual({ cancelled: [], remaining: 0 });
      expect(book.get(marked.id)!.status).toBe('queued');
    });
  });

  it('a settled copy the redaction cannot rewrite is dropped from the row, never left behind', async () => {
    await withBook((book, _clock, sql) => {
      const { job: row } = book.create(job());
      book.cancel(row.id, 'owner');
      // Unreadable JSON that spells the text through an escape: a literal replace cannot reach it.
      sql.exec('UPDATE task_jobs SET brief_json = ?, result_json = ? WHERE id = ?', '{"title":"the \\u004cisbon trip', '{"summary":"\\u004cisbon trip"', row.id);
      expect(book.forget(['Lisbon trip'])).toEqual({ cancelled: [], remaining: 0 });
      expect(book.get(row.id)).toMatchObject({ status: 'cancelled', brief_json: '{}', result_json: null });
    });
  });

  it('DO eviction between checkpoint and apply: a fresh book over the same storage carries on', async () => {
    const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-jobs-evict-${seq += 1}`));
    const id = await runInDurableObject(stub, (_instance, state) => {
      const book = jobBook(state.storage.sql, { now: () => 1_000, newId: () => 'aaaaaaaaaaaa', newToken: () => 'tok-a' });
      const row = book.create(job()).job;
      const ticket = book.startAttempt(row.id)!;
      book.checkpoint(ticket, 1, { turns: [turn(1)] }, spend);
      book.report(ticket, result, spend);
      return row.id;
    });
    await runInDurableObject(stub, (_instance, state) => {
      const book = jobBook(state.storage.sql, { now: () => 2_000, newId: () => 'bbbbbbbbbbbb', newToken: () => 'tok-b' });
      expect(book.due().map(row => row.id)).toEqual([id]);
      expect(book.settle(id)).toBe(true);
      expect(book.due()).toEqual([]);
    });
  });

  it('names the next moment the brain owes work, and trims settled rows past the kept count', async () => {
    await withBook((book, clock) => {
      expect(book.nextDue()).toBeNull();
      const queued = book.create(job('a', { dueAt: clock.at + 5_000 })).job;
      expect(book.nextDue()).toBe(clock.at + 5_000);
      const running = book.create(job('b')).job;
      book.startAttempt(running.id);
      expect(book.nextDue()).toBe(clock.at + 5_000);
      book.cancel(queued.id, 'owner');
      expect(book.nextDue()).toBe(clock.at + TASK_LEASE_MS);
      expect(book.trim()).toBe(0);
    });
  });

  it('a job whose deadline passed is parked instead of started or rejoined; one a wake reached just after it still starts', async () => {
    await withBook((book, clock) => {
      const deadline = clock.at + 3_600_000;
      const late = book.create(job('late')).job, onTime = book.create(job('on-time')).job, rejoin = book.create(job('rejoin')).job;
      const held = book.startAttempt(rejoin.id)!;
      clock.at = deadline + JOB_START_GRACE_MS;
      expect(book.startAttempt(onTime.id)).not.toBeNull();
      clock.at += 1;
      expect(book.startAttempt(late.id)).toBeNull();
      expect(book.get(late.id)).toMatchObject({ status: 'reported', park_reason: 'deadline', outcome: 'failed' });
      expect(book.claim(held)).toBe('parked');
      expect(book.get(rejoin.id)).toMatchObject({ status: 'reported', park_reason: 'deadline' });
    });
  });
});
