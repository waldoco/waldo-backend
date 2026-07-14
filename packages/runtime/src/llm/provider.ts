import {
  ESCALATION_RULES,
  FALLBACK_LADDER,
  GATEWAY_CONSTANT_HEADERS,
  PROVIDER_OF,
  ROSTER,
  ROUTING_TABLE,
  SKILL_PROMPT_SERIALIZER_REVISION,
  isStructuralP6Route,
  p6ClampAction,
  sanitiseFailureReasonSchema,
  sanitiseInputSchema,
  sanitiseResultSchema,
  sourceTaintSchema,
  routingPolicySchema,
  llmRequestSchema,
  llmResponseSchema,
  modelRouteSchema,
  triggerTypeSchema,
  type AdapterResult,
  type ErrorCode,
  type GatewayConstantHeaders,
  type GatewayStep,
  type LLMRequest,
  type LLMResponse,
  type ModelName,
  type ModelRoute,
  type Provider,
  type RoutingLogEvent,
  type RoutingPolicy,
  type SanitiseDestination,
  type SanitiseFailureReason,
} from '@waldo/contracts';
import {
  HookHaltError,
  HOOK_REGISTRY,
  runHooks,
  type HookRegistry,
  type HookRuntimeContext,
} from '../hooks/registry';
import {
  createUnavailableSkillBudget,
  type CountResult,
  type ResolvedSkillBudget,
  type SkillBudgetFactory,
} from '../skills/budget';

export type LLMContextMode = 'full_context' | 'reduced_context';
export type RuntimeFallbackStep = (typeof FALLBACK_LADDER)[number] | 'defer';
type GatewayAttemptFallbackStep = Extract<
  RuntimeFallbackStep,
  'spend_cap_clamp' | 'configured_model' | 'gateway_chain'
>;

export type LLMGatewayRequest = {
  request: LLMRequest;
  route: ModelRoute;
  step: GatewayStep;
  context: LLMContextMode;
  fallback_step: GatewayAttemptFallbackStep;
  headers: GatewayConstantHeaders;
};

export interface LLMGatewayAdapter {
  complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>>;
}

export type RouteSpendState = {
  spent_cents_today: number;
  cap_cents: number | null;
};

export type SelectModelRouteInput = {
  trigger: unknown;
  policy?: RoutingPolicy;
  spend?: RouteSpendState;
};

export type RuntimeLLMRenderInput = {
  route: ModelRoute;
  step: GatewayStep;
  context: LLMContextMode;
  fallback_step: GatewayAttemptFallbackStep;
  attempt: number;
  skillBudget: ResolvedSkillBudget;
};

export type RuntimeLLMRequest = {
  trigger: unknown;
  policy?: RoutingPolicy;
  spend?: RouteSpendState;
  p6ConsecutiveDeferrals?: number;
  renderRequest(
    input: RuntimeLLMRenderInput,
  ): Omit<LLMRequest, 'model'> | Promise<Omit<LLMRequest, 'model'>>;
  renderTemplate?(input: { route: ModelRoute; trigger: ModelRoute['trigger'] }): string;
};

export type LLMUsage = Pick<
  LLMResponse,
  'model' | 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'latency_ms'
>;

export type LLMAttempt =
  | {
      outcome: 'success';
      model: ModelName;
      provider: Provider;
      context: LLMContextMode;
      fallback_step: GatewayAttemptFallbackStep;
      usage: LLMUsage;
    }
  | {
      outcome: 'failure';
      model: ModelName;
      provider: Provider;
      context: LLMContextMode;
      fallback_step: GatewayAttemptFallbackStep;
      code: ErrorCode;
    }
  | {
      outcome: 'skipped';
      model: ModelName;
      provider: Provider;
      context: LLMContextMode;
      fallback_step: GatewayAttemptFallbackStep;
      reason: 'circuit_open';
    };

export type RuntimeLLMSuccess = {
  ok: true;
  response: LLMResponse;
  tool_call_source: { text: string };
  fallback_step: RuntimeFallbackStep;
  degraded: boolean;
  usage: LLMUsage;
  attempts: LLMAttempt[];
  routing_logs: readonly RoutingLogEvent[];
};

export type RuntimeLLMFailure = {
  ok: false;
  error: string;
  code: ErrorCode;
  reason: 'hook_halt' | 'gateway_exhausted' | 'invalid_response' | 'template_unavailable';
  fallback_step: RuntimeFallbackStep;
  attempts: LLMAttempt[];
  routing_logs: readonly RoutingLogEvent[];
  scribe?: {
    destination: SanitiseDestination;
    reason: SanitiseFailureReason;
  };
};

