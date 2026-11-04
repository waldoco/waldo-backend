import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// An owner's app chat holds a live summary of its oldest rows. One real app turn runs through an OwnerDO built with the
// WALDO_COMPACTION value a deployed Worker reads, and the request the model receives shows whether the summary replaced
// the rows it covers.
const OWNER_ID = '6d2f0a8e-41c7-4b9e-a3d5-8e1c7f2b9a04';
const BASE = 'https://directory.fixture.invalid';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const TENANT = `ten_${OWNER_ID.replaceAll('-', '')}`;
const CHAT = `owner:${PRINCIPAL}`;
const NEXT = 'What is on today?';
const SUMMARY = 'Owner instructions:\n- The owner prefers harbour walks.';
const DEPLOYED = (parseJsonc(config) as { vars: { WALDO_COMPACTION?: string } }).vars.WALDO_COMPACTION;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : true };
});
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
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
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

const asked = (n: number) => `Early question ${n}: which harbour path is quietest`;
const answered = (n: number) => `Early answer ${n}: the east path is quietest`;
const recent = 'Recent question: move the Thursday call';
const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, at: number): ConversationEntry => ({
  id, ownerId: PRINCIPAL, chatId: CHAT, parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt: at,
});

// The chain a long app chat leaves: four rounds, then a summary of the first two written through the store's own append,
// so the chat's live-summary key exists as it does after a real compaction.
const seed = async (state: DurableObjectState) => {
  const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } } as never, assertCurrent: async () => undefined, conversationRef: CHAT });
  const rows: ConversationEntry[] = [];
  let parent: string | null = null;
  for (let n = 0; n < 4; n += 1) {
    const text = n < 2 ? asked(n) : n === 2 ? 'Middle question: book the ferry' : recent;
    rows.push(row(`app-u${n}`, parent, 'user', text, 1_000 + n * 10), row(`app-u${n}-reply`, `app-u${n}`, 'assistant', n < 2 ? answered(n) : `Reply ${n}: done`, 1_001 + n * 10));
    parent = `app-u${n}-reply`;
  }
  await store.save(rows, parent!);
  await store.appendCompaction!({
    id: 'app-u1-reply-compaction', ownerId: PRINCIPAL, chatId: CHAT, parentId: 'app-u1-reply', threadAnchorId: null, surface: 'app', modelPayload: SUMMARY, appPayload: '',
    modelProjection: { mode: 'include' }, role: 'compaction', covers: { from_id: 'app-u0', to_id: 'app-u1-reply', rows: 4 }, createdAt: 1_500,
  }, null);
};

// What one app turn sends the model for its reply, as the Worker's environment built with `switchValue` would run it.
const turnRequest = async (name: string, switchValue: string | undefined) => {
  directory();
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    await seed(state);
    const owner = new OwnerDO(state, { ...env, WALDO_COMPACTION: switchValue, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-what-is-on-today', text: NEXT }) }));
    expect(sent.status, await sent.clone().text()).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const replies = model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(NEXT));
    expect(replies.length, 'the turn reached the model').toBeGreaterThan(0);
    return JSON.stringify(replies[0]!.messages);
  });
};

it('the deployed Worker setting is off, and an app turn on it sends the covered rows verbatim, never the summary', async () => {
  expect(DEPLOYED).toBe('off');
  expect((env as { WALDO_COMPACTION?: string }).WALDO_COMPACTION).toBe(DEPLOYED);
  const sent = await turnRequest('compaction-wiring-deployed', DEPLOYED);
  for (const text of [asked(0), answered(0), asked(1), answered(1), recent, NEXT]) expect(sent).toContain(text);
  expect(sent).not.toContain('harbour walks');
  expect(sent).not.toContain('summary of');
});

it('an app turn with the switch on reads the summary first and leaves out the rows it covers', async () => {
  const sent = await turnRequest('compaction-wiring-on', 'on');
  expect(sent.indexOf('harbour walks')).toBeGreaterThanOrEqual(0);
  expect(sent.indexOf('harbour walks')).toBeLessThan(sent.indexOf('Middle question'));
  for (const text of [asked(0), answered(0), asked(1), answered(1)]) expect(sent).not.toContain(text);
  for (const text of ['Middle question', recent, NEXT]) expect(sent).toContain(text);
});
