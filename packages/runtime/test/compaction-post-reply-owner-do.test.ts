import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION_INSTRUCTION } from '../src/conversation/compaction';
import { CONVERSATION_INPUT_BUDGET_TOKENS } from '../src/conversation/window';
import { claimStore } from '../src/memory/claims';
import { forgetPurge } from '../src/memory/forget-purge';
import { ensureSchema } from '../src/tracer/schema';

// A long app chat, then one real app turn through an OwnerDO built with the deploy's WALDO_COMPACTION value. After the
// turn's reply is saved and its inbox record settled, the owner object compacts the chain on its own: nothing calls it.
const OWNER_ID = '6d2f0a8e-41c7-4b9e-a3d5-8e1c7f2b9a04';
const BASE = 'https://directory.fixture.invalid';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const TENANT = `ten_${OWNER_ID.replaceAll('-', '')}`;
const CHAT = `owner:${PRINCIPAL}`;
const PREFIX = `canonical-owner-v1:${PRINCIPAL}:${TENANT}:`;
const SUMMARY = 'Owner instructions:\n- The owner prefers harbour walks.';

type Request = LLMGatewayRequest['request'];
const model = vi.hoisted(() => ({
  requests: [] as LLMGatewayRequest['request'][],
  calls: [] as { name: string; arguments: string }[],
  // What the compaction call answers, from what it was given; and work to run while that call is in flight.
  summary: (_input: string): string => 'Owner instructions:\n- The owner prefers harbour walks.',
  during: async (): Promise<void> => undefined,
}));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const { COMPACTION_INSTRUCTION: instruction } = await import('../src/conversation/compaction');
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (request.request.system === instruction) {
      await model.during();
      return answer(model.summary(JSON.stringify(request.request.messages)));
    }
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = request.request.tool_turns?.length ? undefined : model.calls.shift();
    return call ? answer('', [{ call_id: `call-${model.requests.length}`, ...call }]) : answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => {
  vi.unstubAllGlobals();
  model.requests = []; model.calls = [];
  model.summary = () => SUMMARY; model.during = async () => undefined;
});

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

// Twelve rounds of about three quarters of the model's history budget, so one more turn carries the chain past the
// trigger. Round 0 opens the chat; round 1 books the Lotus Hall; both fall in the span a summary replaces.
const ROUNDS = 12;
const filler = (n: number, side: string) => `${side} ${n}: ${'harbour '.repeat(Math.ceil((CONVERSATION_INPUT_BUDGET_TOKENS * 4 * 0.78) / ROUNDS / 2 / 8))}`;
const asked = (n: number) => n === 0 ? `Opening question: which path is quietest. ${filler(n, 'Owner')}` : n === 1 ? `Book the Lotus Hall for the party. ${filler(n, 'Owner')}` : filler(n, 'Owner');
const answered = (n: number) => filler(n, 'Waldo');
const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, at: number): ConversationEntry => ({
  id, ownerId: PRINCIPAL, chatId: CHAT, parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt: at,
});
const seed = async (state: DurableObjectState) => {
  const store = canonicalOwnerConversationStore(state.storage, { invocation: { verified_authority: { principal_ref: PRINCIPAL, tenant_ref: TENANT } } as never, assertCurrent: async () => undefined, conversationRef: CHAT });
  const rows: ConversationEntry[] = [];
  let parent: string | null = null;
  for (let n = 0; n < ROUNDS; n += 1) {
    rows.push(row(`app-u${n}`, parent, 'user', asked(n), 1_000 + n * 10), row(`app-u${n}-reply`, `app-u${n}`, 'assistant', answered(n), 1_001 + n * 10));
    parent = `app-u${n}-reply`;
  }
  await store.save(rows, parent!);
  return rows;
};

// Each owner object is cleared afterwards, alarm included, so no wake it armed runs into a later test's model counts.
const inOwner = <T,>(name: string, work: (state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try { return await work(state); } finally { await state.storage.deleteAlarm(); await state.storage.deleteAll(); }
  });
