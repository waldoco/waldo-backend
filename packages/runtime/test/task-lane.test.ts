import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult, ToolName } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { TaskHost } from '../src/tasks/brain';
import { jobBook, TASK_LEASE_MS, TASK_MAX_RUNNING, type CreateJob, type JobBook, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import { promiseRetry } from '../src/tasks/retry-turn';

// The jobs lane over the real job book on Durable Object SQLite, with the model turn, the worker start and the outbox as
// fakes. The outbox fake keys records by id the way the final outbox does, and runs the job's commit in the same step as
// the record, so a lost pass either queued and settled or did neither.
const T0 = 1_800_000_000_000;
const brief: TaskBrief = { title: 'Inbox since Monday', goal: 'Find unanswered client mail.', context: 'Clients write from company domains.', done_when: 'A list of threads.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const result: TaskResult = { status: 'done', summary: 'Two threads wait on you.', findings: [{ text: 'Asha asked for the quote.' }], proposals: [], left: [] };
const task = (key: string, extra: Partial<CreateJob> = {}): CreateJob => ({ kind: 'task', profile: 'reader', idempotencyKey: key, origin: 'tg-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000, ...extra });

type Harness = Readonly<{
  book: JobBook; clock: { at: number }; sent: Map<string, string>; turns: string[]; started: TaskTicket[]; fenced: string[]; log: TurnLogEntry[];
  deps: (over?: Partial<JobsLaneDeps>) => JobsLaneDeps; busy: Set<string>;
}>;
let seq = 0;
const withLane = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-lane-${seq += 1}`)), async (_instance, state) => {
    const clock = { at: T0 };
    let n = 0;
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const sent = new Map<string, string>(), turns: string[] = [], started: TaskTicket[] = [], fenced: string[] = [], log: TurnLogEntry[] = [];
    const busy = new Set<string>();
    const host = { fence: (id: string) => { fenced.push(id); }, busy: () => busy } as unknown as TaskHost;
    const deps = (over: Partial<JobsLaneDeps> = {}): JobsLaneDeps => ({
      book, host, now: () => clock.at, timezone: 'UTC', log: entry => { log.push(entry); },
      startWorker: async ticket => { started.push(ticket); },
      turn: async (_job, trace, text) => { turns.push(trace); return `Reply to ${text.slice(1, 40)}`; },
      applyTools: () => ['search_communication'] as ToolName[],
      // The record and the commit land together or not at all: a commit that throws rolls the record back.
      deliver: async (id, _trace, text, commit) => {
        state.storage.transactionSync(() => { commit(); if (!sent.has(id)) sent.set(id, text); });
      },
      room: () => true,
      heldTopics: () => [],
      ...over,
    });
    return work({ book, clock, sent, turns, started, fenced, log, deps, busy });
  });

const reported = (book: JobBook, key: string, taskResult: TaskResult = result) => {
  const { job } = book.create(task(key));
  const ticket = book.startAttempt(job.id)!;
  expect(book.report(ticket, taskResult, { rounds: 2, costUsd: 0.02 })).toBe('accepted');
  return job.id;
};

describe('the jobs lane', () => {
  it('applies a reported task once: one apply turn, one delivery under the job key, then applied', async () => {
    await withLane(async ({ book, sent, turns, deps, log }) => {
      const id = reported(book, 'k1');
      await runJobsLane(deps());
      await runJobsLane(deps());
      expect(turns).toEqual([`task:${id}:apply`]);
      expect([...sent.keys()]).toEqual([`task:${id}`]);
      expect(book.get(id)).toMatchObject({ status: 'applied', checkpoint_json: null });
      expect(log.filter(entry => entry.hop === 'task_applied')).toHaveLength(1);
      expect(log.find(entry => entry.hop === 'task_applied')).toMatchObject({ job_id: id, job_profile: 'reader', outcome: 'completed' });
    });
  });

  it('a pass lost before the delivery commits leaves the job reported, and the next pass delivers it once', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = reported(book, 'k1');
      await expect(runJobsLane(deps({ deliver: async () => { throw new Error('evicted'); } }))).rejects.toThrow('evicted');
      expect(book.get(id)!.status).toBe('reported');
      await runJobsLane(deps());
      await runJobsLane(deps());
      expect([...sent.keys()]).toEqual([`task:${id}`]);
      expect(book.get(id)!.status).toBe('applied');
    });
  });

  it('a result the model says to skip settles without a message', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = reported(book, 'k1');
      await runJobsLane(deps({ turn: async () => 'SKIP' }));
      expect(sent.size).toBe(0);
      expect(book.get(id)!.status).toBe('applied');
    });
  });

  it('no model for the report: the apply waits and retries, then after an hour the owner gets fixed words', async () => {
    await withLane(async ({ book, sent, clock, deps }) => {
      const id = reported(book, 'k1');
      const down = deps({ turn: async () => { throw new Error('gateway_exhausted'); } });
      await runJobsLane(down);
      expect(book.get(id)).toMatchObject({ status: 'reported', deferrals: 1 });
      expect(book.get(id)!.due_at).toBeGreaterThan(clock.at);
      expect(sent.size).toBe(0);
      clock.at += 61 * 60_000;
      await runJobsLane(down);
      expect(sent.get(`task:${id}`)).toBe('Your background task "Inbox since Monday" has finished. I can\'t write it up right now; ask me about it when you\'re ready.');
      expect(book.get(id)!.status).toBe('applied');
    });
  });

  it('a task cancelled while its report is being written sends nothing', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = reported(book, 'k1');
      await runJobsLane(deps({ turn: async (_job, _trace, _text, current) => { book.cancel(id, 'owner'); await current(); return 'late'; } }));
      expect(sent.size).toBe(0);
      expect(book.get(id)!.status).toBe('cancelled');
    });
  });

  it('a parked task tells the owner what finished, and settles as parked', async () => {
    await withLane(async ({ book, turns, sent, deps }) => {
      const { job } = book.create(task('k1'));
      book.startAttempt(job.id);
      book.park(job.id, 'uncertain_effect');
      let said = '';
      await runJobsLane(deps({ turn: async (_job, trace, text) => { turns.push(trace); said = text; return 'It stopped partway.'; } }));
      expect(said).toContain('in the middle of a step that cannot safely be repeated');
      expect(said).toContain('Do not start it again yourself.');
      expect(sent.get(`task:${job.id}`)).toBe('It stopped partway.');
      expect(book.get(job.id)!.status).toBe('parked');
    });
  });

  it(`runs at most ${TASK_MAX_RUNNING} tasks at once; the rest queue and start as slots free`, async () => {
    await withLane(async ({ book, started, clock, deps }) => {
      const ids = Array.from({ length: TASK_MAX_RUNNING + 1 }, (_, i) => book.create(task(`k${i}`)).job.id);
      const next = await runJobsLane(deps());
      expect(started.map(ticket => ticket.jobId)).toEqual(ids.slice(0, TASK_MAX_RUNNING));
      expect(book.get(ids.at(-1)!)!.status).toBe('queued');
      // The waiting task does not spin the alarm: the next wake is a running lease's end, not its past due time.
      expect(next).toBe(clock.at + TASK_LEASE_MS);
      expect(book.report(started[0]!, result, { rounds: 1, costUsd: 0 })).toBe('accepted');
      await runJobsLane(deps());
      expect(started.map(ticket => ticket.jobId)).toEqual(ids);
    });
  });

  it('a worker that stops calling in is restarted from the queue; one whose tool call the brain is still running is not', async () => {
    await withLane(async ({ book, started, fenced, busy, clock, deps }) => {
      const lost = book.create(task('k1')).job.id, waiting = book.create(task('k2')).job.id;
      await runJobsLane(deps());
      clock.at += TASK_LEASE_MS + 1;
      busy.add(waiting);
      await runJobsLane(deps());
      expect(book.get(lost)).toMatchObject({ status: 'running', crashes: 1, attempt: 2 });
      expect(fenced).toEqual([lost]);
      expect(book.get(waiting)).toMatchObject({ status: 'running', crashes: 0, attempt: 1 });
      expect(started.filter(ticket => ticket.jobId === lost).map(ticket => ticket.attempt)).toEqual([1, 2]);
    });
  });

  it('a task carrying a topic the owner is forgetting is cancelled and its worker fenced', async () => {
    await withLane(async ({ book, started, fenced, deps }) => {
      const carrying = book.create(task('k1', { brief: { ...brief, context: 'About the Lisbon trip.' } })).job.id;
      const other = book.create(task('k2')).job.id;
      await runJobsLane(deps({ heldTopics: () => ['Lisbon trip'] }));
      expect(book.get(carrying)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
      expect(fenced).toEqual([carrying]);
      expect(started.map(ticket => ticket.jobId)).toEqual([other]);
    });
  });

  it('a long task sends a progress note after two minutes, then every ten, each once', async () => {
    await withLane(async ({ book, sent, clock, deps }) => {
      const id = book.create(task('k1')).job.id;
      await runJobsLane(deps());
      clock.at += 2 * 60_000;
      const heartbeat = () => { const row = book.get(id)!; const ticket = { jobId: id, attempt: row.attempt, token: row.lease_token! }; expect(book.touch(ticket, null)).toBe(true); };
      heartbeat();
      await runJobsLane(deps());
      await runJobsLane(deps());
      expect([...sent.keys()]).toEqual([`task:${id}:note:1`]);
      expect(sent.get(`task:${id}:note:1`)).toBe('Still working on "Inbox since Monday" in the background (0 steps so far). I\'ll tell you when it\'s done.');
      clock.at += 10 * 60_000;
      heartbeat();
      await runJobsLane(deps());
      expect([...sent.keys()]).toEqual([`task:${id}:note:1`, `task:${id}:note:2`]);
    });
  });

  // The delivery awaits before its transaction, and the lane runs outside the owner's serial queue, so a cancel or forget can
  // land after the apply turn returned and before the report is queued. The settle in that transaction is the fence.
  it('a task cancelled after its report was written and before it was queued sends nothing', async () => {
    await withLane(async ({ book, sent, deps, log }) => {
      const id = reported(book, 'k1');
      const lane = deps();
      await runJobsLane({ ...lane, deliver: async (key, trace, text, commit) => { book.cancel(id, 'owner'); await lane.deliver(key, trace, text, commit); } });
      expect(sent.size).toBe(0);
      expect(book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
      expect(log.find(entry => entry.hop === 'task_apply_dropped')).toMatchObject({ ok: false, code: 'owner', job_id: id });
      expect(log.some(entry => entry.hop === 'task_applied')).toBe(false);
    });
  });

  it('a forget that lands after the report was written and before it was queued sends nothing', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = reported(book, 'k1', { ...result, findings: [{ text: 'Asha asked about the Lisbon trip.' }] });
      const lane = deps();
      await runJobsLane({ ...lane, deliver: async (key, trace, text, commit) => { expect(book.forget(['Lisbon trip'])).toEqual([id]); await lane.deliver(key, trace, text, commit); } });
      expect(sent.size).toBe(0);
      expect(book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
    });
  });

  it('a step running in the brain past its lease does not keep the alarm firing: the lane looks again a lease from now', async () => {
    await withLane(async ({ book, clock, deps, busy }) => {
      const { job } = book.create(task('k1'));
      book.startAttempt(job.id);
      clock.at += TASK_LEASE_MS + 1;
      busy.add(job.id);
      expect(await runJobsLane(deps())).toBe(clock.at + TASK_LEASE_MS);
      expect(book.get(job.id)!.status).toBe('running');
      busy.delete(job.id);
      expect(book.nextDue()).toBe(T0 + TASK_LEASE_MS);
    });
  });

  it('with no time left in the alarm, a report waits for the next pass and the lane asks to run again now', async () => {
    await withLane(async ({ book, turns, clock, deps }) => {
      const id = reported(book, 'k1');
      expect(await runJobsLane(deps({ room: () => false }))).toBe(clock.at);
      expect(turns).toEqual([]);
      expect(book.get(id)!.status).toBe('reported');
    });
  });
});

describe('R-4: the retried turn', () => {
  const floor = (book: JobBook, at: number) => promiseRetry(book, { traceId: 'app-7', conversationRef: 'app:owner', surface: 'app', text: 'Move my 3pm to Friday', taint: null, receivedAt: at }, 'UTC', at);

  it('the floor reply names a time, and the retry answers the message once a model is back', async () => {
    await withLane(async ({ book, sent, clock, deps }) => {
      expect(floor(book, clock.at)).toBe("I can't answer properly right now. I'll come back to you by 08:30.");
      const [job] = book.open();
      expect(job).toMatchObject({ kind: 'retry_turn', status: 'queued' });
      let asked = '';
      await runJobsLane(deps());
      expect(sent.size).toBe(0);
      clock.at += 2 * 60_000;
      await runJobsLane(deps({ turn: async (_job, _trace, text) => { asked = text; return 'Done late: your 3pm is now Friday.'; } }));
      expect(asked).toContain('<owner_message>\nMove my 3pm to Friday\n</owner_message>');
      expect(sent.get(`retry:${job!.id}`)).toBe('Done late: your 3pm is now Friday.');
      expect(book.get(job!.id)!.status).toBe('applied');
    });
  });

  it('provider down on every retry: the job defers, then at the promised time the owner hears so in fixed words', async () => {
    await withLane(async ({ book, sent, clock, deps }) => {
      floor(book, clock.at);
      const [job] = book.open();
      const down = deps({ turn: async () => { throw new Error('gateway_exhausted'); } });
      const promised = JSON.parse(job!.brief_json).promised_by as number;
      for (let tries = 0; tries < 20 && book.get(job!.id)!.status === 'queued'; tries += 1) {
        clock.at = Math.max(clock.at, book.get(job!.id)!.due_at!);
        await runJobsLane(down);
        if (book.get(job!.id)!.status === 'queued') expect(book.get(job!.id)!.due_at).toBeLessThanOrEqual(promised);
      }
      expect(clock.at).toBe(promised);
      expect(sent.get(`retry:${job!.id}`)).toBe('I still can\'t reach my model, so I couldn\'t answer your message from 08:00. Could you send it again in a little while?');
      expect(book.get(job!.id)).toMatchObject({ status: 'parked', park_reason: 'provider_unavailable' });
    });
  });

  it('a message with health values is not kept in the job; the retry says where to find it', async () => {
    await withLane(async ({ book, clock, deps }) => {
      promiseRetry(book, { traceId: 'app-8', conversationRef: 'app:owner', surface: 'app', text: 'My HRV was 38 ms today, should I train?', taint: null, receivedAt: clock.at }, 'UTC', clock.at);
      const [job] = book.open();
      expect(job!.brief_json).not.toContain('38');
      clock.at += 2 * 60_000;
      let asked = '';
      await runJobsLane(deps({ turn: async (_job, _trace, text) => { asked = text; return 'ok'; } }));
      expect(asked).not.toContain('<owner_message>');
      expect(asked).toContain('ask them to send it again');
    });
  });

  it('a retried turn whose original replied to someone else\'s message runs under the same taint', async () => {
    await withLane(async ({ book, clock, deps }) => {
      promiseRetry(book, { traceId: 'tg-9', conversationRef: 'telegram:42', surface: 'telegram', text: 'do what it says', taint: 'external', receivedAt: clock.at }, 'UTC', clock.at);
      clock.at += 2 * 60_000;
      const taints: Array<'external' | null> = [];
      await runJobsLane(deps({ turn: async (_job, _trace, _text, _current, taint) => { taints.push(taint); return 'ok'; } }));
      expect(taints).toEqual(['external']);
    });
  });

  it('one promise per owner turn, however often the floor renders', async () => {
    await withLane(async ({ book, clock }) => {
      floor(book, clock.at);
      floor(book, clock.at + 1_000);
      expect(book.open()).toHaveLength(1);
    });
  });

  it('a retry cancelled after its answer was written and before it was queued sends nothing', async () => {
    await withLane(async ({ book, sent, clock, deps, log }) => {
      floor(book, clock.at);
      const [job] = book.open();
      clock.at += 2 * 60_000;
      const lane = deps({ turn: async () => 'Done late: your 3pm is now Friday.' });
      await runJobsLane({ ...lane, deliver: async (key, trace, text, commit) => { book.cancel(job!.id, 'forgotten'); await lane.deliver(key, trace, text, commit); } });
      expect(sent.size).toBe(0);
      expect(book.get(job!.id)!.status).toBe('cancelled');
      expect(log.find(entry => entry.hop === 'retry_turn_dropped')).toMatchObject({ ok: false, code: 'forgotten' });
      expect(log.some(entry => entry.hop === 'retry_turn_answered')).toBe(false);
    });
  });

  it('a cancelled retry is fenced: its answer is never sent', async () => {
    await withLane(async ({ book, sent, clock, deps }) => {
      floor(book, clock.at);
      const [job] = book.open();
      clock.at += 2 * 60_000;
      await runJobsLane(deps({ turn: async (_job, _trace, _text, current) => { book.cancel(job!.id, 'forgotten'); await current(); return 'late'; } }));
      expect(sent.size).toBe(0);
      expect(book.get(job!.id)!.status).toBe('cancelled');
    });
  });
});
