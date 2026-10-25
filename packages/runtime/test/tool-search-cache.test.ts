import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, OPENAI_GPT_6_1_SOL_MODEL, TOOL_PERMISSIONS, triggerTypeSchema, type ModelName, type ToolName } from '@waldo/contracts';
import OpenAI from 'openai';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { ownerTyped } from './helpers/owner-typed';

// With tool search on, the provider caches a request by its leading bytes, tools first. The tools array must therefore
// be byte-identical on every round of a turn and on the next turn, whatever the turn does: an outside read that taints
// it, a browse refusal that withholds browsing, and a deferred tool loaded by search and called. Each adapter is driven
// through a real owner turn with a recording client, so the bytes compared are the wire bodies.
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const handler = (name: ToolName, schema: z.ZodType, result: () => object) => ({ name, description: `The ${name} tool.`, schema, trigger_allowlist: allowlist(name), autonomy_gated: false, handle: async () => result() });
const handlers = [
  handler('get_context', z.object({}), () => ({ ok: true, data: { now: 'synthetic' }, source_taint: null })),
  handler('read_thread', z.object({ thread_id: z.string() }), () => ({ ok: true, data: { subject: 'Synthetic thread' }, source_taint: 'external' })),
  handler('browse_page', z.object({ url: z.string() }), () => ({ ok: false, code: 'auth_failed', error: 'Browsing is not set up.', source_taint: null })),
  handler('propose_action', z.object({ tool: z.string() }), () => ({ ok: true, data: {}, source_taint: null })),
  handler('list_reminders', z.object({}), () => ({ ok: true, data: { reminders: [] }, source_taint: null })),
];

type Round = readonly Record<string, unknown>[];
const run = async (model: ModelName, gatewayFor: (bodies: Record<string, unknown>[], next: () => Round) => LLMGatewayAdapter, turnOne: readonly Round[], turnTwo: readonly Round[]) => {
  const bodies: Record<string, unknown>[] = [];
  const script = [...turnOne, ...turnTwo];
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'synthetic-key-0123456789', anthropicApiKey: 'synthetic-key-0123456789', toolSearch: true }];
  args[4] = { timezone: 'UTC', now: () => new Date(Date.UTC(2030, 10, 4, 9, bodies.length)) };
  args[5] = handlers as never; args[6] = model; args[10] = gatewayFor(bodies, () => script.shift() ?? []);
  const responder = createOwnerResponder(...args);
  await responder.respond(ownerTyped({ traceId: 'cache-1', conversationRef: 'cache', surface: 'app', text: 'what did the thread say, and what reminders do I have?', memoryWrites: false }), time);
  const firstTurn = bodies.length;
  await responder.respond(ownerTyped({ traceId: 'cache-2', conversationRef: 'cache', surface: 'app', text: 'and the time?', memoryWrites: false }), time);
  return { bodies: bodies.filter((body) => body.tools !== undefined), firstTurn, script };
};

describe('a refused tool search request is visible on the turn record', () => {
  const answered = { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }], output_text: 'Done.', usage: { input_tokens: 1, output_tokens: 1 } };
  const replyHops = async (refuse: boolean) => {
    const entries: TurnLogEntry[] = [];
    const client = { responses: { create: async (body: Record<string, unknown>) => {
      const tools = body.tools as { type: string }[] | undefined;
      if (refuse && tools?.some((tool) => tool.type === 'tool_search')) throw new OpenAI.APIError(400, { message: 'synthetic', code: 'invalid_value' }, 'synthetic', new Headers());
      return answered;
    } } } as unknown as OpenAIResponsesClient;
    const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'synthetic-key-0123456789', toolSearch: true }];
    args[3] = (entry) => entries.push(entry);
    args[5] = handlers as never; args[6] = OPENAI_GPT_6_1_SOL_MODEL; args[10] = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client });
    await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'degrade-1', conversationRef: 'degrade', surface: 'app', text: 'what reminders do I have?', memoryWrites: false }), time);
    return entries.filter((entry) => entry.hop === 'llm_reply');
  };

  it('marks the call that was answered after a refusal, with the refusal not counted as a provider fallback', async () => {
    const hops = await replyHops(true);
    expect(hops.length).toBeGreaterThan(0);
    for (const hop of hops) expect(hop).toMatchObject({ ok: true, tool_search_degraded: true, fallback_fired: false });
  });

  it('marks nothing when the request was accepted', async () => {
    const hops = await replyHops(false);
    expect(hops.length).toBeGreaterThan(0);
    for (const hop of hops) expect(hop.tool_search_degraded).toBeUndefined();
  });
});

