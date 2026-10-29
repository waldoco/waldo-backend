import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import {
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_PROVIDER,
  type LLMRequest,
} from '@waldo/contracts';
import {
  OpenAIResponsesAdapter,
  type OpenAIResponsesClient,
} from '../src/llm/openai';
import type { LLMGatewayRequest } from '../src/llm/provider';

function gatewayRequest(): LLMGatewayRequest {
  const request: LLMRequest = {
    model: OPENAI_GPT_6_LUNA_MODEL,
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Say hello.' }],
    max_tokens: 32,
    temperature: 0,
  };
  return {
    request,
    route: {
      trigger: 'user_message',
      primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' },
      fallback: [],
      floor: 'template',
    },
    step: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' },
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: { 'cf-aig-collect-log-payload': 'false' },
  };
}

function client(create: unknown): OpenAIResponsesClient {
  return { responses: { create } } as unknown as OpenAIResponsesClient;
}

describe('OpenAIResponsesAdapter', () => {
  it('asks the provider not to retain the request or response', async () => {
    let sent: Record<string, unknown> | undefined;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'synthetic-key-0123456789',
      client: client(async (body: Record<string, unknown>) => {
        sent = body;
        return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], output_text: 'hi', usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    });
    await adapter.complete(gatewayRequest());
    expect(sent?.store).toBe(false);
  });

  it.each(['synthetic-only\u2028\u2028', 'synthetic-only\n', ' synthetic-only', 'synthetic only', 'synthetic\0only', 'synthetic-☃', 'synthetic\ronly', 'synthetic\tonly', ''])('rejects malformed credential before calling an injected SDK client: %j', async (apiKey) => {
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey, client: client(async () => { calls++; throw new Error('must not reach SDK'); }) });
    const result = await adapter.complete(gatewayRequest());
    expect(result).toEqual({ ok: false, code: 'auth_failed', error: 'OPENAI_API_KEY is unavailable' });
    expect(calls).toBe(0);
    if (apiKey) expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  // GPT-5.6 and later bill cache writes apart from reads and report them in input_tokens_details.cache_write_tokens.
  it('reports cache writes apart from cache reads, inside the whole prompt count', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => ({
      id: 'resp_write', output_text: 'ok', output: [],
      usage: { input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 60 } },
    } as never)) });
    await expect(adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { input_tokens: 100, cache_read_input_tokens: 30, cache_write_input_tokens: 60 } });
  });

  it('maps Responses API output and usage metadata', async () => {
    let metadata: unknown;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async () => ({
        id: 'resp_test_1',
        output_text: 'Hello from OpenAI.',
        output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Greet briefly.' }] }],
        usage: { input_tokens: 4, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
      } as never)),
      onResponseMetadata: (value) => { metadata = value; },
    });

    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: true,
      data: {
        model: OPENAI_GPT_6_LUNA_MODEL,
        text: 'Hello from OpenAI.',
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        latency_ms: expect.any(Number),
        output_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Greet briefly.' }] }],
      },
    });
    expect(metadata).toMatchObject({ response_id: 'resp_test_1', model: OPENAI_GPT_6_LUNA_MODEL, reasoning: 'Greet briefly.' });
  });

  it('asks for strict structured output when the request carries a schema', async () => {
    let sent: unknown;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: unknown) => {
        sent = body;
        return { id: 'r', output_text: '{"edits":[]}', output: [], usage: { input_tokens: 1, output_tokens: 1 } } as never;
      }),
    });
    const request = gatewayRequest();
    const schema = { type: 'object', additionalProperties: false, required: ['edits'], properties: { edits: { type: 'array' } } };
    await adapter.complete({ ...request, request: { ...request.request, response_format: { name: 'memory_edits', schema } } });
    expect(sent).toMatchObject({ text: { format: { type: 'json_schema', name: 'memory_edits', schema, strict: true } } });
  });

  it('sends owner attachments as image and file inputs on one user message', async () => {
    let sent: { input?: unknown } = {};
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: { input?: unknown }) => {
        sent = body;
        return { id: 'r', output_text: 'Nice lunch.', output: [], usage: { input_tokens: 1, output_tokens: 1 } } as never;
      }),
    });
    const base = gatewayRequest();
    const result = await adapter.complete({
      ...base,
      request: {
        ...base.request,
        attachments: [
          { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg', data_base64: 'AAAA' },
          { kind: 'file', mime_type: 'application/pdf', filename: 'plan.pdf', data_base64: 'BBBB' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(sent.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Say hello.' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA', detail: 'auto' },
        { type: 'input_file', filename: 'plan.pdf', file_data: 'data:application/pdf;base64,BBBB' },
      ],
    }]);
  });

  it('declares function tools, replays prior tool turns and returns tool calls', async () => {
    let sent: { tools?: unknown; input?: unknown } = {};
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: { tools?: unknown; input?: unknown }) => {
        sent = body;
        return { id: 'r', output_text: '', output: [{ type: 'function_call', call_id: 'c2', name: 'get_context', arguments: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } } as never;
      }),
    });
    const base = gatewayRequest();
    const call = { call_id: 'c1', name: 'get_context', arguments: '{}' };
    const parameters = { type: 'object', properties: {} };
    const result = await adapter.complete({
      ...base,
      request: { ...base.request, tools: [{ name: 'get_context', description: 'Current time', parameters }], tool_turns: [{ call, output: '{"now":"13:50"}' }] },
    });
    expect(sent.tools).toEqual([{ type: 'function', name: 'get_context', description: 'Current time', parameters, strict: false }]);
    expect(sent.input).toEqual([
      { role: 'user', content: 'Say hello.' },
      { type: 'function_call', ...call },
      { type: 'function_call_output', call_id: 'c1', output: '{"now":"13:50"}' },
    ]);
    expect(result).toMatchObject({ ok: true, data: { text: '', tool_calls: [{ call_id: 'c2', name: 'get_context', arguments: '{}' }] } });
  });

  it('sends a bounded reasoning effort and classifies an empty truncated output as oversize', async () => {
    let sent: unknown;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: unknown) => {
        sent = body;
        return { id: 'resp_test_2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '', output: [], usage: { input_tokens: 9, output_tokens: 32 } } as never;
      }),
    });
    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: false, code: 'oversize', error: 'OpenAI output incomplete: max_output_tokens',
      spent: { input_tokens: 9, output_tokens: 32, cache_read_input_tokens: 0 },
    });
    expect(sent).toMatchObject({ max_output_tokens: 32, reasoning: { effort: 'low', summary: 'auto' } });
  });

  it('a reasoning-only reply is a transient miss that carries its tokens, and is not asked again here', async () => {
    const empty = { id: 'resp_e', status: 'completed', output_text: '', output: [{ type: 'reasoning', summary: [] }], usage: { input_tokens: 4, output_tokens: 2 } };
    const good = { id: 'resp_g', status: 'completed', output_text: 'Here is your plan.', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Here is your plan.' }] }], usage: { input_tokens: 4, output_tokens: 3 } };
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => [empty, good][calls++] as never) });
    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: false, code: 'transient', error: 'OpenAI returned empty output',
      spent: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0 },
    });
    expect(calls).toBe(1);
  });
  it('a round whose items were not kept (empty) is rebuilt from its records: no id, no reasoning, the kept arguments', async () => {
    let sent: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: { input: unknown }) => { sent = body.input as typeof sent; return { id: 'r', status: 'completed', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } } as never; }),
    });
    const input = gatewayRequest();
    await adapter.complete({ ...input, request: { ...input.request, tool_turns: [
      { call: { call_id: 'c0', name: 'tool', arguments: '{"q":1}' }, output: 'o0', prior_items: [{ type: 'reasoning', id: 'rs_0', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'tool', arguments: '{"q":1}' }] },
      { call: { call_id: 'c1', name: 'tool', arguments: '{}' }, output: 'o1', prior_items: [] },
    ] } });
    expect(sent.slice(1)).toEqual([
      { type: 'reasoning', id: 'rs_0', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'tool', arguments: '{"q":1}' },
      { type: 'function_call_output', call_id: 'c0', output: 'o0' },
      // A function_call sent with its fc_ id needs the reasoning item before it; one rebuilt without an id does not.
      { type: 'function_call', call_id: 'c1', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'o1' },
    ]);
  });
  it('parallel tool calls in one round are replayed once each, not once from the model output and again per call', async () => {
    let sent: Array<{ type?: string; call_id?: string }> = [];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: { input: unknown }) => { sent = body.input as typeof sent; return { id: 'r', status: 'completed', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } } as never; }),
    });
    const input = gatewayRequest();
    const fc = (n: number) => ({ type: 'function_call', id: `fc_${n}`, call_id: `c${n}`, name: 'tool', arguments: '{}' });
    const call = (n: number) => ({ call_id: `c${n}`, name: 'tool', arguments: '{}' });
    await adapter.complete({ ...input, request: { ...input.request, tool_turns: [
      { call: call(1), output: 'o1', prior_items: [{ type: 'reasoning', id: 'rs_1', summary: [] }, fc(1), fc(2), fc(3)] },
      { call: call(2), output: 'o2' },
      { call: call(3), output: 'o3' },
    ] } as never });
    const calls = sent.filter(item => item.type === 'function_call').map(item => item.call_id);
    expect(calls).toEqual(['c1', 'c2', 'c3']);
    expect(sent.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['c1', 'c2', 'c3']);
  });
  it('an incomplete response with partial text is delivered with truncated: true', async () => {
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async () => ({ id: 'resp_test_3', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'partial answer', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial answer' }] }] } as never)),
    });
    await expect(adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { text: 'partial answer', truncated: true } });
  });

  it('fails explicitly when the key is missing', async () => {
    await expect(new OpenAIResponsesAdapter({}).complete(gatewayRequest())).resolves.toEqual({
      ok: false,
      code: 'auth_failed',
      error: 'OPENAI_API_KEY is unavailable',
    });
  });

  it('maps provider errors without exposing their message or key', async () => {
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'secret-test-key',
      client: client(async () => { throw new Error('secret-test-key provider detail'); }),
    });

    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: false,
      code: 'transient',
      error: 'OpenAI request failed',
    });
  });

  it('a provider rejection reports status, error code and parameter, never its message', async () => {
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async () => { throw new OpenAI.APIError(400, { message: 'secret request text', code: 'invalid_value', param: 'input[3]' }, 'secret request text', new Headers()); }),
    });
    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({ ok: false, code: 'invalid_args', error: 'OpenAI request failed (400 invalid_value input[3])' });
  });

  it('aborts a hung request at the adapter timeout', async () => {
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      timeoutMs: 1,
      client: client(async (_body: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })),
    });

    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: false,
      code: 'transient',
      error: 'OpenAI request failed',
    });
  });
});
describe('OpenAIResponsesAdapter reasoning effort', () => {
  const sol = (effort?: string): LLMGatewayRequest => {
    const base = gatewayRequest();
    return {
      ...base,
      request: { ...base.request, model: OPENAI_GPT_6_1_SOL_MODEL, ...(effort === undefined ? {} : { reasoning_effort: effort as never }) },
      route: { ...base.route, primary: { ...base.route.primary, model: OPENAI_GPT_6_1_SOL_MODEL } },
      step: { ...base.step, model: OPENAI_GPT_6_1_SOL_MODEL },
    };
  };
  const recording = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: Record<string, unknown>) => {
        bodies.push(body);
        return { id: 'r', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    });
    return { bodies, adapter };
  };

  it('sends the effort the request names, with an auto summary', async () => {
    const { bodies, adapter } = recording();
    await expect(adapter.complete(sol('medium'))).resolves.toMatchObject({ ok: true });
    await expect(adapter.complete(sol('low'))).resolves.toMatchObject({ ok: true });
    expect(bodies.map((body) => [body.model, body.reasoning])).toEqual([
      [OPENAI_GPT_6_1_SOL_MODEL, { effort: 'medium', summary: 'auto' }],
      [OPENAI_GPT_6_1_SOL_MODEL, { effort: 'low', summary: 'auto' }],
    ]);
  });

  it('a request that names no effort gets the roster effort for its model', async () => {
    const { bodies, adapter } = recording();
    await adapter.complete(sol());
    await adapter.complete(gatewayRequest());
    expect(bodies.map((body) => [body.model, body.reasoning])).toEqual([
      [OPENAI_GPT_6_1_SOL_MODEL, { effort: 'medium', summary: 'auto' }],
      [OPENAI_GPT_6_LUNA_MODEL, { effort: 'low', summary: 'auto' }],
    ]);
  });

  it.each(['none', 'minimal'])('refuses %s for Sol without calling the provider', async (effort) => {
    const { bodies, adapter } = recording();
    await expect(adapter.complete(sol(effort))).resolves.toEqual({
      ok: false, code: 'invalid_args', error: 'OpenAI adapter received a reasoning effort the model does not accept',
    });
    expect(bodies).toHaveLength(0);
  });

  it('refuses an effort Luna does not list either, without calling the provider', async () => {
    const { bodies, adapter } = recording();
    const base = gatewayRequest();
    await expect(adapter.complete({ ...base, request: { ...base.request, reasoning_effort: 'minimal' as never } })).resolves.toMatchObject({ ok: false, code: 'invalid_args' });
    expect(bodies).toHaveLength(0);
  });
});

