import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appRatingResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { memoryUsedBook, memoryUsedFor } from '../src/channels/app-memory-used';
import { APP_CHAT_MEMORY_USED_MAX_V1 } from '../../contracts/src/app/core';
import { ensureSchema } from '../src/tracer/schema';

// Which notes a reply looked at: recorded against the owner message as ids, shown by chat revision 7, and read back as the
// claims stand now.
const REPLY = 'Synthetic reply marker quartz-heron';
const seen = vi.hoisted(() => ({ prompts: [] as string[], calls: [] as { name: string; arguments: string }[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    seen.prompts.push(JSON.stringify(request));
    const done = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = seen.calls.shift();
    return call ? done('', [{ call_id: `call-${seen.prompts.length}`, ...call }]) : done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
// Langfuse as the API answers it: OTLP traces in, scores created and deleted. `refuse` answers every score call with a status.
const langfuse = vi.hoisted(() => ({ calls: [] as { method: string; path: string; body: unknown }[], refuse: 0 }));
const LANGFUSE = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test', WALDO_ENVIRONMENT: 'staging' };
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  langfuse.calls = []; langfuse.refuse = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === 'https://langfuse.test') {
      langfuse.calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (langfuse.refuse && url.pathname.startsWith('/api/public/scores')) return new Response('refused', { status: langfuse.refuse });
      return url.pathname === '/api/public/scores' ? Response.json({ accepted: 1 }, { status: 202 }) : Response.json({});
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
type Owner = InstanceType<typeof OwnerDO>;
// One owner with `exchanges` exchanges in main chat; `run` gets the owner object, its storage and the newest pair's ids.
const withExchange = <T>(name: string, run: (owner: Owner, state: DurableObjectState, ids: Readonly<{ mine: string; reply: string }>) => Promise<T>, exchanges = 1, config: object = {}, seeds: readonly { text: string; kind?: string }[] = []) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...config });
    claimStore(state.storage.sql).add({ kind: 'fact', text: 'Lives in Leeds near the canal', source: 'stated', evidence: 'synthetic', origin: 'owner', source_ref: 'owner, seed' }, '2026-10-01T00:00:00.000Z');
    for (const seed of seeds) claimStore(state.storage.sql).add({ kind: 'fact', source: 'stated', evidence: 'synthetic', origin: 'owner', source_ref: 'owner, seed', ...seed }, '2026-10-01T00:00:00.000Z');
    try {
      for (let index = 1; index <= exchanges; index += 1) {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `rating-client-0${index}`, text: 'Remind me what I said about the canal near Leeds' }) }));
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      }
      const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
      const reply = page.messages.find(message => message.role === 'assistant')!, mine = page.messages.find(message => message.role === 'user')!;
      expect(reply.text).toBe(REPLY);
      return await run(owner, state, { mine: mine.id, reply: reply.id });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

const page = async (owner: Owner, name: string, contract?: string) =>
  (await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { ...headers(name), ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }))).json()) as { messages: Record<string, unknown>[] };
const replyOf = async (owner: Owner, name: string, contract?: string) => (await page(owner, name, contract)).messages.find(message => message.role === 'assistant')!;
const ON = { MEMORY_USED_SHOWN: '1' };

beforeEach(() => { seen.prompts = []; seen.calls = []; });

it('names the notes a turn looked at, only to chat revision 7 and only with the switch on', async () => {
  await withExchange('app-memory-used-golden', async (owner, state) => {
    const used = (await replyOf(owner, 'app-memory-used-golden', 'chat=7')).memory_used;
    expect(used).toEqual([{ id: 'memory:claim:1', text: 'Lives in Leeds near the canal' }]);
    expect(state.storage.sql.exec('SELECT claim_ids FROM reply_memory_used').toArray()).toEqual([{ claim_ids: '[1]' }]);
    expect(seen.prompts.some(prompt => prompt.includes('name the notes above you relied on'))).toBe(true);
    for (const contract of [undefined, 'chat=6', 'chat=3']) expect(await replyOf(owner, 'app-memory-used-golden', contract)).not.toHaveProperty('memory_used');
    expect(appHistoryResultV1Schema.safeParse({ messages: (await page(owner, 'app-memory-used-golden', 'chat=7')).messages, next_cursor: null }).success).toBe(true);
  }, 1, ON);
});

const BEES = { text: 'Keeps bees on an allotment' };
it('does not name a note nothing in the turn looked at', async () => {
  await withExchange('app-memory-used-control', async (owner) => {
    expect((await replyOf(owner, 'app-memory-used-control', 'chat=7')).memory_used).toEqual([{ id: 'memory:claim:1', text: 'Lives in Leeds near the canal' }]);
  }, 1, ON, [BEES]);
});

it('records a claim the model opened with read_memory, as the tool answers it', async () => {
  seen.calls = [{ name: 'read_memory', arguments: JSON.stringify({ query: 'bees', limit: 5 }) }];
  await withExchange('app-memory-used-read', async (owner, state) => {
    expect((await replyOf(owner, 'app-memory-used-read', 'chat=7')).memory_used).toEqual([{ id: 'memory:claim:1', text: 'Lives in Leeds near the canal' }, { id: 'memory:claim:2', text: 'Keeps bees on an allotment' }]);
    expect(state.storage.sql.exec('SELECT claim_ids FROM reply_memory_used').toArray()).toEqual([{ claim_ids: '[1,2]' }]);
  }, 1, ON, [BEES]);
});

