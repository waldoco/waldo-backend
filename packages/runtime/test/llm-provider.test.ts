import {
  GATEWAY_CONSTANT_HEADERS,
  DREAMING_P6_ROUTE,
  ROSTER,
  ROUTING_TABLE,
  SKILL_PROMPT_SERIALIZER_REVISION,
  buildSessionState,
  renderBlock,
  renderSkill,
  skillSchema,
  triggerTypeSchema,
  type AdapterResult,
  type HookHandler,
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
  type RuntimeLLMRequest,
} from '../src/llm/provider';
import { createUnavailableSkillBudget } from '../src/skills/budget';
import type { CountResult, ResolvedSkillBudget, SkillBudgetFactory } from '../src/skills/budget';
import type { HookRuntimeContext } from '../src/hooks/registry';
import { evaluateMedicalClaim } from '../src/scribe/medical-gate';
import { sanitise } from '../src/scribe/sanitiser';

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];

const canonicalCountFragment = renderSkill(
  skillSchema.parse({
    name: 'brief-context',
    version: 1,
    provenance: 'system',
    identity_locked: true,
    provisional: false,
    trigger_types: ['brief'],
    trigger_condition: 'brief context is available',
    required_tools: [],
    required_connectors: [],
    effectiveness: 1,
    invocations: 0,
    last_used: null,
    body_markdown: 'Use the scheduled context.',
    created_at: '2026-07-12T00:00:00Z',
  }),
);
const canonicalCountBlock = renderBlock([canonicalCountFragment]);

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
    sourceTaint: null,
    toolArgSourceTaint: null,
    sanitise,
    medicalGate: evaluateMedicalClaim,
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

  it('fails closed when a policy leaves a trigger route ambiguous', () => {
    expect(() =>
      selectModelRoute({
        trigger: 'dreaming_mode',
        policy: {
          routes: [...Object.values(ROUTING_TABLE), DREAMING_P6_ROUTE],
          escalation: [],
          template_fallback: true,
        },
      }),
    ).toThrow('routing policy ambiguous trigger: dreaming_mode');
  });

  it('mints an opaque skill budget for the configured model immediately before rendering', async () => {
    const events: string[] = [];
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const complete = gateway.complete.bind(gateway);
    gateway.complete = async (request) => {
      events.push('gateway');
      return complete(request);
    };
    const factoryCalls: Array<{
      model: ModelName;
      serializerRevision: typeof SKILL_PROMPT_SERIALIZER_REVISION;
    }> = [];
    let receivedBudget: ResolvedSkillBudget | undefined;
    let renderedSkillCount: Promise<CountResult> | undefined;
    let renderedBlockCount: Promise<CountResult> | undefined;
    const provider = new RuntimeLLMProvider({
      gateway,
      skillBudgetFactory({ model, serializerRevision }) {
        events.push('factory');
        factoryCalls.push({ model, serializerRevision });
        const capability = {
          countRenderedSkill: async () => ({ ok: true as const, tokens: 7 }),
          countRenderedBlock: async () => ({ ok: true as const, tokens: 11 }),
        };
        Object.assign(capability, {
          model,
          tokenizer: 'test-tokenizer',
          serializerRevision,
        });
        return capability;
      },
    });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ context, skillBudget }) {
          events.push('render');
          receivedBudget = skillBudget;
          renderedSkillCount = skillBudget.countRenderedSkill(canonicalCountFragment);
          renderedBlockCount = skillBudget.countRenderedBlock(canonicalCountBlock);
          return {
            system: context,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(factoryCalls).toEqual([
      { model: ROSTER.primary, serializerRevision: SKILL_PROMPT_SERIALIZER_REVISION },
    ]);
    expect(receivedBudget).toBeDefined();
    expect(receivedBudget).not.toHaveProperty('model');
    expect(receivedBudget).not.toHaveProperty('tokenizer');
    expect(receivedBudget).not.toHaveProperty('serializerRevision');
    expect(await renderedSkillCount).toEqual({ ok: true, tokens: 7 });
    expect(await renderedBlockCount).toEqual({ ok: true, tokens: 11 });
    expect(events).toEqual(['factory', 'render', 'gateway']);
  });

  it('awaits an async renderer with a fresh skill budget for every gateway attempt', async () => {
    const gateway = new ScriptedGateway((request) =>
      request.step.model === ROSTER.fallback
        ? { ok: true, data: response(request.request.model) }
        : { ok: false, error: 'provider saturated', code: 'rate_limited' },
    );
    const factoryCalls: Array<{
      model: ModelName;
      serializerRevision: typeof SKILL_PROMPT_SERIALIZER_REVISION;
    }> = [];
    const renderedBudgets: ResolvedSkillBudget[] = [];
    const renderedCounts: CountResult[] = [];
    let minted = 0;
    const provider = new RuntimeLLMProvider({
      gateway,
      skillBudgetFactory({ model, serializerRevision }) {
        factoryCalls.push({ model, serializerRevision });
        minted += 1;
        const count = minted;
        return Object.freeze({
          countRenderedSkill: async () => ({ ok: true as const, tokens: count }),
          countRenderedBlock: async () => ({ ok: true as const, tokens: count }),
        });
      },
    });

    const result = await provider.complete(
      {
        trigger: 'brief',
        async renderRequest({ context, skillBudget }) {
          renderedBudgets.push(skillBudget);
          renderedCounts.push(await skillBudget.countRenderedSkill(canonicalCountFragment));
          return {
            system: context,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.model).toBe(ROSTER.fallback);
    expect(factoryCalls).toEqual([
      { model: ROSTER.primary, serializerRevision: SKILL_PROMPT_SERIALIZER_REVISION },
      { model: ROSTER.primary, serializerRevision: SKILL_PROMPT_SERIALIZER_REVISION },
      { model: ROSTER.fallback, serializerRevision: SKILL_PROMPT_SERIALIZER_REVISION },
    ]);
    expect(renderedBudgets).toHaveLength(3);
    expect(new Set(renderedBudgets).size).toBe(3);
    expect(renderedCounts).toEqual([
      { ok: true, tokens: 1 },
      { ok: true, tokens: 2 },
      { ok: true, tokens: 3 },
    ]);
  });

  it('keeps render callbacks compatible when they ignore the skill budget capability', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ['no factory', undefined],
    [
      'synchronously throwing factory',
      (() => {
        throw new Error('unavailable counter');
      }) as SkillBudgetFactory,
    ],
    ['invalid factory result', (() => ({})) as unknown as SkillBudgetFactory],
  ] as const)('substitutes an unavailable budget when the %s cannot resolve', async (_case, factory) => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const countResults: Array<Promise<CountResult>> = [];
    const provider = new RuntimeLLMProvider({ gateway, skillBudgetFactory: factory });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ skillBudget }) {
          countResults.push(skillBudget.countRenderedSkill(canonicalCountFragment));
          countResults.push(skillBudget.countRenderedBlock(canonicalCountBlock));
          return {
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(await Promise.all(countResults)).toEqual([
      { ok: false, code: 'unavailable' },
      { ok: false, code: 'unavailable' },
    ]);
    expect(gateway.requests).toHaveLength(1);
  });

  it('fails closed when a factory counter throws, rejects, or returns an invalid count', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const skillCountOutcomes: Array<() => unknown> = [
      () => {
        throw new Error('counter unavailable');
      },
      () => Promise.reject(new Error('counter rejected')),
      () => Promise.resolve({ ok: true, tokens: -1 }),
      () => Promise.resolve({ ok: true, tokens: 1.5 }),
      () => Promise.resolve({ ok: false, code: 'unmapped_model' }),
    ];
    const countResults: Array<Promise<CountResult>> = [];
    let nextOutcome = 0;
    const provider = new RuntimeLLMProvider({
      gateway,
      skillBudgetFactory: (() => ({
        countRenderedSkill: () => skillCountOutcomes[nextOutcome++]?.(),
        countRenderedBlock: () => {
          throw new Error('block counter unavailable');
        },
      })) as unknown as SkillBudgetFactory,
    });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ skillBudget }) {
          for (const _outcome of skillCountOutcomes) {
            countResults.push(skillBudget.countRenderedSkill(canonicalCountFragment));
          }
          countResults.push(skillBudget.countRenderedBlock(canonicalCountBlock));
          return {
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(await Promise.all(countResults)).toEqual([
      { ok: false, code: 'count_failed' },
      { ok: false, code: 'count_failed' },
      { ok: false, code: 'count_failed' },
      { ok: false, code: 'count_failed' },
      { ok: false, code: 'unmapped_model' },
      { ok: false, code: 'count_failed' },
    ]);
    expect(gateway.requests).toHaveLength(1);
  });

  it('does not mint a skill budget for circuit-open attempts', async () => {
    const circuitBreaker = new InMemoryCircuitBreaker({ failureThreshold: 1 });
    circuitBreaker.recordFailure('workers_ai');
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const factoryModels: ModelName[] = [];
    const provider = new RuntimeLLMProvider({
      gateway,
      circuitBreaker,
      skillBudgetFactory({ model }) {
        factoryModels.push(model);
        return {
          countRenderedSkill: async () => ({ ok: true as const, tokens: 1 }),
          countRenderedBlock: async () => ({ ok: true as const, tokens: 1 }),
        };
      },
    });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    expect(factoryModels).toEqual([ROSTER.fallback]);
    expect(gateway.requests.map((request) => request.request.model)).toEqual([ROSTER.fallback]);
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

  it('fails with invalid_response when the gateway returns a malformed success payload', async () => {
    const gateway = new ScriptedGateway(() => ({
      ok: true,
      data: {
        model: ROSTER.primary,
        text: '',
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        latency_ms: 11,
      } as LLMResponse,
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
      code: 'invalid_args',
      reason: 'invalid_response',
      fallback_step: 'configured_model',
      attempts: [
        {
          outcome: 'failure',
          model: ROSTER.primary,
          provider: 'workers_ai',
          context: 'full_context',
          fallback_step: 'configured_model',
          code: 'invalid_args',
        },
      ],
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it('clamps a capped route to the primary before L1 and excludes cross-provider fallback', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, 'primary degraded answer'),
    }));
    const budgetModels: ModelName[] = [];
    const provider = new RuntimeLLMProvider({
      gateway,
      skillBudgetFactory({ model }) {
        budgetModels.push(model);
        return createUnavailableSkillBudget();
      },
    });
    const higherCostBriefRoute = {
      ...ROUTING_TABLE.brief,
      primary: { provider: 'anthropic' as const, model: ROSTER.reasoning, cache: 'none' as const },
      fallback: [{ provider: 'anthropic' as const, model: ROSTER.fallback, cache: 'none' as const }],
    };
    let templateCalls = 0;

    const result = await provider.complete(
      {
        trigger: 'brief',
        policy: {
          routes: Object.values({ ...ROUTING_TABLE, brief: higherCostBriefRoute }),
          escalation: [],
          template_fallback: true,
        },
        spend: { spent_cents_today: 70, cap_cents: 70 },
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'brief' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => {
          templateCalls += 1;
          return 'template fallback';
        },
      },
      runtimeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routing_logs).toEqual(['spend_cap_degrade']);
    expect(result.response).toEqual({
      model: ROSTER.primary,
      text: 'primary degraded answer',
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      latency_ms: 11,
    });
    expect(result.fallback_step).toBe('spend_cap_clamp');
    expect(result.degraded).toBe(true);
    expect(result.attempts).toEqual([
      {
        outcome: 'success',
        model: ROSTER.primary,
        provider: 'workers_ai',
        context: 'full_context',
        fallback_step: 'spend_cap_clamp',
        usage: {
          model: ROSTER.primary,
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          latency_ms: 11,
        },
      },
    ]);
    expect(gateway.requests).toHaveLength(1);
    expect(budgetModels).toEqual([ROSTER.primary]);
    expect(gateway.requests[0]).toMatchObject({
      request: { model: ROSTER.primary },
      step: { provider: 'workers_ai', model: ROSTER.primary, cache: 'none' },
      route: {
        primary: { provider: 'workers_ai', model: ROSTER.primary, cache: 'none' },
        fallback: [],
      },
      context: 'full_context',
      fallback_step: 'spend_cap_clamp',
    });
    expect(templateCalls).toBe(0);
  });

  it('reaches the template only after capped primary-only availability attempts', async () => {
    const gateway = new ScriptedGateway(() => ({
      ok: false,
      error: 'gateway unavailable',
      code: 'transient',
    }));
    const provider = new RuntimeLLMProvider({ gateway });
    const higherCostBriefRoute = {
      ...ROUTING_TABLE.brief,
      primary: { provider: 'anthropic' as const, model: ROSTER.reasoning, cache: 'none' as const },
      fallback: [{ provider: 'anthropic' as const, model: ROSTER.fallback, cache: 'none' as const }],
    };

    const result = await provider.complete(
      {
        trigger: 'brief',
        policy: {
          routes: Object.values({ ...ROUTING_TABLE, brief: higherCostBriefRoute }),
          escalation: [],
          template_fallback: true,
        },
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

    expect(result).toMatchObject({
      ok: true,
      fallback_step: 'template',
      routing_logs: ['spend_cap_degrade'],
    });
    expect(
      gateway.requests.map((request) => ({
        model: request.step.model,
        provider: request.step.provider,
        fallback_step: request.fallback_step,
        context: request.context,
      })),
    ).toEqual([
      {
        model: ROSTER.primary,
        provider: 'workers_ai',
        fallback_step: 'spend_cap_clamp',
        context: 'full_context',
      },
      {
        model: ROSTER.primary,
        provider: 'workers_ai',
        fallback_step: 'spend_cap_clamp',
        context: 'reduced_context',
      },
    ]);
  });

  it('fails closed for a capped structural P6 route until its durable count reaches the primary floor', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });
    const p6Request: RuntimeLLMRequest = {
      trigger: 'dreaming_mode',
      policy: {
        routes: Object.values({ ...ROUTING_TABLE, dreaming_mode: DREAMING_P6_ROUTE }),
        escalation: [],
        template_fallback: true,
      },
      spend: { spent_cents_today: 70, cap_cents: 70 },
      renderRequest({ step, context }) {
        return {
          system: `${context}:${step.model}`,
          messages: [{ role: 'user', content: 'dreaming' }],
          max_tokens: 512,
          temperature: 0.3,
        };
      },
    };
    const dreamingCtx = runtimeCtx({
      trigger: 'dreaming_mode',
      session: buildSessionState({
        trigger: 'dreaming_mode',
        canary_tokens: canaryTokens,
        started_at: 1_700_000_000_000,
      }),
    });

    for (const p6ConsecutiveDeferrals of [undefined, -1, 0.5, Number.NaN]) {
      await expect(
        provider.complete({ ...p6Request, p6ConsecutiveDeferrals }, dreamingCtx),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'gateway_exhausted',
        fallback_step: 'defer',
        routing_logs: ['spend_cap_degrade'],
      });
    }
    expect(gateway.requests).toEqual([]);

    const eighth = await provider.complete(
      { ...p6Request, p6ConsecutiveDeferrals: 7 },
      dreamingCtx,
    );
    expect(eighth).toMatchObject({
      ok: true,
      response: { model: ROSTER.primary },
      fallback_step: 'spend_cap_clamp',
      routing_logs: ['spend_cap_degrade', 'p6_degraded'],
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      step: { model: ROSTER.primary, provider: 'workers_ai', cache: 'none' },
      fallback_step: 'spend_cap_clamp',
    });
  });

  it('halts before gateway egress when request sanitisation rejects prompt text', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step, context }) {
          return {
            system: `${context}:${step.model}`,
            messages: [{ role: 'user', content: 'unsafe prompt text' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'template fallback',
      },
      runtimeCtx({
        sanitise: () => ({
          ok: false,
          check: 'instruction_pattern',
          reason: 'untrusted_instruction',
        }),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      fallback_step: 'configured_model',
    });
    expect(gateway.requests).toEqual([]);
  });

  it('halts a capped primary-only request before gateway egress when Scribe rejects prompt text', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    await expect(
      provider.complete(
        {
          trigger: 'brief',
          spend: { spent_cents_today: 70, cap_cents: 70 },
          renderRequest() {
            return {
              messages: [{ role: 'user', content: 'unsafe prompt text' }],
              max_tokens: 512,
              temperature: 0.3,
            };
          },
        },
        runtimeCtx({
          sanitise: () => ({
            ok: false,
            check: 'instruction_pattern',
            reason: 'untrusted_instruction',
          }),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'hook_halt',
      fallback_step: 'spend_cap_clamp',
      routing_logs: ['spend_cap_degrade'],
    });
    expect(gateway.requests).toEqual([]);
  });

  it('halts before gateway egress when system sanitisation throws', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    await expect(
      provider.complete(
        {
          trigger: 'brief',
          renderRequest({ step }) {
            return {
              system: `system:${step.model}`,
              messages: [{ role: 'user', content: 'safe prompt text' }],
              max_tokens: 512,
              temperature: 0.3,
            };
          },
          renderTemplate: () => 'template fallback',
        },
        runtimeCtx({
          sanitise: async () => {
            throw new Error('sanitiser unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'hook_halt', code: 'transient' });
    expect(gateway.requests).toEqual([]);
  });

  it('halts before gateway egress when message sanitisation throws', async () => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    await expect(
      provider.complete(
        {
          trigger: 'brief',
          renderRequest() {
            return {
              messages: [{ role: 'user', content: 'safe prompt text' }],
              max_tokens: 512,
              temperature: 0.3,
            };
          },
          renderTemplate: () => 'template fallback',
        },
        runtimeCtx({
          sanitise: async () => {
            throw new Error('sanitiser unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'hook_halt', code: 'transient' });
    expect(gateway.requests).toEqual([]);
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
        sanitise: (input) => sanitise(input),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.text).toBe('email [REDACTED_EMAIL]');
    expect(result.tool_call_source).toEqual({ text: 'email [REDACTED_EMAIL]' });
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

  it('runs custom PreLLM hooks before terminal sanitisation and never sends injected health data', async () => {
    const injectHealth: HookHandler<HookRuntimeContext> = {
      name: 'inject_health',
      event: 'PreLLMCall',
      priority: 10,
      async handle(payload) {
        if (payload.event !== 'PreLLMCall') return { ok: true };
        return {
          ok: true as const,
          payload: {
            ...payload,
            messages: [
              {
                role: 'user',
                content: JSON.stringify({ context: { steps: 12345 } }),
              },
            ],
          },
        };
      },
    };
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway, hooks: [injectHealth] });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest({ step }) {
          return {
            system: `system:${step.model}`,
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      code: 'forbidden',
      scribe: { destination: 'internal_context', reason: 'health_value_leak' },
    });
    expect(gateway.requests).toEqual([]);
  });

  it('rejects custom PreLLM route drift before gateway egress', async () => {
    const changeModel: HookHandler<HookRuntimeContext> = {
      name: 'change_model',
      event: 'PreLLMCall',
      priority: 10,
      async handle(payload) {
        if (payload.event !== 'PreLLMCall') return { ok: true };
        return {
          ok: true,
          payload: { ...payload, model: ROSTER.fallback },
        };
      },
    };
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway, hooks: [changeModel] });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({ ok: false, reason: 'hook_halt', code: 'transient' });
    expect(gateway.requests).toEqual([]);
  });

  it('sanitises the system once and the whole message array once after custom hooks', async () => {
    const destinations: string[] = [];
    const gateway = new ScriptedGateway((request) => {
      expect(request.request.system).toBe('Contact [REDACTED_EMAIL]');
      expect(request.request.messages).toEqual([
        { role: 'user', content: 'Email [REDACTED_EMAIL]' },
        { role: 'assistant', content: 'Safe reply' },
      ]);
      return { ok: true, data: response(request.request.model) };
    });
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            system: 'Contact owner@example.com',
            messages: [
              { role: 'user', content: 'Email user@example.com' },
              { role: 'assistant', content: 'Safe reply' },
            ],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx({
        sanitise(input) {
          destinations.push(input.destination);
          return sanitise(input);
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(destinations.filter((destination) => destination === 'system_prompt')).toHaveLength(1);
    expect(destinations.filter((destination) => destination === 'internal_context')).toHaveLength(1);
  });

  it('runs terminal core hooks after a custom PostLLM hook and rejects injected health data', async () => {
    const injectHealth: HookHandler<HookRuntimeContext> = {
      name: 'inject_health',
      event: 'PostLLMCall',
      priority: 10,
      async handle(payload, ctx) {
        if (payload.event !== 'PostLLMCall') return { ok: true };
        ctx.sanitise = (input) => ({
          ok: true,
          payload: input.payload,
          source_taint: input.source_taint,
          redactions: [],
        });
        return {
          ok: true,
          payload: {
            ...payload,
            response: {
              ...(payload.response as Record<string, unknown>),
              text: 'HRV: 41 ms',
            },
          },
        };
      },
    };
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, 'safe answer'),
    }));
    const provider = new RuntimeLLMProvider({ gateway, hooks: [injectHealth] });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      code: 'forbidden',
      scribe: { destination: 'send_message', reason: 'health_value_leak' },
    });
  });

  it.each([
    'This appears to be a symptom of pneumonia.',
    'Take .5 tablet of melatonin today.',
    'Take 0.5 tablet of melatonin today.',
  ])('rejects an immutable medical claim returned by the gateway: %s', async (medicalClaim) => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model, medicalClaim),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      code: 'forbidden',
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it.each([
    ['route exhaustion', undefined],
    ['spend cap', { spent_cents_today: 70, cap_cents: 70 }],
  ] as const)('applies terminal output hooks to unsafe templates on %s', async (_case, spend) => {
    const gateway = new ScriptedGateway(() => ({
      ok: false,
      error: 'gateway unavailable',
      code: 'transient',
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        spend,
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'Your HRV is 41 ms',
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      fallback_step: 'template',
      code: 'forbidden',
    });
  });

  it.each([
    ['route exhaustion', undefined],
    ['spend cap', { spent_cents_today: 70, cap_cents: 70 }],
  ] as const)('applies the medical gate to template output on %s', async (_case, spend) => {
    const gateway = new ScriptedGateway(() => ({
      ok: false,
      error: 'gateway unavailable',
      code: 'transient',
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        spend,
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
        renderTemplate: () => 'Take half a tablet of melatonin today.',
      },
      runtimeCtx(),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'hook_halt',
      fallback_step: 'template',
      code: 'forbidden',
    });
  });

  it.each([
    ['route exhaustion', undefined, 3],
    ['spend cap', { spent_cents_today: 70, cap_cents: 70 }, 2],
  ] as const)(
    'redacts safe template PII and preserves the terminal tool source on %s',
    async (_case, spend, gatewayCalls) => {
      const gateway = new ScriptedGateway(() => ({
        ok: false,
        error: 'gateway unavailable',
        code: 'transient',
      }));
      const provider = new RuntimeLLMProvider({ gateway });

      const result = await provider.complete(
        {
          trigger: 'brief',
          spend,
          renderRequest() {
            return {
              messages: [{ role: 'user', content: 'safe prompt' }],
              max_tokens: 512,
              temperature: 0.3,
            };
          },
          renderTemplate: () => 'Contact user@example.com for the update.',
        },
        runtimeCtx(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.text).toBe('Contact [REDACTED_EMAIL] for the update.');
      expect(result.tool_call_source).toEqual({
        text: 'Contact [REDACTED_EMAIL] for the update.',
      });
      expect(gateway.requests).toHaveLength(gatewayCalls);
    },
  );

  it.each([
    ['missing sanitizer', { sanitise: undefined }, 'transient'],
    [
      'oversize policy denial',
      {
        sanitise: () => ({ ok: false, check: 'size_cap', reason: 'oversize' } as const),
      },
      'oversize',
    ],
    [
      'taint mismatch',
      {
        sanitise: (input: Parameters<NonNullable<HookRuntimeContext['sanitise']>>[0]) => ({
          ok: true as const,
          payload: input.payload,
          source_taint: 'external' as const,
          redactions: [],
        }),
      },
      'transient',
    ],
    [
      'invalid sanitizer input',
      { session: undefined, canaryTokens: undefined },
      'invalid_args',
    ],
  ] as const)('classifies %s without provider egress', async (_case, overrides, code) => {
    const gateway = new ScriptedGateway((request) => ({
      ok: true,
      data: response(request.request.model),
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    const result = await provider.complete(
      {
        trigger: 'brief',
        renderRequest() {
          return {
            messages: [{ role: 'user', content: 'safe prompt' }],
            max_tokens: 512,
            temperature: 0.3,
          };
        },
      },
      runtimeCtx(overrides),
    );

    expect(result).toMatchObject({ ok: false, reason: 'hook_halt', code });
    expect(gateway.requests).toEqual([]);
  });

  it('returns a typed failure when template rendering throws', async () => {
    const gateway = new ScriptedGateway(() => ({
      ok: false,
      error: 'gateway unavailable',
      code: 'transient',
    }));
    const provider = new RuntimeLLMProvider({ gateway });

    await expect(
      provider.complete(
        {
          trigger: 'brief',
          spend: { spent_cents_today: 70, cap_cents: 70 },
          renderRequest() {
            return {
              messages: [{ role: 'user', content: 'safe prompt' }],
              max_tokens: 512,
              temperature: 0.3,
            };
          },
          renderTemplate() {
            throw new Error('template unavailable');
          },
        },
        runtimeCtx(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'template_unavailable',
      fallback_step: 'template',
      code: 'transient',
    });
  });
});
