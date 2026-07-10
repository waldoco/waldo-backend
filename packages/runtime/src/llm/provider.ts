import {
  ESCALATION_RULES,
  FALLBACK_LADDER,
  GATEWAY_CONSTANT_HEADERS,
  ROUTING_TABLE,
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
  private readonly hooks: HookRegistry<HookRuntimeContext>;

  constructor(options: RuntimeLLMProviderOptions) {
    this.gateway = options.gateway;
    this.circuitBreaker = options.circuitBreaker ?? new InMemoryCircuitBreaker();
    this.hooks = options.hooks ?? HOOK_REGISTRY;
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
      return templateOrFailure(input, route, attempts, routingLog);
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
      const sanitisedRequest = await sanitiseRequest(request, ctx);
      if (sanitisedRequest === null) {
        return failFromHook(
          new HookHaltError('llm_provider', 'pre-llm sanitisation failed', 'forbidden'),
          plan.fallback_step,
          attempts,
          routingLog,
        );
      }

      const preHook = await this.runPreLlmHook(sanitisedRequest, ctx);
      if (preHook !== null) {
        return failFromHook(preHook, plan.fallback_step, attempts, routingLog);
      }

      let gatewayResult: AdapterResult<LLMResponse>;
      try {
        gatewayResult = await this.gateway.complete({
          request: sanitisedRequest,
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
      if (!parsedResponse.success || parsedResponse.data.model !== sanitisedRequest.model) {
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
        return failFromHook(postHook.error, plan.fallback_step, attempts, routingLog);
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

    return templateOrFailure(input, route, attempts, routingLog);
  }

  private async runPreLlmHook(
    request: LLMRequest,
    ctx: HookRuntimeContext,
  ): Promise<HookHaltError | null> {
    try {
      await runHooks(
        'PreLLMCall',
        { event: 'PreLLMCall', messages: request.messages, model: request.model },
        ctx,
        { registry: this.hooks },
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
      const payload = await runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response,
          tokens_in: response.input_tokens,
          tokens_out: response.output_tokens,
        },
        ctx,
        { registry: this.hooks },
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

function templateOrFailure(
  input: RuntimeLLMRequest,
  route: ModelRoute,
  attempts: LLMAttempt[],
  routingLog: RoutingLogEvent | null,
): RuntimeLLMResult {
  if (route.floor === 'template' && input.renderTemplate !== undefined) {
    const text = input.renderTemplate({ route, trigger: route.trigger });
    const response = llmResponseSchema.parse({
      model: route.primary.model,
      text,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      latency_ms: 0,
    });
    return {
      ok: true,
      response,
      tool_call_source: { text },
      fallback_step: 'template',
      degraded: true,
      usage: usageFromResponse(response),
      attempts,
      routing_log: routingLog,
    };
  }

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
): RuntimeLLMFailure {
  return {
    ok: false,
    error: error.clientMessage,
    code: error.code,
    reason: 'hook_halt',
    fallback_step: fallbackStep,
    attempts,
    routing_log: routingLog,
  };
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
): Promise<LLMRequest | null> {
  const sanitise = ctx.sanitise;
  if (sanitise === undefined) return null;
  const system =
    request.system === undefined
      ? undefined
      : await sanitiseText(request.system, 'system_prompt', sanitise);
  if (request.system !== undefined && system === null) return null;
  const messages = await Promise.all(request.messages.map(async (message) => {
    const content = await sanitiseText(message.content, 'internal_context', sanitise);
    return content === null ? null : { ...message, content };
  }));
  if (messages.some((message) => message === null)) return null;
  return llmRequestSchema.parse({
    ...request,
    system,
    messages,
  });
}

async function sanitiseText(
  text: string,
  destination: 'system_prompt' | 'internal_context',
  sanitise: NonNullable<HookRuntimeContext['sanitise']>,
): Promise<string | null> {
  try {
    const result = await sanitise({ text, destination });
    return result.ok ? result.output : null;
  } catch {
    return null;
  }
}
