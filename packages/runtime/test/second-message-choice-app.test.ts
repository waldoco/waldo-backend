import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { STOPPED_FOR_NEWER } from '../src/channels/second-message';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A second app message while the first one's turn runs, with WALDO_SECOND_MESSAGE=1: the running turn is shown the newer
// message at its next round and the model chooses fold, queue or stop_current with owner_message_heard. The model is scripted;
// everything else is the real owner object. The trace is the model requests and the tool calls in them.
const script = vi.hoisted(() => ({ choice: null as null | 'fold' | 'queue' | 'stop_current', release: null as null | (() => void), held: 0, requests: [] as string[], heard: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (fields: object) => ({ ok: true as const, data: { model: request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...fields } });
    if (request.response_format) return done({ text: request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}' });
    const said = String(request.messages.at(-1)?.content ?? '');
    script.requests.push(said);
    const turns = request.tool_turns ?? [];
    for (const turn of turns) if (turn.call.name === 'owner_message_heard' && !script.heard.includes(turn.output)) script.heard.push(turn.output);
    if (!said.startsWith('QA: research this slowly')) return done({ text: 'Reply to the second message.' });
    // A's first round waits until the test has sent B, then makes one harmless call so the turn takes a second round.
    if (turns.length === 0) {
      script.held += 1;
      await new Promise<void>(resolve => { script.release = resolve; });
      return done({ tool_calls: [{ call_id: 'probe', name: 'owner_message_heard', arguments: JSON.stringify({ message_id: 'app-0', choice: 'queue' }) }] });
    }
    const offered = /\b(app-\d+) \(\d\d:\d\d\)/.exec(said)?.[1];
    if (offered && script.choice && !turns.some(turn => turn.call.call_id === 'answer')) {
      return done({ tool_calls: [{ call_id: 'answer', name: 'owner_message_heard', arguments: JSON.stringify({ message_id: offered, choice: script.choice }) }] });
    }
    return done({ text: 'Reply to the slow ask.' });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5c4b3a29-1f0e-4d7c-8b6a-5d4e3f2a1b0c';
const HASH = 'b'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  script.choice = null; script.release = null; script.held = 0; script.requests = []; script.heard = [];
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

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });
type Owner = InstanceType<typeof OwnerDO>;
const withOwner = <T,>(name: string, work: (owner: Owner) => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_SECOND_MESSAGE: '1' });
  try { return await work(owner); } finally { script.release?.(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = async (owner: Owner, name: string, client: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text }) }));
  expect(sent.status).toBe(202);
  return (await sent.json() as { message_id: string });
};
const receipt = async (owner: Owner, name: string, client: string) => appMessageReceiptV1Schema.parse(await (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name) }))).json());
const history = async (owner: Owner, name: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
const settled = async (owner: Owner, name: string, ...clients: string[]) => {
  for (const client of clients) await vi.waitFor(async () => expect(['completed', 'interrupted']).toContain((await receipt(owner, name, client)).state), { timeout: 10_000, interval: 20 });
};
// A runs; B is sent while A's first round is held; A then takes its next round with B on offer.
const secondWhileFirstRuns = async (owner: Owner, name: string, tag: string) => {
  const a = await send(owner, name, `choice-a-${tag}`, 'QA: research this slowly');
  await vi.waitFor(() => expect(script.held).toBe(1), { timeout: 10_000, interval: 20 });
  const b = await send(owner, name, `choice-b-${tag}`, 'QA: and make it Friday instead');
  script.release!();
  await settled(owner, name, `choice-a-${tag}`, `choice-b-${tag}`);
  const page = await history(owner, name);
  const replyTo = (id: string) => page.messages.filter(message => message.role === 'assistant' && message.parent_id === id).map(message => message.text);
  const ranAsOwnTurn = script.requests.some(said => said.startsWith('QA: and make it Friday instead'));
  return { a, b, page, replyTo, ranAsOwnTurn };
};

it('fold: B closes without a turn of its own, shows in the chat after A, and A\'s one reply answers both', async () => {
  const name = 'second-choice-fold';
  await withOwner(name, async owner => {
    script.choice = 'fold';
    const { a, b, page, replyTo, ranAsOwnTurn } = await secondWhileFirstRuns(owner, name, '0001');
    expect(script.requests.some(said => said.includes('While you were working, the owner sent') && said.includes('make it Friday instead'))).toBe(true);
    expect(script.heard).toContain(JSON.stringify({ ok: true, data: { heard: true, choice: 'fold' } }));
    expect(ranAsOwnTurn).toBe(false);
    expect((await receipt(owner, name, 'choice-b-0001')).state).toBe('completed');
    expect(replyTo(a.message_id)).toEqual(['Reply to the slow ask.']);
    expect(replyTo(b.message_id)).toEqual([]);
    // Newest first: A's reply, then B, then A.
    expect(page.messages.map(message => message.id).filter(id => id === a.message_id || id === b.message_id)).toEqual([b.message_id, a.message_id]);
    expect(page.messages.find(message => message.id === b.message_id)?.text).toBe('QA: and make it Friday instead');
  });
});

it('queue: B keeps its own turn after A, and each message gets its own reply', async () => {
  const name = 'second-choice-queue';
  await withOwner(name, async owner => {
    script.choice = 'queue';
    const { a, b, replyTo, ranAsOwnTurn } = await secondWhileFirstRuns(owner, name, '0002');
    expect(script.heard).toContain(JSON.stringify({ ok: true, data: { heard: true, choice: 'queue' } }));
    expect(ranAsOwnTurn).toBe(true);
    expect(replyTo(a.message_id)).toEqual(['Reply to the slow ask.']);
    expect(replyTo(b.message_id)).toEqual(['Reply to the second message.']);
  });
});

it('stop_current: A ends at its next round with an honest reply, and B runs next as its own turn', async () => {
  const name = 'second-choice-stop';
  await withOwner(name, async owner => {
    script.choice = 'stop_current';
    const { a, b, replyTo, ranAsOwnTurn } = await secondWhileFirstRuns(owner, name, '0003');
    // The turn ends at the round after the choice, so no model call reads the tool's result.
    expect(replyTo(a.message_id).join('\n')).toContain(STOPPED_FOR_NEWER);
    expect(ranAsOwnTurn).toBe(true);
    expect(replyTo(b.message_id)).toEqual(['Reply to the second message.']);
  });
});

it('unanswered: a newer message the model never answers stays queued and runs as its own turn', async () => {
  const name = 'second-choice-silent';
  await withOwner(name, async owner => {
    const { b, replyTo, ranAsOwnTurn } = await secondWhileFirstRuns(owner, name, '0004');
    expect(script.requests.some(said => said.includes('make it Friday instead') && said.includes('research this slowly'))).toBe(true);
    expect(ranAsOwnTurn).toBe(true);
    expect(replyTo(b.message_id)).toEqual(['Reply to the second message.']);
  });
});