export type RuntimeLLMResult = RuntimeLLMSuccess | RuntimeLLMFailure;

type CircuitBreaker = {
  isOpen(provider: Provider): boolean;
  recordSuccess(provider: Provider): void;
  recordFailure(provider: Provider): void;
};

type CircuitBreakerOptions = {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
};

type CircuitState = {
  failures: number;
  opened_at: number | null;
};

type PostLlmHookResult =
  | { ok: true; response: LLMResponse }
  | { ok: false; error: HookHaltError };

type PreLlmHookResult =
  | { ok: true; request: LLMRequest }
  | { ok: false; error: HookHaltError };

type SanitiseRequestResult =
  | { ok: true; request: LLMRequest }
  | {
      ok: false;
      error: HookHaltError;
      scribeDestination?: Extract<SanitiseDestination, 'system_prompt' | 'internal_context'>;
    };

const DEFAULT_ROUTING_POLICY: RoutingPolicy = routingPolicySchema.parse({
  routes: Object.values(ROUTING_TABLE),
  escalation: Array.from(ESCALATION_RULES),
  template_fallback: true,
});

const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 30_000,
};

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly state = new Map<Provider, CircuitState>();
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_CIRCUIT_OPTIONS, ...options };
  }

  isOpen(provider: Provider): boolean {
    const state = this.state.get(provider);
    if (state?.opened_at === null || state === undefined) {
      return false;
    }

    if (this.now() - state.opened_at >= this.options.cooldownMs) {
      this.state.delete(provider);
      return false;
    }

    return true;
  }

  recordSuccess(provider: Provider): void {
    this.state.delete(provider);
  }

  recordFailure(provider: Provider): void {
    const current = this.state.get(provider) ?? { failures: 0, opened_at: null };
    const failures = current.failures + 1;
    this.state.set(provider, {
      failures,
      opened_at:
        failures >= this.options.failureThreshold ? (current.opened_at ?? this.now()) : null,
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export type RuntimeLLMProviderOptions = {
  gateway: LLMGatewayAdapter;
  circuitBreaker?: CircuitBreaker;
  hooks?: HookRegistry<HookRuntimeContext>;
  skillBudgetFactory?: SkillBudgetFactory;
};

export function selectModelRoute(input: SelectModelRouteInput): ModelRoute {
  const trigger = triggerTypeSchema.parse(input.trigger);
  const policy = routingPolicySchema.parse(input.policy ?? DEFAULT_ROUTING_POLICY);
  const candidates = policy.routes.filter((candidate) => candidate.trigger === trigger);
  if (candidates.length === 0) {
    throw new Error(`routing policy missing trigger: ${trigger}`);
  }
  if (candidates.length > 1) {
    throw new Error(`routing policy ambiguous trigger: ${trigger}`);
  }

  return modelRouteSchema.parse(candidates[0]);
}

export class RuntimeLLMProvider {
  private readonly gateway: LLMGatewayAdapter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly customHooks: HookRegistry<HookRuntimeContext>;
  private readonly skillBudgetFactory: SkillBudgetFactory | undefined;

  constructor(options: RuntimeLLMProviderOptions) {
    this.gateway = options.gateway;
    this.circuitBreaker = options.circuitBreaker ?? new InMemoryCircuitBreaker();
    this.customHooks = options.hooks ?? [];
    this.skillBudgetFactory = options.skillBudgetFactory;
  }

  selectModelRoute(input: SelectModelRouteInput): ModelRoute {
    return selectModelRoute(input);
  }

  async complete(input: RuntimeLLMRequest, ctx: HookRuntimeContext): Promise<RuntimeLLMResult> {
    const route = selectModelRoute(input);
    const spendCapped = spendCapExceeded(input.spend);
    const p6Action = spendCapped ? structuralP6SpendCapAction(route, input.p6ConsecutiveDeferrals) : null;
    const routingLogs = routingLogsFor(spendCapped, p6Action?.log ?? null);
    if (p6Action?.action === 'defer') {
      return templateUnavailableFailure(route, [], routingLogs);
    }
    const effectiveRoute = spendCapped ? spendClampedRoute(route) : route;
    const attempts: LLMAttempt[] = [];

    for (const plan of attemptPlan(effectiveRoute, spendCapped)) {
      if (this.circuitBreaker.isOpen(plan.step.provider)) {
        attempts.push({
          outcome: 'skipped',
          model: plan.step.model,
          provider: plan.step.provider,
          context: plan.context,
          fallback_step: plan.fallback_step,
          reason: 'circuit_open',
        });
        continue;
      }

      const skillBudget = this.resolveSkillBudget(plan.step.model);
      const rendered = await input.renderRequest({
        route: effectiveRoute,
        step: plan.step,
        context: plan.context,
        fallback_step: plan.fallback_step,
        attempt: attempts.length,
        skillBudget,
      });
      const request = llmRequestSchema.parse({ ...rendered, model: plan.step.model });
      const customPreHook = await this.runCustomPreLlmHooks(request, ctx);
      if (!customPreHook.ok) {
        return failFromHook(customPreHook.error, plan.fallback_step, attempts, routingLogs);
      }

      const sanitisedRequest = await sanitiseRequest(customPreHook.request, ctx);
      if (!sanitisedRequest.ok) {
        return failFromHook(
          sanitisedRequest.error,
          plan.fallback_step,
          attempts,
          routingLogs,
          sanitisedRequest.scribeDestination,
        );
      }

      const preHook = await this.runCorePreLlmHooks(sanitisedRequest.request, ctx);
      if (preHook !== null) {
        return failFromHook(preHook, plan.fallback_step, attempts, routingLogs);
      }

      let gatewayResult: AdapterResult<LLMResponse>;
      try {
        gatewayResult = await this.gateway.complete({
          request: sanitisedRequest.request,
          route: effectiveRoute,
          step: plan.step,
          context: plan.context,
          fallback_step: plan.fallback_step,
          headers: GATEWAY_CONSTANT_HEADERS,
        });
      } catch {
        this.circuitBreaker.recordFailure(plan.step.provider);
        attempts.push({
          outcome: 'failure',
          model: plan.step.model,
          provider: plan.step.provider,
          context: plan.context,
          fallback_step: plan.fallback_step,
          code: 'transient',
        });
        continue;
      }

      if (!gatewayResult.ok) {
        this.circuitBreaker.recordFailure(plan.step.provider);
        attempts.push({
          outcome: 'failure',
          model: plan.step.model,
          provider: plan.step.provider,
          context: plan.context,
          fallback_step: plan.fallback_step,
          code: gatewayResult.code,
        });
        if (gatewayResult.code === 'invalid_args') {
          return invalidResponseFailure(plan.fallback_step, attempts, routingLogs);
        }
        continue;
      }

      const parsedResponse = llmResponseSchema.safeParse(gatewayResult.data);
      if (!parsedResponse.success || parsedResponse.data.model !== sanitisedRequest.request.model) {
        this.circuitBreaker.recordFailure(plan.step.provider);
        attempts.push({
          outcome: 'failure',
          model: plan.step.model,
          provider: plan.step.provider,
          context: plan.context,
          fallback_step: plan.fallback_step,
          code: 'invalid_args',
        });
        return invalidResponseFailure(plan.fallback_step, attempts, routingLogs);
      }

      const postHook = await this.runPostLlmHook(parsedResponse.data, ctx);
      if (!postHook.ok) {
        return failFromHook(
          postHook.error,
          plan.fallback_step,
          attempts,
          routingLogs,
          'send_message',
        );
      }

      this.circuitBreaker.recordSuccess(plan.step.provider);
      const response = postHook.response;
      const usage = usageFromResponse(response);
      attempts.push({
        outcome: 'success',
        model: plan.step.model,
        provider: plan.step.provider,
        context: plan.context,
        fallback_step: plan.fallback_step,
        usage,
      });

      return {
        ok: true,
        response,
        tool_call_source: { text: response.text },
        fallback_step: plan.fallback_step,
        degraded:
          routingLogs.length > 0 ||
          plan.fallback_step !== 'configured_model' ||
          plan.context !== 'full_context',
        usage,
        attempts,
        routing_logs: routingLogs,
      };
    }

    return this.templateOrFailure(input, effectiveRoute, attempts, routingLogs, ctx);
  }

  private async runCustomPreLlmHooks(
    request: LLMRequest,
    ctx: HookRuntimeContext,
  ): Promise<PreLlmHookResult> {
    try {
      const payload = await runHooks(
        'PreLLMCall',
        { event: 'PreLLMCall', messages: request.messages, model: request.model },
        ctx,
        { registry: this.customHooks, commitContext: false },
      );
      const parsed =
        payload.event === 'PreLLMCall'
          ? llmRequestSchema.safeParse({ ...request, messages: payload.messages, model: payload.model })
          : null;
      if (parsed === null || !parsed.success || parsed.data.model !== request.model) {
        return {
          ok: false,
          error: new HookHaltError('llm_provider', 'custom pre-llm payload invalid', 'transient'),
        };
      }
      return { ok: true, request: parsed.data };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof HookHaltError
            ? error
            : new HookHaltError('llm_provider', 'custom pre-llm hook failed', 'transient'),
      };
    }
  }

  private resolveSkillBudget(model: ModelName): ResolvedSkillBudget {
    if (this.skillBudgetFactory === undefined) {
      return createUnavailableSkillBudget();
    }

    try {
      const budget = this.skillBudgetFactory({
        model,
        serializerRevision: SKILL_PROMPT_SERIALIZER_REVISION,
      });
      return opaqueSkillBudget(budget) ?? createUnavailableSkillBudget();
    } catch {
      return createUnavailableSkillBudget();
    }
  }

  private async runCorePreLlmHooks(
    request: LLMRequest,
    ctx: HookRuntimeContext,
  ): Promise<HookHaltError | null> {
    try {
      await runHooks(
        'PreLLMCall',
        { event: 'PreLLMCall', messages: request.messages, model: request.model },
        ctx,
        { registry: HOOK_REGISTRY },
      );
      return null;
    } catch (error) {
      return error instanceof HookHaltError
        ? error
        : new HookHaltError('llm_provider', 'pre-llm hook failed', 'transient');
    }
  }

  private async runPostLlmHook(
    response: LLMResponse,
    ctx: HookRuntimeContext,
  ): Promise<PostLlmHookResult> {
    try {
      const customPayload = await runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response,
          tokens_in: response.input_tokens,
          tokens_out: response.output_tokens,
        },
        ctx,
        { registry: this.customHooks, commitContext: false },
      );
      const payload = await runHooks(
        'PostLLMCall',
        customPayload,
        ctx,
        { registry: HOOK_REGISTRY },
      );
      const parsed = payload.event === 'PostLLMCall' ? llmResponseSchema.safeParse(payload.response) : null;
      if (parsed === null || !parsed.success) {
        return {
          ok: false,
          error: new HookHaltError('llm_provider', 'post-llm payload invalid', 'transient'),
        };
      }
      return { ok: true, response: parsed.data };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof HookHaltError
            ? error
            : new HookHaltError('llm_provider', 'post-llm hook failed', 'transient'),
      };
    }
  }

  private async templateOrFailure(
    input: RuntimeLLMRequest,
    route: ModelRoute,
    attempts: LLMAttempt[],
    routingLogs: readonly RoutingLogEvent[],
    ctx: HookRuntimeContext,
  ): Promise<RuntimeLLMResult> {
    if (route.floor !== 'template' || input.renderTemplate === undefined) {
      return templateUnavailableFailure(route, attempts, routingLogs);
    }

    let parsedResponse: ReturnType<typeof llmResponseSchema.safeParse>;
    try {
      parsedResponse = llmResponseSchema.safeParse({
        model: route.primary.model,
        text: input.renderTemplate({ route, trigger: route.trigger }),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        latency_ms: 0,
      });
    } catch {
      return templateUnavailableFailure(route, attempts, routingLogs);
    }
    if (!parsedResponse.success) {
      return templateUnavailableFailure(route, attempts, routingLogs);
    }

    const postHook = await this.runPostLlmHook(parsedResponse.data, ctx);
    if (!postHook.ok) {
      return failFromHook(postHook.error, 'template', attempts, routingLogs, 'send_message');
    }
    const response = postHook.response;
    return {
      ok: true,
      response,
      tool_call_source: { text: response.text },
      fallback_step: 'template',
      degraded: true,
      usage: usageFromResponse(response),
      attempts,
      routing_logs: routingLogs,
    };
  }
}

