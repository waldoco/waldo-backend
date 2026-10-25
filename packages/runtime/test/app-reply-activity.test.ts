import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// Through the real owner object: while a turn's tools run, a chat revision 2 receipt says what kind of work it is on,
// named from the tool alone; it gives way to the draft once the answer streams, and is gone when the turn ends.

const ANSWER = `Two invoices are waiting on you. ${Array.from({ length: 80 }, (_, i) => `line${i}`).join(' ')}`;
const EMAIL = 'alice.fixture@example.com';
const gate = vi.hoisted(() => ({ toolsDone: null as null | (() => void), answer: null as null | (() => void), phase: 'idle' as 'idle' | 'after_tools' | 'streamed' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request, stream }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: unknown) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    if (!request.tools) return done('Done.');
    if (!request.tool_turns?.length) return done('', [{ call_id: 'mail-1', name: 'search_communication', arguments: JSON.stringify({ query: `from:${EMAIL} invoice` }) }]);
    gate.phase = 'after_tools';
    await new Promise<void>(resolve => { gate.toolsDone = resolve; });
    for (const piece of ANSWER.match(/.{1,12}/gs)!) stream?.delta(piece);
    gate.phase = 'streamed';
    await new Promise<void>(resolve => { gate.answer = resolve; });
    return done(ANSWER);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const HASH = 'a'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  gate.toolsDone = null; gate.answer = null; gate.phase = 'idle';
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

const headers = (name: string, revision?: 1 | 2) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json', ...(revision ? { 'x-waldo-app-contract': `chat=${revision}` } : {}) });
const withOwner = <T,>(name: string, stream: boolean, work: (owner: InstanceType<typeof OwnerDO>) => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...(stream ? { WALDO_STREAM_REPLIES: 'on' } : {}) });
  try { return await work(owner); } finally { gate.toolsDone?.(); gate.answer?.(); quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const send = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string) => {
  const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: client, text: 'any invoices waiting on me?' }) }));
  expect(sent.status).toBe(202);
  return (await sent.json() as { message_id: string }).message_id;
};
const raw = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string, revision?: 1 | 2) =>
  (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name, revision) }))).text();
const receipt = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string, revision?: 1 | 2) => appMessageReceiptV1Schema.parse(JSON.parse(await raw(owner, name, client, revision)));
const settled = (owner: InstanceType<typeof OwnerDO>) => vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });

it('names a mail tool round as mail work, from the tool alone, until the answer streams, and only to chat revision 2', async () => {
  const name = 'app-reply-activity-on';
  await withOwner(name, true, async (owner) => {
    const id = await send(owner, name, 'activity-client-0001');
    await vi.waitFor(() => expect(gate.phase).toBe('after_tools'), { timeout: 10_000, interval: 20 });
    const during = await receipt(owner, name, 'activity-client-0001', 2);
    expect(during).toMatchObject({ state: 'running', activity: { kind: 'mail' } });
    expect(during.activity!.since).toBeGreaterThan(0);
    expect(during).not.toHaveProperty('draft');
    const wire = await raw(owner, name, 'activity-client-0001', 2);
    for (const leaked of [EMAIL, 'search_communication', 'invoice']) expect(wire).not.toContain(leaked);
    for (const revision of [1, undefined] as const) expect(await receipt(owner, name, 'activity-client-0001', revision)).not.toHaveProperty('activity');

    gate.toolsDone!();
    let streaming = during;
    await vi.waitFor(async () => { streaming = await receipt(owner, name, 'activity-client-0001', 2); expect(streaming.draft).toBeTruthy(); }, { timeout: 5_000, interval: 50 });
    expect(streaming.state).toBe('running');
    expect(streaming).not.toHaveProperty('activity');

    gate.answer!();
    await settled(owner);
    expect(await receipt(owner, name, 'activity-client-0001', 2)).toEqual({ accepted: true, message_id: id, state: 'completed' });
  });
});

it('with the switch off, a tool round puts no activity on any receipt', async () => {
  const name = 'app-reply-activity-off';
  await withOwner(name, false, async (owner) => {
    await send(owner, name, 'activity-client-0002');
    await vi.waitFor(() => expect(gate.phase).toBe('after_tools'), { timeout: 10_000, interval: 20 });
    expect(await receipt(owner, name, 'activity-client-0002', 2)).not.toHaveProperty('activity');
    gate.toolsDone!();
    await vi.waitFor(() => expect(gate.phase).toBe('streamed'), { timeout: 10_000, interval: 20 });
    gate.answer!();
    await settled(owner);
  });
});
