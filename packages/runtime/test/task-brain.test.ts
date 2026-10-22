import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PERMISSIONS, triggerTypeSchema, type ToolName } from '@waldo/contracts';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';
import { taskHost, UNKEPT_OUTPUT, type TaskHostDeps } from '../src/tasks/brain';
import { jobBook, type JobBook, type TaskBrief, type TaskTicket } from '../src/tasks/jobs';
import { TASK_PROFILE_SPECS } from '../src/tasks/profiles';
import { TOOL_RECORDS } from '../src/tools/records';

// The brain's side of the job protocol over the real job book: every worker call is checked against its ticket, the
// profile's tools are enforced here, and a cancel reaches a call that is already running.
const T0 = 1_800_000_000_000;
const brief: TaskBrief = { title: 'Book a table', goal: 'Find a table for two tonight.', context: 'Near Bandra.', done_when: 'A shortlist.', effort: 'standard', timezone: 'UTC', started_at: T0 };
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const CANARIES = ['a1b2c3d4e5f60718', '1a2b3c4d5e6f7081', 'f0e1d2c3b4a59687'];
const VALID_ARGS: Record<string, unknown> = { search_communication: { query: 'from:client' }, browse_act: { url: 'https://example.com/book', task: 'Find a table for two at 8pm.' } };
const call = (name: string) => ({ call_id: `c-${name}`, name, arguments: JSON.stringify(VALID_ARGS[name] ?? {}) });

type Harness = Readonly<{
  book: JobBook; sql: SqlStorage; clock: { at: number }; host: ReturnType<typeof taskHost>; log: TurnLogEntry[]; released: RunEffectScope[]; ran: string[]; withdrawn: string[];
  ticket(profile?: 'reader' | 'errand'): TaskTicket; setSpend(spend: { spentUsd: number; ceilingUsd: number } | undefined): void;
  hold: { release?: () => void; waiting?: Promise<void> };
  // The owner object's serial queue, as OwnerDO.serial() runs it: one unit at a time, in arrival order.
  serial<T>(work: () => Promise<T>): Promise<T>;
  browse: { ms: number; throws?: boolean };
  handler: { search?: (ctx: ToolDispatcherContext) => Promise<unknown> };
}>;
let seq = 0;
const withHost = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`task-brain-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const clock = { at: T0 };
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const log: TurnLogEntry[] = [], released: RunEffectScope[] = [], ran: string[] = [], withdrawn: string[] = [];
    let spend: { spentUsd: number; ceilingUsd: number } | undefined;
    const hold: Harness['hold'] = {};
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T,>(work: () => Promise<T>): Promise<T> => { const run = queue.then(work); queue = run.catch(() => undefined); return run; };
    const browse: Harness['browse'] = { ms: 0 };
    const handler: Harness['handler'] = {};
    const handlers = [
      { name: 'search_communication', description: 'Search mail.', schema: z.object({ query: z.string() }), trigger_allowlist: allowlist('search_communication'), autonomy_gated: false, mutates_state: false,
        async handle(_args: unknown, ctx: ToolDispatcherContext) { ran.push('search_communication'); return { ok: true as const, data: await (handler.search?.(ctx) ?? { hits: 2 }), source_taint: 'external' as const }; } },
      { name: 'browse_act', description: 'Act in the browser.', schema: z.object({ url: z.string(), task: z.string() }).loose(), trigger_allowlist: allowlist('browse_act'), autonomy_gated: false, mutates_state: true,
        async handle() { ran.push('browse_act'); if (browse.ms) await new Promise(resolve => setTimeout(resolve, browse.ms)); if (browse.throws) throw new Error('vendor dropped the session'); ran.push('browse_act:done'); return { ok: true as const, data: { done: true }, source_taint: 'external' as const }; } },
    ] as unknown as ReturnType<TaskHostDeps['handlers']>;
    const host = taskHost({
      book, now: () => clock.at, handlers: () => handlers, context: () => ({ authenticatedUserId: 'owner-1', sanitise, egressAllowlist: ['example.com'] }),
      serialBrowser: (_scope, run) => serial(async () => { if (hold.waiting) await hold.waiting; return run(); }),
      releaseBrowser: scope => { released.push(scope); }, log: entry => { log.push(entry); }, spend: () => spend, wake: async () => undefined, withdrawCards: runRef => { withdrawn.push(runRef); },
    });
    const ticket = (profile: 'reader' | 'errand' = 'reader') => {
      const { job } = book.create({ kind: 'task', profile, idempotencyKey: `k${n += 1}`, origin: 'tg-1', surface: 'app', brief, dueAt: T0, deadlineAt: T0 + 3_600_000 });
      return book.startAttempt(job.id)!;
    };
    return work({ book, sql: state.storage.sql, clock, host, log, released, ran, withdrawn, serial, browse, ticket, setSpend: next => { spend = next; }, hold, handler });
  });

describe('the task brain host', () => {
  it('a reader job is offered only reader tools, and a call outside its profile is refused without running', async () => {
    await withHost(async ({ host, ticket, ran }) => {
      const t = ticket('reader');
      const claim = await host.claim(t);
      expect(claim === 'fenced' ? [] : claim.tools.map(tool => tool.name)).toEqual(['search_communication']);
      const refused = await host.tool(t, call('browse_act'), CANARIES);
      expect(refused).toMatchObject({ ok: false, error_code: 'acl_denied', code: 'rejected' });
      expect(ran).toEqual([]);
      expect(await host.tool(t, call('search_communication'), CANARIES)).toMatchObject({ ok: true, source_taint: 'external' });
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
