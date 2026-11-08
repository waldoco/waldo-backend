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
import { COMPACTION_DUE_KEY } from '../src/scheduler/alarm-slot';

// WALDO_COMPACTION_WAKE: the app turn that makes a chain due leaves its compaction to a later alarm pass of its own, so the
// pass that ran the owner's turn never also runs a summary call.
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
  during: async (_signal?: AbortSignal): Promise<void> => undefined,
  // Work to run while a reply call (not the summary) is in flight; and what happened, in order.
  onReply: async (): Promise<void> => undefined,
  events: [] as string[],
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
      model.events.push('summary_started');
      await model.during(request.runScope?.signal);
      model.events.push('summary_returned');
      return answer(model.summary(JSON.stringify(request.request.messages)));
    }
    if (format === undefined) { model.events.push(`reply:${JSON.stringify(request.request.messages.at(-1)?.content ?? '').slice(1, 30)}`); await model.onReply(); }
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
  model.summary = () => SUMMARY; model.during = async () => undefined; model.onReply = async () => undefined; model.events = [];
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
const ownerFor = async (name: string, state: DurableObjectState, compaction: string | undefined, extra: Readonly<Record<string, string>> = {}) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, WALDO_COMPACTION: compaction, WALDO_COMPACTION_WAKE: '1', SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...extra });
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

it('the turn that makes a chain due arms a compaction wake and runs no summary call; the next alarm pass compacts it', async () => {
  directory();
  const name = 'compaction-wake-on';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    await turn(owner, state, name, 'What is on today?');
    expect(compactions(), 'no summary call in the pass that ran the turn').toHaveLength(0);
    expect(summaries(state)).toHaveLength(0);
    expect(typeof state.storage.kv.get(COMPACTION_DUE_KEY)).toBe('number');
    const alarm = await state.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 3_000);

    await owner.alarm();
    await drained(owner);
    expect(compactions()).toHaveLength(1);
    expect(summaries(state).map(entry => entry.modelPayload)).toEqual([SUMMARY]);
    expect(state.storage.kv.get(COMPACTION_DUE_KEY)).toBeUndefined();

    // The next turn reads the summary first, as with the inline compaction.
    await turn(owner, state, name, 'And tomorrow?');
    expect(JSON.stringify(replyTo('And tomorrow?')[0]!.messages)).toContain('harbour walks');
    expect(compactions(), 'one compaction per span and interval').toHaveLength(1);
  });
});

type Pending = { app: { at: number }[]; chats: { chat: string; at: number }[] };
const PENDING = 'compaction_pending_v1';

it('a pass runs only the compactions asked for before it began, and keeps one asked for since for the next pass', async () => {
  directory();
  const name = 'compaction-wake-later';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    await turn(owner, state, name, 'What is on today?');
    const asked = state.storage.kv.get<Pending>(PENDING)!;
    expect(asked.app).toHaveLength(1);
    // As if this pass's own drain had just asked for the chain again.
    state.storage.kv.put(PENDING, { ...asked, app: [{ ...asked.app[0]!, at: Date.now() + 60_000 }] });
    await owner.alarm();
    await drained(owner);
    expect(compactions()).toHaveLength(0);
    expect(state.storage.kv.get<Pending>(PENDING)!.app).toHaveLength(1);
    expect(typeof state.storage.kv.get(COMPACTION_DUE_KEY)).toBe('number');
    state.storage.kv.put(PENDING, asked);
    await owner.alarm();
    await drained(owner);
    expect(compactions()).toHaveLength(1);
    expect(state.storage.kv.get(PENDING)).toBeUndefined();
  });
});

