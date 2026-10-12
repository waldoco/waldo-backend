import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const ASK = 'connect my google calendar';
const READ = 'what is on my calendar';
const SENT_CLAIM = 'connect button is in the chat';
const model = vi.hoisted(() => ({ requests: [] as { tool_turns?: unknown; messages: { content: string }[]; response_format?: unknown }[] }));
const telegram = vi.hoisted(() => ({ deliver: true, sent: [] as unknown[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; reply_markup?: unknown }) => {
    if (method !== 'sendMessage') return true;
    telegram.sent.push(payload);
    return payload.reply_markup !== undefined && !telegram.deliver ? undefined : { message_id: telegram.sent.length, chat: { id: payload.chat_id } };
  } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.requests.push(request.request as never);
    const writer = request.request.response_format !== undefined;
    const last = request.request.messages.at(-1)?.content ?? '';
    const asks = !writer && !request.request.tool_turns?.length && last.includes(ASK);
    const reads = !writer && !request.request.tool_turns?.length && last.includes(READ);
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : asks || reads ? '' : 'Done.';
    const call = asks ? { call_id: 'connect-1', name: 'connect_service', arguments: JSON.stringify({ service: 'google', feature: 'calendar' }) } : reads ? { call_id: 'read-1', name: 'query_calendar', arguments: '{}' } : null;
    return { ok: true as const, data: { model: request.request.model, text, ...(call ? { tool_calls: [call] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
// A calendar read on a dead grant: the client reports invalid_grant to the host, as the token refresh does, then fails 401.
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, health: (error: string) => void, account: unknown) => ({
    account, events: async () => [],
    calendarPage: async () => { health('invalid_grant'); throw new original.GoogleError(401, 'invalid_grant'); },
  }) };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const google = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', TELEGRAM_WEBHOOK_SECRET: 'synthetic-state-secret' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const rpcs: string[] = [];
beforeEach(() => {
  model.requests = []; telegram.sent = []; telegram.deliver = true; rpcs.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) rpcs.push(fn);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'connect_session_issue') return Response.json('session-1');
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// The connect_service result the reply model read on the round after it asked.
const connectResult = () => JSON.stringify(model.requests.find(request => JSON.stringify(request.tool_turns ?? []).includes('connect_service'))?.tool_turns);
const traceHops = (state: DurableObjectState) => state.storage.sql.exec<{ hop: string; ok: number }>('SELECT hop, ok FROM trace_log').toArray().map(row => `${row.hop}:${row.ok}`);

describe('connecting Google from a chat turn', () => {
  it('on the app, no button is sent or claimed, no link is minted, and the model is told where the owner connects', async () => {
    const name = 'connect-app-turn';
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      await state.storage.put('origin', 'https://fixture.invalid');
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      try {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-connect-0001', text: ASK }) }));
        expect(sent.status).toBe(202);
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        const result = connectResult();
        expect(result).toContain('go back to Home, open the menu at the top left, tap Connections and connect Google there');
        expect(result).not.toContain(SENT_CLAIM);
        expect(rpcs).not.toContain('connect_session_issue');
        expect(await state.storage.get('connect:offers')).toBeUndefined();
        expect([...state.storage.kv.list({ prefix: 'connect_channel:' })]).toEqual([]);
        expect(traceHops(state).filter(hop => hop.startsWith('oauth_link_sent'))).toEqual([]);
        const prompts = JSON.stringify(model.requests);
        expect(prompts).toContain('Google features not connected for this owner');
        expect(prompts).not.toMatch(/button is sent|button is in the chat/);
      } finally { await state.storage.deleteAlarm(); }
    });
  });

  it('on the app, a grant that stops working mints no link: the Connections screen shows it needs a reconnect', async () => {
    const name = 'connect-app-reauth';
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, ...google, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      try {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-reauth-0001', text: READ }) }));
        expect(sent.status).toBe(202);
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        await vi.waitFor(() => expect(traceHops(state)).toContain('google_reauth_notice_skipped:1'), { timeout: 5_000, interval: 20 });
        expect(await state.storage.get('google:health')).toEqual({ 'local:owner@example.test': 'invalid_grant' });
        expect(rpcs).not.toContain('connect_session_issue');
        expect([...state.storage.kv.list({ prefix: 'connect_channel:' })]).toEqual([]);
        expect(traceHops(state).filter(hop => hop.startsWith('oauth_link_sent'))).toEqual([]);
        expect(await state.storage.get('google:reauth-noticed')).toBeUndefined();
      } finally { await state.storage.deleteAlarm(); }
    });
  });

  it.each([
    ['delivered', true],
    ['blocked', false],
  ] as const)('on Telegram, the model hears of a button only when one was delivered (%s)', async (_case, deliver) => {
    const name = `connect-telegram-${deliver}`;
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      const originalNow = Date.now;
      let now = Date.parse('2026-10-12T06:00:00Z');
      Date.now = () => now;
      telegram.deliver = deliver;
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, ...google, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
      await state.storage.put('origin', 'https://fixture.invalid');
      try {
        const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 100, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: ASK } }) }));
        expect(response.status).toBe(200);
        for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
        const result = connectResult();
        expect(result).toBeDefined();
        if (deliver) expect(result).toContain(SENT_CLAIM);
        else expect(result).not.toContain(SENT_CLAIM);
        expect(telegram.sent.some(payload => JSON.stringify(payload).includes('Connect Google'))).toBe(true);
      } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
    });
  });
});
