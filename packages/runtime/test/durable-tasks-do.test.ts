import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { responsibilityBook } from '../src/channels/responsibilities';

// A background task the owner asks for in chat runs its steps on the owner's scheduler, one step per wake, through the same
// machine-turn path as a standing order. Each phase below builds a fresh OwnerDO on the same storage, which is what an eviction
// or a deploy between wakes leaves: the rows, and nothing in memory.
const ERRAND = 'Look into venues for the offsite in the background';
const model = vi.hoisted(() => ({ steps: [] as string[], tools: [] as string[][], turnTools: [] as string[], failStep: 0, revokeAtStep: false, healthStep: false }));
const wire = vi.hoisted(() => ({ revoked: false }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    const step = /Step (\d) of (\d)/.exec(asked);
    if (step) {
      model.steps.push(step[0]);
      model.tools.push((request.tools ?? []).map(tool => tool.name));
      if (model.failStep > 0) { model.failStep -= 1; throw new Error('provider down'); }
      if (model.revokeAtStep) wire.revoked = true;
      if (model.healthStep) return done('Found three venues. Your HRV was 42 ms this morning.');
      return done(step[1] === '1' ? 'Found three venues: the Hall, the Barn and the Loft.' : 'The Hall is the best fit: it holds 40 and has a projector.');
    }
    if (asked.includes(ERRAND)) {
      const turns = request.tool_turns ?? [];
      if (turns.length === 0) model.turnTools = (request.tools ?? []).map(tool => tool.name);
      if (turns.length === 0) return done('', [{ call_id: 'track', name: 'track_responsibility', arguments: JSON.stringify({ title: 'Offsite venue', intent: 'Find a venue for the team offsite and recommend one.', items: [{ title: 'Find venue options' }, { title: 'Pick the best venue', depends_on: [0] }] }) }]);
      if (turns.length === 1) {
        const first = /"id":"(i[^"]+)"/.exec(turns[0]!.output)?.[1] ?? 'missing';
        return done('', [{ call_id: 'start', name: 'delegate_task', arguments: JSON.stringify({ task: 'Find venue options for the offsite.', item_id: first, background: true }) }]);
      }
      return done("On it. I will report back.");
    }
    return done('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6d5c4b3a-2918-4f7e-8d6c-5b4a3c2d1e0f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.steps = []; model.tools = []; model.turnTools = []; model.failStep = 0; model.revokeAtStep = false; model.healthStep = false; wire.revoked = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Switch = Readonly<{ durableTasks?: boolean }>;
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
// One phase: a fresh object on the stored state, as after an eviction.
const phase = <T>(name: string, work: (owner: InstanceType<typeof OwnerDO>, storage: DurableObjectStorage) => Promise<T>, flags: Switch = { durableTasks: true }) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...(flags.durableTasks ? { DURABLE_TASKS: '1' } : {}) });
    try { return await work(owner, state.storage); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

const ask = (name: string, text: string, flags?: Switch) => phase(name, async (owner, storage) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `client-${crypto.randomUUID()}`, text }) }));
  const { message_id: id } = await sent.json() as { message_id: string };
  await vi.waitFor(() => expect(storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
}, flags);

// One wake that runs a step: the platform's alarm, consuming the alarm that fired, until a task_step entry has fired once.
// Other due work (the inbox, the transport outbox) may take a pass first, as it would in production.
const wake = (name: string, flags?: Switch) => phase(name, async (owner, storage) => {
  const fired = () => storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schedule_runs WHERE kind = 'task_step'").one().n;
  const before = fired();
  for (let pass = 0; pass < 6 && fired() === before; pass++) { await storage.deleteAlarm(); await owner.alarm(); }
}, flags);

const chat = (name: string) => phase(name, async owner => {
  const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
  // Newest first on the wire; a reply's receipt line follows its first line and is not what these tests are about.
  return page.messages.map(message => `${message.role}: ${message.text.split('\n')[0]}`).reverse();
});

const rows = (name: string) => phase(name, async (_owner, storage) => ({
  items: storage.sql.exec<{ title: string; status: string }>('SELECT title, status FROM responsibility_items ORDER BY rowid').toArray().map(row => `${row.title}: ${row.status}`),
  responsibility: storage.sql.exec<{ status: string; closed_by_evidence: string | null }>('SELECT status, closed_by_evidence FROM responsibilities').toArray(),
  attempts: storage.sql.exec<{ attempt: number; status: string; report: string | null }>('SELECT attempt, status, report FROM task_step_attempts ORDER BY rowid').toArray().map(row => `${row.attempt}:${row.status}:${row.report ?? '-'}`),
  armed: storage.sql.exec<{ id: string }>("SELECT id FROM schedule WHERE kind = 'task_step'").toArray().map(row => row.id),
}));

const PROGRESS = 'assistant: Step 1 of 2 done for "Offsite venue": Find venue options.';
const RESULT = 'assistant: The Hall is the best fit: it holds 40 and has a projector.';

