import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, ANTHROPIC_PROVIDER, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_PROVIDER, toolNameSchema, type LLMRequest } from '@waldo/contracts';
import { appSubjectFor } from '../src/channels/app-api';
import { GOOGLE_CONSENT_SCOPES } from '../src/connectors/google';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { MESSAGING_BEHAVIOR, TOOL_SEARCH_LINE } from '../src/prompt/messaging-behavior';
import { BRAIN_NAMESPACES, TOOL_RECORDS, brainTools } from '../src/tools/records';
import { ensureSchema } from '../src/tracer/schema';
import { toolDefinitions } from '../src/conversation/tool-loop';
import { browseActHandler, browsePageHandler } from '../src/tools/live/browser';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';

// The brain's tool surface on a real owner turn: an app message to an owner with every Google feature connected, so the
// tool list is the production one. The scripted model records the request; both adapters then build their wire bodies
// from it with recording clients, so the test measures what each provider would be sent and what its model would see.
const OWNER_ID = '6c2e9b14-3a7d-4f05-9e81-2b4c6d8f0a13';
const BASE = 'https://directory.fixture.invalid';
const ASKED = 'what is on today?';
// Tool definitions are JSON: about four UTF-8 bytes per token, the same estimate the turn trace logs (tools_tokens_est).
const BYTES_PER_TOKEN_EST = 4;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

type Scripted = { text: string; tool_calls?: { call_id: string; name: string; arguments: string }[]; output_items?: Record<string, unknown>[] };
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], respond: undefined as undefined | ((request: LLMGatewayRequest['request']) => Promise<Scripted | undefined>) }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const scripted = await model.respond?.(request.request);
    if (scripted) return { ok: true, data: { model: request.request.model, ...scripted, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    const writer = request.request.response_format !== undefined;
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); model.requests = []; model.respond = undefined; });

