import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_PROVIDER,
  PROVIDER_OF,
  type ErrorCode,
  type ModelName,
} from '@waldo/contracts';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { OpenAIResponsesAdapter } from '../src/llm/openai';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

// Every adapter at the LLMGatewayAdapter seam answers the same way to the same situations: the provider loop
// (llm/provider.ts) decides retries, fallbacks and the floor from these results alone, so a difference here is a
// difference in how an outage feels to the owner. Provider replies are recorded response shapes; no key, no network.

type SdkCall = (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
type Usage = Readonly<{ input: number; output: number; cached: number }>;

type Harness = Readonly<{
  model: ModelName;
  keyName: string;
  adapter(call: SdkCall, options?: Readonly<{ apiKey?: string; timeoutMs?: number }>): LLMGatewayAdapter;
  // Recorded reply shapes.
  text(text: string, usage: Usage): unknown;
  toolCall(call: Readonly<{ id: string; name: string; args: Record<string, unknown> }>, usage: Usage): unknown;
  empty(usage: Usage): unknown;
  // The SDK's typed error for a provider status, with the provider's message and headers.
  error(status: number, headers?: Record<string, string>): Error;
  // Where the request landed in the provider body.
  toolNames(body: Record<string, unknown>): string[];
  toolSchema(body: Record<string, unknown>, name: string): unknown;
  replayedCallIds(body: Record<string, unknown>): string[];
  replayedResultIds(body: Record<string, unknown>): string[];
  schema(body: Record<string, unknown>): unknown;
}>;

const SECRET = 'secret provider message';

const openai: Harness = {
  model: OPENAI_GPT_6_LUNA_MODEL,
  keyName: 'OPENAI_API_KEY',
  adapter: (call, options) => new OpenAIResponsesAdapter({ apiKey: 'test-key', ...options, client: { responses: { create: call } } as never }),
  text: (text, usage) => ({ id: 'resp_1', status: 'completed', output_text: text, output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cached } } }),
  toolCall: (call, usage) => ({ id: 'resp_2', status: 'completed', output_text: '', output: [{ type: 'function_call', id: 'fc_1', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }], usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cached } } }),
  empty: (usage) => ({ id: 'resp_3', status: 'completed', output_text: '', output: [{ type: 'reasoning', summary: [] }], usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: usage.cached } } }),
  error: (status, headers) => new OpenAI.APIError(status, { message: SECRET, type: 'server_error' }, SECRET, new Headers(headers)),
  toolNames: (body) => (body.tools as Array<{ name: string }>).map((tool) => tool.name),
  toolSchema: (body, name) => (body.tools as Array<{ name: string; parameters: unknown }>).find((tool) => tool.name === name)?.parameters,
  replayedCallIds: (body) => (body.input as Array<{ type?: string; call_id?: string }>).filter((item) => item.type === 'function_call').map((item) => item.call_id!),
  replayedResultIds: (body) => (body.input as Array<{ type?: string; call_id?: string }>).filter((item) => item.type === 'function_call_output').map((item) => item.call_id!),
  schema: (body) => (body.text as { format: { schema: unknown } }).format.schema,
};

const anthropic: Harness = {
  model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  keyName: 'ANTHROPIC_API_KEY',
  adapter: (call, options) => new AnthropicMessagesAdapter({ apiKey: 'test-key', ...options, client: { messages: { create: call } } as never }),
  text: (text, usage) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: usage.input - usage.cached, output_tokens: usage.output, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0 } }),
  toolCall: (call, usage) => ({ id: 'msg_2', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }], usage: { input_tokens: usage.input - usage.cached, output_tokens: usage.output, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0 } }),
  empty: (usage) => ({ id: 'msg_3', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: { input_tokens: usage.input - usage.cached, output_tokens: usage.output, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0 } }),
  error: (status, headers) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'api_error', message: SECRET } }, SECRET, new Headers(headers)),
  toolNames: (body) => (body.tools as Array<{ name: string }>).map((tool) => tool.name),
  toolSchema: (body, name) => (body.tools as Array<{ name: string; input_schema: unknown }>).find((tool) => tool.name === name)?.input_schema,
  replayedCallIds: (body) => (body.messages as Array<{ content: Array<{ type: string; id?: string }> | string }>).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_use').map((block) => block.id!) : []),
  replayedResultIds: (body) => (body.messages as Array<{ content: Array<{ type: string; tool_use_id?: string }> | string }>).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id!) : []),
  schema: (body) => (body.output_config as { format: { schema: unknown } }).format.schema,
};

function gatewayRequest(model: ModelName): LLMGatewayRequest {
  const step = { provider: PROVIDER_OF[model], model, cache: 'none' as const };
  return {
    request: { model, system: 'Be concise.', messages: [{ role: 'user', content: 'What time is it?' }], max_tokens: 64, temperature: 0 },
    route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' },
    step,
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: { 'cf-aig-collect-log-payload': 'false' },
  };
}

const recorder = (harness: Harness, reply: unknown, options?: Readonly<{ apiKey?: string; timeoutMs?: number }>) => {
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = harness.adapter(async (body) => { bodies.push(body); return reply; }, options);
  return { adapter, bodies };
};

