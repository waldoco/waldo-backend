import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type ToolName } from '@waldo/contracts';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { InMemoryCircuitBreaker } from '../src/llm/provider';
import { sanitise } from '../src/scribe/sanitiser';
import { taskHost, UNKEPT_EFFECT, UNKEPT_OUTPUT, type TaskHostDeps } from '../src/tasks/brain';
import { clearedToolResult, DROPPED_STEPS_NOTE } from '../src/conversation/tool-loop';
import { jobBook, type JobBook, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { FINISH_TASK } from '../src/tasks/profiles';
import { runTaskAttempt, type TaskModel } from '../src/tasks/worker-loop';
import { TASK_PROFILE_SPECS } from '../src/tasks/profiles';
import { TOOL_RECORDS } from '../src/tools/records';

// The brain's side of the job protocol over the real job book: every worker call is checked against its ticket, the
// profile's tools are enforced here, and a cancel reaches a call that is already running.
const T0 = 1_800_000_000_000;
const brief: TaskBrief = { title: 'Book a table', goal: 'Find a table for two tonight.', context: 'Near Bandra.', done_when: 'A shortlist.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const CANARIES = ['a1b2c3d4e5f60718', '1a2b3c4d5e6f7081', 'f0e1d2c3b4a59687'];
const VALID_ARGS: Record<string, unknown> = { search_communication: { query: 'from:client' }, browse_page: { url: 'https://example.com/menu', instruction: 'Read the menu.' }, browse_act: { url: 'https://example.com/book', task: 'Find a table for two at 8pm.', command: { operation: 'click', element_ref: 'e1', intent: 'read' } } };
// An errand step that types nothing past Waldo's own page: the tainted-write law admits it from a worker. A step with no
// typed command takes the legacy path and goes to the owner's card (below).
const UNTYPED_BROWSE = { call_id: 'c-untyped', name: 'browse_act', arguments: JSON.stringify({ url: 'https://example.com/book', task: 'Book a table for two at 8pm.' }) };
const call = (name: string) => ({ call_id: `c-${name}`, name, arguments: JSON.stringify(VALID_ARGS[name] ?? {}) });

type Harness = Readonly<{
  book: JobBook; sql: SqlStorage; clock: { at: number }; host: ReturnType<typeof taskHost>; log: TurnLogEntry[]; released: RunEffectScope[]; ran: string[]; withdrawn: string[];
  ticket(profile?: 'reader' | 'errand'): TaskTicket; setSpend(spend: { spentUsd: number; ceilingUsd: number } | 'throws' | undefined): void;
  hold: { release?: () => void; waiting?: Promise<void> };
  // The owner object's serial queue, as OwnerDO.serial() runs it: one unit at a time, in arrival order.
  serial<T>(work: () => Promise<T>): Promise<T>;
  browse: { ms: number; throws?: boolean };
  handler: { search?: (ctx: ToolDispatcherContext) => Promise<unknown> };
  // The owner's provider breaker, on the harness clock.
  health: InMemoryCircuitBreaker;
  // What the directory says of the owner when a worker call asks.
  admission: { now: 'admitted' | 'dormant' | 'retry' | 'throws'; waiting?: Promise<void> };
  // Topics the owner is forgetting whose purge has not settled.
  topics: string[];
}>;
let seq = 0;
const withHost = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-brain-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: T0 };
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const log: TurnLogEntry[] = [], released: RunEffectScope[] = [], ran: string[] = [], withdrawn: string[] = [];
    let spend: { spentUsd: number; ceilingUsd: number } | 'throws' | undefined;
    const hold: Harness['hold'] = {};
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T,>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };
    const browse: Harness['browse'] = { ms: 0 };
    const handler: Harness['handler'] = {};
    const health = new InMemoryCircuitBreaker({ now: () => clock.at });
    const admission: Harness['admission'] = { now: 'admitted' };
    const topics: string[] = [];
    const handlers = [
      { name: 'search_communication', description: 'Search mail.', schema: z.object({ query: z.string() }), trigger_allowlist: allowlist('search_communication'), autonomy_gated: false, mutates_state: false,
        async handle(_args: unknown, ctx: ToolDispatcherContext) { ran.push('search_communication'); return { ok: true as const, data: await (handler.search?.(ctx) ?? { hits: 2 }), source_taint: 'external' as const }; } },
      { name: 'browse_page', description: 'Read a page.', schema: z.object({ url: z.string(), instruction: z.string() }), trigger_allowlist: allowlist('browse_page'), autonomy_gated: false, mutates_state: false,
        async handle() { ran.push('browse_page'); return { ok: true as const, data: { text: 'A menu.' }, source_taint: 'external' as const }; } },
      { name: 'browse_act', description: 'Act in the browser.', schema: z.object({ url: z.string(), task: z.string() }).loose(), trigger_allowlist: allowlist('browse_act'), autonomy_gated: false, mutates_state: true,
        async handle() { ran.push('browse_act'); if (browse.ms) await new Promise(resolve => setTimeout(resolve, browse.ms)); if (browse.throws) throw new Error('vendor dropped the session'); ran.push('browse_act:done'); return { ok: true as const, data: { done: true }, source_taint: 'external' as const }; } },
    ] as unknown as ReturnType<TaskHostDeps['handlers']>;
    const host = taskHost({
      book, now: () => clock.at, handlers: () => handlers, context: () => ({ authenticatedUserId: 'owner-1', sanitise, egressAllowlist: ['example.com'] }),
      serialBrowser: (_scope, run) => serial(async () => { if (hold.waiting) await hold.waiting; return run(); }),
      releaseBrowser: scope => { released.push(scope); }, log: entry => { log.push(entry); }, spend: () => { if (spend === 'throws') throw new Error('no runtime for the task channel'); return spend; }, wake: async () => undefined, withdrawCards: runRef => { withdrawn.push(runRef); },
      providerHealth: health,
      admitted: async () => { if (admission.waiting) await admission.waiting; if (admission.now === 'throws') throw new Error('directory unreachable'); return admission.now; },
      heldTopics: () => topics,
    });
    const ticket = (profile: 'reader' | 'errand' = 'reader') => {
      const { job } = book.create({ kind: 'task', profile, idempotencyKey: `k${n += 1}`, origin: 'tg-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      return book.startAttempt(job.id)!;
    };
    return work({ book, sql: state.storage.sql, clock, host, log, released, ran, withdrawn, serial, browse, ticket, setSpend: next => { spend = next; }, hold, handler, health, admission, topics });
  });

