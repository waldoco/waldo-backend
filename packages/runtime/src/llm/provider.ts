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
  errorCodeSchema,
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
  type TrustedRunV2ProviderExecutionWitness,
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

// V2 runtime effects are prepared and durably keyed by RunLoopDO before an adapter may issue
// I/O. The adapter owns reconciliation for that key: a retry returns the prior response rather
// than creating a second provider effect. This is deliberately separate from the legacy complete
// method because a normal routing fallback chain cannot share one physical-effect receipt.
export type TrustedProviderEffect = Readonly<{
  effect_ref: string;
  idempotency_key: string;
  request_digest: string;
  execution: TrustedRunV2ProviderExecutionWitness;
  // RunLoopDO derives this from whether the durable intent was written by this drive. A
  // reconciliation adapter must not turn a missing prior receipt into a fresh effect after a
  // reset; `reconcile` is therefore fail-closed when the adapter cannot recover the key.
  operation: 'issue' | 'reconcile';
}>;

export type TrustedProviderEffectReceipt = Readonly<{
  // The V2 state persists only the aggregate bounded meter, never provider text. An
  // unmetered/invalid provider envelope is charged at the cap so it cannot evade the Governor.
  metered_tokens: number;
  outcome: 'post_hook_rejected' | 'invalid_response';
}>;

export const TRUSTED_PROVIDER_EFFECT_METERING_CAP = 100_000;
export const TRUSTED_PROVIDER_RESPONSE_TEXT_MAX_UTF8_BYTES = 32_768;

// An adapter uses this only when a resumed effect key has no recoverable receipt. It is not an
// ordinary provider error: the caller must retain the durable intent and must not fabricate a
// settled provider receipt.
export type TrustedProviderReceiptUnavailable = Readonly<{
  ok: false;
  code: 'transient';
  error: string;
  receipt_status: 'unavailable';
}>;

export type TrustedGatewayAdapterResult =
  | AdapterResult<LLMResponse>
  | TrustedProviderReceiptUnavailable;

// Recovery receives no prompt, request, spend state, or route selection input. The persisted
// execution witness is sufficient to validate an adapter-held receipt without recreating the
// original provider request.
export type TrustedGatewayExecution =
  | Readonly<{
      operation: 'issue';
      request: LLMGatewayRequest;
      effect: TrustedProviderEffect;
    }>
  | Readonly<{
      operation: 'reconcile';
      effect: TrustedProviderEffect;
      execution_witness: TrustedRunV2ProviderExecutionWitness;
    }>;