describe('a two-step background task', () => {
  it('runs one step per wake, survives an eviction between steps, reports progress once and closes on its result', async () => {
    const name = 'durable-task-two-steps';
    await ask(name, ERRAND);
    expect(model.turnTools).toEqual(expect.arrayContaining(['track_responsibility', 'update_todo', 'close_responsibility', 'delegate_task']));
    expect((await rows(name)).armed).toHaveLength(1);
    await wake(name);
    expect(model.steps).toEqual(['Step 1 of 2']);
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.', PROGRESS]);
    // A fresh object: nothing of the first step is in memory, only its rows.
    await wake(name);
    expect(model.steps).toEqual(['Step 1 of 2', 'Step 2 of 2']);
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.', PROGRESS, RESULT]);
    const after = await rows(name);
    expect(after.items).toEqual(['Find venue options: done', 'Pick the best venue: done']);
    expect(after.responsibility).toEqual([{ status: 'done', closed_by_evidence: expect.stringMatching(/^task_step:/) }]);
    expect(after.attempts).toEqual(['1:done:sent', '1:done:sent']);
    expect(after.armed).toEqual([]);
    // A step reads; it holds no tool that acts or sends, and none that reads health.
    for (const offered of model.tools) {
      expect(offered).toContain('web_search');
      for (const name of ['send_email', 'set_reminder', 'delegate_task', 'track_responsibility', 'get_health', 'list_health_logs']) expect(offered).not.toContain(name);
    }
    // A later wake finds nothing to do and says nothing more.
    await wake(name);
    expect(model.steps).toHaveLength(2);
    expect(await chat(name)).toHaveLength(4);
  });

  it('runs nothing further once the owner drops the task between steps', async () => {
    const name = 'durable-task-cancelled';
    await ask(name, ERRAND);
    await wake(name);
    await phase(name, async (_owner, storage) => {
      const book = responsibilityBook(storage.sql, { newId: () => crypto.randomUUID(), now: Date.now });
      const [open] = book.list('open');
      expect(book.close({ id: open!.id, outcome: 'dropped', evidence_ref: 'The owner said to drop it.' })).toBe(true);
    });
    await wake(name);
    expect(model.steps).toEqual(['Step 1 of 2']);
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.', PROGRESS]);
    const after = await rows(name);
    expect(after.items).toEqual(['Find venue options: done', 'Pick the best venue: cancelled']);
    expect(after.attempts).toEqual(['1:done:sent', '1:cancelled:-']);
    expect(after.armed).toEqual([]);
  });

  it('starts a fresh attempt for a step an eviction cut off, and the step still reports once', async () => {
    const name = 'durable-task-interrupted';
    await ask(name, ERRAND);
    // The step was running when the object went away: its attempt row says running, and its entry is still armed.
    await phase(name, async (_owner, storage) => {
      const [item] = storage.sql.exec<{ id: string; revision: number }>('SELECT id, revision FROM responsibility_items ORDER BY rowid LIMIT 1').toArray();
      storage.sql.exec("UPDATE responsibility_items SET status = 'running', revision = revision + 1 WHERE id = ?", item!.id);
      storage.sql.exec("UPDATE task_step_attempts SET status = 'running', revision = ? WHERE item_id = ?", item!.revision + 1, item!.id);
    });
    await wake(name);
    expect(model.steps).toEqual(['Step 1 of 2']);
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.', PROGRESS]);
    expect((await rows(name)).attempts).toEqual(['1:interrupted:-', '2:done:sent', '1:armed:-']);
  });

  it('retries a failing step itself, and after three failures tells the owner once and fails the step', async () => {
    const name = 'durable-task-failing';
    await ask(name, ERRAND);
    model.failStep = 99;
    await wake(name);
    // Each retry waits; move them forward instead of the clock.
    for (let retry = 0; retry < 2; retry++) {
      await phase(name, async (_owner, storage) => { storage.sql.exec("UPDATE schedule SET due_at = ?, occurrence_at = ? WHERE kind = 'task_step'", Date.now() - 1, Date.now() - 1); });
      await wake(name);
    }
    expect(new Set(model.steps)).toEqual(new Set(['Step 1 of 2']));
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.',
      'assistant: I couldn\'t finish "Offsite venue": the step "Find venue options" failed 3 times, so I stopped.']);
    const after = await rows(name);
    expect(after.items).toEqual(['Find venue options: failed', 'Pick the best venue: pending']);
    expect(after.attempts).toEqual(['1:failed:-', '2:failed:-', '3:failed:sent']);
    expect(after.armed).toEqual([]);
  });

  it('does not keep a step result that carries a health reading', async () => {
    const name = 'durable-task-health-result';
    await ask(name, ERRAND);
    model.healthStep = true;
    await wake(name);
    const kept = await phase(name, async (_owner, storage) => storage.sql.exec<{ result_ref: string | null }>('SELECT result_ref FROM responsibility_items').toArray().map(row => row.result_ref));
    expect(kept).toEqual([null, null]);
    expect((await rows(name)).attempts).toEqual(['1:failed:-', '2:armed:-']);
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.']);
  });

  it('runs nothing when the directory no longer admits the owner at the step', async () => {
    const name = 'durable-task-revoked';
    await ask(name, ERRAND);
    wire.revoked = true;
    await wake(name);
    expect(model.steps).toEqual([]);
    expect((await rows(name)).items).toEqual(['Find venue options: running', 'Pick the best venue: pending']);
  });

  it('applies nothing and tells the owner nothing when the directory revokes the owner while a step runs', async () => {
    const name = 'durable-task-revoked-mid-step';
    await ask(name, ERRAND);
    model.revokeAtStep = true;
    await wake(name);
    expect(model.steps).toEqual(['Step 1 of 2']);
    const after = await rows(name);
    expect(after.items).toEqual(['Find venue options: running', 'Pick the best venue: pending']);
    expect(after.attempts).toEqual(['1:failed:-', '2:armed:-']);
    wire.revoked = false;
    expect(await chat(name)).toEqual([`user: ${ERRAND}`, 'assistant: On it. I will report back.']);
  });
});

describe('with the switch off', () => {
  it('offers no task tools and arms nothing', async () => {
    const name = 'durable-task-switch-off';
    await ask(name, ERRAND, {});
    expect(model.turnTools).toContain('delegate_task');
    expect(model.turnTools).not.toEqual(expect.arrayContaining(['track_responsibility']));
    expect(await phase(name, async (_owner, storage) => storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM schedule WHERE kind = 'task_step'").one().n, {})).toBe(0);
  });
});