function opaqueSkillBudget(value: unknown): ResolvedSkillBudget | null {
  if (value === null || typeof value !== 'object') return null;
  const budget = value as Partial<ResolvedSkillBudget>;
  if (
    typeof budget.countRenderedSkill !== 'function' ||
    typeof budget.countRenderedBlock !== 'function'
  ) {
    return null;
  }
  const countRenderedSkill = budget.countRenderedSkill;
  const countRenderedBlock = budget.countRenderedBlock;
  const opaque: ResolvedSkillBudget = {
    countRenderedSkill(fragment) {
      return countFactoryResult(() => countRenderedSkill.call(value, fragment));
    },
    countRenderedBlock(block) {
      return countFactoryResult(() => countRenderedBlock.call(value, block));
    },
  };
  return Object.freeze(opaque);
}

async function countFactoryResult(count: () => unknown): Promise<CountResult> {
  try {
    return normaliseCountResult(await count());
  } catch {
    return { ok: false, code: 'count_failed' };
  }
}

function normaliseCountResult(value: unknown): CountResult {
  if (value === null || typeof value !== 'object') {
    return { ok: false, code: 'count_failed' };
  }
  const result = value as { ok?: unknown; tokens?: unknown; code?: unknown };
  if (
    result.ok === true &&
    typeof result.tokens === 'number' &&
    Number.isFinite(result.tokens) &&
    Number.isInteger(result.tokens) &&
    result.tokens >= 0
  ) {
    return { ok: true, tokens: result.tokens };
  }
  if (result.ok === false && isCountFailureCode(result.code)) {
    return { ok: false, code: result.code };
  }
  return { ok: false, code: 'count_failed' };
}