export interface LLMGatewayAdapter {
  complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>>;
  executeOrReconcile?(input: TrustedGatewayExecution): Promise<TrustedGatewayAdapterResult>;
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

export type TrustedRuntimeLLMRequest = RuntimeLLMRequest & {
  prepareEffect(request: LLMGatewayRequest): Promise<TrustedProviderEffect>;
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
  reason:
    | 'hook_halt'
    | 'gateway_exhausted'
    | 'invalid_response'
    | 'template_unavailable'
    | 'effect_receipt_unavailable';
  fallback_step: RuntimeFallbackStep;
  attempts: LLMAttempt[];
  routing_logs: readonly RoutingLogEvent[];
  scribe?: {
    destination: SanitiseDestination;
    reason: SanitiseFailureReason;
  };
  halted_by?: string;
  effect_receipt?: TrustedProviderEffectReceipt;
};

export type RuntimeLLMResult = RuntimeLLMSuccess | RuntimeLLMFailure;

export type CircuitBreaker = {
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

  // Unlike complete(), this path has exactly one physical provider attempt. A V2 effect intent
  // cannot honestly cover a fallback chain, and a missing reconciliation adapter is therefore a
  // fail-closed condition before any provider request is sent.
  async completeTrusted(
    input: TrustedRuntimeLLMRequest,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeLLMResult> {
    const route = selectModelRoute(input);
    const spendCapped = spendCapExceeded(input.spend);
    const p6Action = spendCapped ? structuralP6SpendCapAction(route, input.p6ConsecutiveDeferrals) : null;
    const routingLogs = routingLogsFor(spendCapped, p6Action?.log ?? null);
    if (p6Action?.action === 'defer') {
      return templateUnavailableFailure(route, [], routingLogs);
    }
    const effectiveRoute = spendCapped ? spendClampedRoute(route) : route;
    const plan = attemptPlan(effectiveRoute, spendCapped)[0];
    if (plan === undefined) return templateUnavailableFailure(effectiveRoute, [], routingLogs);
    const reconcile = this.gateway.executeOrReconcile;
    if (reconcile === undefined) {
      return effectReceiptUnavailableFailure(plan.fallback_step, routingLogs);
    }
    if (this.circuitBreaker.isOpen(plan.step.provider)) {
      return templateUnavailableFailure(effectiveRoute, [
        {
          outcome: 'skipped',
          model: plan.step.model,
          provider: plan.step.provider,
          context: plan.context,
          fallback_step: plan.fallback_step,
          reason: 'circuit_open',
        },
      ], routingLogs);
    }

    const skillBudget = this.resolveSkillBudget(plan.step.model);
    const rendered = await input.renderRequest({
      route: effectiveRoute,
      step: plan.step,
      context: plan.context,
      fallback_step: plan.fallback_step,
      attempt: 0,
      skillBudget,
    });
    const request = llmRequestSchema.parse({ ...rendered, model: plan.step.model });
    const customPreHook = await this.runCustomPreLlmHooks(request, ctx);
    if (!customPreHook.ok) {
      return failFromHook(customPreHook.error, plan.fallback_step, [], routingLogs);
    }
    const sanitisedRequest = await sanitiseRequest(customPreHook.request, ctx);
    if (!sanitisedRequest.ok) {
      return failFromHook(
        sanitisedRequest.error,
        plan.fallback_step,
        [],
        routingLogs,
        sanitisedRequest.scribeDestination,
      );
    }
    const preHook = await this.runCorePreLlmHooks(sanitisedRequest.request, ctx);
    if (preHook !== null) {
      return failFromHook(preHook, plan.fallback_step, [], routingLogs);
    }

    const gatewayRequest: LLMGatewayRequest = {
      request: sanitisedRequest.request,
      route: effectiveRoute,
      step: plan.step,
      context: plan.context,
      fallback_step: plan.fallback_step,
      headers: GATEWAY_CONSTANT_HEADERS,
    };
    // Do not catch preparation failures. A DO storage/programming failure must preserve its
    // cause rather than being misreported as a provider failure.
    const effect = await input.prepareEffect(gatewayRequest);
    if (effect.operation !== 'issue') {
      throw new Error('trusted provider issue must not reuse a pending effect');
    }
    if (!trustedExecutionMatchesRequest(effect.execution, gatewayRequest)) {
      throw new Error('trusted provider effect execution witness does not match issued request');
    }
    return this.completeTrustedGatewayResult({
      received: await this.executeTrustedGateway({
        operation: 'issue',
        request: gatewayRequest,
        effect,
      }),
      execution: effect.execution,
      ctx,
      routingLogs,
    });
  }

  // This is intentionally not a variant of completeTrusted(). A pending provider effect has
  // already crossed the external boundary, so recovery must not rebuild a prompt, select a
  // route, read spend, run pre-hooks, sanitize, or consult circuit state. It asks the adapter
  // only for the prior result associated with the durable key and then applies response safety.
  async reconcileTrusted(
    effect: TrustedProviderEffect,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeLLMResult> {
    if (effect.operation !== 'reconcile') {
      throw new Error('trusted provider recovery requires a reconcile effect');
    }
    const reconcile = this.gateway.executeOrReconcile;
    if (reconcile === undefined) {
      return effectReceiptUnavailableFailure(effect.execution.fallback_step, []);
    }
    let received: TrustedGatewayAdapterResult;
    try {
      received = await reconcile.call(this.gateway, {
        operation: 'reconcile',
        effect,
        execution_witness: effect.execution,
      });
    } catch (error) {
      this.circuitBreaker.recordFailure(effect.execution.step.provider);
      throw error;
    }
    return this.completeTrustedGatewayResult({
      received,
      execution: effect.execution,
      ctx,
      routingLogs: [],
    });
  }

  private async executeTrustedGateway(
    input: Extract<TrustedGatewayExecution, { operation: 'issue' }>,
  ): Promise<TrustedGatewayAdapterResult> {
    const reconcile = this.gateway.executeOrReconcile;
    if (reconcile === undefined) {
      return {
        ok: false,
        code: 'transient',
        error: 'trusted provider effect receipt unavailable',
        receipt_status: 'unavailable',
      };
    }
    try {
      return await reconcile.call(this.gateway, input);
    } catch (error) {
      this.circuitBreaker.recordFailure(input.effect.execution.step.provider);
      throw error;
    }
  }

  private async completeTrustedGatewayResult(input: Readonly<{
    received: TrustedGatewayAdapterResult;
    execution: TrustedRunV2ProviderExecutionWitness;
    ctx: HookRuntimeContext;
    routingLogs: readonly RoutingLogEvent[];
  }>): Promise<RuntimeLLMResult> {
    const { execution, received, ctx, routingLogs } = input;
    const normalised = normaliseGatewayAdapterResult(received);
    if (normalised === null) {
      this.circuitBreaker.recordFailure(execution.step.provider);
      return invalidResponseFailure(
        execution.fallback_step,
        [
          {
            outcome: 'failure',
            model: execution.step.model,
            provider: execution.step.provider,
            context: execution.context,
            fallback_step: execution.fallback_step,
            code: 'invalid_args',
          },
        ],
        routingLogs,
        unmeteredTrustedProviderReceipt(),
      );
    }
    const gatewayResult = normalised;
    if (!gatewayResult.ok) {
      this.circuitBreaker.recordFailure(execution.step.provider);
      if ('receipt_status' in gatewayResult && gatewayResult.receipt_status === 'unavailable') {
        return effectReceiptUnavailableFailure(execution.fallback_step, routingLogs);
      }
      return gatewayExhaustedFailure(execution, routingLogs, gatewayResult.code);
    }
    const parsedResponse = gatewayResult.data;
    if (parsedResponse.model !== execution.step.model) {
      this.circuitBreaker.recordFailure(execution.step.provider);
      return invalidResponseFailure(
        execution.fallback_step,
        [
          {
            outcome: 'failure',
            model: execution.step.model,
            provider: execution.step.provider,
            context: execution.context,
            fallback_step: execution.fallback_step,
            code: 'invalid_args',
          },
        ],
        routingLogs,
        unmeteredTrustedProviderReceipt(),
      );
    }
    const meteredTokens = trustedProviderMeteredTokens(parsedResponse);
    if (meteredTokens === null) {
      this.circuitBreaker.recordFailure(execution.step.provider);
      return invalidResponseFailure(
        execution.fallback_step,
        [
          {
            outcome: 'failure',
            model: execution.step.model,
            provider: execution.step.provider,
            context: execution.context,
            fallback_step: execution.fallback_step,
            code: 'invalid_args',
          },
        ],
        routingLogs,
        unmeteredTrustedProviderReceipt(),
      );
    }
    const postHook = await this.runPostLlmHook(parsedResponse, ctx, {
      preserveUnexpectedCause: true,
    });
    if (!postHook.ok) {
      return failFromHook(postHook.error, execution.fallback_step, [], routingLogs, 'send_message', {
        metered_tokens: meteredTokens,
        outcome: 'post_hook_rejected',
      });
    }
    this.circuitBreaker.recordSuccess(execution.step.provider);
    const response = postHook.response;
    const usage = usageFromResponse(parsedResponse);
    return {
      ok: true,
      response,
      tool_call_source: { text: response.text },
      fallback_step: execution.fallback_step,
      degraded:
        routingLogs.length > 0 ||
        execution.fallback_step !== 'configured_model' ||
        execution.context !== 'full_context',
      usage,
      attempts: [
        {
          outcome: 'success',
          model: execution.step.model,
          provider: execution.step.provider,
          context: execution.context,
          fallback_step: execution.fallback_step,
          usage,
        },
      ],
      routing_logs: routingLogs,
    };
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
    options: Readonly<{ preserveUnexpectedCause?: boolean }> = {},
  ): Promise<PostLlmHookResult> {
    try {
      // output_items are raw provider passthrough for replay, never user-facing; keep them out of egress sanitisation.
      const { output_items: rawOutputItems, ...hookResponse } = response;
      const customPayload = await runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response: hookResponse,
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
      return {
        ok: true,
        response: rawOutputItems === undefined ? parsed.data : { ...parsed.data, output_items: rawOutputItems },
      };
    } catch (error) {
      if (options.preserveUnexpectedCause === true && !(error instanceof HookHaltError)) {
        throw error;
      }
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
  effectReceipt?: TrustedProviderEffectReceipt,
): RuntimeLLMFailure {
  return {
    ok: false,
    error: 'invalid gateway response',
    code: 'invalid_args',
    reason: 'invalid_response',
    fallback_step: fallbackStep,
    attempts,
    routing_logs: routingLogs,
    ...(effectReceipt === undefined ? {} : { effect_receipt: effectReceipt }),
  };
}

function effectReceiptUnavailableFailure(
  fallbackStep: RuntimeFallbackStep,
  routingLogs: readonly RoutingLogEvent[],
): RuntimeLLMFailure {
  return {
    ok: false,
    error: 'trusted provider effect receipt unavailable',
    code: 'transient',
    reason: 'effect_receipt_unavailable',
    fallback_step: fallbackStep,
    attempts: [],
    routing_logs: routingLogs,
  };
}

function gatewayExhaustedFailure(
  plan: Readonly<{
    step: GatewayStep;
    context: LLMContextMode;
    fallback_step: GatewayAttemptFallbackStep;
  }>,
  routingLogs: readonly RoutingLogEvent[],
  code: ErrorCode,
): RuntimeLLMFailure {
  return {
    ok: false,
    error: 'trusted provider effect did not reconcile',
    code,
    reason: 'gateway_exhausted',
    fallback_step: plan.fallback_step,
    attempts: [
      {
        outcome: 'failure',
        model: plan.step.model,
        provider: plan.step.provider,
        context: plan.context,
        fallback_step: plan.fallback_step,
        code,
      },
    ],
    routing_logs: routingLogs,
  };
}

function trustedExecutionMatchesRequest(
  execution: TrustedRunV2ProviderExecutionWitness,
  request: LLMGatewayRequest,
): boolean {
  return (
    execution.context === request.context &&
    execution.fallback_step === request.fallback_step &&
    execution.step.provider === request.step.provider &&
    execution.step.model === request.step.model &&
    execution.step.cache === request.step.cache &&
    execution.step.max_tokens === request.step.max_tokens
  );
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
  effectReceipt?: TrustedProviderEffectReceipt,
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
    halted_by: error.hook,
    fallback_step: fallbackStep,
    attempts,
    routing_logs: routingLogs,
    ...(effectReceipt === undefined ? {} : { effect_receipt: effectReceipt }),
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

const MISSING_GATEWAY_DATA_PROPERTY = Symbol('missing-gateway-data-property');

function normaliseGatewayAdapterResult(value: unknown): TrustedGatewayAdapterResult | null {
  const ok = ownGatewayDataProperty(value, 'ok');
  if (ok === true) {
    const data = ownGatewayDataProperty(value, 'data');
    if (data === MISSING_GATEWAY_DATA_PROPERTY) return null;
    const response = normaliseTrustedGatewayResponse(data);
    return response === null ? null : { ok: true, data: response };
  }
  if (ok === false) {
    const code = errorCodeSchema.safeParse(ownGatewayDataProperty(value, 'code'));
    const error = ownGatewayDataProperty(value, 'error');
    if (!code.success || typeof error !== 'string') return null;
    const receiptStatus = ownGatewayDataProperty(value, 'receipt_status');
    if (receiptStatus === 'unavailable') {
      return code.data === 'transient'
        ? {
            ok: false,
            code: 'transient',
            error,
            receipt_status: 'unavailable',
          }
        : null;
    }
    if (receiptStatus !== MISSING_GATEWAY_DATA_PROPERTY) return null;
    return { ok: false, code: code.data, error };
  }
  return null;
}

function normaliseTrustedGatewayResponse(value: unknown): LLMResponse | null {
  const expectedKeys = [
    'cache_read_input_tokens',
    'input_tokens',
    'latency_ms',
    'model',
    'output_tokens',
    'text',
  ] as const;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !expectedKeys.includes(key as (typeof expectedKeys)[number]),
      )
    ) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    if (
      typeof copy.text !== 'string' ||
      utf8ByteLengthWithinLimit(copy.text, TRUSTED_PROVIDER_RESPONSE_TEXT_MAX_UTF8_BYTES) === null
    ) {
      return null;
    }
    const parsed = llmResponseSchema.safeParse(copy);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function ownGatewayDataProperty(
  value: unknown,
  key: string,
): unknown | typeof MISSING_GATEWAY_DATA_PROPERTY {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return MISSING_GATEWAY_DATA_PROPERTY;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || !('value' in descriptor)
      ? MISSING_GATEWAY_DATA_PROPERTY
      : descriptor.value;
  } catch {
    return MISSING_GATEWAY_DATA_PROPERTY;
  }
}

function utf8ByteLengthWithinLimit(value: string, limit: number): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return null;
  }
  return bytes;
}

function trustedProviderMeteredTokens(response: LLMResponse): number | null {
  const total = response.input_tokens + response.output_tokens;
  return Number.isSafeInteger(total) && total >= 0 && total <= TRUSTED_PROVIDER_EFFECT_METERING_CAP
    ? total
    : null;
}

function unmeteredTrustedProviderReceipt(): TrustedProviderEffectReceipt {
  return {
    metered_tokens: TRUSTED_PROVIDER_EFFECT_METERING_CAP,
    outcome: 'invalid_response',
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
  const toolTurns = request.tool_turns === undefined ? undefined : await sanitiseValue(request.tool_turns, 'internal_context');
  if (toolTurns !== undefined && !toolTurns.ok) return { ...toolTurns, scribeDestination: 'internal_context' };
  const parsed = llmRequestSchema.safeParse({
    ...request,
    system: system?.payload,
    messages: messages.payload,
    ...(toolTurns ? { tool_turns: toolTurns.payload } : {}),
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : {
        ok: false,
        error: new HookHaltError('llm_provider', 'sanitised request invalid', 'transient'),
      };
}
