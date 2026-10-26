import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, ANTHROPIC_PROVIDER, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_PROVIDER, type LLMRequest, type LLMToolCall } from '@waldo/contracts';
import { appSubjectFor } from '../src/channels/app-api';
import { loopBook } from '../src/channels/loops';
import { GOOGLE_CONSENT_SCOPES } from '../src/connectors/google';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { HARNESS_TOOLS_LINE } from '../src/prompt/messaging-behavior';
import { FIND_TOOLS, USE_TOOL } from '../src/tools/loader';
import { ensureSchema } from '../src/tracer/schema';

// The owner's own app turn on the real owner object, with every Google feature connected so the tool list is the
// production one. A scripted model records each request; both adapters then build their wire bodies from it with
// recording clients, so the test reads what each provider would be sent.
const OWNER_ID = '6c2e9b14-3a7d-4f05-9e81-2b4c6d8f0a13';
const BASE = 'https://directory.fixture.invalid';
const BYTES_PER_TOKEN_EST = 4;
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const tokens = (value: unknown) => Math.round(bytes(value) / BYTES_PER_TOKEN_EST);

type Scripted = { text: string; tool_calls?: LLMToolCall[]; output_items?: Record<string, unknown>[] };
const model = vi.hoisted(() => ({ requests: [] as LLMGatewayRequest['request'][], respond: undefined as undefined | ((request: LLMGatewayRequest['request']) => Scripted | undefined) }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    model.requests.push(request.request);
    const scripted = model.respond?.(request.request);
    if (scripted) return { ok: true, data: { model: request.request.model, ...scripted, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    const writer = request.request.response_format !== undefined;
    const text = request.request.response_format?.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : writer ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); model.requests = []; model.respond = undefined; });

// Consecutive owner messages to one owner, two minutes apart. Returns every reply round of each message, in order.
type Flags = Readonly<{ WALDO_TOOL_SEARCH?: string; WALDO_TOOL_LOADER?: string }>;
const ownerTurns = async (name: string, flags: Flags, said: readonly string[], inspect?: (state: DurableObjectState) => void): Promise<LLMRequest[][]> => {
  model.requests = [];
  const start = Date.parse('2030-11-04T09:00:00Z');
  vi.useFakeTimers({ toFake: ['Date'], now: start });
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
    const owner = new OwnerDO(state, { ...env, SUPABASE_PROJECT_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_TOOL_SEARCH: undefined, WALDO_TOOL_LOADER: undefined, ...flags });
    const turns: LLMRequest[][] = [];
    try {
      for (const [index, text] of said.entries()) {
        vi.setSystemTime(start + index * 120_000);
        const before = model.requests.length;
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: `client-${name}-${index}`, text }) }));
        expect(sent.status).toBe(202);
        const { message_id: message } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${message}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        turns.push(model.requests.slice(before).filter((request) => request.tools?.length && request.messages.at(-1)?.content.startsWith(text)));
      }
      inspect?.(state);
    } finally { await state.storage.deleteAlarm(); }
    return turns;
  });
};

const step = (provider: typeof OPENAI_PROVIDER | typeof ANTHROPIC_PROVIDER, chosen: LLMRequest['model']) => ({ provider, model: chosen, cache: 'none' as const });
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
// What reached OpenAI on staging: the provider refused the tool-search shape and the step resent without it.
const degraded = (request: LLMRequest): LLMRequest => { const { tool_search: _search, ...rest } = request; return rest; };

// The cached prefix is the tool list, the system prompt, then the messages. From one owner message to the next, the first
// two must be byte-identical on both wires and the second message's history must open with the first message's words as
// the owner wrote them: every per-turn fact rides after the newest words.
describe('the cached prefix from one owner message to the next, on the real owner object', () => {
  it.each([
    ['full menu', { WALDO_TOOL_SEARCH: 'off' }, (request: LLMRequest) => request],
    ['provider search, as degraded on staging', { WALDO_TOOL_SEARCH: 'on' }, degraded],
    ['harness loader', { WALDO_TOOL_LOADER: 'harness' }, (request: LLMRequest) => request],
  ] as const)('%s: tools and system byte-identical, history extends', async (label, flags, sent) => {
    const said = ['what is on today?', 'and tomorrow?'];
    const turns = await ownerTurns(`prefix-${label.replaceAll(' ', '-').replaceAll(',', '')}`, flags, said);
    const [first, second] = [turns[0]![0], turns[1]![0]];
    expect(first && second, 'both messages reached the model with tools').toBeTruthy();
    const [a, b] = [await openAIBody(sent(first!)), await openAIBody(sent(second!))];
    expect(bytes(b.tools)).toBe(bytes(a.tools));
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    expect(b.instructions).toBe(a.instructions);
    const input = b.input as { role: string; content: string }[];
    expect(input[0]).toEqual({ role: 'user', content: said[0] });
    const [x, y] = [await anthropicBody(sent(first!)), await anthropicBody(sent(second!))];
    expect(JSON.stringify(y.tools)).toBe(JSON.stringify(x.tools));
    expect(JSON.stringify(y.system)).toBe(JSON.stringify(x.system));
  });
});