describe('OpenAIResponsesAdapter prompt caching', () => {
  it('passes prompt_cache_key when the request carries a cache key, omits it otherwise', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: Record<string, unknown>) => {
        bodies.push(body);
        return { id: 'r1', output_text: 'hi', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      }),
    });
    const withKey = gatewayRequest();
    withKey.request.cache_key = 'waldo:owner-1';
    const keyed = await adapter.complete(withKey);
    expect(keyed.ok).toBe(true);
    expect(bodies[0]!.prompt_cache_key).toBe('waldo:owner-1');
    const plain = await adapter.complete(gatewayRequest());
    expect(plain.ok).toBe(true);
    expect('prompt_cache_key' in (bodies[1] ?? {})).toBe(false);
  });
});

describe('OpenAIResponsesAdapter reasoning passback', () => {
  it('replays prior output items verbatim and does not duplicate the function call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: Record<string, unknown>) => {
        bodies.push(body);
        return { id: 'r1', output_text: 'done', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      }),
    });
    const withPrior = gatewayRequest();
    withPrior.request.tool_turns = [{
      call: { call_id: 'c1', name: 'get_context', arguments: '{}' },
      output: '{"ok":true}',
      prior_items: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', call_id: 'c1', name: 'get_context', arguments: '{}' }],
    }];
    const result = await adapter.complete(withPrior);
    expect(result.ok).toBe(true);
    const items = (bodies[0]!.input as Array<Record<string, unknown>>).slice(1);
    expect(items[0]).toMatchObject({ type: 'reasoning', id: 'rs_1' });
    expect(items.filter((item) => item.type === 'function_call' && item.call_id === 'c1')).toHaveLength(1);
    expect(items[items.length - 1]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });

    const plain = gatewayRequest();
    plain.request.tool_turns = [{ call: { call_id: 'c2', name: 'get_context', arguments: '{}' }, output: '{"ok":true}' }];
    await adapter.complete(plain);
    const plainItems = (bodies[1]!.input as Array<Record<string, unknown>>).slice(1);
    expect(plainItems[0]).toMatchObject({ type: 'function_call', call_id: 'c2' });
  });

  // PR 1 item 3: history keeps real roles; a flattened "user: ..." blob made "that one" unresolvable.
  it('sends real multi-turn roles instead of one flattened text', async () => {
    let captured: any;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key', client: client(async (body: unknown) => { captured = body; return { id: 'r', status: 'completed', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const gateway = gatewayRequest();
    (gateway.request as any).messages = [
      { role: 'user', content: 'Show me two flights' },
      { role: 'assistant', content: 'A at 9, B at 11' },
      { role: 'user', content: 'that one' },
    ];
    await adapter.complete(gateway);
    expect(captured.input).toEqual([
      { role: 'user', content: 'Show me two flights' },
      { role: 'assistant', content: 'A at 9, B at 11' },
      { role: 'user', content: 'that one' },
    ]);
  });
});

