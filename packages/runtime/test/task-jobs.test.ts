import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { jobBook, jobCheckpoint, jobResult, TASK_LEASE_MS, TASK_MAX_CRASHES, type CreateJob, type TaskBrief } from '../src/tasks/jobs';

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
      expect(claimed !== 'fenced' && jobCheckpoint(claimed).turns).toEqual([turn(1)]);
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

  it('owner forget mid-job: open jobs carrying the text are cancelled, others keep running, settled rows wait for the purge', async () => {
    await withBook((book) => {
      const carrying = book.create(job('k1', { brief: { ...brief, context: 'Asha said "the Lisbon trip" is off.' } })).job;
      const other = book.create(job('k2')).job;
      const finished = book.create(job('k3')).job;
      const ticket = book.startAttempt(finished.id)!;
      book.report(ticket, { ...result, findings: [{ text: 'Mail about the lisbon trip.' }] }, spend);
      book.settle(finished.id);
      expect(book.forget(['Lisbon trip'])).toEqual([carrying.id]);
      expect(book.get(carrying.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', lease_token: null });
      expect(book.get(other.id)!.status).toBe('queued');
      expect(book.get(finished.id)!.status).toBe('applied');
      expect(book.forget(['  '])).toEqual([]);
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
});
