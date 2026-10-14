import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore, textFingerprint } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A forget hides the current owner message where it carries the forgotten text, as stored before the model ran. The turn
// publishes its reply on that stored message, whether the forget matched, failed, or hid more than the topic: the turn
// completes, the model reads the tool's answer, and the next turn loads the chain with the message as the forget left it.
const OWNER_ID = '6d2f0a8e-41c7-4b9e-a3d5-8e1c7f2b9a04';
const BASE = 'https://directory.fixture.invalid';

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], calls: [] as { name: string; arguments: string }[] }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id } } : true };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const format = request.request.response_format?.name;
    const answer = (text: string, calls?: { call_id: string; name: string; arguments: string }[]) => ({ ok: true as const, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...(calls ? { tool_calls: calls } : {}) } });
    if (format === 'task_source_scope') return answer('{"decision":"retain","sources":[]}');
    if (format !== undefined) return answer('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const call = model.calls.shift();
    return call ? answer('', [{ call_id: `call-${model.requests.length}`, ...call }]) : answer('Noted.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.calls = []; });

const directory = () => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const raw = init?.body ? String(init.body) : '';
  const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
  const args = raw ? JSON.parse(raw) as Record<string, string> : {};
  if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
  if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
  if (fn === 'assert_channel_presence') return Response.json(true);
  if (fn === 'health_context_read') return Response.json(null);
  return new Response('unexpected', { status: 500 });
});
const ownerFor = async (name: string, state: DurableObjectState) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  await state.storage.put('origin', 'https://fixture.invalid');
  return new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
};
// One app turn, run until its inbox record settles. A queued call is what the model answers with first; the next round replies.
const turn = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string, text: string, call?: { name: string; args: unknown }) => {
  if (call) model.calls.push({ name: call.name, arguments: JSON.stringify(call.args) });
  const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${text.replace(/\W+/g, '-')}`, text }) }));
  expect(sent.status, await sent.clone().text()).toBe(202);
  const { message_id: id } = await sent.json() as { message_id: string };
  let settled: string | undefined;
  await vi.waitFor(() => { settled = state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state; expect(['completed', 'interrupted', 'revoked']).toContain(settled); }, { timeout: 10_000, interval: 20 });
  return settled;
};
// What a tool told the model, from the round that follows the call.
const receiptOf = (tool: string) => {
  const outputs = model.requests.flatMap(request => (request.tool_turns ?? []).filter(round => round.call.name === tool).map(round => round.output));
  expect(outputs.length, `the ${tool} call reached the tool`).toBeGreaterThan(0);
  return outputs.at(-1)!;
};
// An ordinary turn after the forget: it completes only if every stored row still loads with its witness. Returns what it sent the model.
const NEXT = 'What is on today?';
const nextTurn = async (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, name: string) => {
  expect(await turn(owner, state, name, NEXT), 'the chain loads after the forget').toBe('completed');
  const replies = model.requests.filter(request => request.response_format === undefined && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(NEXT));
  expect(replies.length, 'the next turn reached the model').toBeGreaterThan(0);
  return JSON.stringify(replies);
};

it('a forget whose topic matches nothing completes the turn and hands the model the failure answer', async () => {
  directory();
  const name = 'app-forget-no-match';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    expect(await turn(owner, state, name, 'Forget zebra stripes', { name: 'forget_memory', args: { topic: 'zebra stripes', scope_note: 'zebras' } })).toBe('completed');
    const receipt = receiptOf('forget_memory');
    expect(receipt).toContain('"ok":false');
    expect(receipt).toContain('No stored memory carries that topic or span');
    // The forget hid the topic from history before it found nothing in memory, and the stored message stays as it left it.
    const next = await nextTurn(owner, state, name);
    expect(next).toContain('Forget [forgotten]');
    expect(next).not.toContain('zebra stripes');
  });
});

it('a forget whose topic sits inside a stored quote the owner repeats completes the turn', async () => {
  directory();
  const name = 'app-forget-quoted-evidence';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    expect(await turn(owner, state, name, 'I love zebra stripes', { name: 'remember', args: { kind: 'preference', text: 'Owner loves zebra stripes', evidence_quote: 'I love zebra stripes' } })).toBe('completed');
    expect(receiptOf('remember')).toContain('"ok":true');
    // The topic selects the claim, whose quote is hidden too: the stored message loses the whole quote, not only the topic.
    expect(await turn(owner, state, name, 'Forget that I love zebra stripes', { name: 'forget_memory', args: { topic: 'zebra stripes', scope_note: 'zebras' } })).toBe('completed');
    expect(receiptOf('forget_memory')).toContain('"ok":true');
    const next = await nextTurn(owner, state, name);
    expect(next).toContain('Forget that [forgotten]');
    expect(next).not.toContain('zebra stripes');
  });
});

it('a forget whose cleanup cannot be verified completes the turn and hands the model that answer', async () => {
  directory();
  const name = 'app-forget-incomplete';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const owner = await ownerFor(name, state);
    state.storage.sql.exec('INSERT INTO topic_purge_pending (fingerprint, topic, created_at, coverage_incomplete) VALUES (?, ?, ?, 1)', textFingerprint('zebra stripes'), 'zebra stripes', new Date().toISOString());
    expect(await turn(owner, state, name, 'Forget zebra stripes', { name: 'forget_memory', args: { topic: 'zebra stripes', scope_note: 'zebras' } })).toBe('completed');
    const receipt = receiptOf('forget_memory');
    expect(receipt).toContain('"ok":false');
    expect(receipt).toContain('Memory cleanup could not be verified');
    const next = await nextTurn(owner, state, name);
    expect(next).toContain('Forget [forgotten]');
    expect(next).not.toContain('zebra stripes');
  });
});
