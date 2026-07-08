import {
  GATEWAY_CONSTANT_HEADERS,
  ROSTER,
  ROUTING_TABLE,
  buildSessionState,
  triggerTypeSchema,
  type AdapterResult,
  type LLMResponse,
  type ModelName,
  type TriggerType,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  InMemoryCircuitBreaker,
  RuntimeLLMProvider,
  selectModelRoute,
  type LLMGatewayAdapter,
  type LLMGatewayRequest,
} from '../src/llm/provider';
import type { HookRuntimeContext } from '../src/hooks/registry';

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];

function runtimeCtx(overrides: Partial<HookRuntimeContext> = {}): HookRuntimeContext {
  return {
    authenticatedUserId: 'user-1',
    trigger: 'brief',
    canaryTokens,
    session: buildSessionState({
      trigger: 'brief',
      canary_tokens: canaryTokens,
      started_at: 1_700_000_000_000,
    }),
    sanitise: ({ text }) => ({ ok: true, output: text, redactions: [] }),
    medicalGate: () => true,
    ...overrides,
  };
}

function response(model: ModelName, text = '{"tool_calls":[]}'): LLMResponse {
  return {
    model,
    text,
    input_tokens: 20,
    output_tokens: 5,
    cache_read_input_tokens: model === ROSTER.primary ? 0 : 3,
    latency_ms: 11,
  };
}

class ScriptedGateway implements LLMGatewayAdapter {
  readonly requests: LLMGatewayRequest[] = [];

  constructor(private readonly script: (request: LLMGatewayRequest) => AdapterResult<LLMResponse>) {}

  async complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    this.requests.push(request);
    return this.script(request);
  }
}

describe('RuntimeLLMProvider', () => {
  it('selectModelRoute returns a contract route for every trigger and rejects unknown triggers', () => {
    for (const trigger of triggerTypeSchema.options) {
      expect(selectModelRoute({ trigger })).toEqual(ROUTING_TABLE[trigger]);
    }

    expect(() => selectModelRoute({ trigger: 'morning_wag' })).toThrow();
  });

  it('selectModelRoute consumes route config so provider swaps do not require code changes', () => {
    const fallbackStep = ROUTING_TABLE.brief.fallback[0];
    if (fallbackStep === undefined) throw new Error('brief route missing fallback step');
    const swappedBriefRoute = {
      ...ROUTING_TABLE.brief,
      primary: fallbackStep,
      fallback: [ROUTING_TABLE.brief.primary],
    };

    const route = selectModelRoute({
      trigger: 'brief',
      policy: {
        routes: Object.values({ ...ROUTING_TABLE, brief: swappedBriefRoute }),
        escalation: [],
        template_fallback: true,
      },
    });

    expect(route.primary.model).toBe(ROSTER.fallback);
    expect(route.fallback.map((step) => step.model)).toEqual([ROSTER.primary]);
  });

  it('routes through gateway headers, re-renders each fallback hop, and returns metering only', async () => {
    let calls = 0;
    const gateway = new ScriptedGateway((request) => {
      calls += 1;
      return calls <= 2
        ? { ok: false, error: 'provider saturated', code: 'rate_limited' }
        : { ok: true, data: response(request.request.model) };
    });
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: `brief:${context}` }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback with derived context',
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.response.model).toBe(ROSTER.fallback);
    expect(result.fallback_step).toBe('gateway_chain');
    expect(result.tool_call_source).toEqual({ text: '{"tool_calls":[]}' });
    expect(result.usage).toEqual({
      model: ROSTER.fallback,
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      latency_ms: 11,
    });
    expect(result.attempts.map((attempt) => [attempt.model, attempt.context, attempt.outcome])).toEqual([
      [ROSTER.primary, 'full_context', 'failure'],
      [ROSTER.primary, 'reduced_context', 'failure'],
      [ROSTER.fallback, 'reduced_context', 'success'],
    ]);
    expect(gateway.requests.map((request) => request.headers)).toEqual([
      GATEWAY_CONSTANT_HEADERS,
      GATEWAY_CONSTANT_HEADERS,
      GATEWAY_CONSTANT_HEADERS,
    ]);
    expect(gateway.requests.map((request) => request.request.system)).toEqual([
      `full_context:${ROSTER.primary}`,
      `reduced_context:${ROSTER.primary}`,
      `reduced_context:${ROSTER.fallback}`,
    ]);
  });

  it('opens and cools a circuit without taking every provider dark', async () => {
    let now = 1_000;
    const breaker = new InMemoryCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: () => now,
    });
    const gateway = new ScriptedGateway((request) =>
      request.step.provider === 'workers_ai'
        ? { ok: false, error: 'primary down', code: 'rate_limited' }
        : { ok: true, data: response(request.request.model, 'fallback ok') },
    );
    const provider = new RuntimeLLMProvider({ gateway, circuitBreaker: breaker });

    const first = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx(),
    );
    expect(first.ok).toBe(true);
    expect(breaker.isOpen('workers_ai')).toBe(true);

    now = 2_000;
    const second = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx(),
    );
    expect(second.ok).toBe(true);
    expect(gateway.requests.at(-1)?.step.provider).toBe('anthropic');

    now = 7_001;
    await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx(),
    );
    expect(gateway.requests.at(-2)?.step.provider).toBe('workers_ai');
  });

  it('falls to a deterministic template without another gateway call when every route is unavailable', async () => {
    const gateway = new ScriptedGateway(() => ({
      ok: false,
      error: 'gateway unavailable',
      code: 'transient',
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback with derived context',
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallback_step).toBe('template');
    expect(result.degraded).toBe(true);
    expect(result.response).toEqual({
      model: ROSTER.primary,
      text: 'template fallback with derived context',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      latency_ms: 0,
    });
    expect(gateway.requests).toHaveLength(3);
  });

  it('records spend-cap degradation as budget, not provider failure or injection', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, 'primary degraded answer'),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        spend: { spent_cents_today: 70, cap_cents: 70 },
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routing_log).toBe('spend_cap_degrade');
    expect(result.response.model).toBe(ROSTER.primary);
    expect(result.fallback_step).toBe('configured_model');
    expect(result.degraded).toBe(true);
    expect(gateway.requests.map((request) => request.step.model)).toEqual([ROSTER.primary]);
  });

  it('returns the sanitised PostLLMCall text as the tool-call source', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, 'email user@example.com'),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx({
        sanitise: ({ text }) => ({
          ok: true,
          output: text.replace('user@example.com', '[redacted]'),
          redactions: text.includes('user@example.com') ? [{ kind: 'email', count: 1 }] : [],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('email [redacted]');
    expect(result.tool_call_source).toEqual({ text: 'email [redacted]' });
  });

  it('halts through PostLLMCall hooks before returning unsafe model text', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, `leaked ${canaryTokens[0]}`),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'forbidden',
      reason: 'hook_halt',
      error: 'hook halted',
      fallback_step: 'configured_model',
    });
  });
});
