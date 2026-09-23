// Owning ADRs: ADR-0069 (roster, metering, fallback semantics), ADR-0004 (gateway seam;
// exact-match-only caching per its amendment).
// Invariants under test: request/response shapes with required metering fields; zero prompt
// caching on workers_ai; payload logging pinned off; AdapterResult carries success under the
// data key (legacy response key rejected); the seam is satisfiable by a pure in-memory fake
// that resolves a coded failure instead of throwing.
// Failure modes caught: metering-field drift breaking the ADR-0051 spend-cap reads, a
// cache-read claim on a cacheless provider, payload logging silently re-enabled, a provider
// key smuggled into the contract, a throwing adapter stalling the fallback ladder, and a
// fallback hop replaying the previous hop's rendered prompt.
import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../core/error';
import type { ModelName } from '../model/roster';
import { modelNameSchema, ROSTER } from '../model/roster';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm';
import {
  GATEWAY_CONSTANT_HEADERS,
  gatewayConstantHeadersSchema,
  llmMessageSchema,
  llmRequestSchema,
  llmResponseSchema,
} from './llm';

const baseRequest: LLMRequest = {
  model: ROSTER.primary,
  messages: [{ role: 'user', content: 'compose the morning brief' }],
  max_tokens: 1_024,
  temperature: 0.7,
};

const baseResponse: LLMResponse = {
  model: ROSTER.primary,
  text: 'brief composed',
  input_tokens: 812,
  output_tokens: 120,
  cache_read_input_tokens: 0,
  latency_ms: 950,
};

class ScriptedProvider implements LLMProvider {
  readonly seen: LLMRequest[] = [];

  constructor(private readonly script: (request: LLMRequest) => AdapterResult<LLMResponse>) {}

  async complete(request: LLMRequest): Promise<AdapterResult<LLMResponse>> {
    this.seen.push(request);
    return this.script(request);
  }

  async classify(content: string, taxonomy: string[]): Promise<string[]> {
    return taxonomy.filter((label) => content.includes(label));
  }
}

describe('llmMessage', () => {
  it('role is exactly user and assistant, in order', () => {
    expect(llmMessageSchema.shape.role.options).toEqual(['user', 'assistant']);
  });

  it('rejects a message role outside user|assistant', () => {
    expect(llmMessageSchema.safeParse({ role: 'system', content: 'x' }).success).toBe(false);
  });

  it('rejects empty message content', () => {
    expect(llmMessageSchema.safeParse({ role: 'user', content: '' }).success).toBe(false);
  });
});

describe('llmRequest', () => {
  it('accepts a request for every roster model, with and without a system prompt', () => {
    for (const model of modelNameSchema.options) {
      expect(llmRequestSchema.safeParse({ ...baseRequest, model }).success).toBe(true);
    }
    expect(llmRequestSchema.safeParse({ ...baseRequest, system: 'soul prefix' }).success).toBe(
      true,
    );
  });

  it('rejects a model id outside the roster (the phantom-pin failure class)', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, model: 'not-in-roster' }).success).toBe(
      false,
    );
  });

  it('rejects max_tokens outside 1..8192', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, max_tokens: 0 }).success).toBe(false);
    expect(llmRequestSchema.safeParse({ ...baseRequest, max_tokens: 8_193 }).success).toBe(false);
  });

  it('rejects temperature outside 0..2', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, temperature: -0.1 }).success).toBe(false);
    expect(llmRequestSchema.safeParse({ ...baseRequest, temperature: 2.1 }).success).toBe(false);
  });

  it('rejects an empty messages array', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, messages: [] }).success).toBe(false);
  });

  it('rejects an api_key field — provider keys live in gateway BYOK, never in the contract', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, api_key: 'sk-anything' }).success).toBe(
      false,
    );
  });
});

describe('llmResponse metering', () => {
  it('metering key set is exactly the contract fields, in order', () => {
    expect(Object.keys(llmResponseSchema.shape)).toEqual([
      'model',
      'text',
      'tool_calls',
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'latency_ms',
    ]);
  });

  it('requests may declare tools and replay prior tool turns', () => {
    const call = { call_id: 'c1', name: 'get_context', arguments: '{}' };
    const tools = [{ name: 'get_context', description: 'Current time and timezone', parameters: { type: 'object', properties: {} } }];
    expect(llmRequestSchema.safeParse({ ...baseRequest, tools, tool_turns: [{ call, output: '{"ok":true}' }] }).success).toBe(true);
  });

  it('carries text or tool calls, never neither', () => {
    const call = { call_id: 'c1', name: 'get_context', arguments: '{}' };
    expect(llmResponseSchema.safeParse({ ...baseResponse, text: '' }).success).toBe(false);
    expect(llmResponseSchema.safeParse({ ...baseResponse, text: '', tool_calls: [call] }).success).toBe(true);
  });

  it('accepts a fully metered success', () => {
    expect(llmResponseSchema.safeParse(baseResponse).success).toBe(true);
  });

  it('rejects a negative token count', () => {
    expect(llmResponseSchema.safeParse({ ...baseResponse, input_tokens: -1 }).success).toBe(false);
  });

  it('rejects a missing metering field', () => {
    const missingLatency: Record<string, unknown> = { ...baseResponse };
    delete missingLatency['latency_ms'];
    expect(llmResponseSchema.safeParse(missingLatency).success).toBe(false);
  });

  it('rejects empty response text', () => {
    expect(llmResponseSchema.safeParse({ ...baseResponse, text: '' }).success).toBe(false);
  });

  it('rejects an unknown response field (strictObject drift)', () => {
    expect(llmResponseSchema.safeParse({ ...baseResponse, confidence: 0.9 }).success).toBe(false);
  });

  // Canary detection is hook territory (ADR-0032); the contract must pass text through
  // unaltered so the upstream leak check stays sound.
  it('passes response text through unaltered, canary markers included', () => {
    const text = 'summary deadbeefdeadbeef end';
    expect(llmResponseSchema.parse({ ...baseResponse, text }).text).toBe(text);
  });
});

