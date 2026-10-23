import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, ANTHROPIC_PROVIDER, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_PROVIDER, type LLMRequest } from '@waldo/contracts';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import { InMemoryCircuitBreaker, RuntimeLLMProvider, routedGateway, type LLMGatewayAdapter, type LLMGatewayRequest } from '../src/llm/provider';
import { FIRST_TOKEN_TIMEOUT_MS } from '../src/llm/time-budget';
import type { ReplyDeltaSink } from '../src/conversation/reply-stream';

// R-6: a streamed call that shows no output within the first-token window fails over to the next provider instead of
// holding the turn for the whole-call limit, and a streamed call records its time to first token.

const sink: ReplyDeltaSink = { delta: () => undefined, retract: () => undefined };
const sol = { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_1_SOL_MODEL, cache: 'none' } as const;
const opus = { provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, cache: 'anthropic_native' } as const;
const request = (fallback: readonly typeof opus[], stream = true): LLMGatewayRequest => {
  const body: LLMRequest = { model: OPENAI_GPT_6_1_SOL_MODEL, system: 'Be concise.', messages: [{ role: 'user', content: 'Plan my day.' }], max_tokens: 32, temperature: 0 };
  return {
    request: body, route: { trigger: 'user_message', primary: sol, fallback: [...fallback], floor: 'template' }, step: sol,
    context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' }, ...(stream ? { stream: sink } : {}),
  };
};
const message = { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Your day.', annotations: [] }] };
const done = { type: 'response.completed', response: { id: 'r', status: 'completed', output: [message], output_text: 'Your day.', usage: { input_tokens: 3, output_tokens: 2 } } };
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});
// A provider that accepts the request at once and then emits its first output after `firstOutputMs`.
const slowClient = (firstOutputMs: number) => ({ responses: { create: async (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
  if (body.stream !== true) { await wait(firstOutputMs, options?.signal); return done.response; }
  return { async *[Symbol.asyncIterator]() {
    yield { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } };
    await wait(firstOutputMs, options?.signal);
    yield { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } };
    yield { type: 'response.output_text.delta', output_index: 0, item_id: 'msg-1', content_index: 0, delta: 'Your day.' };
    yield done;
  } };
} } }) as unknown as OpenAIResponsesClient;

describe('first-token timeout', () => {
  it('is 15 seconds', () => { expect(FIRST_TOKEN_TIMEOUT_MS).toBe(15_000); });

  it('fails a streamed call with no output in the window over to the next provider, without a resend on the same model', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client: slowClient(200), firstTokenTimeoutMs: 50 });
    const result = await adapter.complete(request([opus]));
    expect(result).toMatchObject({ ok: false, code: 'transient', retry: { allowed: false } });
    expect(result.ok ? '' : result.error).toContain('first token');
  });

  it('waits out the whole-call limit when no other provider is on the route, so a slow answer still lands', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client: slowClient(120), firstTokenTimeoutMs: 50 });
    const result = await adapter.complete(request([]));
    expect(result.ok && result.data.text).toBe('Your day.');
  });

  it('records the time to first token on a streamed call, and nothing on an unstreamed one', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client: slowClient(30), firstTokenTimeoutMs: 5_000 });
    const streamed = await adapter.complete(request([opus]));
    const plain = await adapter.complete(request([opus], false));
    expect(streamed.ok && streamed.data.ttft_ms).toBeGreaterThanOrEqual(25);
    expect(plain.ok && plain.data).not.toHaveProperty('ttft_ms');
  });

  it('through the provider: Sol stalls, Opus answers, and Sol is not tried again with reduced context', async () => {
    const asked: string[] = [];
    const opusAdapter: LLMGatewayAdapter = { complete: async (input) => { return { ok: true, data: { model: input.request.model, text: 'From the fallback.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } }; } };
    const openai = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client: slowClient(200), firstTokenTimeoutMs: 50 });
    const gateway: LLMGatewayAdapter = { complete: (input) => { asked.push(input.step.model); return routedGateway({ [OPENAI_PROVIDER]: openai, [ANTHROPIC_PROVIDER]: opusAdapter }).complete({ ...input, stream: sink }); } };
    const result = await new RuntimeLLMProvider({ gateway, circuitBreaker: new InMemoryCircuitBreaker() }).complete({
      trigger: 'user_message',
      policy: { routes: [{ trigger: 'user_message', primary: { ...sol, max_tokens: 4096 }, fallback: [{ ...opus, max_tokens: 16_000 }], floor: 'template' }], escalation: [], template_fallback: true },
      renderRequest: () => ({ system: 'Be concise.', messages: [{ role: 'user', content: 'Plan my day.' }], max_tokens: 32, temperature: 0 }),
    }, { authenticatedUserId: 'owner', trigger: 'user_message', canaryTokens: ['0123456789abcdef', 'fedcba9876543210', 'aaaabbbbccccdddd'], sourceTaint: null, toolArgSourceTaint: null, hasApproval: () => true, sanitise: (input: { payload: unknown; source_taint: unknown }) => ({ ok: true, payload: input.payload, source_taint: input.source_taint, redactions: [] }) } as never);
    expect(result.ok && result.response.text).toBe('From the fallback.');
    expect(asked.filter((model) => model === OPENAI_GPT_6_1_SOL_MODEL)).toHaveLength(1);
  });
});
