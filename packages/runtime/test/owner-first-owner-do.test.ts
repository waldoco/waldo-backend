import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { traceBook } from '../src/channels/harness';
import { OWNER_FIRST_MAX_HOLD_MS, ownerHold, ownerMessageWaiting } from '../src/channels/owner-first';
import { claimStore } from '../src/memory/claims';
import { APP_INBOX_DUE_KEY, TASK_JOBS_DUE_KEY, WHATSAPP_INBOX_DUE_KEY } from '../src/scheduler/alarm-slot';
import { jobBook } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';

// Owner-first: an owner message that arrives while the alarm pass applies a task report runs before the pass's next apply
// turn. The model is the only fake; the trace is the order of the model turns the owner object ran.
const model = vi.hoisted(() => ({ turns: [] as string[], release: null as null | (() => void), held: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: import('../src/llm/provider').LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{}');
    const said = String(request.messages.at(-1)?.content ?? '');
    const turn = said.includes('what time is it') ? 'owner' : said.includes('First report') ? 'report:first' : said.includes('Second report') ? 'report:second' : 'other';
    if (model.turns.at(-1) !== turn) model.turns.push(turn);
    if (turn === 'report:first' && model.held === 0) { model.held = 1; await new Promise<void>(resolve => { model.release = resolve; }); }
    return done(turn === 'owner' ? 'It is noon.' : 'The research is in.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.turns = []; model.release = null; model.held = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    if (fn === 'assert_channel_presence') return Response.json(true);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
// ownerFirst 'in-switches' turns the switch on only inside WALDO_SWITCHES, as a deployed config carries it.
const withAppOwner = (name: string, ownerFirst: '0' | '1' | 'in-switches', run: (owner: Owner, state: DurableObjectState, instance: InstanceType<typeof OwnerDO>) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    const poolAlarm = vi.spyOn(instance as InstanceType<typeof OwnerDO>, 'alarm').mockResolvedValue(undefined);
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ownerFirstVar = ownerFirst === 'in-switches'
      ? { WALDO_SWITCHES: { ...(env as unknown as { WALDO_SWITCHES: Record<string, string> }).WALDO_SWITCHES, WALDO_OWNER_FIRST: '1' } }
      : { WALDO_OWNER_FIRST: ownerFirst };
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...ownerFirstVar }) as unknown as Owner;
    try { await run(owner, state, instance as InstanceType<typeof OwnerDO>); } finally { model.release?.(); logged.mockRestore(); await state.storage.deleteAlarm(); poolAlarm.mockRestore(); }
  });

// Two finished tasks the job book holds for their apply turns, as workers would leave them.
const reported = (state: DurableObjectState) => {
  for (const [key, title] of [['first0000001', 'First report'], ['second000001', 'Second report']] as const) {
    const book = jobBook(state.storage.sql, { now: Date.now, newId: () => key, newToken: () => `tok-${key}` });
    const brief = { title, goal: 'Compare two vendors.', context: 'Synthetic vendors.', done_when: 'A short comparison.', effort: 'standard' as const, timezone: 'UTC', started_at: Date.now() };
    const { job } = book.create({ kind: 'task', profile: 'reader', idempotencyKey: `app-turn:${key}`, origin: 'app-turn', surface: 'app', brief, dueAt: Date.now(), deadlineAt: Date.now() + 3_600_000 });
    expect(book.report(book.startAttempt(job.id)!, { status: 'done', summary: `${title}: vendor A is cheaper.`, findings: [], proposals: [], left: [] }, { rounds: 1, costUsd: 0 })).toBe('accepted');
  }
};
const sendWhileFirstReportRuns = async (owner: Owner, state: DurableObjectState, name: string) => {
  reported(state);
  await state.storage.put(TASK_JOBS_DUE_KEY, Date.now());
  const pass = owner.alarm();
  await vi.waitFor(() => expect(model.held).toBe(1), { timeout: 10_000, interval: 20 });
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST',
    headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' },
    body: JSON.stringify({ client_message_id: 'owner-first-0001', text: 'Quick one: what time is it?' }) }));
  expect(sent.status).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  model.release!();
  await pass;
  await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
  // The report the pass held back is still due: the next pass applies it.
  for (let pass = 0; pass < 3 && !model.turns.includes('report:second'); pass++) await owner.alarm();
};

it('owner-first on: the owner message runs right after the apply turn in flight, before the next report', async () => {
  await withAppOwner('owner-first-on', '1', async (owner, state) => {
    await sendWhileFirstReportRuns(owner, state, 'owner-first-on');
    expect(model.turns).toEqual(['report:first', 'owner', 'report:second']);
  });
});

it('a switch carried only in WALDO_SWITCHES reaches the owner object, as every deployed switch now does', async () => {
  // The object the runtime built from the test pool's env reads the production value, which wrangler.jsonc nests.
  expect('WALDO_OWNER_FIRST' in env).toBe(false);
  await withAppOwner('owner-first-in-switches', 'in-switches', async (owner, state, instance) => {
    expect((instance as unknown as { env: Record<string, unknown> }).env.WALDO_OWNER_FIRST).toBe('0');
    await sendWhileFirstReportRuns(owner, state, 'owner-first-in-switches');
    expect(model.turns).toEqual(['report:first', 'owner', 'report:second']);
  });
});

it('owner-first off: the alarm pass applies every due report before the owner message', async () => {
  await withAppOwner('owner-first-off', '0', async (owner, state) => {
    await sendWhileFirstReportRuns(owner, state, 'owner-first-off');
    expect(model.turns).toEqual(['report:first', 'report:second', 'owner']);
  });
});

it('a message whose wake was put off is not waiting, so it never holds machine work back', () => {
  const kv = new Map<string, unknown>();
  const store = { get: <T,>(key: string) => kv.get(key) as T | undefined };
  const now = 1_000_000;
  expect(ownerMessageWaiting(store, now)).toBe(false);
  kv.set(APP_INBOX_DUE_KEY, now + 250);
  expect(ownerMessageWaiting(store, now)).toBe(true);
  kv.set(APP_INBOX_DUE_KEY, now + 30_000);
  expect(ownerMessageWaiting(store, now)).toBe(false);
  kv.set(WHATSAPP_INBOX_DUE_KEY, now - 5);
  expect(ownerMessageWaiting(store, now)).toBe(true);
  kv.delete(WHATSAPP_INBOX_DUE_KEY);
  kv.set('telegram_owner_inbox_v1', [{ state: 'admitted', control: { kind: 'steer', targetRun: 'r' } }]);
  expect(ownerMessageWaiting(store, now)).toBe(false);
  kv.set('telegram_owner_inbox_v1', [{ state: 'admitted' }]);
  expect(ownerMessageWaiting(store, now)).toBe(true);
});

it('a waiting message that never runs holds machine work back for a bounded time only', () => {
  const now = 5_000_000;
  const first = ownerHold(true, null, now);
  expect(first).toEqual({ hold: true, since: now });
  expect(ownerHold(true, first.since, now + OWNER_FIRST_MAX_HOLD_MS - 1).hold).toBe(true);
  expect(ownerHold(true, first.since, now + OWNER_FIRST_MAX_HOLD_MS)).toEqual({ hold: false, since: now });
  // Once nothing waits, the next message starts its own hold.
  expect(ownerHold(false, first.since, now + OWNER_FIRST_MAX_HOLD_MS)).toEqual({ hold: false, since: null });
});
