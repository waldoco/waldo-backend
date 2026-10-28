import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appRatingResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// Like and Dislike on Waldo's replies in the app's main chat: the owner object keeps one rating per reply, a request_id
// answers once, and nothing a reply says reaches a log or a trace on the way.
const REPLY = 'Synthetic reply marker quartz-heron';
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    return done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
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
const withExchange = <T>(name: string, run: (owner: Owner, state: DurableObjectState, ids: Readonly<{ mine: string; reply: string }>) => Promise<T>, exchanges = 1) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      for (let index = 1; index <= exchanges; index += 1) {
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: `rating-client-0${index}`, text: 'hello there' }) }));
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      }
      const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
      const reply = page.messages.find(message => message.role === 'assistant')!, mine = page.messages.find(message => message.role === 'user')!;
      expect(reply.text).toBe(REPLY);
      return await run(owner, state, { mine: mine.id, reply: reply.id });
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const rate = (owner: Owner, name: string, messageId: string, body: unknown) =>
  owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${encodeURIComponent(messageId)}/rating`, { method: 'PUT', headers: headers(name), body: typeof body === 'string' ? body : JSON.stringify(body) }));
const stored = (state: DurableObjectState) => state.storage.sql.exec<{ message_id: string; rating: string; at: number }>('SELECT message_id, rating, at FROM reply_ratings').toArray();

it('rates a reply, keeps one rating per reply, clears it with null, and answers in the contract shape', async () => {
  await withExchange('app-rating-golden', async (owner, state, { reply }) => {
    const up = await rate(owner, 'app-rating-golden', reply, { request_id: 'rating-req-0001', rating: 'up' });
    expect([up.status, appRatingResultV1Schema.parse(await up.json())]).toEqual([200, { request_id: 'rating-req-0001', message_id: reply, rating: 'up' }]);
    expect(stored(state)).toEqual([{ message_id: reply, rating: 'up', at: expect.any(Number) }]);
    const down = await rate(owner, 'app-rating-golden', reply, { request_id: 'rating-req-0002', rating: 'down' });
    expect(await down.json()).toEqual({ request_id: 'rating-req-0002', message_id: reply, rating: 'down' });
    expect(stored(state)).toEqual([{ message_id: reply, rating: 'down', at: expect.any(Number) }]);
    const cleared = await rate(owner, 'app-rating-golden', reply, { request_id: 'rating-req-0003', rating: null });
    expect([cleared.status, await cleared.json()]).toEqual([200, { request_id: 'rating-req-0003', message_id: reply, rating: null }]);
    expect(stored(state)).toEqual([]);
  });
});

it('repeating a request or a rating changes nothing, and a request_id reused for something else is refused', async () => {
  await withExchange('app-rating-repeat', async (owner, state, { reply }) => {
    await rate(owner, 'app-rating-repeat', reply, { request_id: 'rating-req-0001', rating: 'up' });
    const first = stored(state);
    const replayed = await rate(owner, 'app-rating-repeat', reply, { request_id: 'rating-req-0001', rating: 'up' });
    expect([replayed.status, await replayed.json()]).toEqual([200, { request_id: 'rating-req-0001', message_id: reply, rating: 'up' }]);
    const again = await rate(owner, 'app-rating-repeat', reply, { request_id: 'rating-req-0002', rating: 'up' });
    expect([again.status, await again.json()]).toEqual([200, { request_id: 'rating-req-0002', message_id: reply, rating: 'up' }]);
    expect(stored(state)).toEqual(first);
    const reused = await rate(owner, 'app-rating-repeat', reply, { request_id: 'rating-req-0001', rating: 'down' });
    expect([reused.status, await reused.json()]).toEqual([409, { error: 'request_reused', code: 'request_reused' }]);
    expect(stored(state)).toEqual(first);
  });
});

it('a request_id reused on a different reply is refused with 409, and that reply keeps no rating', async () => {
  await withExchange('app-rating-reuse-other', async (owner, state, { reply }) => {
    const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers('app-rating-reuse-other') }))).json());
    const older = page.messages.filter(message => message.role === 'assistant').map(message => message.id).find(id => id !== reply)!;
    expect(older).toBeDefined();
    expect((await rate(owner, 'app-rating-reuse-other', reply, { request_id: 'rating-req-0001', rating: 'up' })).status).toBe(200);
    const reused = await rate(owner, 'app-rating-reuse-other', older, { request_id: 'rating-req-0001', rating: 'up' });
    expect([reused.status, await reused.json()]).toEqual([409, { error: 'request_reused', code: 'request_reused' }]);
    expect(stored(state)).toEqual([{ message_id: reply, rating: 'up', at: expect.any(Number) }]);
  }, 2);
});

it('refuses a malformed request with 400 and stores nothing; the valid shapes pass', async () => {
  await withExchange('app-rating-invalid', async (owner, state, { reply }) => {
    for (const body of ['not json', { request_id: 'short', rating: 'up' }, { request_id: 'rating-req-0001', rating: 'meh' }, { request_id: 'rating-req-0001' },
      { request_id: 'rating-req-0001', rating: 'up', note: 'extra' }, { request_id: 'rating req 0001', rating: 'up' }]) {
      const response = await rate(owner, 'app-rating-invalid', reply, body);
      expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }]);
    }
    expect(stored(state)).toEqual([]);
    for (const [index, rating] of (['up', 'down', null] as const).entries())
      expect((await rate(owner, 'app-rating-invalid', reply, { request_id: `rating-valid-000${index}`, rating })).status).toBe(200);
  });
});

// Message ids are counted per owner, so two owners' first replies share an id: an id means something only inside the owner
// object the signed-in session routes to. Another owner's reply is unreachable there, and their ratings are never touched.
it('answers 404 for an unknown message, the owner\'s own message, and a reply only another owner has, and stores nothing', async () => {
  const other = await withExchange('app-rating-other', async (_owner, _state, { reply }) => reply, 2);
  await withExchange('app-rating-mine', async (owner, state, { mine, reply }) => {
    expect(other).not.toBe(reply);
    for (const id of ['no-such-message', mine, other, 'x'.repeat(257)]) {
      const response = await rate(owner, 'app-rating-mine', id, { request_id: 'rating-req-0404', rating: 'up' });
      expect(response.status).toBe(404);
    }
    expect(stored(state)).toEqual([]);
    expect((await rate(owner, 'app-rating-mine', reply, { request_id: 'rating-req-0200', rating: 'up' })).status).toBe(200);
  });
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('app-rating-other')), async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'reply_ratings'").toArray().length === 0 || stored(state).length === 0).toBe(true);
  });
});

it('writes no reply text into logs or traces', async () => {
  await withExchange('app-rating-quiet', async (owner, state, { reply }) => {
    const before = state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM trace_log').one().n;
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }));
    try {
      await rate(owner, 'app-rating-quiet', reply, { request_id: 'rating-req-0001', rating: 'down' });
      await rate(owner, 'app-rating-quiet', reply, { request_id: 'rating-req-0002', rating: null });
    } finally { for (const spy of spies) spy.mockRestore(); }
    const traces = state.storage.sql.exec('SELECT * FROM trace_log').toArray().slice(before);
    expect(JSON.stringify([lines, traces])).not.toContain('quartz-heron');
  });
});

// A rating survives a relaunch: from chat=6 the history row of a rated reply carries it, and a build below that sees the page it always did.
const history = async (owner: Owner, name: string, contract?: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { ...headers(name), ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }));
  return await response.json() as { messages: Record<string, unknown>[] };
};
it('a rated reply carries its rating in history from chat=6, and an unrated row, a user row and older builds never do', async () => {
  await withExchange('app-rating-history', async (owner, _state, { mine, reply }) => {
    const unrated = await history(owner, 'app-rating-history', 'chat=6');
    expect(unrated.messages.every(message => !('rating' in message))).toBe(true);
    await rate(owner, 'app-rating-history', reply, { request_id: 'rating-req-0001', rating: 'up' });
    const rated = appHistoryResultV1Schema.parse(await history(owner, 'app-rating-history', 'chat=6'));
    expect(rated.messages.map(message => [message.id === reply ? 'reply' : message.id === mine ? 'mine' : 'other', message.rating])).toEqual(expect.arrayContaining([['reply', 'up'], ['mine', undefined]]));
    for (const contract of [undefined, 'chat=5', 'chat=2']) expect((await history(owner, 'app-rating-history', contract)).messages.every(message => !('rating' in message))).toBe(true);
    await rate(owner, 'app-rating-history', reply, { request_id: 'rating-req-0002', rating: 'down' });
    expect((await history(owner, 'app-rating-history', 'chat=6')).messages.find(message => message.id === reply)?.rating).toBe('down');
    await rate(owner, 'app-rating-history', reply, { request_id: 'rating-req-0003', rating: null });
    expect((await history(owner, 'app-rating-history', 'chat=6')).messages.every(message => !('rating' in message))).toBe(true);
  });
});
