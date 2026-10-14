import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { responsibilityBook } from '../src/channels/responsibilities';
import { attemptJournal } from '../src/channels/tasks/attempts';
import { ownerTasks } from '../src/channels/tasks/step-runner';
import { gateTraceEntry } from '../src/observability/trace-privacy';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { noteDispatch, watchEffects } from '../src/tools/dispatch-watch';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { model.calls++; return { id: 'fixture', output: [], output_text: 'Done.', usage: { input_tokens: 1, output_tokens: 1 } }; } }; } }));

let sequence = 0;
const withState = <T>(work: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`task-steps-unit-${sequence++}`)), (_instance, state) => work(state));
const counter = () => { let n = 0; return { newId: () => String(++n), now: () => 1_000 + n }; };

describe('the task step trace hop', () => {
  it('keeps ids, the attempt and the effect flag with capture off, and drops anything else', () => {
    const hop = { trace: 'task:a1', hop: 'task_step', ms: 4, ok: false, code: 'uncertain', responsibility_id: 'r1', error: 'provider said Hall A', text: { input: 'Hall A', output: 'Hall A' } };
    expect(gateTraceEntry({ ...hop, detail: 'item=i0b1c-22 attempt=2 effects_dispatched=1' }, false))
      .toMatchObject({ detail: 'item=i0b1c-22 attempt=2 effects_dispatched=1', code: 'uncertain', error: undefined, text: undefined });
    for (const detail of ['item=i1 attempt=2 effects_dispatched=1 Hall A', 'item=Hall attempt=2 effects_dispatched=1', 'item=i1 attempt=0 effects_dispatched=1', 'item=i1 attempt=2 effects_dispatched=2']) {
      expect(gateTraceEntry({ ...hop, detail }, false).detail).toBeUndefined();
    }
  });
});

describe('the dispatch watch', () => {
  it('fires for a tool that may act, before it runs, and only for the watched turn', () => {
    const seen: string[] = [];
    const unwatch = watchEffects('task:a1', () => seen.push('effect'));
    noteDispatch('task:a1', 'web_search');
    noteDispatch('task:a1', 'get_context');
    expect(seen).toEqual([]);
    noteDispatch('task:other', 'track_responsibility');
    noteDispatch(undefined, 'track_responsibility');
    expect(seen).toEqual([]);
    noteDispatch('task:a1', 'track_responsibility');
    noteDispatch('task:a1', 'send_email');
    expect(seen).toEqual(['effect', 'effect']);
    unwatch();
    noteDispatch('task:a1', 'send_email');
    expect(seen).toHaveLength(2);
  });
});

