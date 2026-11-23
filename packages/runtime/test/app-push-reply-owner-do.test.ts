import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// Waldo's answer to the owner's app message pushes their phone once, so an owner who left the app while Waldo worked hears
// of it. A turn the owner stopped writes no answer and pushes nothing.
const gate = vi.hoisted(() => ({ release: null as null | (() => void), held: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    if (String(request.messages.at(-1)?.content ?? '').includes('slowly')) { gate.held += 1; await new Promise<void>(resolve => { gate.release = resolve; }); }
    return done('Your 15:00 is with Priya.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c4b3a29-1f0e-4d7c-8b6a-5d4e3f2a1b0c';
const HASH = 'a'.repeat(64);
const EXPO_TOKEN = 'ExponentPushToken[synthetic-reply-token]';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { pushes: [] as unknown[] };
beforeEach(() => {
  gate.release = null; gate.held = 0; wire.pushes = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'app_push_targets') return Response.json([{ installation_id: '0f1e2d3c-4b5a-4968-8776-655443322111', device_epoch: 1, token: EXPO_TOKEN }]);
    if (url === 'https://exp.host/--/api/v2/push/send') { wire.pushes.push(JSON.parse(String(init?.body))); return Response.json({ data: [{ status: 'ok', id: 'ticket-1' }] }); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });
const withOwner = <T,>(name: string, work: (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, EXPO_ACCESS_TOKEN: 'synthetic-expo-access' });
  try { return await work(owner, state); } finally { gate.release?.(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text }) }));
  expect(sent.status).toBe(202);
  return (await sent.json() as { message_id: string }).message_id;
};
const record = (state: DurableObjectState, id: string) => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)!;
const REPLY_PUSH = [{ to: EXPO_TOKEN, body: 'Waldo replied', data: { trigger: 'event' }, sound: 'default' }];

it('an answer to the owner\'s app message pushes "Waldo replied" once, carrying none of the answer', async () => {
  const name = 'app-push-reply';
  await withOwner(name, async (owner, state) => {
    const id = await send(owner, name, 'push-client-0001', 'QA: who is my 3pm with?');
    await vi.waitFor(() => expect(record(state, id).state).toBe('completed'), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(wire.pushes).toEqual([REPLY_PUSH]), { timeout: 10_000, interval: 20 });
    expect(JSON.stringify(wire.pushes)).not.toContain('Priya');
  });
});

it('a turn the owner stopped writes no answer and pushes nothing', async () => {
  const name = 'app-push-stopped';
  await withOwner(name, async (owner, state) => {
    const id = await send(owner, name, 'push-client-0002', 'QA: please answer slowly');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages/push-client-0002/cancel', { method: 'POST', headers: headers(name) }));
    gate.release!();
    await vi.waitFor(() => expect(record(state, id).state).toBe('interrupted'), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
    expect(wire.pushes).toEqual([]);
  });
});
