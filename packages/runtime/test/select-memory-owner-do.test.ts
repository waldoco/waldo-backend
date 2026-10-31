import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { NIGHTLY_THROUGH_KEY } from '../src/channels/episodes';

// MEMORY_SELECTION=1 through the owner object: an app turn (a nested responder on a run scope) shows option B, judging what
// is new by the nightly's own consolidated-through mark. Synthetic fixtures only.
const OWNER_ID = '3b8e2f4a-7c1d-4e9a-b6f0-2d5c8a1e7f39';
const BASE = 'https://directory.fixture.invalid';

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

const appTurn = async (name: string, selection: string) => {
  directory();
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    memory.add({ kind: 'fact', text: 'The owner goes by Sam', evidence: 'Sam', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-30T08:00:00Z');
    memory.add({ kind: 'fact', text: 'The owner keeps the spare key with the neighbour', evidence: 'key', source: 'stated', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-30T08:00:00Z');
    memory.add({ kind: 'fact', text: 'The owner moved the grocery run to Thursdays', evidence: 'grocery', source: 'stated', origin: 'owner', source_ref: 'owner, tg-3' }, '2026-10-31T08:00:00Z');
    expect(memory.pin(1, 'profile', 1)).toBe(true);
    state.storage.kv.put(NIGHTLY_THROUGH_KEY, Date.parse('2026-10-30T22:00:00Z'));
    const owner = new OwnerDO(state, { ...env, MEMORY_SELECTION: selection, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: 'What is on this week?' }) }));
    expect(sent.status, await sent.clone().text()).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const reply = model.requests.find(request => request.response_format === undefined && JSON.stringify(request.messages).includes('What is on this week'));
    expect(reply, 'the reply call reached the model').toBeDefined();
    return JSON.stringify(reply!.messages);
  });
};

it('with MEMORY_SELECTION=1, an app turn shows the pin and what is new since the nightly, not the reviewed fact', async () => {
  const shown = await appTurn('select-memory-owner-do-on', '1');
  expect(shown).toContain('owner_new');
  expect(shown).toContain('grocery run to Thursdays');
  expect(shown).toContain('goes by Sam');
  expect(shown).not.toContain('spare key');
});

it('with MEMORY_SELECTION=0, the same turn shows the newest facts as before', async () => {
  const shown = await appTurn('select-memory-owner-do-off', '0');
  expect(shown).toContain('owner_recent');
  expect(shown).toContain('spare key');
  expect(shown).not.toContain('owner_new');
});