describe('the responsibility book for steps', () => {
  const three = { title: 'Offsite', intent: 'Hold a venue', next_check_at: null, items: [
    { title: 'research', owner: 'waldo' as const, depends_on: [] },
    { title: 'owner picks', owner: 'owner' as const, depends_on: [] },
    { title: 'hold it', owner: 'waldo' as const, depends_on: [0, 1] },
  ] };

  it("offers Waldo's pending steps whose dependencies are done, in an open responsibility only", () => withState((state) => {
    const book = responsibilityBook(state.storage.sql, counter());
    const { responsibility, items } = book.track(three, 'test');
    expect(book.runnable(responsibility.id).map((item) => item.title)).toEqual(['research']);
    book.update({ item_id: items[0]!.id, status: 'done' });
    expect(book.runnable(responsibility.id)).toEqual([]);
    book.update({ item_id: items[1]!.id, status: 'done' });
    expect(book.runnable(responsibility.id).map((item) => item.title)).toEqual(['hold it']);
    expect(book.markUncertain(responsibility.id)).toBe(true);
    expect(book.get(responsibility.id)!.status).toBe('uncertain');
    expect(book.markUncertain(responsibility.id)).toBe(false);
    expect(book.runnable(responsibility.id)).toEqual([]);
  }));

  it('dropping cancels and fences the unfinished steps; closing as done leaves them', () => withState((state) => {
    const book = responsibilityBook(state.storage.sql, counter());
    const dropped = book.track(three, 'test');
    book.update({ item_id: dropped.items[0]!.id, status: 'done' });
    const running = book.start(dropped.items[1]!.id, 'worker:test')!;
    expect(book.close({ id: dropped.responsibility.id, outcome: 'dropped', evidence_ref: 'owner: not needed' })).toBe(true);
    expect(book.items(dropped.responsibility.id).map((item) => item.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(book.finishWorker(dropped.items[1]!.id, running.revision, { status: 'done', result: 'late' })).toBe('superseded');
    expect(book.item(dropped.items[1]!.id)).toMatchObject({ status: 'cancelled', superseded_result: 'late' });
    const done = book.track(three, 'test');
    expect(book.close({ id: done.responsibility.id, outcome: 'done', evidence_ref: 'owner: all set' })).toBe(true);
    expect(book.items(done.responsibility.id).map((item) => item.status)).toEqual(['pending', 'pending', 'pending']);
  }));
});

describe('the step journal', () => {
  it('settles an attempt once and counts attempts per revision', () => withState((state) => {
    const journal = attemptJournal(state.storage.sql, counter());
    const first = journal.begin('i1', 2, 1, null);
    journal.markEffects(first.id);
    expect(journal.settle(first.id, 'uncertain', 'failed after an effect')).toBe(true);
    expect(journal.settle(first.id, 'done', 'completed')).toBe(false);
    journal.begin('i1', 3, 1, null);
    expect(journal.attempts('i1', 2).map((attempt) => [attempt.status, attempt.effects_dispatched])).toEqual([['uncertain', 1]]);
    expect(journal.attempts('i1', 3).map((attempt) => attempt.status)).toEqual(['running']);
  }));
});

describe("the runner's tools", () => {
  it("a runner's step marked done by hand lets the steps waiting on it go; a hand change takes its own attempt off the schedule", () => withState(async (state) => {
    ensureSchema(state.storage);
    const tasks = ownerTasks(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { newId: () => crypto.randomUUID(), now: Date.now });
    const { items } = tasks.book.track({ title: 'Two steps', intent: 'In order', next_check_at: null, items: [
      { title: 'first', owner: 'waldo', depends_on: [] }, { title: 'second', owner: 'waldo', depends_on: [0] }] }, 'test');
    const started = tasks.book.start(items[0]!.id, 'worker:test')!;
    await tasks.delegation.startBackground!({ task: 'Read the clock.', itemId: items[0]!.id, revision: started.revision });
    const entries = () => state.storage.sql.exec<{ id: string }>("SELECT id FROM schedule WHERE kind = 'task_step'").toArray().map((row) => row.id);
    expect(entries()).toEqual([`task:${items[0]!.id}:${started.revision}:1`]);
    const [, updateTodo] = tasks.handlers;
    expect((await updateTodo.handle({ item_id: items[0]!.id, status: 'done', result: 'owner did it' })).ok).toBe(true);
    const second = tasks.book.item(items[1]!.id)!;
    expect(second.status).toBe('running');
    expect(entries()).toEqual([`task:${items[1]!.id}:${second.revision}:1`]);
    expect((await updateTodo.handle({ item_id: items[1]!.id, status: 'blocked' })).ok).toBe(true);
    expect(entries()).toEqual([]);
    await state.storage.deleteAlarm();
  }));
});

describe('the deploy switch', () => {
  const directory = { SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture', WALDO_ROUTER_HMAC_SECRET: 'fixture' };
  it.each([[undefined, false], ['0', false], ['true', false], ['1', true]] as const)('with WALDO_DURABLE_TASKS=%j an armed step runs: %s', (value, runs) => withState(async (state) => {
    ensureSchema(state.storage);
    const name = `task-steps-switch-${String(value)}`;
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    // The test object is named by sequence, so the directory must name this physical object for the owner to be admitted.
    const owners = { idFromName: () => state.id, get: env.OWNER_DO!.get.bind(env.OWNER_DO) };
    const tasks = ownerTasks(state.storage.sql, new Scheduler(state.storage.sql, state.storage, productionDeps()), { newId: () => crypto.randomUUID(), now: Date.now });
    const { items } = tasks.book.track({ title: 'Switch', intent: 'Prove the switch', next_check_at: null, items: [{ title: 'only step', owner: 'waldo', depends_on: [] }] }, 'test');
    const started = tasks.book.start(items[0]!.id, 'worker:test')!;
    await tasks.delegation.startBackground!({ task: 'Read the clock.', itemId: items[0]!.id, revision: started.revision });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/rpc/common_owner_authority')
      ? presenceAuthority('6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e', init?.body) : Response.json(null)));
    model.calls = 0;
    try {
      const owner = new OwnerDO(state, { ...env, ...directory, OWNER_DO: owners, TELEGRAM_BOT_TOKEN: '7:fixture', OPENAI_API_KEY: 'fixture', ...(value === undefined ? {} : { WALDO_DURABLE_TASKS: value }) } as never);
      await owner.alarm();
      expect(model.calls > 0).toBe(runs);
      expect(tasks.book.item(items[0]!.id)!.status).toBe(runs ? 'done' : 'running');
    } finally { vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  }));
});