it('never records or shows a health claim the model read', async () => {
  seen.calls = [{ name: 'read_memory', arguments: JSON.stringify({ query: 'heart rate', limit: 5 }) }];
  await withExchange('app-memory-used-health', async (owner, state) => {
    expect(seen.prompts.join(' ')).toContain('51 bpm');
    expect((await replyOf(owner, 'app-memory-used-health', 'chat=7')).memory_used).toEqual([{ id: 'memory:claim:1', text: 'Lives in Leeds near the canal' }]);
    expect(state.storage.sql.exec('SELECT claim_ids FROM reply_memory_used').toArray()).toEqual([{ claim_ids: '[1]' }]);
  }, 1, ON, [{ text: 'Resting heart rate was 51 bpm last week', kind: 'health' }]);
});

it('never records or shows a health claim recall brought into the turn', async () => {
  await withExchange('app-memory-used-health-recall', async (owner, state) => {
    expect(seen.prompts.join(' ')).toContain('51 bpm');
    expect((await replyOf(owner, 'app-memory-used-health-recall', 'chat=7')).memory_used).toEqual([{ id: 'memory:claim:1', text: 'Lives in Leeds near the canal' }]);
    expect(state.storage.sql.exec('SELECT claim_ids FROM reply_memory_used').toArray()).toEqual([{ claim_ids: '[1]' }]);
  }, 1, ON, [{ text: 'Resting heart rate was 51 bpm near the Leeds canal', kind: 'health' }]);
});

it('records and shows nothing while the switch is off', async () => {
  await withExchange('app-memory-used-off', async (owner, state) => {
    expect(await replyOf(owner, 'app-memory-used-off', 'chat=7')).not.toHaveProperty('memory_used');
    expect(seen.prompts.some(prompt => prompt.includes('name the notes above you relied on'))).toBe(false);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'reply_memory_used'").toArray().length === 0 || state.storage.sql.exec('SELECT * FROM reply_memory_used').toArray().length === 0).toBe(true);
  });
});

it('stops naming a claim the owner forgot, and one a forget is still clearing', async () => {
  await withExchange('app-memory-used-forgotten', async (owner, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    expect((await replyOf(owner, 'app-memory-used-forgotten', 'chat=7')).memory_used).toHaveLength(1);
    store.purge([1], '2026-10-02T00:00:00.000Z');
    expect(await replyOf(owner, 'app-memory-used-forgotten', 'chat=7')).not.toHaveProperty('memory_used');
  }, 1, ON);
});

describe('the book', () => {
  it('keeps only the newest rows', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-memory-used-bound')), async (_instance, state) => {
    const book = memoryUsedBook(state.storage.sql);
    for (let index = 0; index < 2005; index += 1) book.record(`turn-${index}`, [1], index);
    expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reply_memory_used').one().n).toBe(2000);
    expect(book.ids('turn-0')).toEqual([]);
    expect(book.ids('turn-2004')).toEqual([1]);
  }));
});

describe('the reader', () => {
  const claim = (id: number, over: object = {}) => ({ id, kind: 'fact', text: `Note ${id}`, source: 'stated', evidence: 'e', origin: 'owner', status: 'active', created_at: 'x', last_seen_at: 'x', seen_count: 1, source_ref: null, ...over }) as never;
  it('keeps the newest few, drops untrusted and held claims, and carries text as one plain line', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-memory-used-reader')), async (_instance, state) => {
    const book = memoryUsedBook(state.storage.sql);
    book.record('t1', Array.from({ length: 12 }, (_, index) => index + 1), 1);
    const live = [...Array.from({ length: 12 }, (_, index) => claim(index + 1, index === 11 ? { text: 'line one\n\nline   two' } : {})), claim(99, { origin: 'untrusted' })];
    const shown = memoryUsedFor(book, () => live, () => [])('t1')!;
    expect(shown).toHaveLength(APP_CHAT_MEMORY_USED_MAX_V1);
    expect(shown.at(-1)).toEqual({ id: 'memory:claim:12', text: 'line one line two' });
    book.record('t2', [1, 99], 1);
    expect(memoryUsedFor(book, () => live, () => [])('t2')).toEqual([{ id: 'memory:claim:1', text: 'Note 1' }]);
    expect(memoryUsedFor(book, () => live, () => ['Note 1'])('t2')).toBeUndefined();
    expect(memoryUsedFor(book, () => live, () => [])('never')).toBeUndefined();
    expect(memoryUsedFor(book, () => [claim(5, { text: `${'a'.repeat(299)}😀tail` })], () => [])('t1')).toEqual([{ id: 'memory:claim:5', text: `${'a'.repeat(299)}😀` }]);
    expect(memoryUsedFor(book, () => [claim(5, { kind: 'health', text: 'Resting heart rate was 51 bpm' })], () => [])('t1')).toBeUndefined();
    book.record('t3', [], 1);
    expect(memoryUsedFor(book, () => live, () => [])('t3')).toBeUndefined();
  }));
});
