import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { startConsent, type ConsentFlow } from '../src/connectors/google-consent';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A zone the owner confirms in chat reaches what the owner object built for earlier turns: the approval desk formats a
// calendar proposal's times in the zone it was built with, so the next turn's card reads in the new zone.
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const OWNER_ID = '9e4b2c71-5a8d-4f3e-b0c6-7d1a2f9e8b45';
const BASE = 'https://directory.fixture.invalid';
const DAY = 86_400_000;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], calls: [] as { name: string; arguments: string }[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = model.calls.shift();
    return call ? answer('', [{ call_id: `call-${model.requests.length}`, ...call }]) : answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.calls = []; });

const directory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  if (url === `${BASE}/functions/v1/connector-proxy`) {
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (body.op === 'exchange') return Response.json({ id: 'conn-1', email: 'owner@example.test', scopes: [...MAIL, CALENDAR] });
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
  if (fn === 'set_owner_settings') return Response.json(true);
  return new Response('unexpected', { status: 500 });
});
const ownerFor = async (name: string, state: DurableObjectState) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
};
const connect = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => {
  const store = { read: async () => (await state.storage.get<Record<string, ConsentFlow>>('google:consents')) ?? {}, write: (flows: Record<string, ConsentFlow>) => state.storage.put('google:consents', flows) };
  const { nonce } = await startConsent({ store, now: () => Date.now() }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://fixture.invalid/oauth/google/callback' }, 'state-secret-fixture', '7');
  const reply = await owner.fetch(new Request(`https://owner.invalid${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce, code: 'synthetic-code', error: null }) }));
  expect((await reply.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
};
// One app turn, run to completion. A queued call is what the model answers with first; the next round replies.
const send = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string, call: { name: string; args: unknown }) => {
  model.calls.push({ name: call.name, arguments: JSON.stringify(call.args) });
  const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'd'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, '-')}`, text }) }));
  expect(sent.status, await sent.clone().text()).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
};

it('after the owner confirms a zone in chat, the next turn\'s calendar proposal reads in that zone', async () => {
  directory();
  const name = 'zone-rebuild-desk';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    try {
      await connect(owner, state);
      await send(owner, state, name, 'I live in Kolkata now', { name: 'set_timezone', args: { timezone: 'Asia/Kolkata' } });
      expect(state.storage.kv.get('timezone_confirmed')).toBe(true);

      // 12:00 UTC is 17:30 in Kolkata.
      await send(owner, state, name, 'add the dentist on Tuesday at 5:30pm', { name: 'propose_calendar_change', args: { action: 'create', title: 'Dentist', start: '2026-10-20T12:00:00+00:00', end: '2026-10-20T12:30:00+00:00', reason: 'the owner asked' } });
      const cards = state.storage.sql.exec<{ summary: string }>("SELECT summary FROM ledger WHERE kind = 'calendar_change'").toArray();
      expect(cards.length, 'the proposal reached the desk').toBe(1);
      expect(cards[0]!.summary, 'the card reads in the confirmed zone').toContain('17:30');
      expect(cards[0]!.summary).not.toContain('12:00');
    } finally { await state.storage.deleteAlarm(); }
  });
}, 30_000);
