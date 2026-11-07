import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { jobBook, jobCheckpoint } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';

// The owner asks how a background task stands, and their own turn answers from check_task: the task's state and the tools its
// worker called, never what it read. The model is the only fake.
const ANSWER = 'It is still going: three steps so far, reading your mail.';
const model = vi.hoisted(() => ({ requests: [] as string[], jobId: '' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const said = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    if (!request.request.response_format) model.requests.push(JSON.stringify(request.request));
    const data = (fields: object) => ({ ok: true as const, data: { model: request.request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...fields } });
    if (!request.request.response_format && said.includes('How is the vendor research going') && !request.request.tool_turns?.length) {
      return data({ tool_calls: [{ call_id: 'check', name: 'check_task', arguments: JSON.stringify({ job_id: model.jobId }) }] });
    }
    if (!request.request.response_format && said.includes('only vendors that ship to Pune') && !request.request.tool_turns?.length) {
      return data({ tool_calls: [{ call_id: 'steer', name: 'steer_task', arguments: JSON.stringify({ job_id: model.jobId, instruction: 'Only vendors that ship to Pune.', mode: 'interrupt' }) }] });
    }
    return data({ text: request.request.response_format ? '{}' : ANSWER });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { telegramSent: 0 };
beforeEach(() => {
  model.requests = []; model.jobId = ''; wire.telegramSent = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url.startsWith('https://api.telegram.org/')) { wire.telegramSent += 1; return Response.json({ ok: true, result: { message_id: 1, chat: { id: 7 } } }); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Harness = Readonly<{ state: DurableObjectState; call(method: string, path: string, body?: unknown): Promise<Readonly<{ status: number; body: any }>> }>;
const withAppOwner = (name: string, run: (harness: Harness) => Promise<void>, switches: Record<string, string> = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    // The pool's own OwnerDO has no runtime config: a real alarm it caught would start a worker this test does not drive.
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...switches }) as unknown as Owner;
    const call: Harness['call'] = async (method, path, body) => {
      const response = await owner.fetch(new Request(`https://telegram-owner/app/v1${path}`, { method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: await response.json() };
    };
    try { await run({ state, call }); } finally { logged.mockRestore(); await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });

const texts = (body: any): string[] => [...(body.history ?? body).messages].reverse().map((message: { text: string }) => message.text);
const mainTexts = async (call: Harness['call']) => texts((await call('GET', '/chat/main')).body);

// A reader task three steps in, as its worker leaves it: it searched the owner's mail and opened two threads.
const running = (state: DurableObjectState): string => {
  const book = jobBook(state.storage.sql, { now: Date.now, newId: () => 'a1b2c3d4e5f6', newToken: () => 'tok-check' });
  const brief = { title: 'Vendor research', goal: 'Compare the two vendors on price.', context: 'Synthetic vendors A and B.', done_when: 'A short comparison.', effort: 'standard' as const, timezone: 'UTC', started_at: Date.now() };
  const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: 'app-turn:check', origin: 'app-turn', surface: 'app', brief, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
  const ticket = book.startAttempt(job.id)!;
  const turn = (name: string, call_id: string) => ({ call: { call_id, name, arguments: '{}' }, output: 'SYNTHETIC-MAIL-BODY Vendor A quoted a price.' });
  expect(book.checkpoint(ticket, 1, { turns: [turn('search_communication', 'a'), turn('read_thread', 'b'), turn('read_thread', 'c')] }, { rounds: 3, costUsd: 0 })).toBe('ok');
  return job.id;
};

it('the owner asks how a task is going: the turn calls check_task once, reads its state and tools, and answers in main', async () => {
  await withAppOwner('task-check-owner', async ({ state, call }) => {
    model.jobId = running(state);
    const sent = await call('POST', '/chat/main/messages', { client_message_id: 'check-client-01', text: 'How is the vendor research going?' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${sent.body.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });

    // The trace: one check_task call, then the reply delivered to main.
    const hops = state.storage.sql.exec<{ hop: string; ok: number }>('SELECT hop, ok FROM trace_log ORDER BY id').toArray();
    expect(hops.filter(row => row.hop.startsWith('tool_') && row.hop !== 'tool_eligibility')).toEqual([{ hop: 'tool_check_task', ok: 1 }]);
    expect(await mainTexts(call)).toContain(ANSWER);
    const at = (hop: string) => hops.map(row => row.hop).lastIndexOf(hop);
    expect(at('tool_check_task')).toBeLessThan(at('llm_reply'));
    expect(at('llm_reply')).toBeLessThan(at('send'));
    expect(hops.find(row => row.hop === 'send')).toEqual({ hop: 'send', ok: 1 });

    // The model read the task's state and the tools its worker called, and none of what the worker read.
    const turns = model.requests.map(request => JSON.parse(request) as { tool_turns?: { call: { name: string }; output: string }[] }).flatMap(request => request.tool_turns ?? []);
    const output = turns.find(turn => turn.call.name === 'check_task')!.output;
    expect(output).toContain('"state":"running"');
    expect(output).toContain('"tools_called":{"search_communication":1,"read_thread":2}');
    expect(output).not.toContain('SYNTHETIC-MAIL-BODY');
    // steer_task is off by default (WALDO_TASK_STEER), so this turn was never offered it.
    expect(model.requests.some(request => request.includes('"name":"steer_task"'))).toBe(false);
    // Checking changed nothing about the job.
    expect(jobBook(state.storage.sql, { now: Date.now, newId: () => 'x', newToken: () => 'x' }).get(model.jobId)).toMatchObject({ status: 'running', rounds: 3 });
  });
  expect(wire.telegramSent).toBe(0);
});

it('the in-flight line rides in this turn\'s context with the task\'s age, never in the static system prompt', async () => {
  await withAppOwner('task-inflight-owner', async ({ state, call }) => {
    model.jobId = running(state);
    const sent = await call('POST', '/chat/main/messages', { client_message_id: 'inflight-client-01', text: 'Anything new?' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${sent.body.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const request = model.requests.map(text => JSON.parse(text) as { system: string; messages: { content: unknown }[] }).find(r => JSON.stringify(r.messages).includes('Anything new?'))!;
    const line = `- ${model.jobId} (reader, 3 steps so far, started under a minute ago): title "Vendor research"`;
    expect(JSON.stringify(request.messages.at(-1)!.content)).toContain(JSON.stringify(line).slice(1, -1));
    expect(request.system).not.toContain('Background tasks you started');
    expect(request.system).not.toContain(model.jobId);
  });
});

it('with WALDO_TASK_STEER on, the owner corrects a running task: one steer_task call keeps the job, then the reply is sent', async () => {
  await withAppOwner('task-steer-owner', async ({ state, call }) => {
    model.jobId = running(state);
    const sent = await call('POST', '/chat/main/messages', { client_message_id: 'steer-client-01', text: 'Actually, only vendors that ship to Pune.' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${sent.body.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });

    const hops = state.storage.sql.exec<{ hop: string; ok: number }>('SELECT hop, ok FROM trace_log ORDER BY id').toArray();
    expect(hops.filter(row => row.hop.startsWith('tool_') && row.hop !== 'tool_eligibility')).toEqual([{ hop: 'tool_steer_task', ok: 1 }]);
    const at = (hop: string) => hops.map(row => row.hop).lastIndexOf(hop);
    expect(at('tool_steer_task')).toBeLessThan(at('llm_reply'));
    expect(at('llm_reply')).toBeLessThan(at('send'));
    // The reply carries the receipt the tool's claim backs: the change is recorded, not done.
    expect(await mainTexts(call)).toContain(`${ANSWER}\n\nDone: task steered`);

    const job = jobBook(state.storage.sql, { now: Date.now, newId: () => 'x', newToken: () => 'x' }).get(model.jobId)!;
    expect(job).toMatchObject({ id: model.jobId, status: 'running', attempt: 1 });
    expect(jobCheckpoint(job).steers).toMatchObject([{ text: 'Only vendors that ship to Pune.', mode: 'interrupt' }]);
  }, { WALDO_TASK_STEER: '1' });
});