describe('tool search keeps the tools array byte-identical across rounds and turns', () => {
  it('OpenAI Responses', async () => {
    const call = (id: string, name: string, args: object, namespace?: string) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
    const done = [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }];
    const gatewayFor = (bodies: Record<string, unknown>[], next: () => Round): LLMGatewayAdapter => {
      const client = { responses: { create: async (body: Record<string, unknown>) => {
        bodies.push(body);
        if (body.tools === undefined) return { id: 'side', status: 'completed', output: done, output_text: 'Done.', usage: { input_tokens: 1, output_tokens: 1 } };
        const output = next();
        const text = output.some((item) => item.type === 'message') ? 'Done.' : '';
        return { id: `r${bodies.length}`, status: 'completed', output, output_text: text, usage: { input_tokens: 1, output_tokens: 1 } };
      } } } as unknown as OpenAIResponsesClient;
      return new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client });
    };
    const { bodies, firstTurn, script } = await run(OPENAI_GPT_6_1_SOL_MODEL, gatewayFor, [
      [call('c1', 'read_thread', { thread_id: 't1' })],
      [call('c2', 'browse_page', { url: 'https://example.test' })],
      [
        { type: 'tool_search_call', id: 'ts_1', call_id: null, execution: 'server', status: 'completed', arguments: { query: 'reminders' } },
        { type: 'tool_search_output', id: 'tso_1', call_id: null, execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'reminders' }] },
        call('c3', 'list_reminders', {}, 'reminders'),
      ],
      done,
    ], [[call('c4', 'get_context', {})], done]);

    expect(script).toEqual([]);
    expect(firstTurn).toBeGreaterThanOrEqual(4);
    expect(bodies).toHaveLength(6);
    // The deferred tool is in its namespace, not up front, on every round, including the one after its search.
    const tools = bodies.map((body) => JSON.stringify(body.tools));
    expect(new Set(tools).size).toBe(1);
    expect(tools[0]).toContain('"type":"tool_search"');
    expect(tools[0]).toContain('"name":"propose_action"');
    expect(tools[0]).toContain('"name":"browse_page"');
  });

  it('Anthropic Messages', async () => {
    const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
    const done = [{ type: 'text', text: 'Done.' }];
    const reply = (content: Round, stop_reason: string) => ({ id: 'msg', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, stop_reason, content, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const gatewayFor = (bodies: Record<string, unknown>[], next: () => Round): LLMGatewayAdapter => {
      const client = { messages: { create: async (body: Record<string, unknown>) => {
        bodies.push(body);
        if (body.tools === undefined) return reply(done, 'end_turn');
        const content = next();
        return reply(content, content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn');
      } } } as never;
      return new AnthropicMessagesAdapter({ apiKey: 'synthetic-key-0123456789', client });
    };
    const { bodies, script } = await run(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, gatewayFor, [
      [use('c1', 'read_thread', { thread_id: 't1' })],
      [use('c2', 'browse_page', { url: 'https://example.test' })],
      [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'reminders' } },
        { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'list_reminders' }] } },
        use('c3', 'list_reminders', {}),
      ],
      done,
    ], [[use('c4', 'get_context', {})], done]);

    expect(script).toEqual([]);
    expect(bodies).toHaveLength(6);
    const tools = bodies.map((body) => JSON.stringify(body.tools));
    expect(new Set(tools).size).toBe(1);
    expect(tools[0]).toContain('"name":"tool_search_tool_bm25"');
    expect(JSON.parse(tools[0]!).find((tool: { name: string }) => tool.name === 'list_reminders').defer_loading).toBe(true);
    expect(bodies.every((body) => body.model === ANTHROPIC_CLAUDE_OPUS_5_5_MODEL)).toBe(true);
  });
});

// Search shapes the owner's reply rounds only. A delegated child is a short read list the model must see whole.
it('a delegated child gets its tools up front, with no tool search', async () => {
  const requests: LLMGatewayRequest['request'][] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const delegates = request.tools?.some((tool) => tool.name === 'delegate_task') === true && !request.tool_turns?.length;
    return { ok: true, data: { model: request.model, text: delegates ? '' : 'Done.', ...(delegates ? { tool_calls: [{ call_id: 'd1', name: 'delegate_task', arguments: JSON.stringify({ task: 'read the synthetic thread and report what it says' }) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'synthetic-key-0123456789', toolSearch: true }];
  args[5] = handlers as never; args[6] = OPENAI_GPT_6_1_SOL_MODEL; args[10] = gateway;
  await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'child-1', conversationRef: 'child', surface: 'app', text: 'have someone read the thread', memoryWrites: false }), time);
  const offered = requests.filter((request) => request.tools?.length);
  const child = offered.filter((request) => !request.tools!.some((tool) => tool.name === 'delegate_task'));
  expect(child.length, 'the child ran').toBeGreaterThan(0);
  for (const request of child) {
    expect(request.tool_search).toBeUndefined();
    expect(request.tools!.some((tool) => tool.namespace !== undefined || tool.defer_loading !== undefined)).toBe(false);
  }
  expect(offered.find((request) => request.tools!.some((tool) => tool.name === 'delegate_task'))!.tool_search).toBeDefined();
});
