import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// Characterises what happens today when the owner sends a second app message while the first one's turn is still running.
// These tests pin current behaviour, not the target design (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md).
const gate = vi.hoisted(() => ({ release: null as null | (() => void), held: 0, asked: [] as string[], requests: [] as string[][] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    gate.asked.push(asked);
    gate.requests.push(request.messages.map(message => `${message.role}: ${String(message.content)}`));
    if (asked.includes('slowly') && !asked.includes('what time is it')) { gate.held += 1; await new Promise<void>(resolve => { gate.release = resolve; }); return done('Reply to the slow ask.'); }
    return done('Reply to the second message.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const HASH = 'a'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  gate.release = null; gate.held = 0; gate.asked = []; gate.requests = [];
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
const withOwner = <T,>(name: string, work: (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState) => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  try { return await work(owner, state); } finally { gate.release?.(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string, text: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text }) }));
  expect(sent.status).toBe(202);
  return (await sent.json() as { message_id: string; state: string });
};
const receipt = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string) => appMessageReceiptV1Schema.parse(await (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name) }))).json());
const history = async (owner: InstanceType<typeof OwnerDO>, name: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());

it('queues B behind a running A: A is neither interrupted nor steered, and each message gets its own reply', async () => {
  const name = 'second-message-app-queue';
  await withOwner(name, async owner => {
    const a = await send(owner, name, 'second-a-0001', 'QA: research this slowly');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    const b = await send(owner, name, 'second-b-0001', 'QA: also, what time is it?');

    // While A runs, B is only admitted: no steer path reaches the running turn, and A keeps running.
    expect(b.state).toBe('admitted');
    expect((await receipt(owner, name, 'second-a-0001')).state).toBe('running');
    expect((await receipt(owner, name, 'second-b-0001')).state).toBe('admitted');
    expect(gate.asked.filter(text => text.includes('what time is it'))).toEqual([]);

    gate.release!();
    await vi.waitFor(async () => expect((await receipt(owner, name, 'second-b-0001')).state).toBe('completed'), { timeout: 10_000, interval: 20 });
    expect((await receipt(owner, name, 'second-a-0001')).state).toBe('completed');

    // B ran after A, as its own turn, and its model request already holds A's ask and A's reply.
    const bRequest = gate.requests.find(messages => messages.at(-1)?.includes('what time is it'))!;
    expect(bRequest.some(line => line.includes('research this slowly'))).toBe(true);
    expect(bRequest.some(line => line.includes('Reply to the slow ask.'))).toBe(true);

    // Each message has its own reply in the transcript, hung under that message: nothing is lost or merged.
    const page = await history(owner, name);
    const replyTo = (id: string) => page.messages.find(message => message.role === 'assistant' && message.parent_id === id)?.text;
    expect(replyTo(a.message_id)).toContain('Reply to the slow ask.');
    expect(replyTo(b.message_id)).toContain('Reply to the second message.');
  });
});

it('shows B in the transcript only once its own turn starts, so the chat looks unanswered while A runs', async () => {
  const name = 'second-message-app-visible';
  await withOwner(name, async owner => {
    const a = await send(owner, name, 'second-a-0002', 'QA: research this slowly');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    const b = await send(owner, name, 'second-b-0002', 'QA: also, what time is it?');
    const during = await history(owner, name);
    expect(during.messages.some(message => message.id === a.message_id)).toBe(true);
    expect(during.messages.some(message => message.id === b.message_id)).toBe(false);
  });
});
