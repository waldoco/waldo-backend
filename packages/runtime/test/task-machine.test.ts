import { env } from 'cloudflare:workers';
import { NO_REPLAYS } from './helpers/no-replays';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type CancelTaskArgs, type TaskResult, type ToolName } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { numericHealthIn, sanitise } from '../src/scribe/sanitiser';
import { noteDue, taskHost, type TaskHost, type TaskHostDeps } from '../src/tasks/brain';
import { isMachine, jobBook, MACHINE_MAX_RUNNING, MACHINE_SETTLED_KEPT, MACHINE_SETTLED_KEPT_MS, TASK_MAX_OPEN, TASK_MAX_RUNNING, TASK_SETTLED_KEPT, taskBrief, type JobBook, type TaskBrief } from '../src/tasks/jobs';
import { runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import { enqueueMachine, HEALTH_DETAIL_DROPPED, workerRouteDown, type MachineApplier, type MachineEnqueued, type MachineSpec } from '../src/tasks/machine';
import { InMemoryCircuitBreaker } from '../src/llm/provider';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { taintedCallNeedsOwnerApproval } from '../src/hooks/registry';
import { MACHINE_READER, TASK_PROFILE_SPECS } from '../src/tasks/profiles';
import { runningTasksLine, taskToolHandlers } from '../src/tasks/tools';
import { taskBriefText } from '../src/tasks/worker-loop';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// Machine jobs: reader tasks the brain starts on its own schedule (the heartbeat check-back, the update sweep, meeting
// prep), over the real job book on Durable Object SQLite. The owner never asked for them, so they take no owner task slot,
// send no progress note, stay out of the owner's task list and cancel_task, and settle silently when they find nothing.
const T0 = 1_800_000_000_000;
const ownerBrief: TaskBrief = { title: 'Inbox since Monday', goal: 'Find unanswered client mail.', context: 'Clients write from company domains.', done_when: 'A list of threads.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const found: TaskResult = { status: 'done', summary: 'Asha replied about the quote.', findings: [{ text: 'Asha sent the signed quote.', source_ref: 'msg-1' }], proposals: [], left: [] };
const nothing: TaskResult = { status: 'done', summary: 'Nothing new.', findings: [], proposals: [], left: [] };
const spec = (over: Partial<MachineSpec> = {}): MachineSpec => ({
  job: 'heartbeat', scope: 'owner', key: 'machine:heartbeat:heartbeat-tick:1', surface: 'app',
  text: { title: 'Loop check-back', goal: 'Check these loops.', done_when: 'Return no findings when nothing is worth telling.' },
  items: [{ ref: 'l1', detail: 'Chase the quote from Asha (due 2027-01-15 09:00)' }], timezone: 'UTC', now: T0, deadlineAt: T0 + 30 * 60_000, ...over,
});

// Nothing held: the job is written, or another stands in its place.
const enqueue = (book: JobBook, machine: MachineSpec) => enqueueMachine(book, machine, []) as Exclude<MachineEnqueued, { code: 'held_topic' }>;
type Harness = Readonly<{ book: JobBook; clock: { at: number }; sql: SqlStorage; transaction<T>(work: () => T): T }>;
let seq = 0;
const withBook = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-machine-${seq += 1}`)), async (_instance, state) => {
    const clock = { at: T0 };
    let n = 0;
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    return work({ book, clock, sql: state.storage.sql, transaction: work => state.storage.transactionSync(work) });
  });

const reportMachine = (book: JobBook, result: TaskResult, over: Partial<MachineSpec> = {}) => {
  const made = enqueue(book, spec(over));
  const ticket = book.startAttempt(made.job.id)!;
  expect(book.report(ticket, result, { rounds: 1, costUsd: 0.001 })).toBe('accepted');
  return made.job.id;
};

type Lane = Readonly<{ sent: Map<string, string>; turns: string[]; log: TurnLogEntry[]; started: string[]; applied: string[]; deps(over?: Partial<JobsLaneDeps>): JobsLaneDeps }>;
const lane = (h: Harness, appliers: Partial<Record<'heartbeat' | 'update_sweep' | 'meeting_prep', MachineApplier>> = {}): Lane => {
  const sent = new Map<string, string>(), turns: string[] = [], log: TurnLogEntry[] = [], started: string[] = [], applied: string[] = [];
  const host = { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>() } as unknown as TaskHost;
  return {
    sent, turns, log, started, applied,
    deps: (over = {}) => ({
      book: h.book, host, now: () => h.clock.at, timezone: 'UTC', surface: 'app', quiet: () => false, log: entry => { log.push(entry); },
      startWorker: async ticket => { started.push(ticket.jobId); },
      turn: async (_job, trace) => { turns.push(trace); return 'An owner-facing report.'; },
      // A machine job's apply turn names its own tools: it must never be handed the owner's full apply list.
      applyTools: () => { throw new Error('a machine job reached applyTools()'); },
      deliver: async (id, _trace, text, commit) => { h.transaction(() => { commit(); sent.set(id, text); }); },
      room: () => true, heldTopics: () => [], ...NO_REPLAYS, machine: Object.fromEntries(Object.entries(appliers).map(([job, apply]) => [job, { apply }])), ...over,
    }),
  };
};
const hops = (log: readonly TurnLogEntry[], name: string) => log.filter(entry => entry.hop === name);

describe('the machine reader allowlist', () => {
  it('is the reader profile without the two tools whose arguments can carry private text out', () => {
    const reader = TASK_PROFILE_SPECS.reader.tools;
    expect(MACHINE_READER).not.toContain('web_search');
    expect(MACHINE_READER).not.toContain('read_mcp_tool');
    expect([...MACHINE_READER].sort()).toEqual(reader.filter(name => name !== 'web_search' && name !== 'read_mcp_tool').sort());
  });

  it('the brain offers a machine job only those tools, and refuses web_search from it without running it', async () => {
    await withBook(async ({ book }) => {
      const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
      const ran: string[] = [];
      const handler = (name: string) => ({ name, description: name, schema: z.object({}).loose(), trigger_allowlist: allowlist(name as ToolName), autonomy_gated: false, mutates_state: false,
        async handle() { ran.push(name); return { ok: true as const, data: {}, source_taint: 'external' as const }; } });
      const host = taskHost({
        book, now: () => T0, handlers: () => [handler('search_communication'), handler('web_search')] as unknown as ReturnType<TaskHostDeps['handlers']>,
        context: () => ({ authenticatedUserId: 'owner-1', sanitise }), serialBrowser: (_scope, run) => run(), releaseBrowser: () => undefined,
        log: () => undefined, wake: async () => undefined,
        replayApproval: async () => { throw new Error('no approval replays in this harness'); },
      });
      const machine = book.startAttempt(enqueue(book, spec()).job.id)!;
      const claim = await host.claim(machine);
      expect(claim === 'fenced' ? [] : claim.tools.map(tool => tool.name)).toEqual(['search_communication']);
      expect(await host.tool(machine, { call_id: 'c1', name: 'web_search', arguments: '{"query":"asha"}' }, ['a1b2c3d4e5f60718'])).toMatchObject({ ok: false, error_code: 'acl_denied' });
      expect(ran).toEqual([]);
      // An owner's reader task keeps web_search.
      const owner = book.startAttempt(book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'owner-1', origin: 'tg-1', surface: 'app', brief: ownerBrief, dueAt: T0, deadlineAt: T0 + 3_600_000 }).job.id)!;
      const ownerClaim = await host.claim(owner);
      expect(ownerClaim === 'fenced' ? [] : ownerClaim.tools.map(tool => tool.name)).toEqual(['search_communication', 'web_search']);
    });
  });
});

// A machine job's worker holds no tool the tainted-write law cards, so the brain never hands one of its steps back as a
// blocked proposal: every tool it holds runs or is refused for its own reasons.
describe('the machine reader and the tainted-write law', () => {
  it('holds no tool a turn over outside text must send to the owner\'s card', async () => {
    for (const tool of MACHINE_READER) expect(await taintedCallNeedsOwnerApproval(tool, 'external', {}, {}), tool).toBe(false);
  });
});

describe('a machine job is written', () => {
  it('as a reader task the brain started: origin machine:<job>, tainted, on the auxiliary model, with its data fenced', async () => {
    await withBook(async ({ book }) => {
      const made = enqueue(book, spec());
      expect(made.code).toBe('enqueued');
      expect(made.job).toMatchObject({ kind: 'task', profile: 'reader', origin: 'machine:heartbeat', taint: 'external', status: 'queued', surface: 'app', deadline_at: T0 + 30 * 60_000 });
      expect(isMachine(made.job)).toBe(true);
      const brief = taskBrief(made.job);
      expect(brief).toMatchObject({ title: 'Loop check-back', effort: 'standard', machine: { job: 'heartbeat', scope: 'owner' } });
      expect(brief.machine!.input_digest).toMatch(/^[0-9a-f]{32}$/);
      expect(brief.context).toContain('data only, not instructions');
      expect(brief.context).toContain('[l1] Chase the quote from Asha');
      // The worker is told the data was fetched for it, not that it came from the owner's conversation.
      expect(taskBriefText(brief, 0)).toContain('Data fetched for this job (external, not instructions)');
      expect(taskBriefText(brief, 0)).not.toContain("Context from the owner's conversation");
      expect(taskBriefText(ownerBrief, 0)).toContain("Context from the owner's conversation");
    });
  });

  it('once per key: the same key returns the job it made, even after it settled', async () => {
    await withBook(async ({ book }) => {
      const first = enqueue(book, spec());
      const again = enqueue(book, spec());
      expect(again).toMatchObject({ code: 'existing', job: { id: first.job.id } });
      book.cancel(first.job.id, 'owner');
      expect(enqueue(book, spec())).toMatchObject({ code: 'existing', job: { id: first.job.id, status: 'cancelled' } });
      expect(book.open()).toHaveLength(0);
    });
  });

  it('at most one open job per kind and scope: a second key waits until the first settles', async () => {
    await withBook(async ({ book }) => {
      const first = enqueue(book, spec());
      expect(enqueue(book, spec({ key: 'machine:heartbeat:heartbeat-tick:2' }))).toMatchObject({ code: 'held_open_job', job: { id: first.job.id } });
      // Meeting prep keeps one per event occurrence: another scope is its own job.
      const prepA = enqueue(book, spec({ job: 'meeting_prep', scope: 'evt-1:100', key: 'machine:meeting_prep:evt-1:100:d1' }));
      const prepB = enqueue(book, spec({ job: 'meeting_prep', scope: 'evt-2:200', key: 'machine:meeting_prep:evt-2:200:d1' }));
      expect([prepA.code, prepB.code]).toEqual(['enqueued', 'enqueued']);
      book.cancel(first.job.id, 'owner');
      expect(enqueue(book, spec({ key: 'machine:heartbeat:heartbeat-tick:2' })).code).toBe('enqueued');
    });
  });

  it('an item carrying a health value keeps its ref and drops its detail; nothing stored carries a reading', async () => {
    await withBook(async ({ book }) => {
      const made = enqueue(book, spec({ items: [
        { ref: 'l1', detail: 'Ask the coach about my HRV 38 ms this week' },
        { ref: 'l2', detail: 'Send Asha the signed quote' },
      ] }));
      const brief = taskBrief(made.job);
      expect(brief.context).toContain('[l1]');
      expect(brief.context).toContain(HEALTH_DETAIL_DROPPED);
      expect(brief.context).not.toContain('38 ms');
      expect(brief.context).toContain('[l2] Send Asha the signed quote');
      expect(numericHealthIn(made.job.brief_json)).toBe(false);
    });
  });
});

// The owner is forgetting a topic: a machine job whose inputs carry it is held before anything is written, so the forget wins,
// and the next tick asks again once the forget settles. Its inputs are everything the job would be written from: the brief,
// its machine block, and the source text it was given, including a detail the brief leaves out.
describe('a machine job whose inputs carry a topic the owner is forgetting', () => {
  it('is not written, and says so with a content-free code', async () => {
    await withBook(async ({ book, sql }) => {
      expect(enqueueMachine(book, spec(), ['quote from Asha'])).toEqual({ code: 'held_topic' });
      expect(sql.exec('SELECT COUNT(*) AS n FROM task_jobs').one()).toEqual({ n: 0 });
    });
  });

  it('is held by a topic in a detail the brief drops for its health value', async () => {
    await withBook(async ({ book, sql }) => {
      const items = [{ ref: 'l1', detail: 'Ask Dr Rao about my HRV 38 ms this week' }];
      expect(enqueueMachine(book, spec({ items }), ['Dr Rao'])).toEqual({ code: 'held_topic' });
      expect(sql.exec('SELECT COUNT(*) AS n FROM task_jobs').one()).toEqual({ n: 0 });
    });
  });

  it('is written once the forget has settled, and a job that does not carry the topic is written meanwhile', async () => {
    await withBook(async ({ book }) => {
      expect(enqueueMachine(book, spec({ job: 'meeting_prep', scope: 'evt-2', key: 'machine:meeting_prep:evt-2', items: [{ ref: 'e2', detail: 'Budget sync' }] }), ['quote from Asha']).code).toBe('enqueued');
      expect(enqueueMachine(book, spec(), []).code).toBe('enqueued');
    });
  });
});

describe('a machine job never takes the owner\'s place', () => {
  it('does not count against the owner\'s task slots, and starts while every slot is taken', async () => {
    await withBook(async (h) => {
      const { book } = h;
      for (let i = 0; i < TASK_MAX_RUNNING; i += 1) {
        book.startAttempt(book.create({ kind: 'task', profile: 'reader', idempotencyKey: `own-${i}`, origin: 'tg-1', surface: 'app', brief: ownerBrief, dueAt: T0, deadlineAt: T0 + 3_600_000 }).job.id);
      }
      const queuedOwner = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'own-waiting', origin: 'tg-1', surface: 'app', brief: ownerBrief, dueAt: T0, deadlineAt: T0 + 3_600_000 }).job;
      const machine = enqueue(book, spec()).job;
      const l = lane(h);
      await runJobsLane(l.deps());
      expect(l.started).toEqual([machine.id]);
      expect(book.get(queuedOwner.id)!.status).toBe('queued');
      expect(book.runningTasks()).toBe(TASK_MAX_RUNNING);
      // While the owner's slots stay full, a queued machine job is still due at its time.
      const next = enqueue(book, spec({ job: 'update_sweep', key: 'machine:update_sweep:a', now: T0 + 5_000 })).job;
      expect(book.nextDue(true)).toBe(book.get(next.id)!.due_at);
    });
  });

  it('run at most MACHINE_MAX_RUNNING at once, however many triggers fire, and the rest wait without waking the lane', async () => {
    await withBook(async (h) => {
      const { book, clock } = h;
      // A dense day: twelve meetings, each its own prep job, plus a check-back and a sweep.
      for (let i = 0; i < 12; i += 1) enqueue(book, spec({ job: 'meeting_prep', scope: `evt-${i}`, key: `machine:meeting_prep:evt-${i}` }));
      enqueue(book, spec());
      enqueue(book, spec({ job: 'update_sweep', key: 'machine:update_sweep:a' }));
      const l = lane(h);
      const next = await runJobsLane(l.deps());
      expect(l.started).toHaveLength(MACHINE_MAX_RUNNING);
      expect(book.running()).toHaveLength(MACHINE_MAX_RUNNING);
      // The queued ones wait for a running one to report rather than firing the alarm again now.
      expect(next).not.toBe(clock.at);
      await runJobsLane(l.deps());
      expect(book.running()).toHaveLength(MACHINE_MAX_RUNNING);
      // One reports and settles: one more starts.
      const [first] = book.running();
      book.report({ jobId: first!.id, attempt: first!.attempt, token: first!.lease_token! }, nothing, { rounds: 1, costUsd: 0 });
      await runJobsLane(l.deps());
      expect(l.started).toHaveLength(MACHINE_MAX_RUNNING + 1);
      expect(book.running()).toHaveLength(MACHINE_MAX_RUNNING);
    });
  });

  it('sends no progress note however long it runs', async () => {
    await withBook(async (h) => {
      const { book, clock } = h;
      const machine = enqueue(book, spec()).job;
      book.startAttempt(machine.id);
      expect(noteDue(book.get(machine.id)!)).toBeNull();
      clock.at = T0 + 25 * 60_000;
      const l = lane(h);
      await runJobsLane(l.deps());
      expect(l.sent.size).toBe(0);
    });
  });

  it('is hidden from the owner\'s running-task line and from cancel_task', async () => {
    await withBook(async ({ book }) => {
      const machine = enqueue(book, spec()).job;
      expect(runningTasksLine(book)).toBe('');
      const [, cancel] = taskToolHandlers({ book, now: () => T0, timezone: () => 'UTC', surface: 'app', wake: async () => undefined, fence: () => undefined, log: () => undefined });
      const refused = await (cancel as { handle(args: CancelTaskArgs, ctx: ToolDispatcherContext): Promise<unknown> }).handle({ job_id: machine.id }, {} as ToolDispatcherContext);
      expect(refused).toMatchObject({ ok: false, code: 'not_found' });
      expect(book.get(machine.id)!.status).toBe('queued');
    });
  });

  it('do not count toward the owner\'s open-task cap: the owner can still start a task', async () => {
    await withBook(async ({ book }) => {
      for (let i = 0; i < TASK_MAX_OPEN; i += 1) enqueue(book, spec({ job: 'meeting_prep', scope: `evt-${i}`, key: `machine:meeting_prep:evt-${i}` }));
      expect(book.taskCounts('turn-1')).toEqual({ open: 0, fromTurn: 0 });
      const [start] = taskToolHandlers({ book, now: () => T0, timezone: () => 'UTC', surface: 'app', wake: async () => undefined, fence: () => undefined, log: () => undefined });
      const started = await (start as { handle(args: unknown, ctx: ToolDispatcherContext): Promise<unknown> }).handle(
        { profile: 'reader', title: 'Inbox since Monday', goal: 'Find unanswered client mail.', context: 'Clients write from company domains.', done_when: 'A list of threads.' },
        { turnId: 'turn-1', toolCallId: 'call-1' } as ToolDispatcherContext);
      expect(started).toMatchObject({ ok: true, data: { status: 'started' } });
    });
  });

  it('settled machine rows are trimmed apart from the owner\'s: owner history keeps its own count', async () => {
    await withBook(async ({ book, clock, sql }) => {
      const settleOwner = (i: number) => {
        const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: `own-${i}`, origin: 'tg-1', surface: 'app', brief: ownerBrief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
        book.cancel(job.id, 'owner');
      };
      for (let i = 0; i < TASK_SETTLED_KEPT; i += 1) settleOwner(i);
      // Old machine rows, settled long ago, then a burst of recent ones.
      for (let i = 0; i < MACHINE_SETTLED_KEPT + 20; i += 1) {
        clock.at = T0 + i;
        book.cancel(enqueue(book, spec({ key: `old-${i}` })).job.id, 'owner');
      }
      clock.at = T0 + MACHINE_SETTLED_KEPT_MS + 60_000;
      for (let i = 0; i < 70; i += 1) book.cancel(enqueue(book, spec({ key: `new-${i}` })).job.id, 'owner');
      book.trim();
      const count = (machine: boolean) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM task_jobs WHERE origin ${machine ? '' : 'NOT '}LIKE 'machine:%'`).toArray()[0]!.n;
      expect(count(false)).toBe(TASK_SETTLED_KEPT);
      // Within the window every recent row stays; past it only the newest MACHINE_SETTLED_KEPT do, and the old ones go.
      expect(count(true)).toBe(70);
    });
  });
});