describe('caching contract — corrected, not stale', () => {
  it('accepts cache reads on an anthropic model (native cache pass-through signal)', () => {
    expect(
      llmResponseSchema.safeParse({
        ...baseResponse,
        model: ROSTER.reasoning,
        cache_read_input_tokens: 2_048,
      }).success,
    ).toBe(true);
  });

  it('rejects a cache-read claim on a workers_ai model — no prompt caching exists there', () => {
    expect(
      llmResponseSchema.safeParse({ ...baseResponse, cache_read_input_tokens: 64 }).success,
    ).toBe(false);
  });

  it('does NOT carry the stale semantic-cache or cross-provider-cache fields', () => {
    expect(llmRequestSchema.safeParse({ ...baseRequest, semantic_cache: true }).success).toBe(
      false,
    );
    expect(
      llmRequestSchema.safeParse({ ...baseRequest, cross_provider_cache: true }).success,
    ).toBe(false);
  });
});

describe('GATEWAY_CONSTANT_HEADERS', () => {
  it('pins payload logging off on every request', () => {
    expect(gatewayConstantHeadersSchema.safeParse(GATEWAY_CONSTANT_HEADERS).success).toBe(true);
    expect(GATEWAY_CONSTANT_HEADERS['cf-aig-collect-log-payload']).toBe('false');
  });

  it('rejects re-enabling payload logging', () => {
    expect(
      gatewayConstantHeadersSchema.safeParse({ 'cf-aig-collect-log-payload': 'true' }).success,
    ).toBe(false);
  });

  it('rejects an unknown header key', () => {
    expect(
      gatewayConstantHeadersSchema.safeParse({ ...GATEWAY_CONSTANT_HEADERS, 'x-extra': '1' })
        .success,
    ).toBe(false);
  });
});

describe('LLMProvider seam — fake providers', () => {
  it('carries success under the data key — the legacy response key does not typecheck', async () => {
    const provider = new ScriptedProvider(() => ({ ok: true, data: baseResponse }));
    const result = await provider.complete(baseRequest);
    expect(result.ok).toBe(true);
    expect('data' in result).toBe(true);
    expect('response' in result).toBe(false);
    // @ts-expect-error the legacy { ok: true, response } shape must not satisfy AdapterResult
    const legacy: AdapterResult<LLMResponse> = { ok: true, response: baseResponse };
    void legacy;
  });

  it('resolves a coded failure instead of throwing on model failure', async () => {
    const provider = new ScriptedProvider(() => ({
      ok: false,
      error: 'model unavailable',
      code: 'transient',
    }));
    await expect(provider.complete(baseRequest)).resolves.toEqual({
      ok: false,
      error: 'model unavailable',
      code: 'transient',
    });
  });

  it('a rate-limited failure walks the reasoning chain, re-rendering the prompt per hop', async () => {
    let calls = 0;
    const provider = new ScriptedProvider((request) => {
      calls += 1;
      return calls <= 2
        ? { ok: false, error: 'provider saturated', code: 'rate_limited' }
        : { ok: true, data: { ...baseResponse, model: request.model } };
    });

    // Reasoning-tier availability chain (ADR-0069 §4): reasoning → fallback → primary.
    // Each hop renders a provider-shaped prompt for its own target model.
    const renderFor = (model: ModelName): string => `shaped-for:${model}`;
    const chain = [ROSTER.reasoning, ROSTER.fallback, ROSTER.primary];
    let final: AdapterResult<LLMResponse> | undefined;
    for (const model of chain) {
      final = await provider.complete({ ...baseRequest, model, system: renderFor(model) });
      if (final.ok) break;
    }

    expect(final?.ok).toBe(true);
    expect(provider.seen.map((r) => r.model)).toEqual(chain);
    const rendered = provider.seen.map((r) => r.system);
    expect(new Set(rendered).size).toBe(chain.length);
  });

  it('classify is satisfiable by a pure fake returning labels drawn from the taxonomy', async () => {
    const provider = new ScriptedProvider(() => ({ ok: true, data: baseResponse }));
    const labels = await provider.classify('a constellation ask', ['constellation', 'pattern']);
    expect(labels).toEqual(['constellation']);
  });
});
