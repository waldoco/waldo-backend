import { describe, expect, it } from 'vitest';
import {
  OPENAI_GPT_5_NANO_MODEL,
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
    model: OPENAI_GPT_5_NANO_MODEL,
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Say hello.' }],
    max_tokens: 32,
    temperature: 0,
  };
  return {
    request,
    route: {
      trigger: 'user_message',
      primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_5_NANO_MODEL, cache: 'none' },
      fallback: [],
      floor: 'template',
    },
    step: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_5_NANO_MODEL, cache: 'none' },
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: { 'cf-aig-collect-log-payload': 'false' },
  };
}

function client(create: unknown): OpenAIResponsesClient {
  return { responses: { create } } as unknown as OpenAIResponsesClient;
}

describe('OpenAIResponsesAdapter', () => {
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
        model: OPENAI_GPT_5_NANO_MODEL,
        text: 'Hello from OpenAI.',
        input_tokens: 4,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        latency_ms: expect.any(Number),
      },
    });
    expect(metadata).toMatchObject({ response_id: 'resp_test_1', model: OPENAI_GPT_5_NANO_MODEL, reasoning: 'Greet briefly.' });
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
        { type: 'input_text', text: 'user: Say hello.' },
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
      { role: 'user', content: [{ type: 'input_text', text: 'user: Say hello.' }] },
      { type: 'function_call', ...call },
      { type: 'function_call_output', call_id: 'c1', output: '{"now":"13:50"}' },
    ]);
    expect(result).toMatchObject({ ok: true, data: { text: '', tool_calls: [{ call_id: 'c2', name: 'get_context', arguments: '{}' }] } });
  });

  it('sends a bounded reasoning effort and classifies truncated output as oversize', async () => {
    let sent: unknown;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'test-key',
      client: client(async (body: unknown) => {
        sent = body;
        return { id: 'resp_test_2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '', output: [] } as never;
      }),
    });
    await expect(adapter.complete(gatewayRequest())).resolves.toEqual({
      ok: false, code: 'oversize', error: 'OpenAI output incomplete: max_output_tokens',
    });
    expect(sent).toMatchObject({ max_output_tokens: 32, reasoning: { effort: 'low', summary: 'auto' } });
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