import {
  ESCALATION_RULES,
  FALLBACK_LADDER,
  GATEWAY_CONSTANT_HEADERS,
  ROUTING_TABLE,
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

export type LLMContextMode = 'full_context' | 'reduced_context';
export type RuntimeFallbackStep = (typeof FALLBACK_LADDER)[number] | 'defer';

export type LLMGatewayRequest = {
  request: LLMRequest;
  route: ModelRoute;
  step: GatewayStep;
  context: LLMContextMode;
  fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
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
  fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
  attempt: number;
};

export type RuntimeLLMRequest = {
  trigger: unknown;
  policy?: RoutingPolicy;
  spend?: RouteSpendState;
  renderRequest(input: RuntimeLLMRenderInput): Omit<LLMRequest, 'model'>;
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
      fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
      usage: LLMUsage;
    }
  | {
      outcome: 'failure';
      model: ModelName;
      provider: Provider;
      context: LLMContextMode;
      fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
      code: ErrorCode;
    }
  | {
      outcome: 'skipped';
      model: ModelName;
      provider: Provider;
      context: LLMContextMode;
      fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
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
  routing_log: RoutingLogEvent | null;
};

export type RuntimeLLMFailure = {
  ok: false;
  error: string;
  code: ErrorCode;
  reason: 'hook_halt' | 'gateway_exhausted' | 'invalid_response' | 'template_unavailable';
  fallback_step: RuntimeFallbackStep;
  attempts: LLMAttempt[];
  routing_log: RoutingLogEvent | null;
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
};

export function selectModelRoute(input: SelectModelRouteInput): ModelRoute {
  const trigger = triggerTypeSchema.parse(input.trigger);
  const policy = routingPolicySchema.parse(input.policy ?? DEFAULT_ROUTING_POLICY);
  const route = policy.routes.find((candidate) => candidate.trigger === trigger);
  if (route === undefined) {
    throw new Error(`routing policy missing trigger: ${trigger}`);
  }

  return modelRouteSchema.parse(route);
}

export class RuntimeLLMProvider {
  private readonly gateway: LLMGatewayAdapter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly customHooks: HookRegistry<HookRuntimeContext>;

  constructor(options: RuntimeLLMProviderOptions) {
    this.gateway = options.gateway;
    this.circuitBreaker = options.circuitBreaker ?? new InMemoryCircuitBreaker();
    this.customHooks = options.hooks ?? [];
  }

  selectModelRoute(input: SelectModelRouteInput): ModelRoute {
    return selectModelRoute(input);
  }

  async complete(input: RuntimeLLMRequest, ctx: HookRuntimeContext): Promise<RuntimeLLMResult> {
    const route = selectModelRoute(input);
    const routingLog: RoutingLogEvent | null = spendCapExceeded(input.spend)
      ? 'spend_cap_degrade'
      : null;
    const attempts: LLMAttempt[] = [];

    if (routingLog === 'spend_cap_degrade') {
      return this.templateOrFailure(input, route, attempts, routingLog, ctx);
    }

    for (const plan of attemptPlan(route)) {
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

      const rendered = input.renderRequest({
        route,
        step: plan.step,
        context: plan.context,
        fallback_step: plan.fallback_step,
        attempt: attempts.length,
      });
      const request = llmRequestSchema.parse({ ...rendered, model: plan.step.model });
      const customPreHook = await this.runCustomPreLlmHooks(request, ctx);
      if (!customPreHook.ok) {
        return failFromHook(customPreHook.error, plan.fallback_step, attempts, routingLog);
      }

      const sanitisedRequest = await sanitiseRequest(customPreHook.request, ctx);
      if (!sanitisedRequest.ok) {
        return failFromHook(
          sanitisedRequest.error,
          plan.fallback_step,
          attempts,
          routingLog,
          sanitisedRequest.scribeDestination,
        );
      }

      const preHook = await this.runCorePreLlmHooks(sanitisedRequest.request, ctx);
      if (preHook !== null) {
        return failFromHook(preHook, plan.fallback_step, attempts, routingLog);
      }

      let gatewayResult: AdapterResult<LLMResponse>;
      try {
        gatewayResult = await this.gateway.complete({
          request: sanitisedRequest.request,
          route,
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
          return invalidResponseFailure(plan.fallback_step, attempts, routingLog);
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
        return invalidResponseFailure(plan.fallback_step, attempts, routingLog);
      }

      const postHook = await this.runPostLlmHook(parsedResponse.data, ctx);
      if (!postHook.ok) {
        return failFromHook(
          postHook.error,
          plan.fallback_step,
          attempts,
          routingLog,
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
          routingLog !== null ||
          plan.fallback_step !== 'configured_model' ||
          plan.context !== 'full_context',
        usage,
        attempts,
        routing_log: routingLog,
      };
    }

    return this.templateOrFailure(input, route, attempts, routingLog, ctx);
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
    routingLog: RoutingLogEvent | null,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeLLMResult> {
    if (route.floor !== 'template' || input.renderTemplate === undefined) {
      return templateUnavailableFailure(route, attempts, routingLog);
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
      return templateUnavailableFailure(route, attempts, routingLog);
    }
    if (!parsedResponse.success) {
      return templateUnavailableFailure(route, attempts, routingLog);
    }

    const postHook = await this.runPostLlmHook(parsedResponse.data, ctx);
    if (!postHook.ok) {
      return failFromHook(postHook.error, 'template', attempts, routingLog, 'send_message');
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
      routing_log: routingLog,
    };
  }
}

function invalidResponseFailure(
  fallbackStep: RuntimeFallbackStep,
  attempts: LLMAttempt[],
  routingLog: RoutingLogEvent | null,
): RuntimeLLMFailure {
  return {
    ok: false,
    error: 'invalid gateway response',
    code: 'invalid_args',
    reason: 'invalid_response',
    fallback_step: fallbackStep,
    attempts,
    routing_log: routingLog,
  };
}

function attemptPlan(route: ModelRoute): readonly {
  step: GatewayStep;
  context: LLMContextMode;
  fallback_step: Extract<RuntimeFallbackStep, 'configured_model' | 'gateway_chain'>;
}[] {
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
  routingLog: RoutingLogEvent | null,
): RuntimeLLMResult {
  return {
    ok: false,
    error: route.floor === 'template' ? 'template fallback unavailable' : `route ${route.floor}`,
    code: 'transient',
    reason: route.floor === 'template' ? 'template_unavailable' : 'gateway_exhausted',
    fallback_step: route.floor,
    attempts,
    routing_log: routingLog,
  };
}

function failFromHook(
  error: HookHaltError,
  fallbackStep: RuntimeFallbackStep,
  attempts: LLMAttempt[],
  routingLog: RoutingLogEvent | null,
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
    routing_log: routingLog,
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