function isCountFailureCode(value: unknown): value is Extract<CountResult, { ok: false }>['code'] {
  return (
    value === 'unavailable' ||
    value === 'unmapped_model' ||
    value === 'unpinned_revision' ||
    value === 'count_failed'
  );
}

function invalidResponseFailure(
  fallbackStep: RuntimeFallbackStep,
  attempts: LLMAttempt[],
  routingLogs: readonly RoutingLogEvent[],
): RuntimeLLMFailure {
  return {
    ok: false,
    error: 'invalid gateway response',
    code: 'invalid_args',
    reason: 'invalid_response',
    fallback_step: fallbackStep,
    attempts,
    routing_logs: routingLogs,
  };
}

function spendClampedRoute(route: ModelRoute): ModelRoute {
  return {
    ...route,
    primary: {
      provider: PROVIDER_OF[ROSTER.primary],
      model: ROSTER.primary,
      cache: 'none',
    },
    fallback: [],
  };
}

function structuralP6SpendCapAction(
  route: ModelRoute,
  consecutiveDeferrals: unknown,
): ReturnType<typeof p6ClampAction> | null {
  if (!isStructuralP6Route(route)) return null;
  if (
    typeof consecutiveDeferrals !== 'number' ||
    !Number.isSafeInteger(consecutiveDeferrals) ||
    consecutiveDeferrals < 0
  ) {
    return { action: 'defer', log: null };
  }
  return p6ClampAction(consecutiveDeferrals);
}