const ownerFor = async (name: string, state: DurableObjectState, compaction: string | undefined) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, WALDO_COMPACTION: compaction, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
};
const send = async (owner: InstanceType<typeof OwnerDO>, name: string, text: string) => {
  const sent = await owner.fetch(new globalThis.Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, '-')}`, text }) }));
  expect(sent.status, await sent.clone().text()).toBe(202);
  return (await sent.json() as { message_id: string }).message_id;
};
const settled = (state: DurableObjectState, id: string) =>
  vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 15_000, interval: 20 });
// One app turn, run until its inbox record settles and the serial work queued behind it (the compaction) has finished.
const turn = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string, call?: { name: string; args: unknown }) => {
  if (call) model.calls.push({ name: call.name, arguments: JSON.stringify(call.args) });
  const id = await send(owner, name, text);
  await settled(state, id);
  await drained(owner);
  return id;
};
// The owner object's serial queue: a no-op queued now runs after everything queued before it.
const drained = (owner: InstanceType<typeof OwnerDO>) => (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
const stored = (state: DurableObjectState) => [...state.storage.kv.list<ConversationEntry>({ prefix: `${PREFIX}conv:` })].map(([, entry]) => entry);
const summaries = (state: DurableObjectState) => stored(state).filter(entry => entry.role === 'compaction');
const compactions = () => model.requests.filter(request => request.system === COMPACTION_INSTRUCTION);
const replyTo = (text: string): Request[] => model.requests.filter(request => request.response_format === undefined && request.system !== COMPACTION_INSTRUCTION && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(text));

it('with the switch on, one reply past the trigger compacts the chain once; the next turn reads [summary] + tail and the transcript keeps every row', async () => {
  directory();
  const name = 'compaction-post-reply-on';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    const seeded = await seed(state);
    await turn(owner, state, name, 'What is on today?');
    expect(compactions()).toHaveLength(1);
    // The span the summary replaces carries the oldest rounds, the Lotus Hall booking among them.
    expect(JSON.stringify(compactions()[0]!.messages)).toContain('Lotus Hall');
    expect(summaries(state).map(entry => entry.modelPayload)).toEqual([SUMMARY]);
    expect(typeof state.storage.kv.get(`${PREFIX}compaction-attempt:${CHAT}`)).toBe('number');

    await turn(owner, state, name, 'And tomorrow?');
    expect(compactions(), 'one compaction per span and interval').toHaveLength(1);
    const next = JSON.stringify(replyTo('And tomorrow?')[0]!.messages);
    expect(next.indexOf('harbour walks')).toBeGreaterThanOrEqual(0);
    expect(next.indexOf('harbour walks')).toBeLessThan(next.indexOf(`Owner ${ROUNDS - 1}:`));
    expect(next).not.toContain('Opening question');
    expect(next).toContain('What is on today?');

    // The owner's transcript is unchanged: every seeded row is stored as it was, with both new rounds after it.
    const rows = new Map(stored(state).map(entry => [entry.id, entry]));
    for (const entry of seeded) expect(rows.get(entry.id)?.appPayload).toBe(entry.appPayload);
    expect(stored(state).filter(entry => entry.role === 'user').map(entry => entry.appPayload).slice(-2)).toEqual(['What is on today?', 'And tomorrow?']);
  });
});

it('with the switch off, no compaction or flush call is made, no attempt is noted, and the turn sends the model what it sent before', async () => {
  directory();
  const sentWith = async (name: string, compaction: string | undefined) => inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, compaction);
    await seed(state);
    await turn(owner, state, name, 'What is on today?');
    const sent = { requests: [...model.requests], attempt: state.storage.kv.get(`${PREFIX}compaction-attempt:${CHAT}`), summaries: summaries(state).length };
    model.requests = [];
    return sent;
  });
  const off = await sentWith('compaction-post-reply-off', 'off');
  expect(off.requests.filter(request => request.system === COMPACTION_INSTRUCTION || request.response_format?.name === 'claim_ops')).toEqual([]);
  expect(off.attempt).toBeUndefined();
  expect(off.summaries).toBe(0);
  // Before any summary exists the switch changes nothing the turn sends: the reply's history is byte for byte the same.
  const on = await sentWith('compaction-post-reply-on-first', 'on');
  const reply = (requests: readonly Request[]) => JSON.stringify(requests.filter(request => request.response_format === undefined && request.system !== COMPACTION_INSTRUCTION).map(request => request.messages));
  expect(reply(on.requests)).toBe(reply(off.requests));
  expect(on.summaries).toBe(1);
});

it('a topic the owner forgets in the turn never reaches the summary call or the stored summary', async () => {
  directory();
  const name = 'compaction-post-reply-forget';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    // The fake summary repeats the topic whenever its input carries it.
    model.summary = input => input.includes('Lotus Hall') ? `Decisions:\n- The party is at the Lotus Hall.` : SUMMARY;
    await turn(owner, state, name, 'Please forget the Lotus Hall plan', { name: 'forget_memory', args: { topic: 'Lotus Hall', scope_note: 'the party plan' } });
    expect(compactions(), 'the forget turn was a reply past the trigger').toHaveLength(1);
    expect(JSON.stringify(compactions()[0]!.messages)).not.toContain('Lotus Hall');
    expect(JSON.stringify(summaries(state))).not.toContain('Lotus Hall');
    expect(summaries(state).map(entry => entry.modelPayload)).toEqual([SUMMARY]);
  });
});

it('a topic still pending from an earlier forget is cleaned from the chain before the summary reads it', async () => {
  directory();
  const name = 'compaction-post-reply-held';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    // A console forget whose first purge pass left the conversation uncleaned: the topic is pending, its rows still carry it.
    const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    memory.barrier('Lotus Hall', new Date().toISOString());
    await forgetPurge({ sql: state.storage.sql, store: memory, now: Date.now, arm: async () => undefined, stores: [{ name: 'conversation', run: async () => 1 }] }).track(['Lotus Hall'], 'history');
    expect(memory.pendingTopics()).toEqual(['Lotus Hall']);
    expect(JSON.stringify(stored(state))).toContain('Lotus Hall');
    model.summary = input => input.includes('Lotus Hall') ? `Decisions:\n- The party is at the Lotus Hall.` : SUMMARY;
    await turn(owner, state, name, 'What is on today?');
    expect(compactions()).toHaveLength(1);
    expect(JSON.stringify(compactions()[0]!.messages)).not.toContain('Lotus Hall');
    expect(summaries(state).map(entry => entry.modelPayload)).toEqual([SUMMARY]);
    // The turn's cleaning pass finished the purge before the compaction ran, so it read redacted rows.
    expect(memory.pendingTopics()).toEqual([]);
    expect(JSON.stringify(stored(state))).not.toContain('Lotus Hall');
  });
});

it('a summary that carries a health number is not stored, and the attempt still counts', async () => {
  directory();
  const name = 'compaction-post-reply-health';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    model.summary = () => 'Facts:\n- The owner slept 5 hours and prefers harbour walks.';
    await turn(owner, state, name, 'What is on today?');
    expect(compactions()).toHaveLength(1);
    expect(summaries(state)).toEqual([]);
    expect(JSON.stringify(stored(state))).not.toContain('slept 5 hours');
    expect(typeof state.storage.kv.get(`${PREFIX}compaction-attempt:${CHAT}`)).toBe('number');
  });
});

it('an owner message sent while the summary is being written is kept, answered after it, and in order', async () => {
  directory();
  const name = 'compaction-post-reply-mid';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    let late = '';
    model.during = async () => { model.during = async () => undefined; late = await send(owner, name, 'One more thing: book the ferry'); };
    await turn(owner, state, name, 'What is on today?');
    expect(late, 'the message arrived while the summary call was in flight').not.toBe('');
    await settled(state, late);
    await drained(owner);
    expect(compactions()).toHaveLength(1);
    expect(summaries(state)).toHaveLength(1);
    const owners = stored(state).filter(entry => entry.role === 'user').map(entry => entry.appPayload);
    expect(owners.slice(-2)).toEqual(['What is on today?', 'One more thing: book the ferry']);
    // The late message continues the chain from the first reply, never from the summary row.
    const lateRow = stored(state).find(entry => entry.appPayload === 'One more thing: book the ferry')!;
    expect(stored(state).find(entry => entry.id === lateRow.parentId)?.role).toBe('assistant');
    expect(JSON.stringify(replyTo('book the ferry')[0]!.messages)).toContain('harbour walks');
  });
});
