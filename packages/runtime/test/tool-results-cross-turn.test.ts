import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// These tests pin today's gap so a fix has to flip them: an earlier turn's tool result sits in the
// ledger, yet the reply model's request carries it on neither path.
const MARKER = 'BLUEFINCH-4417';
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
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const seedLedger = (state: DurableObjectState) => toolOutputLedger(state.storage).record({ tool: 'search_mail', ok: true, at: Date.now(), taint: 'external', summary: `Pat sent the ${MARKER} invoice on Tuesday.` });
const replyRequests = () => model.requests.filter(request => request.response_format === undefined);
// The ledger is the source the composer reads; without this the absence below could be a seeding failure.
const ledgerServes = async (state: DurableObjectState) => (await toolOutputLedger(state.storage).recent()).map(fragment => fragment.text).join('\n');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.sent = []; });

describe('an earlier tool result in the ledger, then one owner turn', () => {
  it('Telegram: the reply request carries no recent-tool-results section and not the result', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('cross-turn-telegram')), async (_instance, state) => {
      const originalNow = Date.now;
      let now = Date.parse('2026-10-12T06:59:00Z');
      Date.now = () => now;
      const owner = new TelegramOwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      state.storage.kv.put('do_name', 'cross-turn-telegram'); state.storage.kv.put('telegram_subject', '7');
      try {
        await seedLedger(state);
        expect(await ledgerServes(state)).toContain(MARKER);
        const response = await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: 100, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: 'what did you find in my mail earlier?' } }) }));
        expect(response.status).toBe(200);
        for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
        expect(model.sent.some(text => text.includes('Noted.'))).toBe(true);
        const replies = replyRequests();
        expect(replies.length).toBeGreaterThan(0);
        for (const request of replies) {
          expect(JSON.stringify(request)).not.toContain(MARKER);
          expect(request.system ?? '').not.toContain('<recent-tool-results>');
        }
        expect(await ledgerServes(state)).toContain(MARKER);
      } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
    });
  });

  it('app: the reply request carries an empty recent-tool-results section and not the result', async () => {
    const OWNER_ID = '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d';
    const name = 'cross-turn-app';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
      const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
      if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
      if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
      if (fn === 'assert_channel_presence') return Response.json(true);
      if (fn === 'health_context_read') return Response.json(null);
      return new Response('unexpected', { status: 500 });
    });
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      const owner = new TelegramOwnerDO(state, { ...env, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
      try {
        await seedLedger(state);
        expect(await ledgerServes(state)).toContain(MARKER);
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-cross-0001', text: 'what did you find in my mail earlier?' }) }));
        expect(sent.status).toBe(202);
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        const replies = replyRequests();
        expect(replies.length).toBeGreaterThan(0);
        for (const request of replies) {
          expect(JSON.stringify(request)).not.toContain(MARKER);
          expect(request.system ?? '').toContain('<recent-tool-results>');
          expect(request.system ?? '').toContain('No recent tool results.');
        }
        expect(await ledgerServes(state)).toContain(MARKER);
      } finally { await state.storage.deleteAlarm(); }
    });
  });
});
