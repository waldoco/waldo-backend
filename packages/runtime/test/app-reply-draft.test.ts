import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// The app and the console show a running reply as a draft on its message's receipt, through the real owner object:
// only with WALDO_STREAM_REPLIES=on, only to a client that declares chat revision 2, only while the turn runs,
// and only a prefix of the reply the transcript then holds.

const ANSWER = `Here is the plan for your afternoon. ${Array.from({ length: 80 }, (_, i) => `block${i}`).join(' ')}`;
const gate = vi.hoisted(() => ({ release: null as null | (() => void), held: 0, streamed: [] as boolean[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request, stream }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    if (!request.tools) return done('Done.');
    gate.streamed.push(stream !== undefined);
    for (const piece of ANSWER.match(/.{1,12}/gs)!) stream?.delta(piece);
    gate.held += 1;
    await new Promise<void>(resolve => { gate.release = resolve; });
    return done(ANSWER);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const HASH = 'a'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  gate.release = null; gate.held = 0; gate.streamed = [];
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

const headers = (name: string, draft = false) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json', ...(draft ? { 'x-waldo-app-contract': 'chat=2' } : {}) });
const withOwner = <T,>(name: string, stream: boolean, work: (owner: InstanceType<typeof OwnerDO>) => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...(stream ? { WALDO_STREAM_REPLIES: 'on' } : {}) });
  try { return await work(owner); } finally { gate.release?.(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text: 'plan my afternoon' }) }));
  expect(sent.status).toBe(202);
  return (await sent.json() as { message_id: string }).message_id;
};
const receipt = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string, draft: boolean) =>
  appMessageReceiptV1Schema.parse(await (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name, draft) }))).json());

it('serves a running reply as a draft to a client that declares chat revision 2, and the transcript then holds the whole reply', async () => {
  const name = 'app-reply-draft-on';
  await withOwner(name, true, async (owner) => {
    const id = await send(owner, name, 'draft-client-0001');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    let running = await receipt(owner, name, 'draft-client-0001', true);
    await vi.waitFor(async () => { running = await receipt(owner, name, 'draft-client-0001', true); expect(running.draft).toBeTruthy(); }, { timeout: 5_000, interval: 50 });
    expect(running.state).toBe('running');
    expect(ANSWER.startsWith(running.draft!)).toBe(true);
    expect(await receipt(owner, name, 'draft-client-0001', false)).not.toHaveProperty('draft');
    gate.release!();
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
    expect(await receipt(owner, name, 'draft-client-0001', true)).toEqual({ accepted: true, message_id: id, state: 'completed' });
    const page = appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
    expect(page.messages.find((message) => message.role === 'assistant' && message.parent_id === id)?.text).toBe(ANSWER);
    expect(gate.streamed).toEqual([true]);
  });
});

it('with the switch off, the model call carries no stream and no receipt carries a draft', async () => {
  const name = 'app-reply-draft-off';
  await withOwner(name, false, async (owner) => {
    await send(owner, name, 'draft-client-0002');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    expect(await receipt(owner, name, 'draft-client-0002', true)).not.toHaveProperty('draft');
    expect(gate.streamed).toEqual([false]);
    gate.release!();
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
  });
});
