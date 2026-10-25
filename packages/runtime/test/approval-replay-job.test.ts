import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { browseActArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type ToolHandler, type ToolName } from '@waldo/contracts';
import { approvalDesk, type ApprovalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { sanitise } from '../src/scribe/sanitiser';
import { taskHost, type TaskHost } from '../src/tasks/brain';
import { applyInterrupted, jobBook, REPLAY_DEADLINE_MS, replayKey, TASK_LEASE_MS, type JobBook, type TaskTicket } from '../src/tasks/jobs';
import { runJobsLane, type JobsLaneDeps } from '../src/tasks/lane';
import { BROWSER_TOOLS } from '../src/tasks/profiles';
import { runningTasksLine, taskToolHandlers } from '../src/tasks/tools';
import { argumentDigest, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { approvalJobReplay, approvalReplayContext } from '../src/tools/live/propose-action';

// An approved browser card runs as a replay job, wired the way the owner object wires it: the real desk, job book, brain
// host and jobs lane over Durable Object SQLite, with the owner's serial queue and browser host as fakes. The browser fake
// serves only the active run scope, as the owner's browser does, so a call made from the decision itself would be refused.
const T0 = 1_800_000_000_000;
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const ARGS = { url: 'https://tables.example.com/book', task: 'Book the 8pm table for two at Juniper.' };

type Harness = Readonly<{
  desk: ApprovalDesk; book: JobBook; sql: SqlStorage; clock: { at: number }; ran: string[]; sent: Map<string, string>; log: TurnLogEntry[];
  serial<T>(work: () => Promise<T>): Promise<T>;
  // A replay the lane started, still running outside the lane.
  replays: Promise<void>[];
  browser: { gate?: Promise<void>; ms: number };
  // The brain host; `restart` swaps in a fresh one, as an evicted owner object gets.
  host(): TaskHost; restart(): void;
  card(args?: Record<string, unknown>): Promise<string>;
  pass(over?: Readonly<{ startReplay?: (ticket: TaskTicket) => void; deliver?: JobsLaneDeps['deliver'] }>): Promise<number | null>;
  settle(): Promise<void>;
}>;
let seq = 0;
const withReplay = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`approval-replay-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql, clock = { at: T0 };
    let n = 0;
    const book = jobBook(sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const ran: string[] = [], log: TurnLogEntry[] = [], replays: Promise<void>[] = [], sent = new Map<string, string>();
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T,>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };
    let active: RunEffectScope | undefined;
    const browser: Harness['browser'] = { ms: 0 };
    const browseAct: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
      name: 'browse_act', description: 'Act in the owner browser.', schema: browseActArgsSchema, trigger_allowlist: allowlist('browse_act'), autonomy_gated: false, mutates_state: true,
      async handle(_args, ctx) {
        if (!ctx.runScope || !active || ctx.runScope.runId !== active.runId || ctx.runScope.attempt !== active.attempt) return { ok: false, code: 'rejected', error: 'The browser owner run is no longer current.', source_taint: 'external' };
        ran.push('browse_act');
        if (browser.gate) await browser.gate;
        if (browser.ms) await new Promise(resolve => setTimeout(resolve, browser.ms));
        ran.push('browse_act:done');
        return { ok: true, data: { booked: 'table for two, 8pm' }, source_taint: 'external' };
      },
    };
    const commit = <R,>(work: () => R) => state.storage.transactionSync(work);
    let ids = 0;
    const desk = approvalDesk(sql, {
      owner: 42, call: async () => ({ message_id: 1 }), google: async () => null, newId: () => `pr${ids += 1}`, now: () => clock.at, timezone: 'UTC', log: () => undefined, commit,
      // The owner object's effect ledger: with it, an uncertain card with no effect record reads as never dispatched.
      effects: ownerEffectLedger(state.storage, () => clock.at),
      replayLater: {
        takes: tool => BROWSER_TOOLS.has(tool as ToolName),
        enqueue: (approvalId, call) => {
          book.create({ kind: 'approval_replay', profile: null, idempotencyKey: replayKey(approvalId), origin: replayKey(approvalId), surface: 'app',
            brief: { approval_id: approvalId, ...call, approved_at: clock.at }, dueAt: clock.at, deadlineAt: clock.at + REPLAY_DEADLINE_MS, taint: 'external' });
        },
        wake: async () => undefined,
      },
    });
    const makeHost = () => taskHost({
      book, now: () => clock.at, handlers: () => [], context: () => ({ authenticatedUserId: 'owner-1', sanitise }),
      serialBrowser: (scope, run) => serial(async () => {
        const previous = active;
        active = scope;
        try { return await run(); } finally { if (active === scope) active = previous; }
      }),
      releaseBrowser: () => undefined, log: entry => { log.push(entry); }, wake: async () => undefined,
      replayApproval: (_surface, brief, scope) => approvalJobReplay({
        current: (id, digest) => desk.replayCurrent(id, digest), handlers: () => [browseAct],
        context: () => approvalReplayContext({ authenticatedUserId: 'owner-1', hasApproval: () => true, sanitise, egressAllowlist: ['tables.example.com'] }),
      })(brief, scope),
    });
    let host = makeHost();
    const pass: Harness['pass'] = (over = {}) => runJobsLane({
      book, host, now: () => clock.at, timezone: 'UTC', surface: 'app', quiet: () => false, log: entry => { log.push(entry); },
      startWorker: async () => { throw new Error('no task workers here'); },
      turn: async () => { throw new Error('a replay takes no model turn'); },
      applyTools: () => [],
      deliver: over.deliver ?? (async (id, _trace, text, commitWork) => { if (!sent.has(id)) sent.set(id, text); commit(commitWork); }),
      room: () => true, heldTopics: () => [],
      startReplay: over.startReplay ?? (ticket => { replays.push(host.replay(ticket)); }),
      approvals: desk,
    });
    const card = async (args: Record<string, unknown> = ARGS) => desk.proposeTaintedAction({
      tool: 'browse_act', args, args_digest: (await argumentDigest(args))!, reasoning: 'The restaurant email offered the 8pm table.', source: 'external',
    });
    const settle = async () => { await Promise.all(replays.splice(0)); await serial(async () => undefined); };
    return work({ desk, book, sql, clock, ran, sent, log, serial, replays, browser, host: () => host, restart: () => { host = makeHost(); }, card, pass, settle });
  });
const status = (sql: SqlStorage, id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
const within = <T,>(work: Promise<T>, ms = 2_000): Promise<T> =>
  Promise.race([work, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('deadlocked')), ms))]);

describe('an approved browser card runs as a replay job', () => {
  it('a decision inside the serial lane returns at once and runs nothing; the job runs once under its own scope and the owner hears once', async () => {
    await withReplay(async ({ desk, book, sql, ran, sent, serial, card, pass, settle }) => {
      const id = await card();
      const first = await within(serial(() => desk.decide(id, 'a', 'console:approval')));
      expect(first.toast).toBe('Approved');
      expect(ran).toEqual([]);
      expect(status(sql, id)).toBe('running');
      expect(book.byKey(replayKey(id))).toMatchObject({ kind: 'approval_replay', status: 'queued' });
      // A replayed decision returns the original receipt; it is not a terminal state, so it is never "Already handled".
      expect(await desk.decide(id, 'a', 'tap-again')).toEqual(first);
      expect((await desk.approvals(T0, { id }))[0]).toMatchObject({ state: 'outcome_unknown', actions: [] });

      await within(serial(() => pass().then(() => undefined)));
      await settle();
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(book.byKey(replayKey(id))).toMatchObject({ status: 'reported', outcome: 'done', inflight_json: null });

      await serial(() => pass().then(() => undefined));
      await serial(() => pass().then(() => undefined));
      expect([...sent.keys()]).toEqual([replayKey(id)]);
      expect(sent.get(replayKey(id))).toMatch(/^Done: Run browse_act: .*table for two, 8pm/);
      expect(status(sql, id)).toBe('done');
      expect(book.byKey(replayKey(id))!.status).toBe('applied');
      expect(await desk.decide(id, 'a', 'late-tap')).toEqual({ toast: 'Already handled.', message: 'Already handled.' });
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
    });
  });

  it('a pass lost after it started the replay restarts it once; a pass lost mid-call parks it as uncertain and never runs it again', async () => {
    await withReplay(async ({ desk, book, sql, clock, ran, sent, card, pass, settle, browser, restart }) => {
      const lost = await card();
      await desk.decide(lost, 'a', 'tap');
      await pass({ startReplay: () => undefined });
      expect(book.byKey(replayKey(lost))).toMatchObject({ status: 'running', attempt: 1 });
      clock.at += TASK_LEASE_MS + 1;
      await pass();
      await settle();
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(book.byKey(replayKey(lost))).toMatchObject({ status: 'reported', attempt: 2, crashes: 1 });
      await pass();
      expect(status(sql, lost)).toBe('done');

      ran.length = 0;
      const midway = await card({ ...ARGS, task: 'Book the 9pm table for two at Juniper.' });
      await desk.decide(midway, 'a', 'tap');
      let release!: () => void;
      browser.gate = new Promise<void>(resolve => { release = resolve; });
      await pass();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(ran).toEqual(['browse_act']);
      expect(book.byKey(replayKey(midway))!.inflight_json).not.toBeNull();
      // The object is evicted mid-call: its in-memory host is gone, and the lease lapses.
      restart();
      clock.at += TASK_LEASE_MS + 1;
      await pass();
      expect(status(sql, midway)).toBe('uncertain');
      expect(sent.get(replayKey(midway))).toMatch(/^The outcome is unknown: Run browse_act/);
      release();
      await pass();
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(await desk.decide(midway, 'a', 'retry')).toMatchObject({ toast: 'Outcome unknown' });
      expect(ran.filter(step => step === 'browse_act')).toHaveLength(1);
    });
  });

  it('the owner\'s message waits for one browser step at most: two approved replays run one at a time, with the chat between them', async () => {
    await withReplay(async ({ desk, ran, serial, card, pass, settle, browser, book }) => {
      const one = await card(), two = await card({ ...ARGS, task: 'Book the 9pm table for two at Juniper.' });
      await desk.decide(one, 'a', 'tap');
      await desk.decide(two, 'a', 'tap');
      browser.ms = 40;
      await serial(() => pass().then(() => undefined));
      expect(book.byKey(replayKey(two))!.status).toBe('queued');
      await new Promise(resolve => setTimeout(resolve, 10));
      const asked = Date.now();
      const answered = await serial(async () => { ran.push('owner_turn'); return Date.now(); });
      await settle();
      await serial(() => pass().then(() => undefined));
      await settle();
      expect(ran).toEqual(['browse_act', 'browse_act:done', 'owner_turn', 'browse_act', 'browse_act:done']);
      expect(answered - asked).toBeLessThan(browser.ms * 2);
    });
  });

  it('a running replay takes neither an owner task slot nor a machine slot', async () => {
    await withReplay(async ({ desk, card, pass, settle, browser, book }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      let release!: () => void;
      browser.gate = new Promise(resolve => { release = resolve; });
      await pass();
      expect(book.byKey(replayKey(id))!.status).toBe('running');
      expect(book.runningTasks()).toBe(0);
      expect(book.runningMachine()).toBe(0);
      release();
      await settle();
    });
  });

  it('a forget before the replay runs cancels it: nothing runs, the card closes, and no receipt repeats the forgotten words', async () => {
    await withReplay(async ({ desk, book, sql, ran, sent, card, pass, settle }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      expect(book.forget(['Juniper']).cancelled).toEqual([book.byKey(replayKey(id))!.id]);
      await pass();
      await settle();
      expect(ran).toEqual([]);
      expect(status(sql, id)).toBe('skipped');
      expect(sent.size).toBe(0);
    });
  });

  it('a forget while the replay runs fences it; the owner is told once that its outcome is unknown', async () => {
    await withReplay(async ({ desk, book, sql, ran, sent, card, pass, browser, host }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      let release!: () => void;
      browser.gate = new Promise<void>(resolve => { release = resolve; });
      await pass();
      await new Promise(resolve => setTimeout(resolve, 10));
      const job = book.byKey(replayKey(id))!;
      expect(book.forget(['Juniper']).cancelled).toEqual([job.id]);
      host().cancelled(job.id);
      release();
      await pass();
      await pass();
      expect(status(sql, id)).toBe('uncertain');
      expect([...sent.values()]).toEqual([expect.stringMatching(/had already started, so its outcome is unknown/)]);
      expect(sent.get(`${replayKey(id)}:stopped`)).not.toMatch(/Juniper/);
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
    });
  });

  it('a forget after the replay ran keeps the card honest: it ran, and no receipt repeats the forgotten words', async () => {
    await withReplay(async ({ desk, book, sql, ran, sent, card, pass, settle }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      await pass();
      await settle();
      expect(book.byKey(replayKey(id))!.status).toBe('reported');
      expect(book.forget(['Juniper']).cancelled).toHaveLength(1);
      await pass();
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(status(sql, id)).toBe('done');
      expect(sent.size).toBe(0);
    });
  });

  it('a changed digest is refused before the browser runs: on the card, or in the job\'s frozen call', async () => {
    await withReplay(async ({ desk, book, sql, ran, sent, card, pass, settle }) => {
      const onCard = await card();
      await desk.decide(onCard, 'a', 'tap');
      sql.exec("UPDATE ledger SET payload_json = replace(payload_json, '8pm', '10pm') WHERE id = ?", onCard);
      await pass();
      await settle();
      await pass();
      expect(ran).toEqual([]);
      expect(status(sql, onCard)).toBe('failed');
      expect(sent.get(replayKey(onCard))).toMatch(/no longer matches what you approved, so nothing ran/);

      const inJob = await card({ ...ARGS, task: 'Book the 9pm table for two at Juniper.' });
      await desk.decide(inJob, 'a', 'tap');
      sql.exec("UPDATE task_jobs SET brief_json = replace(brief_json, '9pm', '11pm') WHERE id = ?", book.byKey(replayKey(inJob))!.id);
      await pass();
      await settle();
      await pass();
      expect(ran).toEqual([]);
      expect(status(sql, inJob)).toBe('failed');
      expect(sent.get(replayKey(inJob))).toMatch(/changed after you approved it, so nothing ran/);
    });
  });

  it('a replay that waited past its deadline does not run, and the owner hears it did not', async () => {
    await withReplay(async ({ desk, sql, clock, ran, sent, card, pass, settle }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      clock.at += REPLAY_DEADLINE_MS;
      await pass();
      await settle();
      expect(ran).toEqual([]);
      expect(status(sql, id)).toBe('failed');
      expect(sent.get(replayKey(id))).toMatch(/could not start in time, so it did not run/);
    });
  });

  it('cancel_task stops an approved action that has not run, and refuses one that already ran', async () => {
    await withReplay(async ({ desk, book, sql, clock, ran, card, pass, settle }) => {
      const tools = taskToolHandlers({ book, now: () => clock.at, timezone: () => 'UTC', surface: 'app', wake: async () => undefined, fence: () => undefined, log: () => undefined });
      const cancel = tools.find(tool => tool.name === 'cancel_task')!;
      const waiting = await card();
      await desk.decide(waiting, 'a', 'tap');
      const job = book.byKey(replayKey(waiting))!;
      // The owner's turn sees the approved action and its id beside the running tasks, never its page-derived arguments.
      expect(runningTasksLine(book)).toBe(`Actions the owner approved that have not finished (ids for cancel_task):\n- ${job.id}: the approved browse_act action (waiting to run)`);
      expect(await cancel.handle({ job_id: job.id })).toMatchObject({ ok: true, data: { title: 'the approved browse_act action', cancelled: true } });
      await pass();
      await settle();
      expect(ran).toEqual([]);
      expect(status(sql, waiting)).toBe('skipped');

      const done = await card({ ...ARGS, task: 'Book the 9pm table for two at Juniper.' });
      await desk.decide(done, 'a', 'tap');
      await pass();
      await settle();
      const ranJob = book.byKey(replayKey(done))!;
      expect(ranJob.status).toBe('reported');
      expect(await cancel.handle({ job_id: ranJob.id })).toMatchObject({ ok: false, error: expect.stringMatching(/already ran/) });
      await pass();
      expect(status(sql, done)).toBe('done');
    });
  });

  it('a card for a tool the desk runs in the decision is not a replay job', async () => {
    await withReplay(async ({ desk, book }) => {
      const id = await desk.proposeTaintedAction({ tool: 'write_task', args: { title: 'Pay invoice 44' }, args_digest: (await argumentDigest({ title: 'Pay invoice 44' }))!, reasoning: 'The vendor email asked.', source: 'external' });
      await desk.decide(id, 'a', 'tap');
      expect(book.byKey(replayKey(id))).toBeNull();
    });
  });
  it('a replay\'s own intent is never read as a report\'s apply intent: a call lost mid-run reaches the owner as the replay\'s unknown outcome, and no apply turn runs or overwrites it', async () => {
    await withReplay(async ({ desk, book, sql, clock, ran, sent, log, card, pass, browser, restart }) => {
      const id = await card();
      await desk.decide(id, 'a', 'tap');
      let release!: () => void;
      browser.gate = new Promise<void>(resolve => { release = resolve; });
      await pass();
      await new Promise(resolve => setTimeout(resolve, 10));
      restart();
      clock.at += TASK_LEASE_MS + 1;
      // The lane parks the lost call; its receipt fails to queue in this pass.
      await expect(pass({ deliver: async () => { throw new Error('outbox unavailable'); } })).rejects.toThrow('outbox unavailable');
      const parked = book.byKey(replayKey(id))!;
      expect(parked).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect' });
      expect(JSON.parse(parked.inflight_json!)).toMatchObject({ tool: 'browse_act', call_id: replayKey(id) });
      expect(applyInterrupted(parked)).toBe(false);
      await pass();
      expect(sent.get(replayKey(id))).toMatch(/^The outcome is unknown: Run browse_act/);
      expect(status(sql, id)).toBe('uncertain');
      expect(log.map(entry => entry.hop)).not.toContain('task_apply_uncertain');
      release();
      await pass();
      expect(ran.filter(step => step === 'browse_act')).toHaveLength(1);
    });
  });

  it('a settled replay keeps which card and tool it ran, never the frozen arguments; cancel_task still names it', async () => {
    await withReplay(async ({ desk, book, clock, card, pass, settle }) => {
      const tools = taskToolHandlers({ book, now: () => clock.at, timezone: () => 'UTC', surface: 'app', wake: async () => undefined, fence: () => undefined, log: () => undefined });
      const cancel = tools.find(tool => tool.name === 'cancel_task')!;
      const ran = await card();
      await desk.decide(ran, 'a', 'tap');
      await pass();
      await settle();
      await pass();
      const applied = book.byKey(replayKey(ran))!;
      expect(applied.status).toBe('applied');
      expect(JSON.parse(applied.brief_json)).toEqual({ approval_id: ran, tool: 'browse_act', approved_at: T0 });
      expect(await cancel.handle({ job_id: applied.id })).toMatchObject({ ok: false, error: '"the approved browse_act action" already finished.' });

      const forgotten = await card({ ...ARGS, task: 'Book the 9pm table for two at Juniper.' });
      await desk.decide(forgotten, 'a', 'tap');
      expect(book.forget(['Juniper']).cancelled).toHaveLength(1);
      await pass();
      expect(JSON.parse(book.byKey(replayKey(forgotten))!.brief_json)).toEqual({ approval_id: forgotten, tool: 'browse_act', approved_at: T0 });
    });
  });
});
