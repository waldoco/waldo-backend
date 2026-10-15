import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { CONSOLE_ACTION_PATH, CONSOLE_COOKIE, CONSOLE_PATH, consoleAccess } from '../src/channels/console';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { startConsent, type ConsentFlow } from '../src/connectors/google-consent';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A Google connect hands the owner object the account's name and phone. The name reaches the next turn once, framed as
// unconfirmed; the phone reaches no prompt, no log and no outbound request, and never the owner's verified phone.
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const PHONE_SCOPE = 'https://www.googleapis.com/auth/user.phonenumbers.read';
const EMAIL = 'owner@example.test';
const PHONE = '+15550100777';
const NAMES = { name: 'Zoë Okonkwo-Ström', given_name: 'Zoë', family_name: 'Okonkwo-Ström' };
const LABEL = "From the owner's Google account, not yet confirmed by the owner";
const ASKED = 'what should you call me?';
const DAY = 86_400_000;
// Writers of the owner's own phone: the owners row, and the functions that set phone or phone_verified_at.
const OWNER_PHONE_WRITE = /phone_verified_at|\/rest\/v1\/owners\b|\/rpc\/(?:signup_owner_for_auth|owner_for_auth|[a-z_]*phone[a-z_]*)\b/;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], sent: [] as string[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => { if (method === 'sendMessage') { model.sent.push(payload.text ?? ''); return { message_id: model.sent.length, chat: { id: payload.chat_id } }; } return true; } };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const writer = request.request.response_format !== undefined;
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
// The local rail's readback client answers without reaching Google.
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original,
    googleAccessToken: async () => 'ya29.fixture',
    googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
      account, events: async () => [], calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
      event: async () => null, changedEvents: async () => [], newMail: async () => [],
    }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const idToken = (claims: Record<string, unknown>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  return `e30.${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;
};
const count = (text: string, part: string) => text.split(part).length - 1;
const asked = () => model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(ASKED));
const expectNameOnce = () => {
  const replies = asked();
  expect(replies.length, 'the owner turn reached the model').toBeGreaterThan(0);
  for (const request of replies) {
    expect(count(request.system ?? '', LABEL), 'the name line appears once').toBe(1);
    expect(request.system).toContain('"Zoë Okonkwo-Ström"');
    expect(JSON.stringify(request)).not.toContain(PHONE);
  }
};
const expectNoPhoneWrite = (outbound: readonly string[]) => {
  for (const line of outbound) {
    expect(line).not.toContain(PHONE);
    expect(line).not.toMatch(OWNER_PHONE_WRITE);
  }
};
// One consent attempt, settled through the owner object's own finish route.
const connect = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => {
  const store = { read: async () => (await state.storage.get<Record<string, ConsentFlow>>('google:consents')) ?? {}, write: (flows: Record<string, ConsentFlow>) => state.storage.put('google:consents', flows) };
  const { nonce } = await startConsent({ store, now: () => Date.now() }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://fixture.invalid/oauth/google/callback' }, 'state-secret-fixture', '7');
  const reply = await owner.fetch(new Request(`https://owner.invalid${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce, code: 'synthetic-code', error: null }) }));
  expect((await reply.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
};

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.sent = []; });

