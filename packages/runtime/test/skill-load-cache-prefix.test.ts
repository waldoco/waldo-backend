import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, ANTHROPIC_PROVIDER, type LLMRequest } from '@waldo/contracts';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { appSubjectFor } from '../src/channels/app-api';
import { GOOGLE_CONSENT_SCOPES } from '../src/connectors/google';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// A skill loaded mid-turn appends its procedure to the system prompt. The tools and the stable head before it must stay a
// cached prefix on the next round. A recording client captures the wire bodies, and the cache is modelled as Anthropic
// documents it: each request writes an entry at every breakpoint, and a later request reads the longest earlier entry that
// matches the prefix ending at one of its own breakpoints.
const model = vi.hoisted(() => ({ requests: [] as LLMRequest[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, extra = {}) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0, ...extra } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    if (!request.tools?.length) return done('Noted.');
    model.requests.push(request);
    return request.tool_turns?.length
      ? done('Here is your day.')
      : done('', { tool_calls: [{ call_id: 'load-1', name: 'skills_load', arguments: JSON.stringify({ name: 'day-brief', version: 2 }) }] });
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c2e9b14-3a7d-4f05-9e81-2b4c6d8f0a13';
const STAGING = (parseJsonc(config) as { env: { staging: { vars: Record<string, string> } } }).env.staging.vars;
// Identity, channel and deploy-label vars are the test pool's own; everything that shapes the owner's model request is staging's.
const settings = Object.fromEntries(Object.entries(STAGING).filter(([key]) => !/^(IMESSAGE_|WHATSAPP_|WALDO_OWNER_|WALDO_PUBLIC_ORIGIN|GMAIL_PUSH|PHOTON_|LANGFUSE_|WALDO_EGRESS|WALDO_COST_LEDGER|AGENT_MAIL|WALDO_RELEASE|WALDO_ENVIRONMENT)/.test(key)));
const BYTES_PER_TOKEN = 4;

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
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: 'plan my day' }) }));
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
  const { reasoning_effort: _effort, web_search: _search, ...rest } = request;
  await new AnthropicMessagesAdapter({ apiKey: 'test-key', client }).complete({ request: { ...rest, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL }, route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' }, step, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
  return body;
};

// The prompt in cache order (tools, system, messages) as blocks; each breakpoint is the prefix through a marked block.
type Block = Record<string, unknown>;
const breakpointPrefixes = (body: Record<string, unknown>): string[] => {
  const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : (body.system as Block[] | undefined) ?? [];
  const blocks: Block[] = [...(body.tools as Block[] | undefined) ?? [], ...system, ...(body.messages as Array<{ role: string; content: Block[] | string }>).flatMap((message) =>
    typeof message.content === 'string' ? [{ role: message.role, text: message.content }] : message.content.map((block) => ({ role: message.role, ...block })))];
  const unmarked = blocks.map(({ cache_control: _marker, ...block }) => JSON.stringify(block));
  return blocks.flatMap((block, at) => block.cache_control ? [unmarked.slice(0, at + 1).join('')] : []);
};
const cachedTokens = (written: readonly string[], body: Record<string, unknown>): number =>
  Math.max(0, ...breakpointPrefixes(body).filter((prefix) => written.includes(prefix)).map((prefix) => Math.floor(prefix.length / BYTES_PER_TOKEN)));

it('a skill loaded mid-turn keeps the tools and the stable system head cached on the next round', async () => {
  const [first, second, ...rest] = await ownerTurn('skill-load-cache-prefix');
  expect(rest).toEqual([]);
  expect(second!.tool_turns?.[0]?.output).toContain('"name":"day-brief"');
  // The procedure follows the head the first round sent; nothing before it moved.
  expect(second!.system!.startsWith(`${first!.system!}\n\n`)).toBe(true);
  const [one, two] = [await wireBody(first!), await wireBody(second!)];
  expect(two.tools).toEqual(one.tools);
  expect(JSON.stringify(two).split('"cache_control"').length - 1).toBeLessThanOrEqual(4);
  const read = cachedTokens(breakpointPrefixes(one), two);
  expect(read).toBeGreaterThanOrEqual(4_000);
});