describe('the task brain host', () => {
  // A research worker reads pages, which a web_search snippet often cannot answer; acting on a page stays the errand's.
  it('a reader job is offered only reader tools, page reads among them, and a call outside its profile is refused without running', async () => {
    await withHost(async ({ host, ticket, ran, released }) => {
      const t = ticket('reader');
      const claim = await host.claim(t);
      expect(claim === 'fenced' ? [] : claim.tools.map(tool => tool.name)).toEqual(['search_communication', 'browse_page']);
      for (const name of ['browse_act', 'propose_action', 'send_message', 'send_email', 'start_task']) {
        expect(await host.tool(t, call(name), CANARIES), name).toMatchObject({ ok: false, error_code: 'acl_denied', code: 'rejected' });
      }
      expect(ran).toEqual([]);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: true, source_taint: 'external' });
      expect(await host.tool(t, call('browse_page'), CANARIES)).toMatchObject({ ok: true, source_taint: 'external' });
      expect(ran).toEqual(['search_communication', 'browse_page']);
      expect(released).toEqual([]);
    });
  });

  it('the app thread a task reports to stays with the brain: the worker\'s claim carries the brief without it', async () => {
    await withHost(async ({ host, book }) => {
      const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'k-thread', origin: 'app-1', surface: 'app', brief: { ...brief, conversation_ref: 'owner:prn_1:thr_1' }, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      const claim = await host.claim(book.startAttempt(job.id)!);
      expect(claim === 'fenced' ? null : claim.brief).toEqual(brief);
    });
  });

  // A worker has always read outside content, and it cannot raise a card or approve: a step the taint gate sends to the
  // owner (a free-form browser step, a download) does not run, and the worker is told to stop there and hand the step back
  // in its result's proposals, which the report's apply turn puts to the owner. It is never pointed at propose_action, which
  // no worker profile holds.
  for (const [label, step] of [
    ['untyped browser step', UNTYPED_BROWSE],
    ['download', { call_id: 'c-download', name: 'browse_act', arguments: JSON.stringify({ url: 'https://example.com/book', task: 'Save the menu.', command: { operation: 'download', element_ref: 'e2' } }) }],
  ] as const) {
    it(`an errand worker's ${label} stops for the owner: nothing runs, no intent is written, and the worker is told to finish with it as a proposal`, async () => {
      await withHost(async ({ host, ticket, ran, book }) => {
        const t = ticket('errand');
        await host.claim(t);
        const refused = await host.tool(t, step, CANARIES);
        expect(refused).toMatchObject({ ok: false, error_code: 'taint_needs_approval', retryable: false });
        const told = JSON.stringify(refused);
        expect(told).not.toContain('propose_action');
        expect(told).toContain(FINISH_TASK);
        expect(told).toContain('proposals');
        expect(ran).toEqual([]);
        expect(book.get(t.jobId)!).toMatchObject({ status: 'running', inflight_json: null });
        expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
        expect(ran).toEqual(['browse_act', 'browse_act:done']);
      });
    });
  }

  it('a worker that stops at a step needing the owner reports it as a proposal, and the stored result keeps the exact step', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket('errand');
      await host.claim(t);
      await host.tool(t, UNTYPED_BROWSE, CANARIES);
      const proposal = { tool: 'browse_act', why: 'Booking needs the owner\'s approval.', args: JSON.parse(UNTYPED_BROWSE.arguments) as Record<string, unknown> };
      expect(await host.report(t, { kind: 'result', result: { status: 'blocked', summary: 'Found a table; booking it needs you.', findings: [], proposals: [proposal], left: [] } }, [], { rounds: 1, costUsd: 0 })).toBe('accepted');
      expect(JSON.parse(book.get(t.jobId)!.result_json!)).toMatchObject({ status: 'blocked', proposals: [proposal] });
    });
  });

  // A worker has always read outside content, so every call it makes runs with outside-sourced arguments: this value is
  // the whole taint gate for a worker's browse_act, and the worker never grants itself approval.
  it('every worker call reaches its handler with outside-sourced arguments and no approval', async () => {
    await withHost(async ({ host, ticket, handler }) => {
      const seen: Pick<ToolDispatcherContext, 'toolArgSourceTaint' | 'sourceTaint'>[] = [];
      let approved: boolean | undefined;
      handler.search = async (ctx) => { seen.push({ toolArgSourceTaint: ctx.toolArgSourceTaint, sourceTaint: ctx.sourceTaint }); approved = await ctx.hasApproval?.({ tool: 'search_communication', args: {}, session: null }); return { hits: 1 }; };
      const t = ticket();
      await host.claim(t);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: true });
      expect(seen).toEqual([{ toolArgSourceTaint: 'external', sourceTaint: null }]);
      expect(approved).toBe(false);
    });
  });

  // The lease renews only for the attempt's own token: a forged token neither keeps the job alive nor reaches its calls.
  it('a heartbeat with a forged token is refused and leaves the lease where it was', async () => {
    await withHost(async ({ host, ticket, book, clock }) => {
      const t = ticket();
      await host.claim(t);
      const lease = book.get(t.jobId)!.lease_until;
      clock.at += 60_000;
      expect(await host.heartbeat({ ...t, token: 'forged' })).toBe(false);
      expect(book.get(t.jobId)!.lease_until).toBe(lease);
      expect(await host.tool({ ...t, token: 'forged' }, call('search_communication'), CANARIES)).toBe('fenced');
      expect(await host.heartbeat(t)).toBe(true);
      expect(book.get(t.jobId)!.lease_until).toBeGreaterThan(lease!);
    });
  });

  it('records external taint on the job when a tool returns outside content', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      await host.claim(t);
      await host.tool(t, call('search_communication'), CANARIES);
      expect(book.get(t.jobId)!.taint).toBe('external');
    });
  });

  it('frozen intent: a brief changed after the job started is not run, and the job parks for the owner to hear', async () => {
    await withHost(async ({ host, ticket, book, sql, log }) => {
      const t = ticket();
      sql.exec("UPDATE task_jobs SET brief_json = replace(brief_json, 'Bandra', 'Juhu') WHERE id = ?", t.jobId);
      expect(await host.claim(t)).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'brief_changed' });
      expect(log.find(entry => entry.hop === 'task_parked')).toMatchObject({ code: 'brief_changed', ok: false });
    });
  });

  it('a cancel while a tool call is in flight aborts its I/O, and the worker gets nothing back', async () => {
    await withHost(async ({ host, ticket, book, handler }) => {
      const t = ticket();
      await host.claim(t);
      let aborted = false;
      handler.search = (ctx) => new Promise((resolve) => {
        ctx.runScope!.signal.addEventListener('abort', () => { aborted = true; resolve({ late: true }); });
      });
      const pending = host.tool(t, call('search_communication'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(book.cancel(t.jobId, 'owner')).toBe(true);
      host.fence(t.jobId);
      expect(await pending).toBe('fenced');
      expect(aborted).toBe(true);
    });
  });

  it('an unreplayable step writes its intent only once it can start: waiting behind the serial lane is not an uncertain effect', async () => {
    await withHost(async ({ host, ticket, book, hold, ran }) => {
      const t = ticket('errand');
      await host.claim(t);
      let release!: () => void;
      hold.waiting = new Promise<void>(resolve => { release = resolve; });
      const pending = host.tool(t, call('browse_act'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(book.get(t.jobId)!.inflight_json).toBeNull();
      expect(host.busy().has(t.jobId)).toBe(true);
      expect(book.lapse(host.busy())).toEqual([]);
      release();
      expect(await pending).toMatchObject({ ok: true });
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(host.busy().has(t.jobId)).toBe(false);
    });
  });

  // The effect's result exists only in the worker until a checkpoint or report records it, so the intent stays until then.
  it('a worker lost after an unreplayable step but before its checkpoint: the lapse parks the job as an uncertain effect', async () => {
    await withHost(async ({ host, ticket, book, clock, ran }) => {
      const t = ticket('errand');
      await host.claim(t);
      expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
      expect(JSON.parse(book.get(t.jobId)!.inflight_json!)).toMatchObject({ tool: 'browse_act', call_id: 'c-browse_act' });
      clock.at += 10 * 60_000;
      expect(book.lapse(host.busy())).toEqual([{ id: t.jobId, parked: true }]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect' });
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
    });
  });

  it('the same attempt rejoining while the step is still recorded in flight is parked, not handed the job to run again', async () => {
    await withHost(async ({ host, ticket, book, log, released }) => {
      const t = ticket('errand');
      await host.claim(t);
      await host.tool(t, call('browse_act'), CANARIES);
      expect(await host.claim(t)).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect', lease_token: null });
      expect(log.find(entry => entry.hop === 'task_parked')).toMatchObject({ ok: false, code: 'uncertain_effect' });
      expect(released).toHaveLength(1);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toBe('fenced');
    });
  });

  // P2c: the forget found no row carrying the text, but the worker read it and holds it in memory. Its next checkpoint
  // would write the text back after the forget: the job is cancelled as forgotten instead, and nothing is written.
  it('a checkpoint carrying a topic the owner is forgetting cancels the job as forgotten and writes nothing', async () => {
    await withHost(async ({ host, ticket, book, topics, released, withdrawn, sql }) => {
      const t = ticket('errand');
      await host.claim(t);
      topics.push('Project Falcon');
      const turns = [{ call: call('search_communication'), output: '{"ok":true,"data":"Mail about project falcon, page 1"}' }];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 1, costUsd: 0 })).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'cancelled', cancel_reason: 'forgotten', checkpoint_json: null, lease_token: null });
      expect(JSON.stringify(sql.exec('SELECT * FROM task_jobs').toArray())).not.toMatch(/project falcon/i);
      expect(released).toHaveLength(1);
      expect(withdrawn).toEqual([`task:${t.jobId}`]);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toBe('fenced');
    });
  });

  it('a checkpoint clear of the held topics is written as usual', async () => {
    await withHost(async ({ host, ticket, book, topics }) => {
      const t = ticket();
      await host.claim(t);
      topics.push('Project Falcon');
      expect(await host.checkpoint(t, 1, [{ call: call('search_communication'), output: 'page 1' }], [], { rounds: 1, costUsd: 0 })).toBe('ok');
      expect(book.get(t.jobId)).toMatchObject({ status: 'running', checkpoint_seq: 1 });
    });
  });

  it('a checkpoint after the step records its result and clears the intent, so a later loss is an ordinary crash', async () => {
    await withHost(async ({ host, ticket, book, clock }) => {
      const t = ticket('errand');
      await host.claim(t);
      await host.tool(t, call('browse_act'), CANARIES);
      const turns = [{ call: call('browse_act'), output: '{"ok":true}' }];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 1, costUsd: 0 })).toBe('ok');
      expect(book.get(t.jobId)!.inflight_json).toBeNull();
      clock.at += 10 * 60_000;
      expect(book.lapse(host.busy())).toEqual([{ id: t.jobId, parked: false }]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'queued', crashes: 1, park_reason: null });
    });
  });

  it('a report after the step clears the intent with the result', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket('errand');
      await host.claim(t);
      await host.tool(t, call('browse_act'), CANARIES);
      const result = { status: 'done' as const, summary: 'Booked nothing; shortlist ready.', findings: [], proposals: [], left: [] };
      expect(await host.report(t, { kind: 'result', result }, [], { rounds: 1, costUsd: 0 })).toBe('accepted');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: null, inflight_json: null });
    });
  });

  it('no provider after an unrecorded step: the job parks as an uncertain effect instead of waiting to run it again', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket('errand');
      await host.claim(t);
      await host.tool(t, call('browse_act'), CANARIES);
      expect(await host.report(t, { kind: 'unavailable' }, [], { rounds: 1, costUsd: 0 })).toBe('parked');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect' });
    });
  });

  it('a handler that throws during an unreplayable step parks the job as an uncertain effect; the worker gets nothing to retry', async () => {
    await withHost(async ({ host, ticket, book, browse, ran }) => {
      const t = ticket('errand');
      await host.claim(t);
      browse.throws = true;
      expect(await host.tool(t, call('browse_act'), CANARIES)).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect' });
      expect(ran).toEqual(['browse_act']);
    });
  });

  it('a read that fails is an ordinary tool failure: nothing was in flight, the job keeps running', async () => {
    await withHost(async ({ host, ticket, book, handler }) => {
      const t = ticket('errand');
      await host.claim(t);
      handler.search = async () => { throw new Error('mail provider down'); };
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: false, error_code: 'handler_failed' });
      expect(book.get(t.jobId)).toMatchObject({ status: 'running', inflight_json: null });
    });
  });

  it('an MCP read\'s output is not kept in the checkpoint, so whatever a connected server returned never persists', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      await host.claim(t);
      const turns = [
        { call: { call_id: 'm1', name: 'read_mcp_tool', arguments: '{"server":"ring","tool":"today","args":{}}' }, output: '{"ok":true,"data":{"output":"synthetic server text"}}' },
        { call: call('search_communication'), output: '{"ok":true,"data":{"hits":2}}' },
      ];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 1, costUsd: 0 })).toBe('ok');
      const kept = JSON.parse(book.get(t.jobId)!.checkpoint_json!).turns as { output: string }[];
      expect(kept.map(turn => turn.output)).toEqual([UNKEPT_OUTPUT, '{"ok":true,"data":{"hits":2}}']);
      expect(book.get(t.jobId)!.checkpoint_json).not.toContain('synthetic server text');
    });
  });

  it('a note on dropped steps riding on an MCP read survives the checkpoint; only the read\'s output is dropped', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      await host.claim(t);
      const note = `${DROPPED_STEPS_NOTE}browse_act {"url":"https://example.com/book"} (already run; do not run it again)]\n\n`;
      const turns = [{ call: { call_id: 'm1', name: 'read_mcp_tool', arguments: '{"server":"ring","tool":"today","args":{}}' }, output: `${note}{"ok":true,"data":{"output":"synthetic server text"}}` }];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 1, costUsd: 0 })).toBe('ok');
      const [kept] = JSON.parse(book.get(t.jobId)!.checkpoint_json!).turns as { output: string }[];
      expect(kept!.output).toBe(`${note}${UNKEPT_OUTPUT}`);
      expect(book.get(t.jobId)!.checkpoint_json).not.toContain('synthetic server text');
    });
  });

  it('a lab-results mail: no checkpoint or result keeps the reading, and the resumed attempt reads the mail again', async () => {
    await withHost(async ({ host, ticket, book, handler, ran }) => {
      const t = ticket();
      handler.search = async () => ({ messages: [{ from: 'lab@clinic.example', subject: 'Your results', body: 'Your LDL is 162 mg/dL and your HbA1c 6.1%. Please book a follow-up.' }] });
      const results = [] as string[];
      const model = (script: readonly Readonly<{ call: string; args: unknown }>[]): TaskModel => {
        let n = 0;
        return async ({ turns }) => {
          const next = script[Math.min(n, script.length - 1)]!;
          n += 1;
          results.push(...turns.map(turn => turn.output));
          return { response: { text: '', tool_calls: [{ call_id: `c${n}:${next.call}`, name: next.call, arguments: JSON.stringify(next.args) }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
        };
      };
      const read = { call: 'search_communication', args: { query: 'from:lab@clinic.example' } };
      // The first slice reads the mail and checkpoints.
      expect(await runTaskAttempt(t, { brain: host, model: model([read]), sliceEnd: 0 })).toBe('continue');
      expect(book.get(t.jobId)!.checkpoint_json).not.toMatch(/162|6\.1/);
      expect(JSON.parse(book.get(t.jobId)!.checkpoint_json!).turns[0].output).toBe(UNKEPT_OUTPUT);
      // The next slice reads the mail again, then tries a result with the reading in it, which is refused, then one in words.
      const numbers = { status: 'done', summary: 'Your LDL is 162 mg/dL and your HbA1c 6.1%.', findings: [{ text: 'LDL 162 mg/dL', source_ref: 'gmail:lab' }], proposals: [], left: [] };
      const words = { status: 'done', summary: 'Your lab results came in: cholesterol is above the usual range, and the clinic asks you to book a follow-up.', findings: [{ text: 'The clinic sent your lab results and asks for a follow-up.', source_ref: 'gmail:lab' }], proposals: [], left: [] };
      expect(await runTaskAttempt(t, { brain: host, model: model([read, { call: FINISH_TASK, args: numbers }, { call: FINISH_TASK, args: words }]), sliceEnd: Date.now() + 60_000 })).toBe('reported');
      expect(ran).toEqual(['search_communication', 'search_communication']);
      expect(results.some(output => output.includes('162 mg/dL') && output.startsWith('{"ok":true'))).toBe(true);
      expect(results.some(output => output.includes('health readings') && output.includes('in words'))).toBe(true);
      const row = book.get(t.jobId)!;
      expect(row).toMatchObject({ status: 'reported', outcome: 'done' });
      expect(row.result_json).not.toMatch(/162|6\.1/);
      expect(JSON.parse(row.result_json!)).toEqual(words);
      expect(row.checkpoint_json).not.toMatch(/162|6\.1/);
      // The refused result's call carried the reading: its arguments are not kept either.
      expect(JSON.parse(row.checkpoint_json!).turns.at(-1)).toMatchObject({ call: { name: FINISH_TASK, arguments: '{}' }, output: UNKEPT_OUTPUT });
    });
  });

  it('an errand step whose output carries a reading is not kept, and is never offered to run again', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket('errand');
      await host.claim(t);
      const turns = [{ call: call('browse_act'), output: '{"ok":true,"data":{"page":"Booked. Your pulse at check-in: 88 bpm."}}' }];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 1, costUsd: 0 })).toBe('ok');
      const [kept] = JSON.parse(book.get(t.jobId)!.checkpoint_json!).turns as { output: string }[];
      expect(kept!.output).toBe(UNKEPT_EFFECT);
    });
  });

  it('a reading in the provider items riding on a round is not kept: the round is rebuilt from its kept records on resume', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      await host.claim(t);
      const reading = JSON.stringify({ status: 'done', summary: 'Your LDL is 162 mg/dL.', findings: [], proposals: [], left: [] });
      const clean = JSON.stringify({ query: 'from:lab' });
      const turns = [
        // An earlier round with no reading keeps its items, encrypted reasoning included, so its replay is unchanged.
        { call: { call_id: 'c0', name: 'search_communication', arguments: clean }, output: '{"ok":true,"data":{"hits":1}}',
          prior_items: [{ type: 'reasoning', id: 'rs_0', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'search_communication', arguments: clean }] },
        // The reading sits in a reasoning summary, the model's interim words and a parallel call's arguments.
        { call: { call_id: 'c1', name: 'search_communication', arguments: clean }, output: '{"ok":true,"data":{"hits":0}}',
          prior_items: [
            { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'The mail says LDL is 162 mg/dL; I will report it.' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Your LDL is 162 mg/dL; finishing.' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'search_communication', arguments: clean },
            { type: 'function_call', id: 'fc_2', call_id: 'c2', name: FINISH_TASK, arguments: reading },
          ] },
        { call: { call_id: 'c2', name: FINISH_TASK, arguments: reading }, output: '{"ok":false,"error":"The result names health readings with their numbers, which a task never stores."}' },
      ];
      expect(await host.checkpoint(t, 1, turns, [], { rounds: 2, costUsd: 0 })).toBe('ok');
      const stored = book.get(t.jobId)!.checkpoint_json!;
      expect(stored).not.toMatch(/162/);
      const kept = JSON.parse(stored).turns as Array<{ call: { arguments: string }; prior_items?: unknown[] }>;
      expect(kept[0]!.prior_items).toEqual(turns[0]!.prior_items);
      // Emptied, not removed: the turn still opens its own round, so the resumed request keeps the round boundaries.
      expect(kept[1]!.prior_items).toEqual([]);
      expect(kept[1]!.call.arguments).toBe(clean);
      expect(kept[2]).toMatchObject({ call: { arguments: '{}' } });
      expect(kept[2]).not.toHaveProperty('prior_items');
    });
  });

  it('end to end, a refused result with a reading is not kept once the provider returns its items with the call', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      const numbers = { status: 'done', summary: 'Your LDL is 162 mg/dL.', findings: [], proposals: [], left: [] };
      const words = { status: 'done', summary: 'Your cholesterol is above the usual range.', findings: [], proposals: [], left: [] };
      let n = 0;
      // The OpenAI adapter's shape: output_items is the response output, which holds each function_call with its arguments.
      const model: TaskModel = async () => {
        n += 1;
        const args = JSON.stringify(n === 1 ? numbers : words);
        return { response: { text: '', tool_calls: [{ call_id: `c${n}`, name: FINISH_TASK, arguments: args }], output_items: [{ type: 'function_call', call_id: `c${n}`, name: FINISH_TASK, arguments: args }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
      };
      expect(await runTaskAttempt(t, { brain: host, model, sliceEnd: 0 })).toBe('continue');
      const stored = book.get(t.jobId)!.checkpoint_json!;
      expect(JSON.parse(stored).turns[0].call.arguments).toBe('{}');
      expect(stored).not.toMatch(/162/);
    });
  });

  it('an errand step that already succeeded is refused when repeated, in the same slice and after a resume', async () => {
    const act = { call: 'browse_act', args: { url: 'https://example.com/book', task: 'Book the 8pm table for two.', command: { operation: 'click', element_ref: 'e1', intent: 'read' } } };
    const other = { call: 'browse_act', args: { url: 'https://example.com/book', task: 'Add a note: window seat.', command: { operation: 'click', element_ref: 'e2', intent: 'read' } } };
    const finish = { call: FINISH_TASK, args: { status: 'done', summary: 'Booked.', findings: [], proposals: [], left: [] } };
    const model = (script: readonly Readonly<{ call: string; args: unknown }>[]): TaskModel => {
      let n = 0;
      return async () => {
        const next = script[Math.min(n, script.length - 1)]!;
        n += 1;
        return { response: { text: '', tool_calls: [{ call_id: `c${n}:${next.call}`, name: next.call, arguments: JSON.stringify(next.args) }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
      };
    };
    await withHost(async ({ host, ticket, ran }) => {
      const t = ticket('errand');
      expect(await runTaskAttempt(t, { brain: host, model: model([act, act, finish]), sliceEnd: Date.now() + 60_000 })).toBe('reported');
      expect(ran.filter(name => name === 'browse_act')).toHaveLength(1);
    });
    // Across an alarm-slice hand-over, the repeat is answered from the checkpoint; a different step still runs.
    await withHost(async ({ host, ticket, ran }) => {
      const t = ticket('errand');
      expect(await runTaskAttempt(t, { brain: host, model: model([act]), sliceEnd: 0 })).toBe('continue');
      expect(await runTaskAttempt(t, { brain: host, model: model([act, other, finish]), sliceEnd: Date.now() + 60_000 })).toBe('reported');
      expect(ran.filter(name => name === 'browse_act')).toHaveLength(2);
    });
  });

  it('a resumed errand step whose result was cleared as succeeded, or left out, is not run again', async () => {
    const args = JSON.stringify({ url: 'https://example.com/book', task: 'Book the 8pm table for two.' });
    for (const output of [clearedToolResult('browse_act', { ok: true, receipt: null, repeatable: false }), UNKEPT_EFFECT]) {
      await withHost(async ({ host, ticket, ran }) => {
        const t = ticket('errand');
        await host.claim(t);
        expect(await host.checkpoint(t, 1, [{ call: { call_id: 'c1', name: 'browse_act', arguments: args }, output }], [], { rounds: 1, costUsd: 0 })).toBe('ok');
        let n = 0;
        const model: TaskModel = async () => {
          n += 1;
          const call = n === 1 ? { name: 'browse_act', arguments: args } : { name: FINISH_TASK, arguments: JSON.stringify({ status: 'done', summary: 'Booked.', findings: [], proposals: [], left: [] }) };
          return { response: { text: '', tool_calls: [{ call_id: `r${n}`, ...call }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
        };
        expect(await runTaskAttempt(t, { brain: host, model, sliceEnd: Date.now() + 60_000 })).toBe('reported');
        expect(ran).toEqual([]);
      });
    }
  });

  it('a resumed errand step whose arguments were not kept (a reading) is not run again; a step without a reading still runs', async () => {
    const withReading = { url: 'https://example.com/clinic', task: 'Book the follow-up; pulse at check-in was 88 bpm.', command: { operation: 'click', element_ref: 'e1', intent: 'read' } };
    const plain = { url: 'https://example.com/clinic', task: 'Add the owner\'s phone number to the booking.', command: { operation: 'click', element_ref: 'e1', intent: 'read' } };
    await withHost(async ({ host, ticket, ran, book }) => {
      const t = ticket('errand');
      let n = 0;
      const script = [withReading, withReading, plain];
      const model = (steps: readonly unknown[]): TaskModel => async () => {
        const step = steps[n];
        n += 1;
        const call = step === undefined ? { name: FINISH_TASK, arguments: JSON.stringify({ status: 'done', summary: 'Booked.', findings: [], proposals: [], left: [] }) } : { name: 'browse_act', arguments: JSON.stringify(step) };
        return { response: { text: '', tool_calls: [{ call_id: `c${n}`, ...call }] }, event: { trace: 'task:x', hop: 'llm_task', ms: 1, ok: true } };
      };
      expect(await runTaskAttempt(t, { brain: host, model: model(script), sliceEnd: 0 })).toBe('continue');
      expect(JSON.parse(book.get(t.jobId)!.checkpoint_json!).turns[0]).toMatchObject({ call: { arguments: '{}' }, output: UNKEPT_EFFECT });
      expect(await runTaskAttempt(t, { brain: host, model: model(script), sliceEnd: Date.now() + 60_000 })).toBe('reported');
      expect(ran.filter(name => name === 'browse_act')).toHaveLength(2);
    });
  });

  it('a result that still carries a reading when it reaches the brain is not stored; the owner hears it was not kept', async () => {
    await withHost(async ({ host, ticket, book }) => {
      const t = ticket();
      await host.claim(t);
      expect(await host.report(t, { kind: 'result', result: { status: 'done', summary: 'Your LDL is 162 mg/dL.', findings: [], proposals: [], left: [] } }, [], { rounds: 1, costUsd: 0 })).toBe('accepted');
      const row = book.get(t.jobId)!;
      expect(row.result_json).not.toContain('162');
      expect(JSON.parse(row.result_json!)).toMatchObject({ status: 'partial', findings: [], proposals: [] });
    });
  });

  it('a stale ticket from a lapsed attempt rejoining leaves the live attempt\'s call alone', async () => {
    await withHost(async ({ host, ticket, book, clock, hold, ran, log }) => {
      const t1 = ticket('errand');
      await host.claim(t1);
      clock.at += 10 * 60_000;
      book.lapse(new Set());
      const t2 = book.startAttempt(t1.jobId)!;
      expect(t2.attempt).toBe(2);
      expect(await host.claim(t2)).not.toBe('fenced');
      let release!: () => void;
      hold.waiting = new Promise<void>(resolve => { release = resolve; });
      const live = host.tool(t2, call('browse_act'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await host.claim(t1)).toBe('fenced');
      release();
      expect(await live).not.toBe('fenced');
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
      expect(book.get(t1.jobId)).toMatchObject({ status: 'running', attempt: 2 });
      expect(log.some(entry => entry.hop === 'task_rejoin_fenced')).toBe(false);
    });
  });

  it('a rejoin of the same attempt while its browser step waits in the serial lane fences both: the step never runs twice', async () => {
    await withHost(async ({ host, ticket, book, hold, ran, log }) => {
      const t = ticket('errand');
      await host.claim(t);
      let release!: () => void;
      hold.waiting = new Promise<void>(resolve => { release = resolve; });
      const queued = host.tool(t, call('browse_act'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(await host.claim(t)).toBe('fenced');
      expect(log.some(entry => entry.hop === 'task_rejoin_fenced')).toBe(true);
      const second = host.tool(t, call('browse_act'), CANARIES);
      release();
      expect(await queued).toBe('fenced');
      expect(await second).toBe('fenced');
      expect(ran).toEqual([]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'queued', crashes: 1, lease_token: null, inflight_json: null });
    });
  });

  it('a rejoin of the same attempt while the directory is still being asked fences both: the step never runs twice', async () => {
    await withHost(async ({ host, ticket, book, ran, log, admission }) => {
      const t = ticket('errand');
      await host.claim(t);
      let admit!: () => void;
      admission.waiting = new Promise<void>(resolve => { admit = resolve; });
      const asking = host.tool(t, call('browse_act'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      const rejoined = await host.claim(t);
      const rejoinFenced = log.some(entry => entry.hop === 'task_rejoin_fenced');
      expect({ rejoined, rejoinFenced }).toEqual({ rejoined: 'fenced', rejoinFenced: true });
      const second = host.tool(t, call('browse_act'), CANARIES);
      admit();
      expect(await asking).toBe('fenced');
      expect(await second).toBe('fenced');
      expect(ran).toEqual([]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'queued', crashes: 1, lease_token: null, inflight_json: null });
    });
  });

  it('a call the directory turned away or could not answer leaves the attempt free to rejoin: nothing stays busy', async () => {
    await withHost(async ({ host, ticket, book, admission }) => {
      const t = ticket('errand');
      await host.claim(t);
      admission.now = 'retry';
      expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: false, retryable: true });
      expect(host.busy().has(t.jobId)).toBe(false);
      expect(book.lapse(host.busy())).toEqual([]);
      admission.now = 'admitted';
      expect(await host.claim(t)).not.toBe('fenced');
      expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
    });
    await withHost(async ({ host, ticket, book, admission }) => {
      const t = ticket('errand');
      await host.claim(t);
      admission.now = 'dormant';
      expect(await host.tool(t, call('browse_act'), CANARIES)).toBe('fenced');
      admission.now = 'admitted';
      const next = book.startAttempt(t.jobId)!;
      expect(await host.claim(next)).not.toBe('fenced');
      expect(host.busy().has(t.jobId)).toBe(false);
      expect(await host.tool(next, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
    });
  });

  it('a rejoin while the step is running parks the job as an uncertain effect, and the running step returns nothing', async () => {
    await withHost(async ({ host, ticket, book, browse, ran }) => {
      const t = ticket('errand');
      await host.claim(t);
      browse.ms = 30;
      const running = host.tool(t, call('browse_act'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(await host.claim(t)).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect', lease_token: null });
      expect(await running).toBe('fenced');
      expect(ran).toEqual(['browse_act', 'browse_act:done']);
    });
  });

  it('an old attempt\'s slow read still running in the brain does not fence the fresh attempt that replaces it', async () => {
    await withHost(async ({ host, ticket, book, handler }) => {
      const t1 = ticket('reader');
      await host.claim(t1);
      let release!: () => void;
      handler.search = () => new Promise(resolve => { release = () => resolve({ hits: 1 }); });
      const slow = host.tool(t1, call('search_communication'), CANARIES);
      await new Promise(resolve => setTimeout(resolve, 5));
      // The worker's alarm re-fires while it waits on that read: the attempt ends, as designed.
      expect(await host.claim(t1)).toBe('fenced');
      expect(book.get(t1.jobId)).toMatchObject({ status: 'queued', crashes: 1 });
      expect(host.busy().has(t1.jobId)).toBe(false);
      const t2 = book.startAttempt(t1.jobId)!;
      expect(await host.claim(t2)).not.toBe('fenced');
      // The old call still in flight is not the live attempt's, so it does not hold the new attempt's lease open.
      expect(host.busy().has(t1.jobId)).toBe(false);
      release();
      expect(await slow).toBe('fenced');
      expect(book.get(t1.jobId)).toMatchObject({ status: 'running', attempt: 2, crashes: 1 });
    });
  });

  it('a worker call for an owner the directory no longer admits runs nothing; the job waits in the queue, not counted as a crash', async () => {
    await withHost(async ({ host, ticket, book, ran, released, log, admission }) => {
      const t = ticket('errand');
      await host.claim(t);
      admission.now = 'dormant';
      expect(await host.tool(t, call('browse_act'), CANARIES)).toBe('fenced');
      expect(ran).toEqual([]);
      expect(released).toHaveLength(1);
      expect(book.get(t.jobId)).toMatchObject({ status: 'queued', crashes: 0, lease_token: null, inflight_json: null });
      expect(log.find(entry => entry.hop === 'task_suspended')).toMatchObject({ ok: false, code: 'owner_not_admitted' });
      // Admitted again, the lane's next attempt resumes it.
      admission.now = 'admitted';
      const next = book.startAttempt(t.jobId)!;
      expect(await host.claim(next)).not.toBe('fenced');
      expect(await host.tool(next, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
    });
  });

  it('a worker call when the directory cannot be asked runs nothing and is told to try again; the attempt keeps running', async () => {
    for (const answer of ['retry', 'throws'] as const) {
      await withHost(async ({ host, ticket, book, ran, admission }) => {
        const t = ticket('errand');
        await host.claim(t);
        admission.now = answer;
        expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: false, retryable: true, code: 'transient' });
        expect(ran).toEqual([]);
        expect(book.get(t.jobId)).toMatchObject({ status: 'running', attempt: 1, inflight_json: null });
      });
    }
  });

  it('suspending an owner\'s running jobs requeues each attempt, and parks one whose effect was in flight', async () => {
    await withHost(async ({ book, ticket }) => {
      const quiet = ticket('reader'), acting = ticket('errand');
      expect(book.beginEffect(acting, { tool: 'browse_act', call_id: 'c1' })).toBe(true);
      expect([...book.suspend()].sort()).toEqual([quiet.jobId, acting.jobId].sort());
      expect(book.get(quiet.jobId)).toMatchObject({ status: 'queued', crashes: 0, lease_token: null });
      expect(book.get(acting.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect' });
      expect(book.suspend()).toEqual([]);
    });
  });

  it('a worker rejoining past its job\'s deadline is parked as out of time, and the trace says so', async () => {
    await withHost(async ({ host, ticket, book, clock, log }) => {
      const t = ticket('reader');
      clock.at = book.get(t.jobId)!.deadline_at + 60 * 60_000;
      expect(await host.claim(t)).toBe('fenced');
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'deadline' });
      expect(log.find(entry => entry.hop === 'task_parked')).toMatchObject({ code: 'deadline' });
    });
  });

  it('a busy job past its deadline still ends: its running call is then fenced', async () => {
    await withHost(async ({ ticket, book, clock }) => {
      const t = ticket('errand');
      clock.at += 2 * 3_600_000;
      expect(book.lapse(new Set([t.jobId]))).toEqual([{ id: t.jobId, parked: true }]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'deadline' });
    });
  });

  it('a cancel withdraws the cards its errand raised and fences the attempt; a report leaves them for the owner', async () => {
    await withHost(async ({ host, ticket, book, withdrawn, released }) => {
      const t = ticket('errand');
      await host.claim(t);
      expect(book.cancel(t.jobId, 'owner')).toBe(true);
      host.cancelled(t.jobId);
      expect(withdrawn).toEqual([`task:${t.jobId}`]);
      expect(released).toHaveLength(1);
      const reported = ticket('errand');
      await host.claim(reported);
      await host.report(reported, { kind: 'result', result: { status: 'done', summary: 'A card waits for you.', findings: [], proposals: [], left: [] } }, [], { rounds: 1, costUsd: 0 });
      expect(withdrawn).toEqual([`task:${t.jobId}`]);
    });
  });

  it('an owner message during an errand waits for one browser step at most: the lane yields between steps', async () => {
    await withHost(async ({ host, ticket, ran, serial, browse }) => {
      const t = ticket('errand');
      await host.claim(t);
      browse.ms = 40;
      const errand = (async () => {
        await host.tool(t, call('browse_act'), CANARIES);
        await host.tool(t, call('browse_act'), CANARIES);
      })();
      await new Promise(resolve => setTimeout(resolve, 10));
      const asked = Date.now();
      const answered = await serial(async () => { ran.push('owner_turn'); return Date.now(); });
      await errand;
      expect(ran).toEqual(['browse_act', 'browse_act:done', 'owner_turn', 'browse_act', 'browse_act:done']);
      expect(answered - asked).toBeLessThan(browse.ms * 2);
    });
  });

  it('an attempt lost while an unreplayable step ran parks as an uncertain effect at once, never re-run blind', async () => {
    await withHost(async ({ ticket, book, clock }) => {
      const t = ticket('errand');
      expect(book.beginEffect(t, { tool: 'browse_act', call_id: 'c1' })).toBe(true);
      clock.at += 10 * 60_000;
      expect(book.lapse(new Set())).toEqual([{ id: t.jobId, parked: true }]);
      expect(book.get(t.jobId)).toMatchObject({ status: 'reported', park_reason: 'uncertain_effect', crashes: 1 });
    });
  });

  it('past the spend ceiling a worker is clamped at claim and its paid tools are held, counted as worker spend', async () => {
    await withHost(async ({ host, ticket, setSpend, log, ran }) => {
      setSpend({ spentUsd: 26, ceilingUsd: 25 });
      const t = ticket('errand');
      const claim = await host.claim(t);
      expect(claim === 'fenced' ? null : claim.spend).toEqual({ spentUsd: 26, ceilingUsd: 25 });
      const held = await host.tool(t, call('browse_act'), CANARIES);
      expect(held).toMatchObject({ ok: false, error_code: 'spend_ceiling_reached' });
      expect(ran).toEqual([]);
      expect(log.find(entry => entry.hop === 'spend_hold')).toMatchObject({ cost_kind: 'worker', code: 'spend_ceiling_reached:browse_act', job_id: t.jobId });
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: true });
    });
  });

  it('when the owner\'s spend cannot be read, a worker is held at the ceiling, and the brain warns once until a read works again', async () => {
    await withHost(async ({ host, ticket, setSpend, log, ran }) => {
      setSpend('throws');
      const t = ticket('errand');
      const claim = await host.claim(t);
      const spend = claim === 'fenced' ? null : claim.spend;
      expect(spend!.spentUsd).toBeGreaterThanOrEqual(spend!.ceilingUsd);
      expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: false, error_code: 'spend_ceiling_reached' });
      expect(ran).toEqual([]);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: true });
      const warned = () => log.filter(entry => entry.hop === 'task_spend_unread');
      expect(warned()).toEqual([expect.objectContaining({ ok: false, code: 'spend_unreadable' })]);
      setSpend({ spentUsd: 1, ceilingUsd: 25 });
      expect(await host.tool(t, call('browse_act'), CANARIES)).toMatchObject({ ok: true });
      setSpend('throws');
      await host.tool(t, call('search_communication'), CANARIES);
      expect(warned()).toHaveLength(2);
    });
  });

  it('a worker\'s claim carries the owner\'s breaker, and the provider outcomes it sends back are replayed into it in order', async () => {
    await withHost(async ({ host, ticket, health }) => {
      const spend = { rounds: 1, costUsd: 0 };
      const fail = { provider: 'openai', ok: false } as const, served = { provider: 'openai', ok: true } as const;
      health.recordFailure('openai');
      const t = ticket();
      const claim = await host.claim(t);
      expect(claim === 'fenced' ? null : claim.providerHealth).toEqual([{ provider: 'openai', failures: 1, opened_at: null }]);
      // In order: the success clears the first failure, so one failure is left, not three.
      expect(await host.checkpoint(t, 1, [], [], spend, [fail, served, fail])).toBe('ok');
      expect(health.snapshot()).toEqual([{ provider: 'openai', failures: 1, opened_at: null }]);
      // A stale checkpoint (a sequence already written) is not replayed.
      expect(await host.checkpoint(t, 1, [], [], spend, [fail, fail])).toBe('stale');
      expect(health.snapshot()).toEqual([{ provider: 'openai', failures: 1, opened_at: null }]);
      // The unavailable report is the one that matters most: it carries the misses that ended the attempt.
      expect(await host.report(t, { kind: 'unavailable' }, [], spend, [fail, fail])).toBe('deferred');
      expect(health.isOpen('openai')).toBe(true);
      // A late report from the attempt that already ended is fenced, and its outcomes are not replayed.
      expect(await host.report(t, { kind: 'unavailable' }, [], spend, [served])).toBe('fenced');
      expect(health.isOpen('openai')).toBe(true);
    });
  });

  it('a late call from an attempt the brain fenced changes nothing', async () => {
    await withHost(async ({ host, ticket, book, ran }) => {
      const t = ticket();
      await host.claim(t);
      book.cancel(t.jobId, 'owner');
      expect(await host.claim(t)).toBe('fenced');
      expect(await host.tool(t, call('search_communication'), CANARIES)).toBe('fenced');
      expect(await host.checkpoint(t, 1, [], [], { rounds: 1, costUsd: 0 })).toBe('fenced');
      expect(await host.report(t, { kind: 'result', result: { status: 'done', summary: 'x', findings: [], proposals: [], left: [] } }, [], { rounds: 0, costUsd: 0 })).toBe('fenced');
      expect(await host.heartbeat(t)).toBe(false);
      expect(ran).toEqual([]);
    });
  });
});

// Every profile against every tool a worker must never hold: a worker cannot reach the owner, approve or propose for them,
// write or read their memory, hand work on, start or stop tasks, or read health. Read from the tool records, so a tool added
// to one of those groups is covered without editing this list.
describe('task profiles', () => {
  const names = Object.keys(TOOL_RECORDS) as ToolName[];
  const forbidden: Readonly<Record<string, readonly ToolName[]>> = {
    send: names.filter(name => name.startsWith('send_') || name === 'attach_file'),
    approve: ['propose_action', 'raise_approval', 'execute_action', 'propose_calendar_change', 'propose_google_task_change', 'propose_schedule'],
    memory: [...names.filter(name => TOOL_RECORDS[name].brain === 'memory'), 'read_memory', 'remember'],
    delegation: ['delegate_task', 'use_mac'],
    tasks: ['start_task', 'cancel_task'],
    health: [...names.filter(name => TOOL_RECORDS[name].brain === 'health'), 'get_health'],
  };

  // Whatever list a tool is missing from, a profile can only read: every tool a worker holds is a safe read, except the
  // browser's act step (it stops before a submit, which becomes an owner card) and the code profile's refused tool.
  const MAY_ACT: readonly ToolName[] = ['browse_act', 'execute_code'];
  it.each(Object.keys(TASK_PROFILE_SPECS) as (keyof typeof TASK_PROFILE_SPECS)[])('%s holds only safe reads, beside the browser act step', (profile) => {
    expect(TASK_PROFILE_SPECS[profile].tools.filter(tool => !MAY_ACT.includes(tool) && TOOL_RECORDS[tool].replay.replay !== 'safe_read')).toEqual([]);
  });

  it.each(Object.keys(TASK_PROFILE_SPECS) as (keyof typeof TASK_PROFILE_SPECS)[])('%s holds no send, approve, memory, delegation, task or health tool', (profile) => {
    for (const [group, tools] of Object.entries(forbidden)) {
      expect(tools.length, group).toBeGreaterThan(0);
      expect(TASK_PROFILE_SPECS[profile].tools.filter(tool => tools.includes(tool)), `${profile} ∩ ${group}`).toEqual([]);
    }
  });
});
