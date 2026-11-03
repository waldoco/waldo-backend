import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolCall, type LLMToolTurn, type TaskResult, type ToolName } from '@waldo/contracts';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { TASK_JOBS_TABLE_SCHEMA } from '../src/do-schema';
import { sanitise } from '../src/scribe/sanitiser';
import { taskHost, type TaskHostDeps } from '../src/tasks/brain';
import { jobBook, jobCheckpoint, replayKey, type JobBook, type JobRow, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { PARK_RETRY_MS, runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import { applyMachineJob, machineStoppedNote } from '../src/tasks/machine';
import { FINISH_TASK } from '../src/tasks/profiles';
import { runTaskAttempt, type TaskModel } from '../src/tasks/worker-loop';
import { PARK_WORDS } from '../src/prompt/fixed-lines';

// Ask and resume (WALDO_TASK_ASK): a worker that reaches a step only the owner can approve raises the card at once and the job
// waits as awaiting_owner, with no lease or slot; the owner's answer resumes it from its checkpoint with the step as one already
// taken. Real job book on Durable Object SQLite; the model, the card desk and the outbox are fakes. The trace is the job's
// states, the hops it logged and what the resumed worker read.
const T0 = 1_800_000_000_000;
const brief: TaskBrief = { title: 'Book a table', goal: 'Book a table for two tonight.', context: 'Near Bandra.', done_when: 'A booking.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const CANARIES = ['a1b2c3d4e5f60718', '1a2b3c4d5e6f7081', 'f0e1d2c3b4a59687'];
// A step with no typed command: the taint gate holds it for the owner's card.
const BOOK = { url: 'https://example.com/book', task: 'Book a table for two at 8pm.' };
const step = (id = 'c-book'): LLMToolCall => ({ call_id: id, name: 'browse_act', arguments: JSON.stringify(BOOK) });
const done = (summary: string): TaskResult => ({ status: 'done', summary, findings: [], proposals: [], left: [] });

type World = Readonly<{
  book: JobBook; clock: { at: number }; host: ReturnType<typeof taskHost>; log: TurnLogEntry[]; cards: { tool: string; runRef: string }[]; withdrawn: string[]; ran: string[];
  ticket(): TaskTicket; ask: { on: boolean; during?: (row: JobRow) => void };
}>;
let seq = 0;
const withWorld = <T,>(work: (world: World) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-ask-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: T0 };
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const log: TurnLogEntry[] = [], cards: World['cards'] = [], withdrawn: string[] = [], ran: string[] = [];
    const ask: World['ask'] = { on: true };
    const handlers = [
      { name: 'browse_act', description: 'Act in the browser.', schema: z.object({ url: z.string(), task: z.string() }).loose(), trigger_allowlist: allowlist('browse_act'), autonomy_gated: false, mutates_state: true,
        async handle() { ran.push('browse_act'); return { ok: true as const, data: { done: true }, source_taint: 'external' as const }; } },
    ] as unknown as ReturnType<TaskHostDeps['handlers']>;
    let queue: Promise<unknown> = Promise.resolve();
    const host = taskHost({
      book, now: () => clock.at, handlers: () => handlers, context: () => ({ authenticatedUserId: 'owner-1', sanitise, egressAllowlist: ['example.com'] }),
      serialBrowser: (_scope: RunEffectScope, run) => { const next = queue.then(run); queue = next.catch(() => undefined); return next; },
      releaseBrowser: () => undefined, log: entry => { log.push(entry); }, wake: async () => undefined, withdrawCards: runRef => { withdrawn.push(runRef); },
      replayApproval: async () => { throw new Error('the replay job runs approved steps, not the worker'); },
      askOwner: async (row: JobRow, call: LLMToolCall) => { if (!ask.on) return null; ask.during?.(row); cards.push({ tool: call.name, runRef: `task:${row.id}` }); return `p${cards.length}`; },
    });
    const ticket = () => {
      const { job } = book.create({ kind: 'task', profile: 'errand', idempotencyKey: `k${n += 1}`, origin: 'app-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      return book.startAttempt(job.id)!;
    };
    return work({ book, clock, host, log, cards, withdrawn, ran, ticket, ask });
  });

// The worker's model: one tool call per round from the script, and every turn it was shown.
const scripted = (script: readonly Readonly<{ call: string; args: unknown }>[], seen: LLMToolTurn[][]): TaskModel => {
  let n = 0;
  return async ({ turns }) => {
    seen.push([...turns]);
    const next = script[Math.min(n, script.length - 1)]!;
    n += 1;
    return { response: { text: '', tool_calls: [{ call_id: next.call === 'browse_act' ? 'c-book' : `c${n}`, name: next.call, arguments: JSON.stringify(next.args) }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
  };
};
const hops = (log: readonly TurnLogEntry[]) => log.map(entry => entry.hop).filter(hop => /^task_(awaiting_owner|resumed|parked|cancelled|ask_closed)$/.test(hop));

describe('a task worker that needs the owner mid-task', () => {
  it('blocks, raises the card, waits as awaiting_owner, and on approval resumes from its checkpoint to finish', async () => {
    await withWorld(async ({ book, host, log, cards, ran, ticket }) => {
      const t = ticket(), seen: LLMToolTurn[][] = [];
      // The first attempt reaches the booking step: the card is raised now, the attempt is fenced and the job waits.
      expect(await runTaskAttempt(t, { brain: host, model: scripted([{ call: 'browse_act', args: BOOK }], seen), sliceEnd: T0 + 60_000 })).toBe('fenced');
      expect(cards).toEqual([{ tool: 'browse_act', runRef: `task:${t.jobId}` }]);
      expect(ran).toEqual([]);
      const waiting = book.get(t.jobId)!;
      expect(waiting).toMatchObject({ status: 'awaiting_owner', lease_token: null, lease_until: null, inflight_json: null, due_at: waiting.deadline_at });
      expect(jobCheckpoint(waiting).asked).toEqual({ approval_id: 'p1', call: step() });
      expect(book.runningTasks()).toBe(0);
      // The owner approves; the card's replay job ran the step once and reported done; the job queues to resume.
      expect(book.resume('p1', 'approved', { status: 'done', message: 'Booked for 8pm.' })).toBe(true);
      const next = book.startAttempt(t.jobId)!;
      expect(await runTaskAttempt(next, { brain: host, model: scripted([{ call: FINISH_TASK, args: done('Booked the table for 8pm.') }], seen), sliceEnd: T0 + 60_000 })).toBe('reported');
      // The resumed worker read the step as already taken, with the replay's outcome, and never ran it itself.
      const resumed = seen.at(-1)!;
      expect(resumed.map(turn => turn.call.name)).toEqual(['browse_act']);
      expect(JSON.parse(resumed[0]!.output)).toEqual({ ok: true, data: { approved_by_owner: true, result: 'Booked for 8pm.' } });
      expect(resumed[0]!.source_taint).toBe('external');
      expect(ran).toEqual([]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', outcome: 'done' });
      expect(jobCheckpoint(book.get(t.jobId)!).asked).toBeUndefined();
      expect(hops(log)).toEqual(['task_awaiting_owner', 'task_resumed']);
    });
  });

  it('on a no, the worker resumes without the step and is told not to try it again', async () => {
    await withWorld(async ({ book, host, log, ticket }) => {
      const t = ticket(), seen: LLMToolTurn[][] = [];
      await runTaskAttempt(t, { brain: host, model: scripted([{ call: 'browse_act', args: BOOK }], seen), sliceEnd: T0 + 60_000 });
      expect(book.resume('p1', 'declined')).toBe(true);
      expect(book.resume('p1', 'declined')).toBe(false);
      const next = book.startAttempt(t.jobId)!;
      expect(await runTaskAttempt(next, { brain: host, model: scripted([{ call: FINISH_TASK, args: { ...done('The owner declined the booking.'), status: 'partial' } }], seen), sliceEnd: T0 + 60_000 })).toBe('reported');
      const told = JSON.parse(seen.at(-1)![0]!.output) as { ok: boolean; error: string; fix: string };
      expect(told).toMatchObject({ ok: false, error: 'The owner declined this step, so it did not run.' });
      expect(told.fix).toContain('Do not try it again');
      expect(seen.at(-1)![0]!.source_taint).toBeUndefined();
      expect(hops(log)).toEqual(['task_awaiting_owner', 'task_resumed']);
      expect(log.find(entry => entry.hop === 'task_resumed')).toMatchObject({ code: 'declined' });
    });
  });

  it('a cancel while it waits ends the job and withdraws its card', async () => {
    await withWorld(async ({ book, host, withdrawn, ticket }) => {
      const t = ticket();
      await runTaskAttempt(t, { brain: host, model: scripted([{ call: 'browse_act', args: BOOK }], []), sliceEnd: T0 + 60_000 });
      expect(book.cancel(t.jobId, 'owner')).toBe(true);
      host.cancelled(t.jobId);
      expect(withdrawn).toEqual([`task:${t.jobId}`]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'cancelled', checkpoint_json: null });
      // A late answer finds no job to resume.
      expect(book.resume('p1', 'approved', { status: 'done', message: 'Booked.' })).toBe(false);
    });
  });

  it('the attempt that asked has lost its lease: its late calls are fenced, and a lapse pass leaves the waiting job alone', async () => {
    await withWorld(async ({ book, clock, host, ticket }) => {
      const t = ticket();
      await runTaskAttempt(t, { brain: host, model: scripted([{ call: 'browse_act', args: BOOK }], []), sliceEnd: T0 + 60_000 });
      expect(await host.heartbeat(t)).toBe(false);
      expect(await host.tool(t, step('c-late'), CANARIES)).toBe('fenced');
      expect(await host.checkpoint(t, 9, [], [], { rounds: 0, costUsd: 0 })).toBe('fenced');
      expect(await host.report(t, { kind: 'result', result: done('late') }, [], { rounds: 0, costUsd: 0 })).toBe('fenced');
      clock.at += 10 * 60_000;
      expect(book.lapse()).toEqual([]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'awaiting_owner', crashes: 0 });
    });
  });

  it('a cancel that lands while the card is being raised: the job cannot wait, and the card it just raised is withdrawn', async () => {
    await withWorld(async ({ book, host, withdrawn, cards, ticket, ask }) => {
      const t = ticket();
      await host.claim(t);
      ask.during = row => { expect(book.cancel(row.id, 'owner')).toBe(true); };
      expect(await host.tool(t, step(), CANARIES)).toBe('fenced');
      expect(cards).toHaveLength(1);
      expect(withdrawn).toEqual([`task:${t.jobId}`]);
      expect(book.get(t.jobId)!.status).toBe('cancelled');
    });
  });

  it('with asking off, the step goes back to the worker to hand over in its result, as before', async () => {
    await withWorld(async ({ book, host, cards, ticket, ask }) => {
      ask.on = false;
      const t = ticket();
      await host.claim(t);
      const refused = await host.tool(t, step(), CANARIES);
      expect(refused).toMatchObject({ ok: false, error_code: 'taint_needs_approval', retryable: false });
      expect(JSON.stringify(refused)).toContain(FINISH_TASK);
      expect(cards).toEqual([]);
      expect(book.get(t.jobId)!.status).toBe('running');
    });
  });
});

// The jobs lane's side: the deadline of a waiting job, a card that closed undecided, the approved replay that resumes it,
// and §4.5's follow-up (one retry of a parked task, a note from a machine job that stopped).
type Lane = Readonly<{ book: JobBook; clock: { at: number }; sent: Map<string, string>; fenced: string[]; log: TurnLogEntry[]; deps(over?: Partial<JobsLaneDeps>): JobsLaneDeps }>;
const withLane = <T,>(work: (lane: Lane) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-ask-lane-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: T0 };
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const sent = new Map<string, string>(), fenced: string[] = [], log: TurnLogEntry[] = [];
    const host = { fence: (id: string) => { fenced.push(id); }, cancelled: (id: string) => { fenced.push(`cancelled:${id}`); }, busy: () => new Set<string>() } as unknown as JobsLaneDeps['host'];
    const deps = (over: Partial<JobsLaneDeps> = {}): JobsLaneDeps => ({
      book, host, now: () => clock.at, timezone: 'UTC', surface: 'app', quiet: () => false, log: entry => { log.push(entry); },
      startWorker: async () => undefined, turn: async (_job, _trace, text) => `Reply to ${text.slice(1, 60)}`, applyTools: () => [] as ToolName[],
      deliver: async (id, _trace, text, commit) => { state.storage.transactionSync(() => { commit(); if (!sent.has(id)) sent.set(id, text); }); },
      room: () => true, heldTopics: () => [], startReplay: () => undefined,
      approvals: { replays: () => [], replayReceipt: (id, status, message) => `receipt ${id} ${status}: ${message}`, settleReplay: () => true },
      ...over,
    });
    return work({ book, clock, sent, fenced, log, deps });
  });
const waitingJob = (book: JobBook, approval: string) => {
  const { job } = book.create({ kind: 'task', profile: 'errand', idempotencyKey: `ask-${approval}`, origin: 'app-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
  expect(book.await(book.startAttempt(job.id)!, { approval_id: approval, call: step() })).toBe(true);
  return job.id;
};

describe('the jobs lane and a waiting job', () => {
  it('past its deadline the waiting job parks, its card is withdrawn, and the owner hears it ran out of time', async () => {
    await withLane(async ({ book, clock, sent, fenced, deps }) => {
      const id = waitingJob(book, 'p1');
      expect(await runJobsLane(deps({ waitingCards: () => ['p1'] }))).toBe(T0 + 3_600_000);
      expect(book.get(id)!.status).toBe('awaiting_owner');
      clock.at = T0 + 3_600_000;
      await runJobsLane(deps({ waitingCards: () => ['p1'] }));
      expect(fenced).toEqual([`cancelled:${id}`]);
      expect(book.get(id)).toMatchObject({ status: 'parked', park_reason: 'deadline' });
      expect(sent.get(`task:${id}`)).toContain(PARK_WORDS.deadline);
    });
  });

  it('a card that closed without the owner approving it (withdrawn, expired) resumes the job as declined', async () => {
    await withLane(async ({ book, log, deps }) => {
      const id = waitingJob(book, 'p1');
      await runJobsLane(deps({ waitingCards: () => ['p1'] }));
      expect(book.get(id)!.status).toBe('awaiting_owner');
      // An approved card is running, not waiting: the job keeps waiting for its replay.
      await runJobsLane(deps({ waitingCards: () => [], approvals: { replays: () => ['p1'], replayReceipt: () => '', settleReplay: () => true } }));
      expect(book.get(id)!.status).toBe('awaiting_owner');
      expect(await runJobsLane(deps({ waitingCards: () => [] }))).toBe(T0);
      expect(book.get(id)!.status).toBe('queued');
      expect(jobCheckpoint(book.get(id)!).asked?.decision).toBe('declined');
      expect(log.some(entry => entry.hop === 'task_ask_closed')).toBe(true);
    });
  });

  it('the approved card\'s replay reports: the owner gets its receipt and the waiting job resumes with its outcome, once', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = waitingJob(book, 'p1');
      const { job: replay } = book.create({ kind: 'approval_replay', profile: null, idempotencyKey: replayKey('p1'), origin: replayKey('p1'), surface: 'app',
        brief: { approval_id: 'p1', tool: 'browse_act', args: BOOK, args_digest: 'd', approved_at: T0 }, dueAt: T0, deadlineAt: T0 + 1_800_000, taint: 'external' });
      expect(book.reportReplay(book.startAttempt(replay.id)!, { status: 'done', message: 'Booked for 8pm.' })).toBe('accepted');
      await runJobsLane(deps());
      expect(sent.get(replayKey('p1'))).toBe('receipt p1 done: Booked for 8pm.');
      expect(book.get(id)).toMatchObject({ status: 'queued', due_at: T0 });
      expect(jobCheckpoint(book.get(id)!).asked).toMatchObject({ decision: 'approved', outcome: { status: 'done', message: 'Booked for 8pm.' } });
    });
  });
});

describe('background work stays in sight (WALDO_TASK_NOTES)', () => {
  const parked = (book: JobBook, key: string) => {
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: key, origin: 'app-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
    book.startAttempt(job.id);
    expect(book.park(job.id, 'crashed')).toBe(true);
    return job.id;
  };

  it('a task parked for a crash runs once more after a backoff before the owner hears; the second park is reported', async () => {
    await withLane(async ({ book, clock, sent, log, deps }) => {
      const id = parked(book, 'crash-1');
      expect(await runJobsLane(deps({ followUp: true }))).toBe(T0 + PARK_RETRY_MS);
      expect(book.get(id)).toMatchObject({ status: 'queued', park_retries: 1, crashes: 0, park_reason: null, due_at: T0 + PARK_RETRY_MS });
      expect(sent.size).toBe(0);
      expect(log.find(entry => entry.hop === 'task_park_retry')).toMatchObject({ code: 'crashed' });
      clock.at = T0 + PARK_RETRY_MS;
      await runJobsLane(deps({ followUp: true }));
      expect(book.park(id, 'crashed')).toBe(true);
      await runJobsLane(deps({ followUp: true }));
      expect(book.get(id)!.status).toBe('parked');
      expect(sent.get(`task:${id}`)).toBeDefined();
    });
  });

  it('without the switch, or for a park that may have acted, the owner hears at once', async () => {
    await withLane(async ({ book, sent, deps }) => {
      const id = parked(book, 'crash-2');
      await runJobsLane(deps());
      expect(book.get(id)!.status).toBe('parked');
      const { job } = book.create({ kind: 'task', profile: 'errand', idempotencyKey: 'uncertain', origin: 'app-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      book.startAttempt(job.id);
      expect(book.park(job.id, 'uncertain_effect')).toBe(true);
      await runJobsLane(deps({ followUp: true }));
      expect(book.get(job.id)!.status).toBe('parked');
      expect([...sent.keys()]).toEqual([`task:${id}`, `task:${job.id}`]);
    });
  });

  it('a machine job that stopped tells the owner once a day, and settles silently without the switch', async () => {
    await withLane(async ({ book, clock }) => {
      const machine = (key: string) => {
        const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: key, origin: 'machine:update_sweep', surface: 'app',
          brief: { ...brief, machine: { job: 'update_sweep', input_digest: key, scope: key, refs: [] } }, dueAt: T0, deadlineAt: T0 + 3_600_000, taint: 'external' });
        book.startAttempt(job.id);
        book.park(job.id, 'crashed');
        return book.get(job.id)!;
      };
      const notes = new Map<string, string>();
      const note = async (key: string, text: string, settle: () => void) => { settle(); notes.set(key, text); };
      const hop = () => undefined;
      await applyMachineJob(machine('m1'), { book, now: () => clock.at, appliers: {}, hop, note });
      expect([...notes.values()]).toEqual([machineStoppedNote('update_sweep', PARK_WORDS.crashed)]);
      await applyMachineJob(machine('m2'), { book, now: () => clock.at, appliers: {}, hop, note });
      expect(notes.size).toBe(1);
      const silent = machine('m3');
      await applyMachineJob(silent, { book, now: () => clock.at, appliers: {}, hop });
      expect(book.get(silent.id)!.status).toBe('parked');
      expect(notes.size).toBe(1);
    });
  });
});

it('a job book made by an earlier build is rebuilt to admit waiting jobs, keeping every row', async () => {
  await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-ask-rebuild-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    const before = TASK_JOBS_TABLE_SCHEMA[0].replace(", 'awaiting_owner'", '').replace(/\n\s*park_retries[^\n]*\n/, '\n');
    expect(before).not.toContain('awaiting_owner');
    sql.exec(before);
    sql.exec(`INSERT INTO task_jobs (id, kind, profile, idempotency_key, origin, surface, brief_json, brief_digest, status, deadline_at, created_at, updated_at)
      VALUES ('job_000000000001', 'task', 'reader', 'k-old', 'app-1', 'app', '{}', 'd', 'queued', ?, ?, ?)`, T0 + 1, T0, T0);
    const book = jobBook(sql, { now: () => T0, newId: () => '000000000002', newToken: () => 'tok' });
    expect(book.get('job_000000000001')).toMatchObject({ status: 'queued', park_retries: 0 });
    expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'task_jobs'").one().sql).toContain("'awaiting_owner'");
  });
});
