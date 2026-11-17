// The owner asks Waldo in chat to move the Brief: one app turn through the real owner object, the model's tool call and its
// result. The tool writes the same daily time the app's schedule.set writes, and the model gets the fixed receipt to say back.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { dayPlanBook } from '../src/channels/day-cards';
import { ensureSchema } from '../src/tracer/schema';

const OWNER_ID = '7e2a9c41-5b8d-4f60-a1c3-9d0e2f4b6a85';
const world = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], call: { name: 'set_schedule_preference', args: { action: 'time', card: 'brief', time: '07:10' } as object } }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const data = { model: request.request.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 };
    if (request.request.response_format) return { ok: true, data: { ...data, text: '{"decision":"retain","sources":[],"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' } };
    world.requests.push(request.request);
    return { ok: true, data: world.requests.length === 1
      ? { ...data, text: '', tool_calls: [{ call_id: 'c1', name: world.call.name, arguments: JSON.stringify(world.call.args) }] }
      : { ...data, text: 'Done.' } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const appTurn = (name: string, ask: string) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    (instance as unknown as { alarm(): Promise<void> }).alarm = async () => {};
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: ask }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 10 });
      return { pins: dayPlanBook(state.storage.sql).pins() };
    } finally { await state.storage.deleteAlarm(); }
  });
};
// The tool result the model read back on its second call, as the turn's tool rounds carry it.
const toolResult = () => JSON.stringify(world.requests[1]?.tool_turns ?? []);

afterEach(() => { vi.unstubAllGlobals(); world.requests = []; world.call = { name: 'set_schedule_preference', args: { action: 'time', card: 'brief', time: '07:10' } }; });

it('the owner moves the Brief in chat: the daily time is kept, and the receipt comes back to say', async () => {
  const { pins } = await appTurn('chat-card-time-brief', 'send my brief at 7:10 every morning');
  expect(pins).toEqual({ 'card:brief': '07:10' });
  expect(toolResult()).toContain('Saved. Your Brief comes at 7:10am.');
  expect(world.requests).toHaveLength(2);
});

it('a malformed time from the model changes nothing and is refused as invalid arguments', async () => {
  world.call = { name: 'set_schedule_preference', args: { action: 'time', card: 'close', time: '9:30pm' } };
  const { pins } = await appTurn('chat-card-time-invalid', 'make my close 9:30pm');
  expect(pins).toEqual({});
  expect(toolResult()).toMatch(/invalid_args/);
});
