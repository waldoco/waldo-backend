import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { HEALTH_SAVED_KEY } from '../src/channels/health-memory';
import { ensureSchema } from '../src/tracer/schema';

// A health note Waldo kept on its own, through the owner object as it runs: the app shows the owner how many notes, never
// their words or ids, and the next turn's model reads that reply back with the ids, so "forget that" can name them.
// Synthetic fixtures only.
const OWNER_ID = '5d2a7c41-8e3b-4f60-9a1d-3c7b2e6f8a05';
const BASE = 'https://directory.fixture.invalid';
const NOTE = 'Sleeps badly after late coffee';

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => {
    args[11] = gateway;
    return original.createTelegramResponder(...args);
  } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; });

const directory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = raw ? JSON.parse(raw) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  return new Response('unexpected', { status: 500 });
});

it('shows the owner a count, and gives the next turn\'s model the ids behind it', async () => {
  directory();
  const name = 'health-notice-owner-do';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    memory.add({ kind: 'health', text: NOTE, evidence: 'I sleep badly after late coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-26T08:00:00Z');
    const id = memory.allClaims().find((claim) => claim.text === NOTE)!.id;
    state.storage.kv.put(HEALTH_SAVED_KEY, [id]);
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' };
    const send = async (clientId: string, text: string) => {
      const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers, body: JSON.stringify({ client_message_id: clientId, text }) }));
      expect(sent.status, await sent.clone().text()).toBe(202);
      const { message_id: messageId } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${messageId}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      return messageId;
    };
    const first = await send('client-notice-0001', 'Morning.');
    const shown = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main', { headers }));
    const reply = (await shown.json() as { messages: { id: string; text: string }[] }).messages.find((message) => message.id === `${first}-reply`)!.text;
    expect(reply).toContain('I kept a note about your health from earlier.');
    expect(reply).not.toMatch(new RegExp(`c${id}\\b|coffee|Not shown`));
    expect(state.storage.kv.get(HEALTH_SAVED_KEY)).toBeUndefined();

    await send('client-notice-0002', 'Actually, forget that.');
    const asked = model.requests.filter((request) => request.response_format === undefined && JSON.stringify(request.messages).includes('Actually, forget that.'));
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.stringify(asked.at(-1)!.messages)).toContain(`the notes are c${id}.`);
  });
});