it('a proxy connect keeps the name and phone as a provider fact, the next app turn sees the name once and no phone, and a reconnect replaces it', async () => {
  const OWNER_ID = '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d';
  const BASE = 'https://directory.fixture.invalid';
  const edge: { id: string; profile?: unknown } = { id: 'conn-1', profile: { ...NAMES, phone: PHONE } };
  const outbound: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body ? String(init.body) : '';
    outbound.push(`${url} ${raw}`);
    if (url === `${BASE}/functions/v1/connector-proxy`) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.op === 'exchange') return Response.json({ id: edge.id, email: EMAIL, scopes: [...MAIL, CALENDAR], ...(edge.profile === undefined ? {} : { profile: edge.profile }) });
      if (body.op === 'gmail_watch') return Response.json({ data: { historyId: '555', expiration: Date.now() + 7 * DAY } });
      if (body.op === 'calendar_watch') return Response.json({ data: { channelId: body.channel_id, resourceId: 'res-1', expiration: Date.now() + 7 * DAY } });
      if (body.op === 'call') return Response.json({ data: [] });
      return Response.json({ error: { status: 404, message: 'unknown operation' } });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const args = raw ? JSON.parse(raw) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  const name = 'google-profile-proxy-app';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    const logs = vi.spyOn(console, 'log');
    try {
      // The consent finish settles on the Telegram runtime, so the fixture carries a bot token beside the app.
      await connect(owner, state);
      expect(await state.storage.get('google:profiles')).toEqual({ 'conn-1': { ...NAMES, phone: PHONE, at: expect.any(Number) } });
      const connectLogs = JSON.stringify(logs.mock.calls);
      expect(connectLogs, 'connect logs carry no name').not.toContain('Okonkwo');
      expect(connectLogs, 'connect logs carry no phone').not.toContain(PHONE);

      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: ASKED }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      expectNameOnce();

      // A reconnect gives a new connection and no phone (the owner withheld that scope): the old profile goes with it.
      edge.id = 'conn-2';
      edge.profile = NAMES;
      await connect(owner, state);
      expect(await state.storage.get('google:profiles')).toEqual({ 'conn-2': { ...NAMES, at: expect.any(Number) } });
      // An edge that predates the profile says nothing about it, so the kept profile stands.
      edge.profile = undefined;
      await connect(owner, state);
      expect(await state.storage.get('google:profiles')).toEqual({ 'conn-2': { ...NAMES, at: expect.any(Number) } });

      expectNoPhoneWrite(outbound);
      expect(JSON.stringify(logs.mock.calls), 'no log carries the phone').not.toContain(PHONE);
    } finally { logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('a local connect keeps the profile too, and a Telegram turn without the composer carries the name once in its own section', async () => {
  const real = globalThis.fetch;
  const outbound: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push(`${url} ${init?.body ? String(init.body) : ''}`);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-fixture', refresh_token: 'rt-fixture', id_token: idToken({ email: EMAIL, ...NAMES }), scope: ['openid', 'https://www.googleapis.com/auth/userinfo.profile', ...MAIL, CALENDAR, PHONE_SCOPE].join(' ') });
    if (url.startsWith('https://people.googleapis.com/v1/people/me')) return Response.json({ phoneNumbers: [{ value: '555 0100 777', canonicalForm: PHONE, metadata: { primary: true } }] });
    return real(input, init);
  });
  const name = 'google-profile-local-telegram';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    let now = Date.now();
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: undefined, SUPABASE_PUBLISHABLE_KEY: undefined, WALDO_ROUTER_HMAC_SECRET: undefined, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    const logs = vi.spyOn(console, 'log');
    try {
      await connect(owner, state);
      expect(await state.storage.get('google:profiles')).toEqual({ [`local:${EMAIL}`]: { ...NAMES, phone: PHONE, at: expect.any(Number) } });
      Date.now = () => now;
      const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 100, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: ASKED } }) }));
      expect(response.status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
      expect(model.sent.some(text => text.includes('Noted.'))).toBe(true);
      expectNameOnce();
      const replies = logs.mock.calls.flatMap(([raw]) => { try { const json = JSON.parse(String(raw)) as { hop?: string; shape?: { context?: { system_sections?: Record<string, number> } } }; return json.hop === 'llm_reply' ? [json] : []; } catch { return []; } });
      expect.soft(replies.some(entry => (entry.shape?.context?.system_sections?.owner_profile ?? 0) > 0), 'the tail line is measured in its own section').toBe(true);
      expectNoPhoneWrite(outbound);
      expect(JSON.stringify(logs.mock.calls), 'no log carries the phone').not.toContain(PHONE);
    } finally { Date.now = originalNow; logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
});

it('a console disconnect removes the kept profile, phone included, and a connect with an empty profile clears it', async () => {
  const BASE = 'https://directory.fixture.invalid';
  const real = globalThis.fetch;
  const edge: { profile: unknown } = { profile: { ...NAMES, phone: PHONE } };
  const revoked: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(BASE)) return real(input, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    if (url === `${BASE}/functions/v1/connector-proxy`) {
      if (body.op === 'exchange') return Response.json({ id: 'conn-1', email: EMAIL, scopes: [...MAIL, CALENDAR], profile: edge.profile });
      if (body.op === 'gmail_watch') return Response.json({ data: { historyId: '555', expiration: Date.now() + 7 * DAY } });
      if (body.op === 'calendar_watch') return Response.json({ data: { channelId: body.channel_id, resourceId: 'res-1', expiration: Date.now() + 7 * DAY } });
      if (body.op === 'call') return Response.json({ data: [] });
      return Response.json({ error: { status: 404, message: 'unknown operation' } });
    }
    if (url === `${BASE}/rest/v1/rpc/connection_revoke`) { revoked.push(body.p_connection ?? ''); return Response.json(true); }
    return new Response('unexpected', { status: 500 });
  });
  const name = 'google-profile-disconnect';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
    const stored = async () => {
      const all = await state.storage.list();
      expect(all.has('do_name'), 'the listing holds what the sync API wrote').toBe(true);
      return JSON.stringify([...all]);
    };
    const access = consoleAccess(state.storage);
    const token = await access.grant();
    const { csrf } = (await access.session(token))!;
    try {
      await connect(owner, state);
      expect(await stored(), 'the scan finds the kept phone').toContain(PHONE);
      const reply = await owner.fetch(new Request(`https://owner.invalid${CONSOLE_ACTION_PATH}`, { method: 'POST', headers: { cookie: `${CONSOLE_COOKIE}=${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, action: 'google.disconnect', id: 'conn-1' }) }));
      expect(reply.headers.get('location')).toBe(`${CONSOLE_PATH}?m=google.disconnect`);
      expect(revoked).toEqual(['conn-1']);
      expect(await state.storage.get('google:accounts')).toEqual([]);
      expect.soft(await state.storage.get('google:profiles'), 'the disconnected account keeps no profile').toEqual({});
      const left = await stored();
      for (const kept of [PHONE, ...Object.values(NAMES)]) expect.soft(left, 'no object KV entry carries the phone or a name').not.toContain(kept);

      // A connect with no name claims and no phone sends an empty profile: it clears the kept one, and the account stays.
      await connect(owner, state);
      expect(await state.storage.get('google:profiles')).toEqual({ 'conn-1': { ...NAMES, phone: PHONE, at: expect.any(Number) } });
      edge.profile = {};
      await connect(owner, state);
      expect(await state.storage.get('google:accounts')).toEqual([expect.objectContaining({ id: 'conn-1' })]);
      expect(await state.storage.get('google:profiles')).toEqual({});
      expect(await stored()).not.toContain(PHONE);
    } finally { await state.storage.deleteAlarm(); }
  });
});
