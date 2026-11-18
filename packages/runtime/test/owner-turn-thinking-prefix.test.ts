import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_PROVIDER, type LLMRequest } from '@waldo/contracts';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';
import { appSubjectFor } from '../src/channels/app-api';
import { GOOGLE_CONSENT_SCOPES } from '../src/connectors/google';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// WALDO_THINKING_REPLAY on an owner's own turn, as staging builds it: the turn's model thinks and reads twice, then answers.
// Each request the turn sends is put on the wire by the real adapter, and every request after the first must start with
// the one before it unchanged (tools, system prompt and messages), so the thinking each round produced stays bound to an
// unchanged prefix and the cache reads it back.
const model = vi.hoisted(() => ({ requests: [] as LLMRequest[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, extra = {}) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...extra } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (!request.tools?.length) return done('Noted.');
    model.requests.push(request);
    const round = request.tool_turns?.length ?? 0;
    if (round >= 2) return done('Your afternoon is clear after 3.');
    const call = { type: 'tool_use', id: `call-${round}`, name: 'get_context', input: { topic: `t${round}` } };
    return done('', {
      tool_calls: [{ call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) }],
      output_items: [{ type: 'thinking', provider: ANTHROPIC_PROVIDER, block: { type: 'thinking', thinking: '', signature: `sig-${round}` } }, { type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: call }],
    });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c2e9b14-3a7d-4f05-9e81-2b4c6d8f0a13';
const STAGING = (flatConfig(parseJsonc(config)) as { env: { staging: { vars: Record<string, string> } } }).env.staging.vars;
const settings = Object.fromEntries(Object.entries(STAGING).filter(([key]) => !/^(IMESSAGE_|WHATSAPP_|WALDO_OWNER_|WALDO_PUBLIC_ORIGIN|GMAIL_PUSH|PHOTON_|LANGFUSE_|WALDO_EGRESS|WALDO_COST_LEDGER|AGENT_MAIL|WALDO_RELEASE|WALDO_ENVIRONMENT)/.test(key)));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); model.requests = []; });

const ownerTurn = async (name: string): Promise<LLMRequest[]> => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-04T09:00:00Z') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const args = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: args.p_do_name, session_hash: args.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: args.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'conn-1', email: 'owner@example.test', scopes: [...GOOGLE_CONSENT_SCOPES] }]);
    const owner = new OwnerDO(state, { ...env, ...settings, SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret',
      ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic-fixture-0000000000000000000000', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: 'what does my afternoon look like?' }) }));
      expect(sent.status).toBe(202);
      const { message_id: message } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${message}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      return [...model.requests];
    } finally { await state.storage.deleteAlarm(); }
  });
};

const wireBody = async (request: LLMRequest): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const client = { messages: { create: async (sent: Record<string, unknown>) => { body = sent; return { id: 'msg_1', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; } } } as never;
  const step = { provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, cache: 'anthropic_native' as const };
  const { web_search: _search, ...rest } = request;
  await new AnthropicMessagesAdapter({ apiKey: 'test-key', client, replayThinking: true }).complete({ request: { ...rest, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL }, route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' }, step, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
  return body;
};
const unmarked = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unmarked);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, unmarked(inner)]));
};

it('staging turns the switch on', () => {
  expect(STAGING.WALDO_THINKING_REPLAY).toBe('1');
  const production = (flatConfig(parseJsonc(config)) as { vars: Record<string, string> }).vars;
  expect(production.WALDO_THINKING_REPLAY).toBe('0');
});

it('an owner turn that reads twice sends each round as an unchanged extension of the one before, its thinking in place', async () => {
  const requests = await ownerTurn('thinking-prefix');
  expect(requests).toHaveLength(3);
  const bodies = await Promise.all(requests.map(wireBody));
  for (const body of bodies.slice(1)) {
    expect(JSON.stringify(unmarked(body.tools))).toBe(JSON.stringify(unmarked(bodies[0]!.tools)));
    expect(JSON.stringify(unmarked(body.system))).toBe(JSON.stringify(unmarked(bodies[0]!.system)));
  }
  for (let k = 0; k + 1 < bodies.length; k += 1) {
    const [now, next] = [unmarked(bodies[k]!.messages) as unknown[], unmarked(bodies[k + 1]!.messages) as unknown[]];
    expect(next.slice(0, now.length)).toEqual(now);
  }
  const replayed = (unmarked(bodies[2]!.messages) as Array<{ role: string; content: Array<{ type: string; signature?: string }> }>)
    .filter((message) => message.role === 'assistant').map((message) => message.content.map((block) => block.signature ?? block.type));
  expect(replayed.slice(-2)).toEqual([['sig-0', 'tool_use'], ['sig-1', 'tool_use']]);
});