describe('applying a machine job', () => {
  it('nothing worth telling: settles applied with no apply turn, no applier call and no delivery', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, nothing);
      let called = 0;
      const l = lane(h, { heartbeat: async () => { called += 1; return 'delivered'; } });
      await runJobsLane(l.deps());
      expect(called).toBe(0);
      expect(l.turns).toEqual([]);
      expect(l.sent.size).toBe(0);
      expect(h.book.get(id)).toMatchObject({ status: 'applied', outcome: 'done', result_json: null });
      expect(hops(l.log, 'machine_no_news')).toHaveLength(1);
    });
  });

  it('a finding or a proposal alone is news: the job\'s applier runs once, and settles it with its delivery', async () => {
    for (const result of [found, { ...nothing, proposals: [{ tool: 'send_email', why: 'She asked for the quote.', args: { to: 'asha@example.com' } }] }] as TaskResult[]) {
      await withBook(async (h) => {
        const id = reportMachine(h.book, result);
        const seen: TaskResult[] = [];
        const l = lane(h, { heartbeat: async (row, got, io) => { seen.push(got); await io.current(); h.transaction(() => { io.settle(); l.sent.set(`machine:${row.id}`, 'told'); }); return 'delivered'; } });
        await runJobsLane(l.deps());
        await runJobsLane(l.deps());
        expect(seen).toEqual([result]);
        expect([...l.sent.keys()]).toEqual([`machine:${id}`]);
        expect(l.turns).toEqual([]);
        expect(h.book.get(id)!.status).toBe('applied');
        expect(hops(l.log, 'machine_applied')).toHaveLength(1);
      });
    }
  });

  // HIGH-2 for machine jobs: an apply turn holds tools (a close card, a source loop) and delivers, so it writes its intent
  // first. A pass lost inside it is not run again. The owner never asked for this work, so nothing tells them: the job settles
  // silently, as a parked one does, and the trigger's next tick asks again.
  it('the apply writes its intent before its turn; a pass lost inside it settles the job silently and is never applied again', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, found);
      const during: (string | null)[] = [];
      const l = lane(h, { heartbeat: async (row) => { during.push(h.book.get(row.id)!.inflight_json); throw new Error('the pass was lost here'); } });
      await runJobsLane(l.deps());
      expect(during.map(value => value && (JSON.parse(value) as { turn?: string }).turn)).toEqual(['task_report']);
      // What a lost pass leaves: the row still reported, with the apply's intent on it.
      h.sql.exec("UPDATE task_jobs SET inflight_json = ?, due_at = ? WHERE id = ?", JSON.stringify({ turn: 'task_report', at: T0 }), h.clock.at, id);
      let again = 0;
      const next = lane(h, { heartbeat: async () => { again += 1; return 'delivered'; } });
      await runJobsLane(next.deps());
      expect(again).toBe(0);
      expect(next.turns).toEqual([]);
      expect(next.sent.size).toBe(0);
      expect(h.book.get(id)!.status).toBe('applied');
      expect(hops(next.log, 'machine_apply_uncertain')).toHaveLength(1);
    });
  });

  it('an apply closed partway, or that could not run, clears its intent, so the next pass applies it', async () => {
    for (const thrown of [new ClosedRunError(), new Error('no model answered')]) {
      await withBook(async (h) => {
        const id = reportMachine(h.book, found);
        await runJobsLane(lane(h, { heartbeat: async () => { throw thrown; } }).deps());
        expect(h.book.get(id)).toMatchObject({ status: 'reported', inflight_json: null });
        h.sql.exec('UPDATE task_jobs SET due_at = ? WHERE id = ?', h.clock.at, id);
        let applied = 0;
        await runJobsLane(lane(h, { heartbeat: async (_row, _result, io) => { applied += 1; h.transaction(io.settle); return 'delivered'; } }).deps());
        expect(applied).toBe(1);
        expect(h.book.get(id)!.status).toBe('applied');
      });
    }
  });

  it('a parked machine job settles silently: no notice, no turn, no delivery', async () => {
    await withBook(async (h) => {
      const made = enqueue(h.book, spec());
      expect(h.book.park(made.job.id, 'provider_unavailable')).toBe(true);
      const l = lane(h, { heartbeat: async () => { throw new Error('a parked machine job reached its applier'); } });
      await runJobsLane(l.deps());
      expect(l.turns).toEqual([]);
      expect(l.sent.size).toBe(0);
      expect(h.book.get(made.job.id)).toMatchObject({ status: 'parked', park_reason: 'provider_unavailable' });
      expect(hops(l.log, 'machine_parked')).toMatchObject([{ code: 'provider_unavailable', ok: false }]);
      expect(hops(l.log, 'task_parked_notice')).toHaveLength(0);
    });
  });

  it('an applier with no model waits like a task report, then settles silently instead of sending fixed words', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, found);
      let calls = 0;
      const l = lane(h, { heartbeat: async () => { calls += 1; throw new Error('gateway_exhausted'); } });
      await runJobsLane(l.deps());
      expect(h.book.get(id)).toMatchObject({ status: 'reported', deferrals: 1 });
      h.clock.at = T0 + 61 * 60_000;
      await runJobsLane(l.deps());
      expect(calls).toBe(2);
      expect(l.sent.size).toBe(0);
      expect(h.book.get(id)!.status).toBe('applied');
      expect(hops(l.log, 'machine_dropped')).toHaveLength(1);
    });
  });

  it('an item the worker was not shown (its words carry health values) goes to the brain\'s apply even when the worker found nothing', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, nothing, { items: [{ ref: 'l1', detail: 'Book the follow-up: BP was 150/95' }, { ref: 'l2', detail: 'Send the deck' }] });
      expect(taskBrief(h.book.get(id)!).machine!.withheld).toEqual(['l1']);
      const seen: TaskResult[] = [];
      let quiet = 0;
      const l = lane(h);
      await runJobsLane(l.deps({ machine: { heartbeat: {
        apply: async (_row, got, io) => { seen.push(got); h.transaction(io.settle); return 'skipped'; },
        noNews: (_row, settle) => { quiet += 1; h.transaction(settle); },
      } } }));
      expect([seen, quiet]).toEqual([[nothing], 0]);
      expect(hops(l.log, 'machine_skipped')).toHaveLength(1);
    });
  });

  it('a no-news hook that throws waits like an apply, then settles silently, and an owner task report behind it still applies', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, nothing);
      h.clock.at = T0 + 1;
      const owner = h.book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'own-behind', origin: 'tg-1', surface: 'app', brief: ownerBrief, dueAt: T0 + 1, deadlineAt: T0 + 3_600_000 }).job;
      expect(h.book.report(h.book.startAttempt(owner.id)!, found, { rounds: 1, costUsd: 0 })).toBe('accepted');
      let calls = 0;
      const l = lane(h);
      const deps = l.deps({ applyTools: () => [], machine: { heartbeat: { apply: async () => { throw new Error('a no-news job reached its applier'); }, noNews: async () => { calls += 1; throw new Error('calendar unavailable'); } } } });
      await runJobsLane(deps);
      expect(h.book.get(owner.id)!.status).toBe('applied');
      expect([...l.sent.keys()]).toEqual([`task:${owner.id}`]);
      expect(h.book.get(id)).toMatchObject({ status: 'reported', deferrals: 1 });
      expect(hops(l.log, 'machine_apply_deferred')).toHaveLength(1);
      h.clock.at = T0 + 61 * 60_000;
      await runJobsLane(deps);
      expect(calls).toBe(2);
      expect(h.book.get(id)!.status).toBe('applied');
      expect(hops(l.log, 'machine_dropped')).toHaveLength(1);
      expect(hops(l.log, 'machine_no_news')).toHaveLength(0);
    });
  });

  it('a job cancelled while its applier runs delivers nothing: the settle throws inside the delivery and rolls it back', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, found);
      const l = lane(h, { heartbeat: async (row, _got, io) => {
        h.book.cancel(row.id, 'forgotten');
        h.transaction(() => { io.settle(); l.sent.set('x', 'told'); });
        return 'delivered';
      } });
      await runJobsLane(l.deps());
      expect(l.sent.size).toBe(0);
      expect(h.book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
      expect(hops(l.log, 'machine_apply_dropped')).toMatchObject([{ code: 'forgotten' }]);
    });
  });

  it('a held machine job (its gate closed by apply time) settles with the code its applier names', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, found);
      const l = lane(h, { heartbeat: async (_row, _got, io) => { h.transaction(io.settle); return { held: 'held_quiet' }; } });
      await runJobsLane(l.deps());
      expect(h.book.get(id)!.status).toBe('applied');
      expect(hops(l.log, 'machine_held')).toMatchObject([{ code: 'held_quiet' }]);
    });
  });

  it('a held topic cancels the machine job before it applies', async () => {
    await withBook(async (h) => {
      const id = reportMachine(h.book, found);
      const l = lane(h, { heartbeat: async () => { throw new Error('applied a forgotten job'); } });
      await runJobsLane(l.deps({ heldTopics: () => ['Asha'] }));
      expect(h.book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
    });
  });

  it('a held topic cancels a running machine job and fences its worker, so the forget does not wait on it', async () => {
    await withBook(async (h) => {
      const id = enqueue(h.book, spec()).job.id;
      expect(h.book.startAttempt(id)).not.toBeNull();
      const fenced: string[] = [];
      const host = { fence: () => undefined, cancelled: (job: string) => { fenced.push(job); }, busy: () => new Set<string>() } as unknown as TaskHost;
      await runJobsLane(lane(h).deps({ host, heldTopics: () => ['Asha'] }));
      expect(h.book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten' });
      expect(fenced).toEqual([id]);
    });
  });
});

describe('the worker route', () => {
  it('is down only when every provider a worker could be served by is open on the owner\'s breaker', () => {
    const health = new InMemoryCircuitBreaker();
    const access = { openaiApiKey: 'synthetic-openai', anthropicApiKey: 'synthetic-anthropic', health };
    expect(workerRouteDown(access)).toBe(false);
    for (let i = 0; i < 3; i += 1) health.recordFailure('openai');
    // The second provider still answers.
    expect(workerRouteDown(access)).toBe(false);
    expect(workerRouteDown({ openaiApiKey: 'synthetic-openai', health })).toBe(true);
    for (let i = 0; i < 3; i += 1) health.recordFailure('anthropic');
    expect(workerRouteDown(access)).toBe(true);
    // An object that keeps no breaker never holds a job back.
    expect(workerRouteDown({ openaiApiKey: 'synthetic-openai' })).toBe(false);
  });
});