const ownerReply = async (name: string, toolSearch: boolean): Promise<LLMRequest> => {
  model.requests = [];
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2030-11-04T09:00:00Z') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
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
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, ...(toolSearch ? { WALDO_TOOL_SEARCH: 'on' } : {}) });
    try {
      const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}`, text: ASKED }) }));
      expect(sent.status).toBe(202);
      const { message_id: message } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${message}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      const reply = model.requests.find(request => request.tools?.length && JSON.stringify(request.messages.at(-1)?.content ?? '').includes(ASKED));
      expect(reply, 'the owner turn reached the model with tools').toBeDefined();
      return reply!;
    } finally { await state.storage.deleteAlarm(); }
  });
};

const step = (provider: typeof OPENAI_PROVIDER | typeof ANTHROPIC_PROVIDER, model: LLMRequest['model']) => ({ provider, model, cache: 'none' as const });
const openAIBody = async (request: LLMRequest): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const client = { responses: { create: async (sent: Record<string, unknown>) => { body = sent; return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }; } } } as unknown as OpenAIResponsesClient;
  const at = step(OPENAI_PROVIDER, OPENAI_GPT_6_1_SOL_MODEL);
  await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete({ request: { ...request, model: OPENAI_GPT_6_1_SOL_MODEL }, route: { trigger: 'user_message', primary: at, fallback: [], floor: 'template' }, step: at, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
  return body;
};
const anthropicBody = async (request: LLMRequest): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const client = { messages: { create: async (sent: Record<string, unknown>) => { body = sent; return { id: 'msg_1', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; } } } as never;
  const at = step(ANTHROPIC_PROVIDER, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL);
  const { reasoning_effort: _effort, web_search: _search, ...rest } = request;
  await new AnthropicMessagesAdapter({ apiKey: 'test-key', client }).complete({ request: { ...rest, model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL }, route: { trigger: 'user_message', primary: at, fallback: [], floor: 'template' }, step: at, context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' } });
  return body;
};

type WireTool = Record<string, unknown> & { type?: string; name?: string; tools?: WireTool[]; defer_loading?: boolean };
// What the model sees before any search: OpenAI shows core functions and each namespace's name and description, not the
// functions inside it; Anthropic shows every tool without defer_loading, the search tool included.
const openAIVisible = (tools: readonly WireTool[]) => tools.filter((tool) => tool.type !== 'web_search').map((tool) => tool.type === 'namespace' ? { ...tool, tools: undefined } : tool);
const anthropicVisible = (tools: readonly WireTool[]) => tools.filter((tool) => tool.defer_loading !== true);

describe('the brain tool surface', () => {
  it('places every tool once: about a dozen core tools, the rest in namespaces of fewer than ten', () => {
    expect(Object.keys(TOOL_RECORDS).sort()).toEqual([...toolNameSchema.options].sort());
    const core = Object.entries(TOOL_RECORDS).filter(([, record]) => record.brain === 'core').map(([name]) => name);
    expect(core.length).toBeLessThanOrEqual(13);
    for (const namespace of Object.keys(BRAIN_NAMESPACES)) {
      const members = Object.values(TOOL_RECORDS).filter((record) => record.brain === namespace).length;
      expect(members, namespace).toBeGreaterThan(0);
      expect(members, namespace).toBeLessThan(10);
    }
  });

  // A tool the behaviour text names must be findable: loaded up front, or named in its namespace's routing line.
  it('keeps every tool the prompt names in the core or in its namespace description', () => {
    const named = [...new Set([...MESSAGING_BEHAVIOR.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]))].filter((word) => toolNameSchema.safeParse(word).success);
    expect(named.length).toBeGreaterThan(10);
    for (const tool of named) {
      const place = TOOL_RECORDS[tool as keyof typeof TOOL_RECORDS].brain;
      if (place !== 'core') expect(BRAIN_NAMESPACES[place], `${tool} in ${place}`).toContain(tool);
    }
  });

  it('switch off: the request and both wire bodies carry every tool up front, non-strict, as before', async () => {
    const request = await ownerReply('tool-surface-off', false);
    expect(request.tool_search).toBeUndefined();
    expect(request.tools!.some((tool) => tool.namespace !== undefined || tool.defer_loading !== undefined)).toBe(false);
    expect(request.system).not.toContain(TOOL_SEARCH_LINE);
    const openAI = (await openAIBody(request)).tools as WireTool[];
    expect(openAI.filter((tool) => tool.type !== 'web_search')).toEqual(request.tools!.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })));
    const anthropic = (await anthropicBody(request)).tools as WireTool[];
    expect(anthropic).toEqual(request.tools!.map((tool) => ({ name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: 'object' } })));
  });

  it('switch on: under 4k tokens of tool definitions per round for both providers, strict on OpenAI where it fits', async () => {
    const off = await ownerReply('tool-surface-before', false);
    const request = await ownerReply('tool-surface-on', true);
    expect(request.system).toContain(TOOL_SEARCH_LINE);
    // One menu every round, so propose_action is offered before anything outside arrives; the switch-off loop adds it
    // only once the turn is tainted. Otherwise the same tools, each placed by its record.
    expect(request.tools!.map((tool) => tool.name).filter((name) => name !== 'propose_action')).toEqual(off.tools!.map((tool) => tool.name));
    expect(brainTools(request.tools!.map(({ namespace: _n, defer_loading: _d, ...tool }) => tool), true)).toEqual({ tools: request.tools, tool_search: request.tool_search });

    const openAI = (await openAIBody(request)).tools as WireTool[];
    const functions = openAI.filter((tool) => tool.type === 'function');
    const namespaces = openAI.filter((tool) => tool.type === 'namespace');
    expect(openAI.filter((tool) => tool.type === 'tool_search')).toHaveLength(1);
    // Every deferred function sits inside a namespace: OpenAI shows a loose deferred function's description up front.
    expect(functions.every((tool) => tool.defer_loading === undefined)).toBe(true);
    for (const namespace of namespaces) {
      expect(namespace.tools!.length).toBeLessThan(10);
      expect(namespace.tools!.every((tool) => tool.defer_loading === true)).toBe(true);
    }
    const strict = [...functions, ...namespaces.flatMap((namespace) => namespace.tools!)];
    const anthropic = (await anthropicBody(request)).tools as WireTool[];
    expect(anthropic[0]).toEqual({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
    expect(anthropic.some((tool) => tool.strict !== undefined)).toBe(false);

    // This owner has no browser binding, so browse_page (core) and browse_act (web) are not offered; a production owner
    // with browsing has both. They are added here with their own definitions so the figure covers that owner too.
    const browse = brainTools(toolDefinitions([browsePageHandler(undefined, undefined, undefined), browseActHandler(undefined, undefined, undefined)]), true).tools!;
    const withBrowse = { ...request, tools: [...request.tools!, ...browse], tool_search: { namespaces: { ...request.tool_search!.namespaces, web: BRAIN_NAMESPACES.web } } };
    const openAIBrowse = (await openAIBody(withBrowse)).tools as WireTool[];
    const anthropicBrowse = (await anthropicBody(withBrowse)).tools as WireTool[];
    expect(openAIBrowse.filter((tool) => tool.type === 'function').map((tool) => tool.name)).toContain('browse_page');
    const report = {
      tools: request.tools!.length,
      before_bytes: bytes(off.tools), before_tokens_est: Math.round(bytes(off.tools) / BYTES_PER_TOKEN_EST),
      openai_visible_bytes: bytes(openAIVisible(openAI)), openai_visible_tokens_est: Math.round(bytes(openAIVisible(openAI)) / BYTES_PER_TOKEN_EST),
      openai_calendar_loaded_tokens_est: Math.round((bytes(openAIVisible(openAI)) + bytes(namespaces.find((namespace) => namespace.name === 'calendar')!.tools)) / BYTES_PER_TOKEN_EST),
      anthropic_visible_bytes: bytes(anthropicVisible(anthropic)), anthropic_visible_tokens_est: Math.round(bytes(anthropicVisible(anthropic)) / BYTES_PER_TOKEN_EST),
      browsing_openai_visible_bytes: bytes(openAIVisible(openAIBrowse)), browsing_openai_visible_tokens_est: Math.round(bytes(openAIVisible(openAIBrowse)) / BYTES_PER_TOKEN_EST),
      browsing_anthropic_visible_bytes: bytes(anthropicVisible(anthropicBrowse)), browsing_anthropic_visible_tokens_est: Math.round(bytes(anthropicVisible(anthropicBrowse)) / BYTES_PER_TOKEN_EST),
      core_bytes: Object.fromEntries(openAIBrowse.filter((tool) => tool.type === 'function').map((tool) => [tool.name, bytes(tool)])), namespaces: Object.fromEntries(namespaces.map((namespace) => [namespace.name, namespace.tools!.map((tool) => tool.name)])),
      strict: strict.filter((tool) => tool.strict === true).length, non_strict: strict.filter((tool) => tool.strict !== true).map((tool) => tool.name),
    };
    console.log(`BRAIN_TOOL_SURFACE ${JSON.stringify(report)}`);
    expect(report.openai_visible_tokens_est).toBeLessThan(4_000);
    expect(report.anthropic_visible_tokens_est).toBeLessThan(4_000);
    expect(report.browsing_openai_visible_tokens_est).toBeLessThan(4_000);
    expect(report.browsing_anthropic_visible_tokens_est).toBeLessThan(4_000);
    expect(report.before_tokens_est).toBeGreaterThan(report.openai_visible_tokens_est * 2);
  });

  // A round after a search replays the provider's search items, and an OpenAI tool_search_output carries the loaded
  // definitions: health tools among them. The scribe reads each tool turn whole, so it must pass them unchanged.
  it('a search round replays through the scribe unchanged, health tool definitions included', async () => {
    let produced: Record<string, unknown>[] = [];
    model.respond = async (request) => {
      if (!request.tool_search || request.tool_turns?.length || !JSON.stringify(request.messages.at(-1)?.content ?? '').includes(ASKED)) return undefined;
      const loaded = ((await openAIBody(request)).tools as WireTool[]).filter((tool) => tool.type === 'namespace' && (tool.name === 'health' || tool.name === 'reminders'));
      expect(loaded.map((tool) => tool.name).sort()).toEqual(['health', 'reminders']);
      produced = [
        { type: 'tool_search_call', id: 'ts_1', call_id: null, execution: 'server', status: 'completed', arguments: { query: 'meal log and reminders' } },
        { type: 'tool_search_output', id: 'tso_1', call_id: null, execution: 'server', status: 'completed', tools: loaded },
        { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'list_reminders', namespace: 'reminders', arguments: '{}' },
      ];
      return { text: '', tool_calls: [{ call_id: 'c1', name: 'list_reminders', arguments: '{}' }], output_items: produced };
    };
    await ownerReply('tool-surface-search-round', true);
    const searched = model.requests.find((request) => request.tool_turns?.some((turn) => turn.call.name === 'list_reminders'));
    expect(searched, 'the round after the search reached the model').toBeDefined();
    const turn = searched!.tool_turns!.find((item) => item.call.name === 'list_reminders')!;
    expect(JSON.stringify(produced)).toContain('log_meal');
    expect(turn.prior_items).toEqual(produced);
    const wire = (await openAIBody(searched!)).input as Record<string, unknown>[];
    expect(wire.map((item) => item.type).filter(Boolean)).toEqual(['tool_search_call', 'tool_search_output', 'function_call', 'function_call_output']);
  });
});

// The deployed switch: staging runs tool search; production keeps the full menu until its own flip. Off is the rollback.
it('staging runs tool search and production does not', () => {
  const parsed = parseJsonc(config) as { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } };
  expect(parsed.env.staging.vars.WALDO_TOOL_SEARCH).toBe('on');
  expect(parsed.vars.WALDO_TOOL_SEARCH).toBe('off');
});
