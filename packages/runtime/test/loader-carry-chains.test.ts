import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The carried definitions stay with the chain and the owner object they were loaded on: a thread, another owner, or an owner
// object that was evicted and rebuilt starts from nothing, and the turn still answers, paying its own find_tools round.
type Seen = Readonly<{ said: string; carried: boolean }>;
const HEADER_TEXT = vi.hoisted(() => 'Tool definitions you loaded on your previous turn');
const model = vi.hoisted(() => ({ seen: [] as { said: string; carried: boolean }[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: LLMGatewayRequest) {
    const reply = request.request.response_format === undefined && Boolean(request.request.tools?.length);
    const said = request.request.messages.at(-1)?.content ?? '';
    const turns = request.request.tool_turns ?? [];
    const answer = (data: Record<string, unknown>) => ({ ok: true as const, data: { model: request.request.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...data } });
    if (!reply) return answer({ text: request.request.response_format ? '{}' : 'Noted.' });
    if (turns.length === 0) model.seen.push({ said: said.split('\n')[0]!, carried: said.includes(HEADER_TEXT) });
    if (said.startsWith('show reminders')) {
      if (turns.length === 0) return answer({ text: '', tool_calls: [{ call_id: 'f1', name: 'find_tools', arguments: JSON.stringify({ names: ['list_reminders'] }) }] });
      if (turns.length === 1) return answer({ text: '', tool_calls: [{ call_id: 'u1', name: 'use_tool', arguments: JSON.stringify({ name: 'list_reminders', arguments: {} }) }] });
    }
    if (said.startsWith('and again') && turns.length === 0) {
      // A model that was shown the definition calls the tool; one that was not loads it first.
      return answer({ text: '', tool_calls: [said.includes(HEADER_TEXT)
        ? { call_id: 'u2', name: 'use_tool', arguments: JSON.stringify({ name: 'list_reminders', arguments: {} }) }
        : { call_id: 'f2', name: 'find_tools', arguments: JSON.stringify({ names: ['list_reminders'] }) }] });
    }
    return answer({ text: 'Done.' });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7d3a1e5c-2b4f-4a86-9c10-3e5f7a9b1d24';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  model.seen = [];
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

type Owner = Readonly<{ say(path: string, text: string): Promise<void>; thread(): Promise<string>; evict(): void }>;
let clients = 0;
const withOwner = (name: string, work: (owner: Owner) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const build = () => new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_LOADER: 'harness', WALDO_LOADER_CARRY: '1' });
    let instance = build();
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await instance.fetch(new Request(`https://telegram-owner/app/v1${path}`, { method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    let operations = 0;
    const thread = async () => (await call('POST', '/threads', { operation_id: `0b6f3c1e-8a2d-4f5b-9c7e-${String(++operations).padStart(12, '0')}` })).body.thread_id as string;
    const say = async (path: string, text: string) => {
      const sent = await call('POST', `${path}/messages`, { client_message_id: `client-${++clients}`, text, ...(path === '/chat/main' ? {} : { expected_revision: 1 }) });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      const id = sent.body.message_id as string;
      await vi.waitFor(() => expect(['completed', 'interrupted']).toContain(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state), { timeout: 10_000, interval: 20 });
    };
    try { await work({ say, thread, evict: () => { instance = build(); } }); } finally { logged.mockRestore(); await state.storage.deleteAlarm(); }
  });
const seen = (said: string): Seen[] => model.seen.filter((entry) => entry.said.startsWith(said));

describe('carried definitions stay on their chain and their owner object', () => {
  it('carry on the chain that loaded them and not into a thread, and a thread\'s own turns carry its own', async () => {
    await withOwner('carry-chains', async ({ say, thread }) => {
      const id = await thread();
      await say('/chat/main', 'show reminders');
      await say(`/threads/${id}`, 'and again in the thread');
      await say('/chat/main', 'and again in main');
      expect(seen('and again in the thread').map((entry) => entry.carried)).toEqual([false]);
      expect(seen('and again in main').map((entry) => entry.carried)).toEqual([true]);
      await say(`/threads/${id}`, 'show reminders');
      await say(`/threads/${id}`, 'and again once more');
      expect(seen('and again once more').map((entry) => entry.carried)).toEqual([true]);
    });
  });

  it('a second owner starts from nothing', async () => {
    await withOwner('carry-owner-a', async ({ say }) => { await say('/chat/main', 'show reminders'); });
    await withOwner('carry-owner-b', async ({ say }) => { await say('/chat/main', 'and again for b'); });
    expect(seen('and again for b').map((entry) => entry.carried)).toEqual([false]);
  });

  it('an owner object rebuilt between messages loses the book, and the next turn answers and loads for itself', async () => {
    await withOwner('carry-evicted', async ({ say, evict }) => {
      await say('/chat/main', 'show reminders');
      await say('/chat/main', 'and again before');
      evict();
      await say('/chat/main', 'and again after');
    });
    expect(seen('and again before').map((entry) => entry.carried)).toEqual([true]);
    expect(seen('and again after').map((entry) => entry.carried)).toEqual([false]);
  });
});
