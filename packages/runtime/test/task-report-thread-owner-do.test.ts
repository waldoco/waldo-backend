import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { threadChainRef } from '../src/channels/app-threads';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { jobBook, type JobRow } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';

// A background task answers where it was asked: one started in an app thread reports in that thread, and one whose thread was
// archived or deleted since reports in main. The model is the only fake.
const REPORT = 'The research is in: two vendors fit.';
const BRIEF = { profile: 'reader', title: 'Vendor research', goal: 'Compare the two vendors on price.', context: 'Synthetic vendors A and B.', done_when: 'A short comparison.' };
const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const said = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    if (!request.request.response_format) model.requests.push(JSON.stringify(request.request));
    const data = (fields: object) => ({ ok: true as const, data: { model: request.request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...fields } });
    if (!request.request.response_format && said.includes('in the background') && !request.request.tool_turns?.length) {
      return data({ tool_calls: [{ call_id: 'start', name: 'start_task', arguments: JSON.stringify(BRIEF) }] });
    }
    return data({ text: request.request.response_format ? '{}' : REPORT });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { telegramSent: 0 };
beforeEach(() => {
  model.requests = []; wire.telegramSent = 0;
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
type Harness = Readonly<{ owner: Owner; state: DurableObjectState; call(method: string, path: string, body?: unknown): Promise<Readonly<{ status: number; body: any }>>; thread(): Promise<string> }>;
const withAppOwner = (name: string, run: (harness: Harness) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    // The pool's own OwnerDO has no runtime config: a real alarm it caught would start a worker this test does not drive.
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    const call: Harness['call'] = async (method, path, body) => {
      const response = await owner.fetch(new Request(`https://telegram-owner/app/v1${path}`, { method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: await response.json() };
    };
    let operations = 0;
    const thread = async () => (await call('POST', '/threads', { operation_id: `1c2d3e4f-8a2d-4f5b-9c7e-${String(++operations).padStart(12, '0')}`, title: 'Research' })).body.thread_id as string;
    try { await run({ owner, state, call, thread }); } finally { logged.mockRestore(); await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });

const texts = (body: any): string[] => [...(body.history ?? body).messages].reverse().map((message: { text: string }) => message.text);
const mainTexts = async (call: Harness['call']) => texts((await call('GET', '/chat/main')).body);
const threadTexts = async (call: Harness['call'], id: string) => texts((await call('GET', `/threads/${id}`)).body);

// A task the job book holds as finished, as a worker would leave it, started from `conversationRef`.
const reported = (state: DurableObjectState, key: string, conversationRef?: string): JobRow => {
  const book = jobBook(state.storage.sql, { now: Date.now, newId: () => key.padEnd(12, '0').slice(0, 12), newToken: () => `tok-${key}` });
  const brief = { title: BRIEF.title, goal: BRIEF.goal, context: BRIEF.context, done_when: BRIEF.done_when, effort: 'standard' as const, timezone: 'UTC', started_at: Date.now(), ...(conversationRef ? { conversation_ref: conversationRef } : {}) };
  const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: `app-turn:${key}`, origin: 'app-turn', surface: 'app', brief, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
  const ticket = book.startAttempt(job.id)!;
  expect(book.report(ticket, { status: 'done', summary: 'Vendor A is cheaper.', findings: [{ text: 'Vendor B ships faster.' }], proposals: [], left: [] }, { rounds: 1, costUsd: 0 })).toBe('accepted');
  return book.get(job.id)!;
};
// The jobs lane applies the report and queues it; the transport passes then deliver it through the app route.
const deliver = async (owner: Owner, state: DurableObjectState) => {
  await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
  await owner.alarm(); await owner.alarm(); await owner.alarm();
  await new Promise(resolve => setTimeout(resolve, 300));
  await owner.alarm(); await owner.alarm();
};

it('start_task in an app thread records that thread with the frozen brief; main records none', async () => {
  await withAppOwner('task-thread-capture', async ({ state, call, thread }) => {
    const id = await thread();
    const sent = await call('POST', `/threads/${id}/messages`, { client_message_id: 'thread-client-01', text: 'Research the two vendors in the background.', expected_revision: 1 });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${sent.body.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const main = await call('POST', '/chat/main/messages', { client_message_id: 'main-client-01', text: 'And one more in the background, please.' });
    expect(main.status, JSON.stringify(main.body)).toBe(202);
    await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${main.body.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });

    const jobs = state.storage.sql.exec<JobRow>("SELECT * FROM task_jobs WHERE kind = 'task' ORDER BY created_at").toArray();
    expect(jobs).toHaveLength(2);
    expect(JSON.parse(jobs[0]!.brief_json).conversation_ref).toBe(threadChainRef(PRINCIPAL, id));
    expect(JSON.parse(jobs[1]!.brief_json)).not.toHaveProperty('conversation_ref');
  });
});

it('a task started in an app thread reports in that thread, and main never shows it', async () => {
  await withAppOwner('task-thread-report', async ({ owner, state, call, thread }) => {
    const id = await thread();
    const job = reported(state, 'a1b2c3d4e5f6', threadChainRef(PRINCIPAL, id));
    await deliver(owner, state);
    expect(jobBook(state.storage.sql, { now: Date.now, newId: () => 'x', newToken: () => 'x' }).get(job.id)!.status).toBe('applied');
    expect(await threadTexts(call, id)).toEqual([REPORT]);
    expect(await mainTexts(call)).not.toContain(REPORT);
    expect(model.requests.some(request => request.includes('A background task you started has finished') && request.includes('Vendor B ships faster.'))).toBe(true);
  });
  expect(wire.telegramSent).toBe(0);
});

it('a task whose thread was deleted or archived since reports in main', async () => {
  await withAppOwner('task-thread-closed', async ({ owner, state, call, thread }) => {
    const deleted = await thread(), archived = await thread();
    reported(state, 'b1b2c3d4e5f6', threadChainRef(PRINCIPAL, deleted));
    reported(state, 'c1b2c3d4e5f6', threadChainRef(PRINCIPAL, archived));
    expect((await call('POST', `/threads/${deleted}/delete`, { operation_id: '1c2d3e4f-8a2d-4f5b-9c7e-000000000091', expected_revision: 1 })).status).toBe(200);
    expect((await call('POST', `/threads/${archived}/archive`, { operation_id: '1c2d3e4f-8a2d-4f5b-9c7e-000000000092', expected_revision: 1, archived: true })).status).toBe(200);
    await deliver(owner, state);
    expect((await mainTexts(call)).filter(text => text === REPORT)).toHaveLength(2);
    expect(await threadTexts(call, archived)).toEqual([]);
  });
});
