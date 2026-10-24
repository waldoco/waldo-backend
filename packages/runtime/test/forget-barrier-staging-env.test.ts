import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import { holdTopic } from './helpers/pending-topic';

// The test pool loads the top-level (production) vars of wrangler.jsonc. The deployed staging Worker reads env.staging.vars,
// so this owner object is built with the staging block's own forget-barrier value, and an app turn is run through it while a
// forget is still cleaning.
const OWNER_ID = '6d2f0a8e-41c7-4b9e-a3d5-8e1c7f2b9a04';
const BASE = 'https://directory.fixture.invalid';
const STAGING = (parseJsonc(config) as { env: { staging: { vars: { WALDO_FORGET_BARRIER?: string } } } }).env.staging.vars;

const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], calls: [] as { name: string; arguments: string }[], modes: [] as unknown[] }));
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
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => {
    args[11] = gateway;
    model.modes.push(args[22]?.forgetBarrier);
    return original.createTelegramResponder(...args);
  } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); model.requests = []; model.calls = []; model.modes = []; });

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

const readMemoryTurn = async (name: string, barrier: string | undefined) => {
  directory();
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const memory = claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://fixture.invalid');
    memory.add({ kind: 'fact', text: 'Drinks coffee black', evidence: 'coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-21T08:00:00Z');
    memory.add({ kind: 'fact', text: 'Climbs on Thursdays', evidence: 'climbs', source: 'stated', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-21T08:00:00Z');
    // A goal whose JSON the redaction will not rewrite in place keeps the forget cleaning through the turn's own pass.
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, description TEXT)');
    state.storage.sql.exec('INSERT INTO goals (id, description) VALUES (?, ?)', 'g1', '{ "note": "less coffee" }');
    holdTopic(state.storage.sql, 'coffee', '2026-10-21T08:00:00Z');
    const owner = new OwnerDO(state, { ...env, WALDO_FORGET_BARRIER: barrier, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    model.calls.push({ name: 'read_memory', arguments: JSON.stringify({ limit: 10 }) });
    const sent = await owner.fetch(new Request('https://owner.invalid/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'c'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: 'client-what-do-you-remember', text: 'What do you remember about me?' }) }));
    expect(sent.status, await sent.clone().text()).toBe(202);
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    expect(memory.pendingTopics(), 'the forget is still cleaning').toEqual(['coffee']);
    const outputs = model.requests.flatMap(request => (request.tool_turns ?? []).filter(round => round.call.name === 'read_memory').map(round => round.output));
    expect(outputs.length, 'the read reached the model').toBeGreaterThan(0);
    return { modes: [...new Set(model.modes)], output: outputs.at(-1)! };
  });
};

it('the staging Worker runs owner turns on the item rule: a held memory item is dropped and the rest is shown', async () => {
  expect(STAGING.WALDO_FORGET_BARRIER).toBe('on');
  const { modes, output } = await readMemoryTurn('forget-barrier-staging-env', STAGING.WALDO_FORGET_BARRIER);
  expect(modes).toEqual(['items']);
  expect(output).toContain('Climbs on Thursdays');
  expect(output).not.toMatch(/coffee/i);
});

it('the production Worker keeps the earlier whole-read rule', async () => {
  expect((env as { WALDO_FORGET_BARRIER?: string }).WALDO_FORGET_BARRIER).toBe('off');
  const { modes } = await readMemoryTurn('forget-barrier-production-env', (env as { WALDO_FORGET_BARRIER?: string }).WALDO_FORGET_BARRIER);
  expect(modes).toEqual(['reads']);
});