describe('the harness tool loader on the owner turn', () => {
  const ASKED = 'log my lunch and show my reminders';
  const isReply = (request: LLMGatewayRequest['request']) => Boolean(request.tools?.length) && request.messages.at(-1)!.content.startsWith(ASKED);

  it('loads definitions as a tool result and calls through use_tool, with one tool list every round', async () => {
    model.respond = (request) => {
      if (!isReply(request)) return undefined;
      const round = request.tool_turns?.length ?? 0;
      if (round === 0) return { text: '', tool_calls: [{ call_id: 'f1', name: FIND_TOOLS, arguments: JSON.stringify({ groups: ['health', 'reminders'] }) }] };
      if (round === 1) return { text: '', tool_calls: [{ call_id: 'u1', name: USE_TOOL, arguments: JSON.stringify({ name: 'list_reminders', arguments: {} }) }] };
      return { text: 'You have no reminders.' };
    };
    const rounds = (await ownerTurns('harness-rounds', { WALDO_TOOL_LOADER: 'harness' }, [ASKED]))[0];
    expect(rounds!.length).toBe(3);
    expect(new Set(rounds!.map((request) => JSON.stringify(request.tools))).size).toBe(1);
    expect(rounds![0]!.tool_search).toBeUndefined();
    expect(rounds![0]!.system).toContain(HARNESS_TOOLS_LINE);
    // The loaded definitions crossed the scribe unchanged, health tools among them, and only as tool-result text.
    const loaded = JSON.parse(rounds![1]!.tool_turns![0]!.output.split('\n[')[0]!) as { ok: boolean; data: { tools: { name: string; description: string }[] } };
    expect(loaded.ok).toBe(true);
    expect(loaded.data.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['log_meal', 'list_health_logs', 'list_reminders']));
    expect(rounds![1]!.tools!.map((tool) => tool.name)).not.toContain('log_meal');
    // The call ran as list_reminders; the history the provider sees keeps the use_tool call it made.
    const used = rounds![2]!.tool_turns![1]!;
    expect(used.call.name).toBe(USE_TOOL);
    expect(JSON.parse(used.output.split('\n[')[0]!)).toMatchObject({ ok: true });
  });

  // Hostile: the round's hosted web search brought outside text into the turn, and the same response asks to change the
  // owner's quiet hours through use_tool. The taint gate must refuse it as it refuses the direct call, and nothing changes.
  it('a use_tool call in a turn tainted by outside text meets the taint gate and changes nothing', async () => {
    const QUIET = { quiet_start: '00:00', quiet_end: '23:59', volume: 'low' };
    model.respond = (request) => {
      if (!isReply(request)) return undefined;
      if (request.tool_turns?.length) return { text: 'That needs your approval.' };
      return { text: '', output_items: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }], tool_calls: [{ call_id: 'u1', name: USE_TOOL, arguments: JSON.stringify({ name: 'set_proactivity', arguments: QUIET }) }] };
    };
    let volume: string | undefined;
    const rounds = (await ownerTurns('harness-taint', { WALDO_TOOL_LOADER: 'harness' }, [ASKED], (state) => {
      volume = loopBook(state.storage.sql, { newId: () => 'x', now: Date.now }).proactivity().volume;
    }))[0];
    const refused = JSON.parse(rounds!.at(-1)!.tool_turns![0]!.output.split('\n[')[0]!);
    expect(refused).toMatchObject({ ok: false, error_code: 'taint_needs_approval' });
    expect(volume).not.toBe('low');
  });

  it('measures the tools per round: under 4k tokens on both wires, the catalogue counted', async () => {
    const off = (await ownerTurns('harness-measure-off', { WALDO_TOOL_SEARCH: 'off' }, ['what is on today?']))[0]![0];
    const on = (await ownerTurns('harness-measure-on', { WALDO_TOOL_LOADER: 'harness' }, ['what is on today?']))[0]![0];
    const openAI = (await openAIBody(on!)).tools as { type: string; name?: string }[];
    const anthropic = (await anthropicBody(on!)).tools as { name?: string }[];
    const functions = openAI.filter((tool) => tool.type === 'function');
    const find = on!.tools!.find((tool) => tool.name === FIND_TOOLS)!;
    const report = {
      before_tools: off!.tools!.length, before_tokens_est: tokens((await openAIBody(off!)).tools),
      offered: functions.map((tool) => tool.name),
      openai_tokens_est: tokens(functions), anthropic_tokens_est: tokens(anthropic),
      find_tools_tokens_est: tokens(find),
      // The catalogue moved from definitions into the system prompt: counted here so the saving is not overstated.
      system_added_tokens_est: Math.round((bytes(on!.system!) - bytes(off!.system!)) / BYTES_PER_TOKEN_EST),
    };
    console.log(`HARNESS_TOOL_SURFACE ${JSON.stringify(report)}`);
    expect(functions.map((tool) => tool.name)).toEqual(expect.arrayContaining([FIND_TOOLS, USE_TOOL, 'search_communication', 'query_calendar']));
    expect(report.openai_tokens_est).toBeLessThan(4_000);
    expect(report.anthropic_tokens_est).toBeLessThan(4_000);
    expect(report.system_added_tokens_est).toBeLessThan(1_000);
    expect(report.before_tokens_est).toBeGreaterThan((report.openai_tokens_est + report.system_added_tokens_est) * 3);
  });
});