describe.each([
  ['OpenAI Responses', openai],
  ['Anthropic Messages', anthropic],
] as const)('%s adapter conformance', (_name, harness) => {
  const usage: Usage = { input: 120, output: 9, cached: 40 };

  it('declares the tools, replays an earlier tool turn, and returns the model tool call under its own id', async () => {
    const { adapter, bodies } = recorder(harness, harness.toolCall({ id: 'call_2', name: 'get_context', args: { detail: 'time' } }, usage));
    const base = gatewayRequest(harness.model);
    const result = await adapter.complete({ ...base, request: {
      ...base.request,
      tools: [{ name: 'get_context', description: 'Current time and place', parameters: { type: 'object', properties: {} } }],
      tool_turns: [{ call: { call_id: 'call_1', name: 'get_context', arguments: '{}' }, output: '{"now":"13:50"}' }],
    } });
    expect(harness.toolNames(bodies[0]!)).toEqual(['get_context']);
    expect(harness.replayedCallIds(bodies[0]!)).toEqual(['call_1']);
    expect(harness.replayedResultIds(bodies[0]!)).toEqual(['call_1']);
    expect(result).toMatchObject({ ok: true, data: { model: harness.model, tool_calls: [{ call_id: 'call_2', name: 'get_context', arguments: '{"detail":"time"}' }] } });
  });

  it('sends a tool parameter that takes either an integer or a string (anyOf) unchanged, and returns the string the model chose', async () => {
    // The memory tools name a claim as `c12` or `12`; both providers accept anyOf in tool parameters.
    const parameters = { type: 'object', additionalProperties: false, required: ['claim_ids'], properties: { claim_ids: { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^c?[0-9]+$' }] } } } };
    const { adapter, bodies } = recorder(harness, harness.toolCall({ id: 'call_3', name: 'forget_memory', args: { claim_ids: ['c12', 13] } }, usage));
    const base = gatewayRequest(harness.model);
    const result = await adapter.complete({ ...base, request: { ...base.request, tools: [{ name: 'forget_memory', description: 'Forget claims', parameters }] } });
    expect(harness.toolSchema(bodies[0]!, 'forget_memory')).toEqual(parameters);
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'call_3', name: 'forget_memory', arguments: '{"claim_ids":["c12",13]}' }] } });
  });

  it('asks for the JSON schema the request names and returns the JSON text', async () => {
    const schema = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } };
    const { adapter, bodies } = recorder(harness, harness.text('{"title":"Weekend plans"}', usage));
    const base = gatewayRequest(harness.model);
    const result = await adapter.complete({ ...base, request: { ...base.request, response_format: { name: 'thread_title', schema } } });
    expect(harness.schema(bodies[0]!)).toEqual(schema);
    expect(result).toMatchObject({ ok: true, data: { text: '{"title":"Weekend plans"}' } });
  });

  it('reports the whole prompt as input tokens, with the cache reads inside it, and the output tokens', async () => {
    const { adapter } = recorder(harness, harness.text('Half past one.', usage));
    await expect(adapter.complete(gatewayRequest(harness.model))).resolves.toMatchObject({
      ok: true,
      data: { text: 'Half past one.', input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 40, latency_ms: expect.any(Number) },
    });
  });

  it('a reply with neither text nor a tool call is a transient miss that still carries its tokens', async () => {
    const { adapter } = recorder(harness, harness.empty(usage));
    await expect(adapter.complete(gatewayRequest(harness.model))).resolves.toMatchObject({
      ok: false, code: 'transient', spent: { input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 40 },
    });
  });

  it.each<[number, ErrorCode]>([
    [400, 'invalid_args'],
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [404, 'not_found'],
    [413, 'oversize'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [529, 'transient'],
  ])('maps a provider %i to %s and keeps the provider message out of the result', async (status, code) => {
    const adapter = harness.adapter(async () => { throw harness.error(status); });
    const result = await adapter.complete(gatewayRequest(harness.model));
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('a 429 carries the wait the provider asked for and whether it allows another try', async () => {
    const adapter = harness.adapter(async () => { throw harness.error(429, { 'retry-after': '7', 'x-should-retry': 'true' }); });
    await expect(adapter.complete(gatewayRequest(harness.model))).resolves.toMatchObject({ ok: false, code: 'rate_limited', retry: { afterMs: 7_000, allowed: true } });
  });

  it('a request the provider never answers is aborted at the adapter timeout and reported transient', async () => {
    const adapter = harness.adapter((_body, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    }), { timeoutMs: 1 });
    await expect(adapter.complete(gatewayRequest(harness.model))).resolves.toMatchObject({ ok: false, code: 'transient' });
  });

  it('a transport failure before any answer is transient, without the thrown message', async () => {
    const adapter = harness.adapter(async () => { throw new Error(SECRET); });
    const result = await adapter.complete(gatewayRequest(harness.model));
    expect(result).toMatchObject({ ok: false, code: 'transient' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('fails as auth_failed before any call when its key is missing', async () => {
    let calls = 0;
    const adapter = harness.adapter(async () => { calls += 1; return harness.text('never', usage); }, { apiKey: '' });
    await expect(adapter.complete(gatewayRequest(harness.model))).resolves.toEqual({ ok: false, code: 'auth_failed', error: `${harness.keyName} is unavailable` });
    expect(calls).toBe(0);
  });

  it('refuses a route for another provider as invalid_args without a call', async () => {
    let calls = 0;
    const adapter = harness.adapter(async () => { calls += 1; return harness.text('never', usage); });
    const other = PROVIDER_OF[harness.model] === OPENAI_PROVIDER ? ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL : OPENAI_GPT_6_LUNA_MODEL;
    const foreign = gatewayRequest(other);
    expect([OPENAI_PROVIDER, ANTHROPIC_PROVIDER]).toContain(foreign.step.provider);
    await expect(adapter.complete(foreign)).resolves.toMatchObject({ ok: false, code: 'invalid_args' });
    expect(calls).toBe(0);
  });
});
