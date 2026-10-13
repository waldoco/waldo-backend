import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appThreadListV1Schema, appThreadOperationResultV1Schema } from '../../contracts/src/app/threads';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { redactThreadTitles } from '../src/channels/app-threads';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The model may name an untitled thread once, from its first exchange; forgetting a topic reaches every title.
const model = vi.hoisted(() => ({
  titleAsks: [] as string[],
  title: '{"title":"Lisbon trip planning"}' as string | Error,
  whileTitling: null as (() => Promise<void>) | null,
}));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    const reply = (text: string, tool_calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.request.response_format?.name === 'thread_title') {
      model.titleAsks.push(JSON.stringify(request.request));
      await model.whileTitling?.();
      if (model.title instanceof Error) throw model.title;
      return reply(model.title);
    }
    if (request.request.response_format) return reply('{}');
    const said = JSON.stringify(request.request.messages.at(-1)?.content ?? '');
    if (said.includes('forget marigold') && !request.request.tool_turns?.length) {
      return reply('', [{ call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: 'marigold', scope_note: 'the marigold topic' }) }]);
    }
    return reply(said.includes('Lisbon') ? 'Happy to help plan Lisbon.' : 'Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5b1f0c2a-7d3e-4c91-8f62-0a1b2c3d4e5f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.titleAsks = []; model.title = '{"title":"Lisbon trip planning"}'; model.whileTitling = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Call = (method: string, path: string, body?: unknown) => Promise<Readonly<{ status: number; body: any }>>;
type ConsoleAction = Readonly<{ action: 'spot.forget' | 'node.forget'; id: string; value: string }>;
type Owner = Readonly<{
  call: Call; state: DurableObjectState; thread(title?: string): Promise<string>; say(path: string, client: string, text: string, revision?: number): Promise<void>; op(): string;
  act(input: ConsoleAction): Promise<boolean | string>;
}>;
const withOwner = (name: string, work: (owner: Owner) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const call: Call = async (method, path, body) => {
      const response = await owner.fetch(new Request(`https://telegram-owner/app/v1${path}`, { method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: await response.json() };
    };
    let operations = 0;
    const op = () => `0b6f3c1e-8a2d-4f5b-9c7e-${String(++operations).padStart(12, '0')}`;
    const thread = async (title?: string) => (await call('POST', '/threads', { operation_id: op(), ...(title ? { title } : {}) })).body.thread_id as string;
    // Sends, then waits until the drain that ran its turn has finished, titling included.
    const say = async (path: string, client: string, text: string, revision?: number) => {
      const sent = await call('POST', `${path}/messages`, { client_message_id: client, text, ...(revision === undefined ? {} : { expected_revision: revision }) });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      const id = sent.body.message_id as string;
      await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state), { timeout: 10_000, interval: 20 });
      await (owner as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(async () => undefined);
    };
    const act = (input: ConsoleAction) => (owner as unknown as { setup(channel: string): { act(input: ConsoleAction): Promise<boolean | string> } }).setup('app').act(input);
    try { await work({ call, state, thread, say, op, act }); } finally { logged.mockRestore(); await state.storage.deleteAlarm(); }
  });
const listed = async (call: Call, id: string) => appThreadListV1Schema.parse((await call('GET', '/threads?state=all')).body).threads.find(thread => thread.thread_id === id);
const titleLog = (state: DurableObjectState) => state.storage.sql.exec<{ ok: number; note: string | null }>("SELECT ok, note FROM trace_log WHERE hop = 'thread_title'").toArray();

describe('the model naming an untitled thread', () => {
  it('names it once, from the first exchange, and the list shows the title in the pinned shape', async () => {
    await withOwner('titles-golden', async ({ call, state, thread, say }) => {
      const id = await thread();
      await say(`/threads/${id}`, 'title-client-01', 'Help me plan four days in Lisbon in May.', 1);
      expect(await listed(call, id)).toMatchObject({ title: 'Lisbon trip planning', title_revision: 2, revision: 1, state: 'active' });
      expect(model.titleAsks).toHaveLength(1);
      expect(model.titleAsks[0]).toContain('Help me plan four days in Lisbon in May.');
      expect(model.titleAsks[0]).toContain('Happy to help plan Lisbon.');
      expect(titleLog(state)).toEqual([{ ok: 1, note: expect.stringMatching(/named/) }]);

      model.title = '{"title":"Something else"}';
      await say(`/threads/${id}`, 'title-client-02', 'And a day trip to Sintra?', 1);
      expect(model.titleAsks).toHaveLength(1);
      expect((await listed(call, id))!.title).toBe('Lisbon trip planning');
      // The model's title moved title_revision, so a rename made against the untitled thread rereads.
      expect(await call('POST', `/threads/${id}/rename`, { operation_id: '0b6f3c1e-8a2d-4f5b-9c7e-000000000099', expected_title_revision: 1, title: 'Mine' }))
        .toEqual({ status: 409, body: { error: 'title_revision_conflict' } });
    });
  });

  it('never names a thread the owner titled, and a rename made while the model answers wins', async () => {
    await withOwner('titles-owner-wins', async ({ call, thread, say, op }) => {
      const titled = await thread('Taxes');
      await say(`/threads/${titled}`, 'title-client-03', 'Where did I put the receipts?', 1);
      expect(model.titleAsks).toEqual([]);
      expect((await listed(call, titled))!.title).toBe('Taxes');

      const raced = await thread();
      model.whileTitling = async () => {
        model.whileTitling = null;
        expect(appThreadOperationResultV1Schema.parse((await call('POST', `/threads/${raced}/rename`, { operation_id: op(), expected_title_revision: 1, title: 'My own name' })).body).title_revision).toBe(2);
      };
      await say(`/threads/${raced}`, 'title-client-04', 'Help me plan four days in Lisbon in May.', 1);
      expect(model.titleAsks).toHaveLength(1);
      expect(await listed(call, raced)).toMatchObject({ title: 'My own name', title_revision: 2 });
    });
  });

  it('an unreadable answer or a model outage leaves the thread untitled, and the model is not asked again', async () => {
    for (const [name, answer] of [['titles-unreadable', '{"title":"   "}'], ['titles-too-long', JSON.stringify({ title: 'x'.repeat(201) })], ['titles-outage', new Error('down')]] as const) {
      model.titleAsks = []; model.title = answer;
      await withOwner(name, async ({ call, state, thread, say }) => {
        const id = await thread();
        await say(`/threads/${id}`, 'title-client-05', 'Help me plan four days in Lisbon in May.', 1);
        model.title = '{"title":"Lisbon trip planning"}';
        await say(`/threads/${id}`, 'title-client-06', 'And Porto?', 1);
        // The provider may retry one failed request; the thread is still asked about only once, for its first exchange.
        expect(new Set(model.titleAsks.map(ask => ask.includes('And Porto') ? 'second exchange' : 'first exchange')), name).toEqual(new Set(['first exchange']));
        expect(await listed(call, id)).toMatchObject({ title: null, title_revision: 1 });
        expect(titleLog(state)).toEqual([{ ok: 0, note: expect.stringMatching(answer instanceof Error ? /model_failed/ : /unreadable/) }]);
      });
    }
  });

  it('a thread archived while the model answers is not named', async () => {
    await withOwner('titles-archived', async ({ call, thread, say, op }) => {
      const id = await thread();
      model.whileTitling = async () => { model.whileTitling = null; await call('POST', `/threads/${id}/archive`, { operation_id: op(), expected_revision: 1, archived: true }); };
      await say(`/threads/${id}`, 'title-client-07', 'Help me plan four days in Lisbon in May.', 1);
      expect(await listed(call, id)).toMatchObject({ title: null, state: 'archived' });
    });
  });
});

describe('titles and erasure', () => {
  it('forgetting a topic in main reaches a thread title the owner typed and one the model made', async () => {
    await withOwner('titles-forget', async ({ call, thread, say }) => {
      const typed = await thread('Marigold shelf locker');
      model.title = '{"title":"The marigold plan"}';
      const named = await thread();
      await say(`/threads/${named}`, 'title-client-08', 'Help me plan the marigold beds.', 1);
      expect((await listed(call, named))!.title).toBe('The marigold plan');

      await say('/chat/main', 'title-client-09', 'Please forget marigold.');
      const [afterTyped, afterNamed] = [await listed(call, typed), await listed(call, named)];
      expect([afterTyped!.title, afterNamed!.title]).toEqual([`${FORGOTTEN} shelf locker`, `The ${FORGOTTEN} plan`]);
      expect([afterTyped!.title_revision, afterNamed!.title_revision]).toEqual([2, 3]);
    });
  });

  it('the console\'s forgets, of a spot and of a pattern, reach thread titles too', async () => {
    await withOwner('titles-console-forget', async ({ call, state, thread, act }) => {
      const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      memory.add({ kind: 'fact', text: 'Keeps a copper lantern in the shed', source: 'stated', evidence: '"copper lantern"', origin: 'owner' }, '2026-10-13T00:00:00.000Z');
      state.storage.sql.exec("INSERT INTO constellation_nodes(domain,label,summary,strength,status,first_seen,last_confirmed,supporting_spots) VALUES ('work','harbor fund','synthetic',0.5,'active','now','now','[]')");
      const lantern = await thread('Keeps a copper lantern in the shed'), fund = await thread('Harbor fund paperwork');
      expect(await act({ action: 'spot.forget', id: String(memory.claims()[0]!.id), value: '' })).toBe(true);
      expect(await act({ action: 'node.forget', id: String(memory.nodes()[0]!.id), value: '' })).toBe(true);
      expect([(await listed(call, lantern))!.title, (await listed(call, fund))!.title]).toEqual([FORGOTTEN, `${FORGOTTEN} paperwork`]);
    });
  });

  it('a forget left unfinished is finished at the owner\'s next turn, titles included', async () => {
    await withOwner('titles-forget-retry', async ({ call, state, thread, say }) => {
      const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      memory.add({ kind: 'fact', text: 'Keeps a copper lantern in the shed', source: 'stated', evidence: '"copper lantern"', origin: 'owner' }, '2026-10-13T00:00:00.000Z');
      memory.setStatus(memory.claims()[0]!.id, 'purging');
      const lantern = await thread('Keeps a copper lantern in the shed');
      await say('/chat/main', 'title-client-10', 'Good morning.');
      expect((await listed(call, lantern))!.title).toBe(FORGOTTEN);
    });
  });

  it('a title redaction answers what remains, and leaves a title without the topic alone', async () => {
    await withOwner('titles-redact', async ({ call, state, thread }) => {
      const kept = await thread('Weekend in Porto'), hit = await thread('Copper lantern repair');
      expect(redactThreadTitles(state.storage.kv, ['copper lantern'], FORGOTTEN)).toEqual({ rewritten: 1, remaining: 0 });
      expect([(await listed(call, kept))!.title, (await listed(call, hit))!.title]).toEqual(['Weekend in Porto', `${FORGOTTEN} repair`]);
      expect(redactThreadTitles(state.storage.kv, ['copper lantern'], FORGOTTEN)).toEqual({ rewritten: 0, remaining: 0 });
    });
  });

  it('a deleted thread keeps no title in its tombstone', async () => {
    await withOwner('titles-delete', async ({ call, state, thread, op }) => {
      const id = await thread('Doctor visit notes');
      expect((await call('POST', `/threads/${id}/delete`, { operation_id: op(), expected_revision: 1 })).status).toBe(200);
      expect(state.storage.kv.get<{ title: string | null }>(`app:thread:${id}`)?.title).toBeNull();
    });
  });
});