function routingLogsFor(
  spendCapped: boolean,
  p6Log: Extract<RoutingLogEvent, 'p6_degraded'> | null,
): readonly RoutingLogEvent[] {
  const logs: RoutingLogEvent[] = [];
  if (spendCapped) logs.push('spend_cap_degrade');
  if (p6Log !== null) logs.push(p6Log);
  return logs;
}

function attemptPlan(route: ModelRoute, spendCapped = false): readonly {
  step: GatewayStep;
  context: LLMContextMode;
  fallback_step: GatewayAttemptFallbackStep;
}[] {
  if (spendCapped) {
    return [
      { step: route.primary, context: 'full_context', fallback_step: 'spend_cap_clamp' },
      { step: route.primary, context: 'reduced_context', fallback_step: 'spend_cap_clamp' },
    ];
  }
  return [
    { step: route.primary, context: 'full_context', fallback_step: 'configured_model' },
    { step: route.primary, context: 'reduced_context', fallback_step: 'configured_model' },
    ...route.fallback.map((step) => ({
      step,
      context: 'reduced_context' as const,
      fallback_step: 'gateway_chain' as const,
    })),
  ];
}

function templateUnavailableFailure(
  route: ModelRoute,
  attempts: LLMAttempt[],
  routingLogs: readonly RoutingLogEvent[],
): RuntimeLLMResult {
  return {
    ok: false,
    error: route.floor === 'template' ? 'template fallback unavailable' : `route ${route.floor}`,
    code: 'transient',
    reason: route.floor === 'template' ? 'template_unavailable' : 'gateway_exhausted',
    fallback_step: route.floor,
    attempts,
    routing_logs: routingLogs,
  };
}

