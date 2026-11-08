// The owner tells Waldo in chat where they are: one app turn through the real owner object, the model's tool call and its
// result. The tool confirms the zone the way the console does: the directory keeps it first, then the owner object applies it
// and re-arms the owner's own jobs on it. Until a zone is confirmed, the turn context says so, and the model may ask.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { ownerClockLine, ZONE_UNCONFIRMED } from '../src/prompt/messaging-behavior';

const OWNER_ID = '4c9e1a7b-2d3f-4e85-b6a0-8f1d3c5e7a92';
const world = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], call: null as { name: string; args: object } | null, saved: [] as Record<string, string>[], directory: true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const data = { model: request.request.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 };
    if (request.request.response_format) return { ok: true, data: { ...data, text: '{"decision":"retain","sources":[],"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' } };
    world.requests.push(request.request);
    return { ok: true, data: world.requests.length === 1 && world.call
      ? { ...data, text: '', tool_calls: [{ call_id: 'c1', name: world.call.name, arguments: JSON.stringify(world.call.args) }] }
      : { ...data, text: 'Done.' } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const appTurn = (name: string, ask: string, setup: Readonly<{ confirmed?: boolean; askSwitch?: string }> = {}) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'set_owner_settings') { world.saved.push(asked); return Response.json(world.directory); }
    return new Response('unexpected', { status: 500 });
  });
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (instance, state) => {
    (instance as unknown as { alarm(): Promise<void> }).alarm = async () => {};
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('timezone', 'UTC');
    if (setup.confirmed) state.storage.kv.put('timezone_confirmed', true);
    const owner = new OwnerDO(state, { ...env, ...(setup.askSwitch ? { WALDO_TIMEZONE_ASK: setup.askSwitch } : {}), SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: ask }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 10 });
      return { zone: state.storage.kv.get<string>('timezone'), confirmed: state.storage.kv.get<boolean>('timezone_confirmed') === true };
    } finally { await state.storage.deleteAlarm(); }
  });
};
const toolResult = () => JSON.stringify(world.requests[1]?.tool_turns ?? []);
const firstRequest = () => JSON.stringify(world.requests[0] ?? {});

afterEach(() => { vi.unstubAllGlobals(); world.requests = []; world.call = null; world.saved = []; world.directory = true; });

it('the owner says where they are: the directory keeps the zone, the owner object confirms it, and the receipt names it', async () => {
  world.call = { name: 'set_schedule_preference', args: { action: 'timezone', timezone: 'Asia/Kolkata' } };
  const after = await appTurn('chat-timezone-set', 'I live in Bengaluru');
  expect(after).toEqual({ zone: 'Asia/Kolkata', confirmed: true });
  expect(world.saved).toHaveLength(1);
  expect(world.saved[0]).toMatchObject({ p_timezone: 'Asia/Kolkata' });
  expect(toolResult()).toContain('Asia/Kolkata');
  expect(toolResult()).not.toMatch(/invalid_args|rejected/);
});

it('a zone written in the wrong case is saved by its IANA name', async () => {
  world.call = { name: 'set_schedule_preference', args: { action: 'timezone', timezone: 'europe/london' } };
  const after = await appTurn('chat-timezone-case', 'I live in London');
  expect(after).toEqual({ zone: 'Europe/London', confirmed: true });
  expect(world.saved[0]).toMatchObject({ p_timezone: 'Europe/London' });
});

// An offset has no daylight-saving rules and an abbreviation can name several zones, though Intl accepts both.
it.each(['Mars/Olympus_Mons', 'EST', 'IST', '+05:30'])('%s is not saved as the owner\'s zone, and nothing changes', async (timezone) => {
  world.call = { name: 'set_schedule_preference', args: { action: 'timezone', timezone } };
  const after = await appTurn(`chat-timezone-invalid-${timezone.replace(/\W/g, '')}`, 'this is where I am');
  expect(after).toEqual({ zone: 'UTC', confirmed: false });
  expect(world.saved).toHaveLength(0);
  expect(toolResult()).toMatch(/rejected/);
});

it('only a turn with the owner on the other side says the zone is unconfirmed: a job\'s card cannot ask them', () => {
  const clock = { timezone: 'UTC', now: () => new Date(0), confirmed: () => false };
  expect(ownerClockLine(clock, true)).toContain(ZONE_UNCONFIRMED);
  expect(ownerClockLine(clock)).not.toContain(ZONE_UNCONFIRMED);
  expect(ownerClockLine({ ...clock, confirmed: () => true }, true)).not.toContain(ZONE_UNCONFIRMED);
});

it('when the directory does not keep the zone, the owner object does not apply it either', async () => {
  world.directory = false;
  world.call = { name: 'set_schedule_preference', args: { action: 'timezone', timezone: 'Europe/London' } };
  const after = await appTurn('chat-timezone-directory-down', 'I am in London');
  expect(after).toEqual({ zone: 'UTC', confirmed: false });
  expect(toolResult()).toMatch(/rejected/);
});

it('with WALDO_TIMEZONE_ASK on, a turn whose zone is not confirmed says so; a confirmed zone, or the switch off, does not', async () => {
  await appTurn('chat-timezone-ask-on', 'what is on today?', { askSwitch: '1' });
  expect(firstRequest()).toContain(ZONE_UNCONFIRMED);
  world.requests = [];
  await appTurn('chat-timezone-ask-confirmed', 'what is on today?', { askSwitch: '1', confirmed: true });
  expect(firstRequest()).not.toContain(ZONE_UNCONFIRMED);
  world.requests = [];
  await appTurn('chat-timezone-ask-off', 'what is on today?');
  expect(firstRequest()).not.toContain(ZONE_UNCONFIRMED);
});