it('the owner\'s chain waits for a Telegram message already admitted, and is taken once none is', async () => {
  directory();
  const name = 'compaction-wake-telegram';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    state.storage.kv.put(PENDING, { app: [], chats: [{ chat: 'telegram', at: Date.now() - 1_000 }] });
    state.storage.kv.put('telegram_owner_inbox_v1', [{ id: 'row-1', digest: 'd', sequence: 1, updateId: 1, body: '{"update_id":1}', admittedAt: Date.now(), state: 'admitted', bot: 'fixture-bot', subject: '7', doName: name }]);
    await (owner as unknown as { compactDue(passStart: number): Promise<void> }).compactDue(Date.now());
    expect(state.storage.kv.get<Pending>(PENDING)!.chats.map(entry => entry.chat)).toEqual(['telegram']);
    state.storage.kv.delete('telegram_owner_inbox_v1');
    await (owner as unknown as { compactDue(passStart: number): Promise<void> }).compactDue(Date.now());
    expect(state.storage.kv.get(PENDING)).toBeUndefined();
    // Taking the chain set the Telegram runtime up; let it finish before the object is cleared.
    await (owner as unknown as { setup(surface: string): { ready: Promise<unknown> } }).setup('telegram').ready;
  });
});

type Lanes = { compactDue(passStart: number, alarmEnd?: number): Promise<void> };

it('a compaction the pass has no time left for stays pending, and the next pass with time runs it', async () => {
  directory();
  const name = 'compaction-wake-short-pass';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    await seed(state);
    await turn(owner, state, name, 'What is on today?');
    state.storage.kv.put(PENDING, { ...state.storage.kv.get<Pending>(PENDING)!, chats: [{ chat: 'telegram', at: Date.now() - 1_000 }] });
    // Ten seconds left in the pass: less than one compaction's budget.
    await (owner as unknown as Lanes).compactDue(Date.now() + 1, Date.now() + 10_000);
    expect(compactions()).toHaveLength(0);
    const kept = state.storage.kv.get<Pending>(PENDING)!;
    expect(kept.app).toHaveLength(1);
    expect(kept.chats.map(entry => entry.chat)).toEqual(['telegram']);
    expect(typeof state.storage.kv.get(COMPACTION_DUE_KEY)).toBe('number');
    await (owner as unknown as Lanes).compactDue(Date.now() + 1);
    await drained(owner);
    expect(compactions()).toHaveLength(1);
    expect(state.storage.kv.get(PENDING)).toBeUndefined();
    // The lane built the app and Telegram runtimes directly, not through alarm(); their setup settles before storage is cleared.
    for (const chat of ['app', 'telegram']) await (owner as unknown as { setup(chat: string): { ready: Promise<unknown> } }).setup(chat).ready;
  });
});

it('with NEXT_DUE_ALARM on, the compaction wake still runs its lane', async () => {
  directory();
  const name = 'compaction-wake-next-due';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on', { NEXT_DUE_ALARM: '1' });
    await seed(state);
    await turn(owner, state, name, 'What is on today?');
    expect(compactions()).toHaveLength(0);
    await owner.alarm();
    await drained(owner);
    expect(compactions()).toHaveLength(1);
    expect(state.storage.kv.get(PENDING)).toBeUndefined();
    expect(state.storage.kv.get(COMPACTION_DUE_KEY)).toBeUndefined();
  });
});

it('a compaction lane that throws keeps every request for the next pass and leaves an alarm armed', async () => {
  directory();
  const name = 'compaction-wake-throws';
  await inOwner(name, async (state) => {
    const owner = await ownerFor(name, state, 'on');
    state.storage.kv.put(PENDING, { app: [], chats: [{ chat: 'telegram', at: Date.now() - 1_000 }] });
    state.storage.kv.put(COMPACTION_DUE_KEY, Date.now() - 1_000);
    vi.spyOn(owner as unknown as { compactTimeline(): Promise<void> }, 'compactTimeline').mockRejectedValue(new Error('synthetic compaction failure'));
    await owner.alarm().catch(() => undefined);
    expect(state.storage.kv.get<Pending>(PENDING)!.chats.map(entry => entry.chat)).toEqual(['telegram']);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});