function failFromHook(
  error: HookHaltError,
  fallbackStep: RuntimeFallbackStep,
  attempts: LLMAttempt[],
  routingLogs: readonly RoutingLogEvent[],
  scribeDestination?: SanitiseDestination,
): RuntimeLLMFailure {
  const scribeReason =
    error.hook === 'scribe_sanitise' && error.reason.startsWith('scribe:')
      ? sanitiseFailureReasonSchema.safeParse(error.reason.slice('scribe:'.length))
      : null;
  const failure: RuntimeLLMFailure = {
    ok: false,
    error: error.clientMessage,
    code: error.code,
    reason: 'hook_halt',
    fallback_step: fallbackStep,
    attempts,
    routing_logs: routingLogs,
  };
  if (scribeDestination !== undefined && scribeReason?.success === true) {
    failure.scribe = { destination: scribeDestination, reason: scribeReason.data };
  }
  return failure;
}

function usageFromResponse(response: LLMResponse): LLMUsage {
  return {
    model: response.model,
    input_tokens: response.input_tokens,
    output_tokens: response.output_tokens,
    cache_read_input_tokens: response.cache_read_input_tokens,
    latency_ms: response.latency_ms,
  };
}

function spendCapExceeded(spend: RouteSpendState | undefined): boolean {
  return (
    spend !== undefined &&
    spend.cap_cents !== null &&
    spend.spent_cents_today >= spend.cap_cents
  );
}

async function sanitiseRequest(
  request: LLMRequest,
  ctx: HookRuntimeContext,
): Promise<SanitiseRequestResult> {
  const sanitise = ctx.sanitise;
  if (sanitise === undefined) {
    return {
      ok: false,
      error: new HookHaltError('llm_provider', 'scribe sanitiser unavailable', 'transient'),
    };
  }
  const sourceTaint = sourceTaintSchema.safeParse(ctx.sourceTaint);
  const canaryTokens = ctx.session?.canary_tokens ?? ctx.canaryTokens;
  if (!sourceTaint.success) {
    return {
      ok: false,
      error: new HookHaltError('llm_provider', 'request taint invalid', 'invalid_args'),
    };
  }

  const sanitiseValue = async (
    payload: unknown,
    destination: 'system_prompt' | 'internal_context',
  ): Promise<{ ok: true; payload: unknown } | { ok: false; error: HookHaltError }> => {
    const input = sanitiseInputSchema.safeParse({
      payload,
      destination,
      canary_tokens: canaryTokens,
      source_taint: sourceTaint.data,
    });
    if (!input.success) {
      return {
        ok: false,
        error: new HookHaltError('llm_provider', 'scribe candidate invalid', 'invalid_args'),
      };
    }
    try {
      const result = sanitiseResultSchema.parse(await sanitise(input.data));
      if (!result.ok) {
        return {
          ok: false,
          error: new HookHaltError(
            'scribe_sanitise',
            `scribe:${result.reason}`,
            result.reason === 'oversize' ? 'oversize' : 'forbidden',
          ),
        };
      }
      if (result.source_taint !== sourceTaint.data) {
        return {
          ok: false,
          error: new HookHaltError('llm_provider', 'scribe sanitiser changed taint', 'transient'),
        };
      }
      return { ok: true, payload: result.payload };
    } catch {
      return {
        ok: false,
        error: new HookHaltError('llm_provider', 'scribe sanitiser failed', 'transient'),
      };
    }
  };

  const system =
    request.system === undefined
      ? undefined
      : await sanitiseValue(request.system, 'system_prompt');
  if (system !== undefined && !system.ok) {
    return { ...system, scribeDestination: 'system_prompt' };
  }
  if (system !== undefined && typeof system.payload !== 'string') {
    return {
      ok: false,
      error: new HookHaltError('llm_provider', 'sanitised system prompt invalid', 'transient'),
    };
  }
  const messages = await sanitiseValue(request.messages, 'internal_context');
  if (!messages.ok) return { ...messages, scribeDestination: 'internal_context' };
  if (!Array.isArray(messages.payload)) {
    return {
      ok: false,
      error: new HookHaltError('llm_provider', 'sanitised messages invalid', 'transient'),
    };
  }
  const parsed = llmRequestSchema.safeParse({
    ...request,
    system: system?.payload,
    messages: messages.payload,
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : {
        ok: false,
        error: new HookHaltError('llm_provider', 'sanitised request invalid', 'transient'),
      };
}