describe('OpenAIResponsesAdapter after another provider ran a round', () => {
  it('drops the other provider output items and rebuilds the round from its call record', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: Record<string, unknown>) => { bodies.push(body); return { id: 'r', status: 'completed', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const request = gatewayRequest();
    request.request.tool_turns = [{
      call: { call_id: 'c1', name: 'get_context', arguments: '{}' }, output: '{"ok":true}',
      prior_items: [{ type: 'thinking', provider: 'anthropic', block: { type: 'thinking', thinking: '', signature: 's' } }, { type: 'tool_use', provider: 'anthropic', block: { type: 'tool_use', id: 'c1', name: 'get_context', input: {} } }],
    }];
    await expect(adapter.complete(request)).resolves.toMatchObject({ ok: true });
    expect((bodies[0]!.input as unknown[]).slice(1)).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'get_context', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]);
  });
});

describe('OpenAIResponsesAdapter hosted web search', () => {
  const searching = (replies: unknown[]) => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: Record<string, unknown>) => { bodies.push(body); return replies[bodies.length - 1]; }) });
    const request = (web_search?: LLMRequest['web_search']): LLMGatewayRequest => {
      const base = gatewayRequest();
      return { ...base, request: { ...base.request, tools: [{ name: 'get_context', description: 'Read context.', parameters: { type: 'object', properties: {} } }], ...(web_search ? { web_search } : {}) } };
    };
    return { bodies, adapter, request };
  };
  const usage = { input_tokens: 1, output_tokens: 1 };
  const message = (text: string, citations: Array<{ url: string; title: string }>) => ({
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: citations.map((c) => ({ type: 'url_citation', start_index: 0, end_index: 1, ...c })) }],
  });

  it('offers the hosted search after the function tools, located where the owner is', async () => {
    const { bodies, adapter, request } = searching([{ id: 'r', status: 'completed', output_text: 'ok', output: [], usage }]);
    await adapter.complete(request({ country: 'IN', timezone: 'Asia/Kolkata' }));
    expect(bodies[0]!.tools).toEqual([
      { type: 'function', name: 'get_context', description: 'Read context.', parameters: { type: 'object', properties: {} }, strict: false },
      { type: 'web_search', user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } },
    ]);
  });

  it('leaves a request without hosted search unchanged', async () => {
    const { bodies, adapter, request } = searching([{ id: 'r', status: 'completed', output_text: 'ok', output: [], usage }]);
    await adapter.complete(request());
    expect((bodies[0]!.tools as Array<{ type: string }>).map((tool) => tool.type)).toEqual(['function']);
  });

  it('adds every cited link the reply text does not already show', async () => {
    const text = 'The Lalit is 1.2 km from the venue ([thelalit.com](https://www.thelalit.com/bangalore?utm_source=openai)).';
    const output = [
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'hotels near the venue' } },
      message(text, [{ url: 'https://www.thelalit.com/bangalore?utm_source=openai', title: 'The Lalit' }, { url: 'https://maps.example/route?utm_source=openai', title: 'Route\nmap' }]),
    ];
    const { adapter, request } = searching([{ id: 'r', status: 'completed', output_text: text, output, usage }]);
    const result = await adapter.complete(request({ country: 'IN' }));
    if (!result.ok) throw Error(result.error);
    expect(result.data.text).toBe(`${text}\n\nSources:\n- Route map: https://maps.example/route?utm_source=openai`);
  });

  it('leaves a reply whose citations are all shown unchanged', async () => {
    const text = 'Rooms from ₹6,000 ([agoda.com](https://www.agoda.com/x?utm_source=openai)).';
    const { adapter, request } = searching([{ id: 'r', status: 'completed', output_text: text, output: [message(text, [{ url: 'https://www.agoda.com/x?utm_source=openai', title: 'Agoda' }])], usage }]);
    const result = await adapter.complete(request({ country: 'IN' }));
    if (!result.ok) throw Error(result.error);
    expect(result.data.text).toBe(text);
  });

  it('replays a round with a hosted search untouched ahead of its function call output', async () => {
    const roundOne = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-1', summary: [] },
      { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'hotels near the venue' } },
      { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'get_context', arguments: '{}' },
    ];
    const { bodies, adapter, request } = searching([
      { id: 'r1', status: 'completed', output_text: '', output: roundOne, usage },
      { id: 'r2', status: 'completed', output_text: 'Booked nothing yet; here are three options.', output: [], usage },
    ]);
    const first = await adapter.complete(request({ country: 'IN' }));
    if (!first.ok) throw Error(first.error);
    const second = request({ country: 'IN' });
    second.request.tool_turns = [{ call: first.data.tool_calls![0]!, output: '{"ok":true}', prior_items: first.data.output_items! }];
    await expect(adapter.complete(second)).resolves.toMatchObject({ ok: true });
    expect((bodies[1]!.input as unknown[]).slice(1)).toEqual([...roundOne, { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' }]);
  });
});

