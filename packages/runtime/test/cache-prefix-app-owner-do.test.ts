// The app chat through a real owner object, on the canonical store with compaction and the stepped window on, as staging
// runs it: a chat past its budget is cut once, compacted after its reply, and from then on each turn starts with what the
// turn before it sent; the trace marks the turns whose view moved, the summary's arrival among them.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION_INSTRUCTION } from '../src/conversation/compaction';
import { CONVERSATION_INPUT_BUDGET_TOKENS } from '../src/conversation/window';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const OWNER_ID = '7a1c5e2d-90b4-4f3a-8c6d-2e9b1f4a7c03';
const BASE = 'https://directory.fixture.invalid';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const TENANT = `ten_${OWNER_ID.replaceAll('-', '')}`;
const CHAT = `owner:${PRINCIPAL}`;
const PREFIX = `canonical-owner-v1:${PRINCIPAL}:${TENANT}:`;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const { COMPACTION_INSTRUCTION: instruction } = await import('../src/conversation/compaction');
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const answer = (text: string) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.system === instruction) return answer('Owner instructions:\n- The owner prefers harbour walks.');
    const format = request.request.response_format?.name;
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); model.requests = []; });

const directory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof globalThis.Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = raw ? JSON.parse(raw) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  return new Response('unexpected', { status: 500 });
});

// Sixteen rounds that together run past the history budget, so the first turn cuts the window and compaction is due after it.
const ROUNDS = 16;
const filler = (n: number, side: string) => `${side} ${n}: ${'harbour '.repeat(Math.ceil((CONVERSATION_INPUT_BUDGET_TOKENS * 4 * 1.3) / ROUNDS / 2 / 8))}`;
const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, at: number): ConversationEntry => ({
  id, ownerId: PRINCIPAL, chatId: CHAT, parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt: at,
});
const seed = async (state: DurableObjectState) => {
  const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } } as never, assertCurrent: async () => undefined, conversationRef: CHAT });
  const rows: ConversationEntry[] = [];
  let parent: string | null = null;
  for (let n = 0; n < ROUNDS; n += 1) {
    rows.push(row(`app-u${n}`, parent, 'user', filler(n, 'Owner'), 1_000 + n * 10), row(`app-u${n}-reply`, `app-u${n}`, 'assistant', filler(n, 'Waldo'), 1_001 + n * 10));
    parent = `app-u${n}-reply`;
  }
  await store.save(rows, parent!);
};
const ownerFor = async (name: string, state: DurableObjectState) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, WALDO_COMPACTION: 'on', WALDO_STEPPED_WINDOW: '1', SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
};
// One app turn, run until its inbox record settles and the serial work queued behind it (the compaction) has finished.
const turn = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string) => {
  const sent = await owner.fetch(new globalThis.Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, '-')}`, text }) }));
  expect(sent.status, await sent.clone().text()).toBe(202);
  const id = (await sent.json() as { message_id: string }).message_id;
  await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 15_000, interval: 20 });
  await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
};
const replyTo = (text: string) => model.requests.find(request => request.response_format === undefined && request.system !== COMPACTION_INSTRUCTION && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(text))!;
const moved = (logs: { mock: { calls: unknown[][] } }) => logs.mock.calls.flatMap(([raw]) => {
  try { const line = JSON.parse(String(raw)) as { hop?: string; shape?: { context?: { history_moved?: boolean } } }; return line.hop === 'llm_reply' && line.shape?.context?.history_moved !== undefined ? [line.shape.context.history_moved] : []; } catch { return []; }
});

it('an app chat past its budget is cut, then compacted; the turn the summary arrives on is marked moved, and the next starts with what it sent', async () => {
  directory();
  const name = 'cache-prefix-app';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const logs = vi.spyOn(console, 'log');
    try {
      const owner = await ownerFor(name, state);
      await seed(state);
      const said = ['What is on today?', 'And tomorrow?', 'Book the harbour walk at 7.', 'Move it to 8.'];
      for (const text of said) await turn(owner, state, name, text);
      const compacted = [...state.storage.kv.list<ConversationEntry>({ prefix: `${PREFIX}conv:` })].map(([, entry]) => entry).filter(entry => entry.role === 'compaction');
      expect(compacted).toHaveLength(1);
      // The first turn cuts; the second reads the summary first; the third and fourth hold.
      expect(moved(logs)).toEqual([true, true, false, false]);
      expect(state.storage.kv.get<{ head: string }>(`${PREFIX}window-start:${CHAT}`)?.head).toBe(compacted[0]!.id);
      for (const [before, after] of [[said[1]!, said[2]!], [said[2]!, said[3]!]] as const) {
        const history = replyTo(before).messages.slice(0, -1);
        expect(replyTo(after).messages.slice(0, history.length)).toEqual(history);
        expect(replyTo(after).system).toBe(replyTo(before).system);
      }
    } finally { await state.storage.deleteAlarm(); await state.storage.deleteAll(); }
  });
}, 120_000);
