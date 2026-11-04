import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { browseActArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMToolTurn, type TaskResult, type ToolHandler, type ToolName } from '@waldo/contracts';
import { approvalDesk, taskAskRef, withdrawRunCards, type ApprovalDesk } from '../src/channels/approvals';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { sanitise } from '../src/scribe/sanitiser';
import { taskAsks } from '../src/tasks/asks';
import { taskHost, type TaskHost } from '../src/tasks/brain';
import { jobBook, jobCheckpoint, REPLAY_DEADLINE_MS, replayKey, type JobBook, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { runJobsLane } from '../src/tasks/lane';
import { BROWSER_TOOLS, FINISH_TASK } from '../src/tasks/profiles';
import { runTaskAttempt, type TaskModel } from '../src/tasks/worker-loop';
import { argumentDigest, type ToolDispatcherContext } from '../src/tools/dispatcher';

// Ask and resume through the real approval desk, wired as the owner object wires it (tasks/asks.ts): the desk, job book,
// brain host and jobs lane over Durable Object SQLite, with the serial queue, the browser and the model as fakes. The browser
// serves only the active run scope, as the owner's does, so the approved step can run only inside the task's own attempt.
const T0 = 1_800_000_000_000;
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const BOOK = { url: 'https://tables.example.com/book', task: 'Book the 8pm table for two at Juniper.' };
const brief: TaskBrief = { title: 'Book a table', goal: 'Book a table for two tonight.', context: 'Juniper.', done_when: 'A booking.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const done = (summary: string): TaskResult => ({ status: 'done', summary, findings: [], proposals: [], left: [] });

type Harness = Readonly<{
  desk: ApprovalDesk; book: JobBook; sql: SqlStorage; host: TaskHost; ran: string[]; log: TurnLogEntry[];
  serial<T>(work: () => Promise<T>): Promise<T>;
  // Work done while the card is being raised, after its ledger row exists.
  raising: { during?: (approvalId: string) => Promise<void> };
  task(): TaskTicket; pass(): Promise<void>;
  // The attempts the lane started.
  started: TaskTicket[];
}>;
let seq = 0;
const withDesk = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-ask-desk-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    let n = 0, ids = 0;
    const book = jobBook(sql, { now: () => T0, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const asks = taskAsks(sql, () => book);
    const ran: string[] = [], log: TurnLogEntry[] = [], started: TaskTicket[] = [];
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T,>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };
    let active: RunEffectScope | undefined;
    const raising: Harness['raising'] = {};
    const browseAct: ToolHandler<unknown, unknown, ToolDispatcherContext> = {
      name: 'browse_act', description: 'Act in the owner browser.', schema: browseActArgsSchema, trigger_allowlist: allowlist('browse_act'), autonomy_gated: false, mutates_state: true,
      async handle(_args, ctx) {
        if (!ctx.runScope || !active || ctx.runScope.runId !== active.runId || ctx.runScope.attempt !== active.attempt) return { ok: false, code: 'rejected', error: 'The browser owner run is no longer current.', source_taint: 'external' };
        ran.push(`browse_act:${ctx.runScope.runId}`);
        return { ok: true, data: { booked: 'table for two, 8pm' }, source_taint: 'external' };
      },
    };
    const desk: ApprovalDesk = approvalDesk(sql, {
      owner: 42, call: async () => ({ message_id: 1 }), google: async () => null, newId: () => `pr${ids += 1}`, now: () => T0, timezone: 'UTC', log: () => undefined,
      commit: work => state.storage.transactionSync(work),
      replayLater: {
        takes: tool => BROWSER_TOOLS.has(tool as ToolName),
        enqueue: (approvalId, call) => {
          if (asks.approved(approvalId)) return;
          book.create({ kind: 'approval_replay', profile: null, idempotencyKey: replayKey(approvalId), origin: replayKey(approvalId), surface: 'app',
            brief: { approval_id: approvalId, ...call, approved_at: T0 }, dueAt: T0, deadlineAt: T0 + REPLAY_DEADLINE_MS, taint: 'external' });
        },
        wake: async () => undefined,
        declined: async approvalId => { book.resume(approvalId, 'declined'); },
      },
    });
    const host = taskHost({
      book, now: () => T0, handlers: () => [browseAct] as never, context: () => ({ authenticatedUserId: 'owner-1', sanitise, egressAllowlist: ['tables.example.com'] }),
      serialBrowser: (scope, run) => serial(async () => {
        const previous = active;
        active = scope;
        try { return await run(); } finally { if (active === scope) active = previous; }
      }),
      releaseBrowser: () => undefined, log: entry => { log.push(entry); }, wake: async () => undefined,
      replayApproval: async () => { throw new Error('a task runs its own approved step'); },
      withdrawCards: runRef => { withdrawRunCards(sql, runRef, T0); }, endAsks: jobId => { asks.end(jobId, T0); },
      askCurrent: (_row, approvalId, argsDigest) => desk.replayCurrent(approvalId, argsDigest),
      settleAsk: (_row, approvalId, status) => { desk.settleReplay(approvalId, status); },
      askOwner: async (row, call) => {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        const args_digest = (await argumentDigest(args))!;
        const id = await serial(() => desk.proposeTaintedAction({ tool: call.name, args, args_digest, reasoning: 'A task reached this step.', source: 'external' }, { runRef: taskAskRef(row.id) }));
        await raising.during?.(id);
        return id;
      },
    });
    const task = () => {
      const { job } = book.create({ kind: 'task', profile: 'errand', idempotencyKey: `k${n += 1}`, origin: 'app-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      return book.startAttempt(job.id)!;
    };
    const pass = async () => { await runJobsLane({
      book, host, now: () => T0, timezone: 'UTC', surface: 'app', quiet: () => false, log: entry => { log.push(entry); },
      startWorker: async ticket => { started.push(ticket); }, turn: async () => 'ok', applyTools: () => [], deliver: async (_id, _trace, _text, commit) => { state.storage.transactionSync(commit); },
      room: () => true, heldTopics: () => [], startReplay: () => undefined,
      approvals: { replays: () => asks.replays(desk), replayReceipt: (id, status, message) => desk.replayReceipt(id, status, message), settleReplay: (id, status) => desk.settleReplay(id, status) },
      askedCard: id => asks.card(desk, id),
    }); };
    return work({ desk, book, sql, host, ran, log, serial, raising, task, pass, started });
  });

const scripted = (calls: readonly Readonly<{ name: string; args: unknown }>[], seen: LLMToolTurn[][]): TaskModel => {
  let k = 0;
  return async ({ turns }) => {
    seen.push([...turns]);
    const next = calls[Math.min(k, calls.length - 1)]!;
    k += 1;
    return { response: { text: '', tool_calls: [{ call_id: `c${k}`, name: next.name, arguments: JSON.stringify(next.args) }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
  };
};
const status = (sql: SqlStorage, id: string) => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
const blocks = (host: TaskHost, ticket: TaskTicket) => runTaskAttempt(ticket, { brain: host, model: scripted([{ name: 'browse_act', args: BOOK }], []), sliceEnd: T0 + 60_000 });

describe('a task asks the owner through the real desk', () => {
  it('approve: the card resumes the task, whose next attempt runs the step once in its own scope, settles the card done, and finishes', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, serial, task, pass, started }) => {
      const t = task();
      expect(await blocks(host, t)).toBe('fenced');
      expect(book.get(t.jobId)!.status).toBe('awaiting_owner');
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      expect(status(sql, id)).toBe('open');
      await serial(() => desk.decide(id, 'a', 'console:approval'));
      // No replay job: the task itself is queued to resume, and the card waits on it.
      expect(book.byKey(replayKey(id))).toBeNull();
      expect(book.get(t.jobId)!.status).toBe('queued');
      expect(status(sql, id)).toBe('running');
      // The lane starts the resumed attempt and leaves the task's approved card alone.
      await pass();
      expect(status(sql, id)).toBe('running');
      expect(started.map(ticket => ticket.jobId)).toEqual([t.jobId]);
      const seen: LLMToolTurn[][] = [];
      expect(await runTaskAttempt(started[0]!, { brain: host, model: scripted([{ name: FINISH_TASK, args: done('Booked the 8pm table.') }], seen), sliceEnd: T0 + 60_000 })).toBe('reported');
      expect(ran).toEqual([`browse_act:task:${t.jobId}`]);
      expect(status(sql, id)).toBe('done');
      expect(JSON.parse(seen[0]![0]!.output)).toMatchObject({ ok: true, data: { booked: 'table for two, 8pm' } });
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', outcome: 'done' });
    });
  });

  it('an approval that lands while the card is still being raised: the task waits, and the lane resumes it approved', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, raising, task, pass }) => {
      raising.during = async approvalId => { await desk.decide(approvalId, 'a', 'console:approval'); };
      const t = task();
      expect(await blocks(host, t)).toBe('fenced');
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      expect(book.get(t.jobId)!.status).toBe('awaiting_owner');
      expect(status(sql, id)).toBe('running');
      await pass();
      expect(jobCheckpoint(book.get(t.jobId)!).asked?.decision).toBe('approved');
      expect(['queued', 'running']).toContain(book.get(t.jobId)!.status);
      expect(ran).toEqual([]);
    });
  });

  it('skip: the task resumes without the step and the step never runs', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, serial, task }) => {
      const t = task();
      await blocks(host, t);
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      await serial(() => desk.decide(id, 's', 'console:approval'));
      expect(status(sql, id)).toBe('skipped');
      expect(jobCheckpoint(book.get(t.jobId)!).asked?.decision).toBe('declined');
      const seen: LLMToolTurn[][] = [];
      expect(await runTaskAttempt(book.startAttempt(t.jobId)!, { brain: host, model: scripted([{ name: FINISH_TASK, args: { ...done('Not booked.'), status: 'partial' } }], seen), sliceEnd: T0 + 60_000 })).toBe('reported');
      expect(ran).toEqual([]);
      expect(JSON.parse(seen[0]![0]!.output)).toMatchObject({ ok: false, error: 'The owner declined this step, so it did not run.' });
    });
  });

  it('a cancel after the approval and before the step ran: the card ends as stopped before it ran', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, serial, task }) => {
      const t = task();
      await blocks(host, t);
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      await serial(() => desk.decide(id, 'a', 'console:approval'));
      expect(book.cancel(t.jobId, 'owner')).toBe(true);
      host.cancelled(t.jobId);
      expect(status(sql, id)).toBe('skipped');
      expect(ran).toEqual([]);
    });
  });

  it('a cancel while it waits withdraws the card, so a late approval runs nothing', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, serial, task }) => {
      const t = task();
      await blocks(host, t);
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      expect(book.cancel(t.jobId, 'owner')).toBe(true);
      host.cancelled(t.jobId);
      expect(status(sql, id)).toBe('skipped');
      await serial(() => desk.decide(id, 'a', 'console:approval'));
      expect(status(sql, id)).toBe('skipped');
      expect(ran).toEqual([]);
    });
  });

  it('the card changed after the approval: the resumed attempt runs nothing, the card fails and the worker is told', async () => {
    await withDesk(async ({ desk, book, sql, host, ran, serial, task }) => {
      const t = task();
      await blocks(host, t);
      const id = jobCheckpoint(book.get(t.jobId)!).asked!.approval_id;
      await serial(() => desk.decide(id, 'a', 'console:approval'));
      sql.exec("UPDATE ledger SET proposal_digest = 'changed' WHERE id = ?", id);
      const seen: LLMToolTurn[][] = [];
      expect(await runTaskAttempt(book.startAttempt(t.jobId)!, { brain: host, model: scripted([{ name: FINISH_TASK, args: { ...done('Not booked.'), status: 'partial' } }], seen), sliceEnd: T0 + 60_000 })).toBe('reported');
      expect(ran).toEqual([]);
      expect(status(sql, id)).toBe('failed');
      expect(JSON.parse(seen[0]![0]!.output)).toMatchObject({ ok: false, error_code: 'approval_denied' });
      expect(book.get(t.jobId)!.inflight_json).toBeNull();
    });
  });

  it('a card raised while the task\'s scope was active, not asked by the task: approved, it is a replay job as before, and a park keeps it', async () => {
    await withDesk(async ({ desk, book, sql, host, serial, task }) => {
      const t = task();
      const args_digest = (await argumentDigest(BOOK))!;
      const other = await serial(() => desk.proposeTaintedAction({ tool: 'browse_act', args: BOOK, args_digest, reasoning: 'Raised in the task run.', source: 'external' }, { runRef: `task:${t.jobId}` }));
      const later = { ...BOOK, task: 'Book 9pm instead.' }, laterDigest = (await argumentDigest(later))!;
      const waiting = await serial(() => desk.proposeTaintedAction({ tool: 'browse_act', args: later, args_digest: laterDigest, reasoning: 'Also raised in the task run.', source: 'external' }, { runRef: `task:${t.jobId}` }));
      await serial(() => desk.decide(other, 'a', 'console:approval'));
      expect(book.byKey(replayKey(other))).toMatchObject({ kind: 'approval_replay', status: 'queued' });
      expect(book.park(t.jobId, 'crashed')).toBe(true);
      host.endAsk(book.get(t.jobId)!);
      expect(status(sql, other)).toBe('running');
      expect(status(sql, waiting)).toBe('open');
    });
  });
});
