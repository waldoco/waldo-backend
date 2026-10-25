import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema, appMessageReceiptV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { AppInbox } from '../src/channels/app-inbox';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const gate = vi.hoisted(() => ({ release: null as null | (() => void), held: 0, asked: [] as string[], signal: null as AbortSignal | null }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request, runScope }: LLMGatewayRequest) {
    const done = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[]}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    gate.asked.push(asked);
    if (asked.includes('slowly')) { gate.held += 1; gate.signal = runScope?.signal ?? null; await new Promise<void>(resolve => { gate.release = resolve; }); }
    return done('Done.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const HASH = 'a'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  gate.release = null; gate.held = 0; gate.asked = []; gate.signal = null;
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
  return (await sent.json() as { message_id: string }).message_id;
};
const cancel = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string) => owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}/cancel`, { method: 'POST', headers: headers(name) }));
const receipt = async (owner: InstanceType<typeof OwnerDO>, name: string, client: string) => appMessageReceiptV1Schema.parse(await (await owner.fetch(new Request(`https://telegram-owner/app/v1/chat/main/messages/${client}`, { headers: headers(name) }))).json());
const history = async (owner: InstanceType<typeof OwnerDO>, name: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }))).json());
const record = (state: DurableObjectState, id: string) => state.storage.kv.get<{ state: string; notice?: string; landed?: string; effectsUnconfirmed?: boolean }>(`app:inbox-record:${id}`)!;

it('stops a running turn, aborting its model request, leaves its effects unconfirmed, and writes no "did not finish" reply', async () => {
  const name = 'app-stop-running';
  await withOwner(name, async (owner, state) => {
    const id = await send(owner, name, 'stop-client-0001', 'QA: please answer slowly');
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: 10_000, interval: 20 });
    const stopped = await cancel(owner, name, 'stop-client-0001');
    expect(stopped.status).toBe(200);
    expect(appMessageReceiptV1Schema.parse(await stopped.json())).toEqual({ accepted: true, message_id: id, state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: true });
    expect(gate.signal?.aborted).toBe(true);
    gate.release!();
    await vi.waitFor(() => expect((owner as unknown as { activeApp: unknown }).activeApp).toBeNull(), { timeout: 10_000, interval: 20 });
    expect(record(state, id)).toMatchObject({ state: 'interrupted', effectsUnconfirmed: true });
    expect(record(state, id).notice).toBeUndefined();
    expect(await receipt(owner, name, 'stop-client-0001')).toEqual({ accepted: true, message_id: id, state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: true });
    // A second stop is the same answer, and the transcript holds the owner's message with no reply under it.
    expect(appMessageReceiptV1Schema.parse(await (await cancel(owner, name, 'stop-client-0001')).json())).toMatchObject({ state: 'interrupted', closed_reason: 'cancelled' });
    const page = await history(owner, name);
    expect(page.messages.some(message => message.role === 'user' && message.id === id)).toBe(true);
    expect(page.messages.some(message => message.role === 'assistant' && message.parent_id === id)).toBe(false);
  });
});

it('stops an admitted message before it runs, with nothing unconfirmed, and the drain skips it', async () => {
  const name = 'app-stop-admitted';
  await withOwner(name, async (owner, state) => {
    const inbox = new AppInbox(state.storage);
    const admitted = await inbox.admit(name, HASH, 'stop-client-0002', 'QA: never run this one', `owner:prn_${OWNER_ID.replaceAll('-', '')}`);
    expect(admitted.kind).toBe('admitted');
    const id = admitted.kind === 'admitted' ? admitted.record.id : '';
    expect(appMessageReceiptV1Schema.parse(await (await cancel(owner, name, 'stop-client-0002')).json())).toEqual({ accepted: true, message_id: id, state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: false });
    await send(owner, name, 'stop-client-0003', 'QA: hello');
    await vi.waitFor(() => expect(record(state, id).state).toBe('interrupted'), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(gate.asked.some(text => text.includes('hello'))).toBe(true), { timeout: 10_000, interval: 20 });
    expect(gate.asked.some(text => text.includes('never run this one'))).toBe(false);
    expect(record(state, id).notice).toBeUndefined();
  });
});

it('answers a finished message with its recorded receipt, and an unknown one with 404', async () => {
  const name = 'app-stop-finished';
  await withOwner(name, async (owner, state) => {
    const id = await send(owner, name, 'stop-client-0004', 'QA: hello');
    await vi.waitFor(() => expect(record(state, id).state).toBe('completed'), { timeout: 10_000, interval: 20 });
    expect(appMessageReceiptV1Schema.parse(await (await cancel(owner, name, 'stop-client-0004')).json())).toEqual({ accepted: true, message_id: id, state: 'completed' });
    expect((await cancel(owner, name, 'stop-client-9999')).status).toBe(404);
    expect((await cancel(owner, name, 'bad id')).status).toBe(404);
  });
});
