import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appRatingResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// MEMORY_VALIDITY through a real owner turn: a fact that was replaced reaches the model dated and marked as over only when
// the switch is on.
const REPLY = 'Synthetic reply marker quartz-heron';
const seen = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    seen.prompts.push(JSON.stringify(request));
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
// Langfuse as the API answers it: OTLP traces in, scores created and deleted. `refuse` answers every score call with a status.
const langfuse = vi.hoisted(() => ({ calls: [] as { method: string; path: string; body: unknown }[], refuse: 0 }));
const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test', WALDO_ENVIRONMENT: 'staging' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  langfuse.calls = []; langfuse.refuse = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === 'https://langfuse.test') {
      langfuse.calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (langfuse.refuse && url.pathname.startsWith('/api/public/scores')) return new Response('refused', { status: langfuse.refuse });
      return url.pathname === '/api/public/scores' ? Response.json({ accepted: 1 }, { status: 202 }) : Response.json({});
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
type Owner = InstanceType<typeof OwnerDO>;
// One owner with `exchanges` exchanges in main chat; `run` gets the owner object, its storage and the newest pair's ids.
const withExchange = <T>(name: string, run: (owner: Owner, state: DurableObjectState, ids: Readonly<{ mine: string; reply: string }>) => Promise<T>, exchanges = 1, config: object = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...config });
    const seed = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    seed.add({ kind: 'fact', text: 'Lives in Leeds near the canal', source: 'stated', evidence: 'synthetic', origin: 'owner', source_ref: 'owner, seed' }, '2026-09-01T00:00:00.000Z');
    seed.correct(1, { kind: 'fact', text: 'Lives in Pune near the river', source: 'stated', evidence: 'synthetic', origin: 'owner', source_ref: 'owner, seed2' }, '2026-10-12T21:00:00.000Z');
    try {
      for (let index = 1; index <= exchanges; index += 1) {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `rating-client-0${index}`, text: 'Where did I live before, the canal near Leeds?' }) }));
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      }
      const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
      const reply = page.messages.find(message => message.role === 'assistant')!, mine = page.messages.find(message => message.role === 'user')!;
      expect(reply.text).toBe(REPLY);
      return await run(owner, state, { mine: mine.id, reply: reply.id });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

beforeEach(() => { seen.prompts = []; });
const sawHistory = () => seen.prompts.some(prompt => prompt.includes('NO LONGER TRUE') && prompt.includes('Leeds'));

it('shows the model a replaced fact, dated and marked as over, when the switch is on', async () => {
  await withExchange('validity-on', async () => {
    expect(sawHistory()).toBe(true);
    expect(seen.prompts.some(prompt => prompt.includes('held until 2026-10-12'))).toBe(true);
  }, 1, { MEMORY_VALIDITY: '1' });
});

it('shows it nothing of the kind when the switch is off', async () => {
  await withExchange('validity-off', async () => { expect(sawHistory()).toBe(false); });
});