describe('OpenAIResponsesAdapter tool search', () => {
  const when = { type: 'object', properties: { day: { type: 'string', format: 'date' }, note: { type: 'string', pattern: '^[a-z]+$' } }, required: ['day'], additionalProperties: false };
  const searchRequest = (): LLMGatewayRequest => {
    const base = gatewayRequest();
    return { ...base, request: { ...base.request, tools: [
      { name: 'get_context', description: 'Current time', parameters: { type: 'object', properties: {} } },
      { name: 'query_availability', description: 'Free and busy time', parameters: when, namespace: 'calendar', defer_loading: true },
      { name: 'free_form', description: 'Takes anything', parameters: { type: 'object', properties: { args: { type: 'object', additionalProperties: {} } } }, namespace: 'calendar', defer_loading: true },
    ], tool_search: { namespaces: { calendar: 'Calendar changes and free time.' } } } };
  };

  it('sends core functions strict up front, deferred ones in their namespace, then the hosted tool_search', async () => {
    let sent: { tools?: unknown } = {};
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: { tools?: unknown }) => { sent = body; return { id: 'r', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    await adapter.complete(searchRequest());
    expect(sent.tools).toEqual([
      { type: 'function', name: 'get_context', description: 'Current time', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true },
      { type: 'namespace', name: 'calendar', description: 'Calendar changes and free time.', tools: [
        // The pattern is dropped (JavaScript regex syntax the provider may not compile); the tool's own schema checks it on dispatch.
        { type: 'function', name: 'query_availability', description: 'Free and busy time', strict: true, defer_loading: true, parameters: {
          type: 'object', properties: { day: { type: 'string', format: 'date' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['day', 'note'], additionalProperties: false } },
        // A free-form record cannot be strict, so it goes as it is.
        { type: 'function', name: 'free_form', description: 'Takes anything', strict: false, defer_loading: true, parameters: { type: 'object', properties: { args: { type: 'object', additionalProperties: {} } } } },
      ] },
      { type: 'tool_search' },
    ]);
  });

  it('returns a strict call with the nulls for fields the model left out removed, other calls as sent', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => ({ id: 'r', output_text: '', usage: { input_tokens: 1, output_tokens: 1 }, output: [
      { type: 'tool_search_call', id: 'ts_1', call_id: null, execution: 'server', status: 'completed', arguments: { query: 'free time' } },
      { type: 'tool_search_output', id: 'tso_1', call_id: null, execution: 'server', status: 'completed', tools: [] },
      { type: 'function_call', call_id: 'c1', name: 'query_availability', namespace: 'calendar', arguments: '{"day":"2030-11-04","note":null}' },
      { type: 'function_call', call_id: 'c2', name: 'free_form', namespace: 'calendar', arguments: '{"args":null}' },
    ] })) });
    const result = await adapter.complete(searchRequest());
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [
      { call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' },
      { call_id: 'c2', name: 'free_form', arguments: '{"args":null}' },
    ] } });
  });

  it('replays the search items while tools are offered, and leaves them out of a closing round that offers none', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: Record<string, unknown>) => { bodies.push(body); return { id: 'r', output_text: 'done', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const search = { type: 'tool_search_call', id: 'ts_1', execution: 'server', status: 'completed', arguments: { query: 'free time' } };
    const loaded = { type: 'tool_search_output', id: 'tso_1', execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'calendar' }] };
    const call = { type: 'function_call', call_id: 'c1', name: 'query_availability', namespace: 'calendar', arguments: '{"day":"2030-11-04"}' };
    const turns = [{ call: { call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }, output: '{"free":true}', prior_items: [search, loaded, call] }];
    const offered = searchRequest();
    await adapter.complete({ ...offered, request: { ...offered.request, tool_turns: turns } });
    const closing = searchRequest();
    const { tools: _withdrawn, ...closingRequest } = closing.request;
    await adapter.complete({ ...closing, request: { ...closingRequest, tool_turns: turns } });
    expect((bodies[0]!.input as unknown[]).slice(1)).toEqual([search, loaded, call, { type: 'function_call_output', call_id: 'c1', output: '{"free":true}' }]);
    const { namespace: _namespace, ...plainCall } = call;
    expect((bodies[1]!.input as unknown[]).slice(1)).toEqual([plainCall, { type: 'function_call_output', call_id: 'c1', output: '{"free":true}' }]);
  });

  it('sends a deferred function up front when a round another provider ran called it, so its rebuilt call has a definition', async () => {
    let sent: { tools?: Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>; input?: unknown[] } = {};
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: typeof sent) => { sent = body; return { id: 'r', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const base = searchRequest();
    const block = { type: 'tool_use', id: 'c1', name: 'query_availability', input: { day: '2030-11-04' } };
    await adapter.complete({ ...base, request: { ...base.request, tool_turns: [{ call: { call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }, output: 'free', prior_items: [{ type: 'tool_use', provider: 'anthropic', block }] }] } });
    expect(sent.tools!.filter((tool) => tool.type === 'function').map((tool) => tool.name)).toEqual(['get_context', 'query_availability']);
    expect(sent.tools!.find((tool) => tool.type === 'namespace')!.tools!.map((tool) => tool.name)).toEqual(['free_form']);
    expect(sent.input!.slice(1)).toEqual([{ type: 'function_call', call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }, { type: 'function_call_output', call_id: 'c1', output: 'free' }]);
  });

  it('continues a response that only searched, with its items, and returns the answer after them', async () => {
    const search = { type: 'tool_search_call', id: 'ts_1', call_id: null, execution: 'server', status: 'completed', arguments: { query: 'free time' } };
    const loaded = { type: 'tool_search_output', id: 'tso_1', call_id: null, execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'calendar' }] };
    const call = { type: 'function_call', call_id: 'c1', name: 'query_availability', namespace: 'calendar', arguments: '{"day":"2030-11-04","note":null}' };
    const bodies: Array<Record<string, unknown>> = [];
    const replies = [
      { id: 'r1', status: 'completed', output_text: '', output: [search, loaded], usage: { input_tokens: 10, output_tokens: 2 } },
      { id: 'r2', status: 'completed', output_text: '', output: [call], usage: { input_tokens: 12, output_tokens: 3 } },
    ];
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: Record<string, unknown>) => { bodies.push(body); return replies[bodies.length - 1]; }) });
    const result = await adapter.complete(searchRequest());
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.input).toEqual([{ role: 'user', content: 'Say hello.' }, search, loaded]);
    expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }], input_tokens: 22, output_tokens: 5 } });
    if (result.ok) expect(result.data.output_items).toEqual([search, loaded, call]);
  });

  it('stops continuing a response that keeps only searching, and fails it as an empty answer', async () => {
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => { calls++; return { id: 'r', status: 'completed', output_text: '', usage: { input_tokens: 1, output_tokens: 1 }, output: [
      { type: 'tool_search_call', id: 'ts_1', execution: 'server', status: 'completed', arguments: { query: 'x' } },
      { type: 'tool_search_output', id: 'tso_1', execution: 'server', status: 'completed', tools: [] },
    ] }; }) });
    const result = await adapter.complete(searchRequest());
    expect(calls).toBe(3);
    expect(result).toMatchObject({ ok: false, code: 'transient' });
  });

  const searchItems = [
    { type: 'tool_search_call', id: 'ts_1', execution: 'server', status: 'completed', arguments: { query: 'free time' } },
    { type: 'tool_search_output', id: 'tso_1', execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'calendar' }] },
  ];
  const answer = { id: 'r2', status: 'completed', output_text: 'Free at 3.', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Free at 3.', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } };

  it('keeps the spend of a search-only response when its continuation fails', async () => {
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => {
      calls += 1;
      if (calls === 1) return { id: 'r1', status: 'completed', output_text: '', output: searchItems, usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } };
      throw new OpenAI.APIError(400, { message: 'synthetic', code: 'invalid_value' }, 'synthetic', new Headers());
    }) });
    const result = await adapter.complete(searchRequest());
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, code: 'invalid_args', spent: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 } });
  });

  it('reports no spend for a first call that fails', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => { throw new OpenAI.APIError(400, { message: 'synthetic', code: 'invalid_value' }, 'synthetic', new Headers()); }) });
    const result = await adapter.complete(searchRequest());
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(result).not.toHaveProperty('spent');
  });

  it('keeps the spend of an output cut off at its limit, searches included', async () => {
    const replies = [
      { id: 'r1', status: 'completed', output_text: '', output: searchItems, usage: { input_tokens: 10, output_tokens: 2 } },
      { id: 'r2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '', output: [], usage: { input_tokens: 12, output_tokens: 3 } },
    ];
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => replies[calls++]) });
    const result = await adapter.complete(searchRequest());
    expect(result).toMatchObject({ ok: false, code: 'oversize', spent: { input_tokens: 22, output_tokens: 5 } });
  });

  // Each continuation is billed, so only a complete response whose every item is search work, and that holds a search
  // output, is continued; anything else is answered or failed on the call that returned it.
  it.each([
    ['holds no items at all', { id: 'r1', status: 'completed', output_text: '', output: [], usage: { input_tokens: 1, output_tokens: 1 } }],
    ['called the search but holds no output', { id: 'r1', status: 'completed', output_text: '', output: [searchItems[0]], usage: { input_tokens: 1, output_tokens: 1 } }],
    ['also answered in text', { ...answer, id: 'r1', output: [...searchItems, ...answer.output] }],
    ['stopped at the output limit', { id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '', output: searchItems, usage: { input_tokens: 1, output_tokens: 1 } }],
  ])('does not continue a response that %s', async (_case, response) => {
    let calls = 0;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async () => (calls++ === 0 ? response : answer)) });
    await adapter.complete(searchRequest());
    expect(calls).toBe(1);
  });

  it('replays no search items and no namespaces in a request that declares no tool search', async () => {
    let sent: { input?: unknown[]; tools?: Array<{ type: string }> } = {};
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: typeof sent) => { sent = body; return { id: 'r', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const search = { type: 'tool_search_call', id: 'ts_1', execution: 'server', status: 'completed', arguments: { query: 'free time' } };
    const loaded = { type: 'tool_search_output', id: 'tso_1', execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'calendar' }] };
    const call = { type: 'function_call', call_id: 'c1', name: 'query_availability', namespace: 'calendar', arguments: '{"day":"2030-11-04"}' };
    const base = searchRequest();
    const { tool_search: _declared, ...withoutSearch } = base.request;
    await adapter.complete({ ...base, request: { ...withoutSearch, tool_turns: [{ call: { call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }, output: 'free', prior_items: [search, loaded, call] }] } });
    const { namespace: _namespace, ...plainCall } = call;
    expect(sent.input!.slice(1)).toEqual([plainCall, { type: 'function_call_output', call_id: 'c1', output: 'free' }]);
    expect(sent.tools!.every((tool) => tool.type === 'function')).toBe(true);
  });

  it('sends no length, count or number bounds in a strict schema; the tool checks them after the call', async () => {
    let sent: { tools?: Array<{ type: string; name?: string; parameters?: unknown; strict?: boolean }> } = {};
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: typeof sent) => { sent = body; return { id: 'r', output_text: 'ok', output: [], usage: { input_tokens: 1, output_tokens: 1 } }; }) });
    const base = searchRequest();
    const bounded = { type: 'object', properties: {
      body: { type: 'string', minLength: 1, maxLength: 2000 },
      to: { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1, maxItems: 10 },
      count: { type: 'integer', minimum: 1, maximum: 50 },
    }, required: ['body', 'to'], additionalProperties: false };
    await adapter.complete({ ...base, request: { ...base.request, tools: [{ name: 'send_note', description: 'Send a note', parameters: bounded }] } });
    const tool = sent.tools!.find((item) => item.name === 'send_note')!;
    expect(tool.strict).toBe(true);
    expect(tool.parameters).toEqual({ type: 'object', properties: {
      body: { type: 'string' },
      to: { type: 'array', items: { type: 'string', format: 'email' } },
      count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    }, required: ['body', 'to', 'count'], additionalProperties: false });
  });

  it('sends a tool non-strict when an optional field already takes null, so leaving it out still means keep it', async () => {
    let sent: { tools?: Array<{ type: string; name?: string; parameters?: unknown; strict?: boolean }> } = {};
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key', client: client(async (body: typeof sent) => { sent = body; return { id: 'r', output_text: '', usage: { input_tokens: 1, output_tokens: 1 }, output: [
      { type: 'function_call', call_id: 'c1', name: 'change_task', arguments: '{"task_id":"t1","changes":{"title":"Renamed"}}' },
    ] }; }) });
    const base = searchRequest();
    // What zod writes for `.nullable().optional()`: absent keeps the field, null clears it.
    const changes = { type: 'object', properties: {
      title: { type: 'string', minLength: 1 },
      notes: { anyOf: [{ type: 'string', maxLength: 8192 }, { type: 'null' }] },
    }, additionalProperties: false };
    const parameters = { type: 'object', properties: { task_id: { type: 'string' }, changes }, required: ['task_id'], additionalProperties: false };
    const result = await adapter.complete({ ...base, request: { ...base.request, tools: [{ name: 'change_task', description: 'Change a task', parameters }] } });
    const tool = sent.tools!.find((item) => item.name === 'change_task')!;
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual(parameters);
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'c1', name: 'change_task', arguments: '{"task_id":"t1","changes":{"title":"Renamed"}}' }] } });
  });
});
