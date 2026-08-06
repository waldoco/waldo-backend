import { DurableObject } from 'cloudflare:workers';
import {
  TOOL_PERMISSIONS,
  canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest,
  canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest,
  acceptTrustedInvocation,
  buildSessionState,
  canonicalInvocationIdempotencySerialization,
  canonicalTrustedOperationalScopeSerialization,
  canonicalRuntimeRunIdempotencySerialization,
  deliveryVerdictSchema,
  deliveryCandidateSchema,
  getCrsArgsSchema,
  journalRowSchema,
  outboxStatusSchema,
  pushClassSchema,
  runStateSchema,
  runtimeOperationalRefSchema,
  runtimeContextCheckpointSchema,
  runtimeContextFailureReasonSchema,
  runtimeInvocationV2RecordSchema,
  runtimeRunCanAdvance,
  runtimeRunContextSchema,
  runtimeRunFailureReasonSchema,
  runtimeRunRecordSchema,
  runtimeRunScratchSchema,
  runtimeRunToolCallSchema,
  runtimeToolCheckpointSchema,
  trustedInvocationAdmissionSchema,
  runtimeTraceDetailSchema,
  sanitiseFailureReasonSchema,
  webSearchArgsSchema,
  writeTaskArgsSchema,
  type DeliveryCandidate,
  type DeliverySink,
  type ErrorCode,
  type GetCrsArgs,
  type RuntimeReplayFixture,
  type RuntimeContextCheckpoint,
  type RuntimeContextFailureReason,
  type RuntimeRunContext,
  type RuntimeRunFallbackStep,
  type RuntimeRunFailureReason,
  type RuntimeRunRecord,
  type RuntimeRunScratch,
  type RuntimeRunState,
  type RuntimeInvocationV2Record,
  type RuntimeToolCheckpoint,
  type RoutingLogEvent,
  type SanitiseDestination,
  type SanitiseFailureReason,
  type SourceTaint,
  type RuntimeTraceEval,
  type ScheduleEntry,
  type SessionState,
  type ToolHandler,
  type ToolName,
  type TrustedInvocationAdmission,
  type TrustedInvocationEnvelope,
  type TriggerType,
  type WebSearchArgs,
  type WriteTaskArgs,
} from '@waldo/contracts';
import { runHooks, type HookRuntimeContext } from '../hooks/registry';
import {
  WaldoCoordinator,
  type ResponsibilityCaptureAdmission,
  type ResponsibilityCaptureResult,
  type ResponsibilityProjectionRead,
  type ResponsibilityReplay,
} from '../coordinator/waldo-coordinator';
import { provisionDoSchema } from '../do-schema';
import {
  verifyResponsibilityIngress,
  type SignedResponsibilityIngressContext,
} from '../responsibility/ingress-signature';
import {
  RuntimeLLMProvider,
  TRUSTED_PROVIDER_EFFECT_METERING_CAP,
  type CircuitBreaker,
  type RouteSpendState,
  type LLMGatewayRequest,
  type RuntimeLLMFailure,
  type TrustedProviderEffectReceipt,
} from '../llm/provider';
import {
  RunJournalOutbox,
  TrustedRunOwnerScopeMismatchError,
  type RunJournalOutboxCrashPoint,
} from '../run-journal/outbox-runtime';
import type { GovernorDecision, SetLoopKillFlagInput } from '../loop-governor/governor';
import { Scheduler, type ScheduleExecutors } from '../scheduler/multiplexer';
import type { Deps } from '../seams/deps';
import { prepareWithScribe, type StrictSchema } from '../scribe/prepare';
import {
  dispatchTool,
  parseToolCalls,
  reconcileTrustedToolEffect,
  type DispatchToolResult,
  type RuntimeToolCall,
  type ToolDispatcherContext,
} from '../tools/dispatcher';
import { ensureSchema } from '../tracer/schema';
import { triage } from '../triage/dispatcher';
import {
  RUN_LOOP_OBSERVE_SYSTEM_PREFIX,
  RUN_LOOP_PLAN_SYSTEM_PREFIX,
  fakeSinkStats,
  isLocalRunLoopEnvironment,
  localTrustedBriefScheduleInput,
  resolveRunLoopAdapters,
  type RunLoopAdapters,
  type RunLoopTestOverrides,
} from './adapters';
import {
  buildRuntimeReplayFixture,
  normaliseRuntimeTraceDetail,
  runtimeTraceEventKey,
  scoreRuntimeFixture,
  type RuntimeTraceSqlRow,
} from './evidence';
import {
  initialTrustedRunV2State,
  parseTrustedRunV2State,
  updateTrustedRunV2State,
  v2CheckpointGuards,
  v2CompletedToolCheckpoints,
  v2OpaqueRef,
  v2SettledToolCheckpoints,
  type TrustedRunV2PendingEffect,
  type TrustedRunV2ProviderExecutionWitness,
  type TrustedRunV2ToolEffectWitness,
  type TrustedRunV2State,
} from './trusted-v2';

const TRIGGER = 'brief' satisfies TriggerType;
const PUSH_CLASS = 'brief' as const;
const CANARY_TOKENS = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
const RUNTIME_RUN_SCRIBE_AUDIT_VERSION = 1;
// Version 3 requires the contract-owned reconciled-effect marker. Earlier V2 sidecars did not
// have a durable external-effect receipt and therefore remain fail-closed V2, never V1 fallback.
const TRUSTED_V2_SCRIBE_AUDIT_VERSION = 3;
const LOCAL_RUN_TOKEN_HEADER = 'x-waldo-local-run-token';
const LOCAL_INGRESS_RATE_WINDOW_MS = 60_000;
const LOCAL_INGRESS_MAX_REQUESTS_PER_WINDOW = 32;
const RESPONSIBILITY_INGRESS_RATE_WINDOW_MS = 60_000;
const RESPONSIBILITY_INGRESS_MAX_REQUESTS_PER_WINDOW = 60;
const RESPONSIBILITY_OWNER_MAX_REQUESTS_PER_WINDOW = 240;
const TRUSTED_V2_SYNTHESIS_MESSAGE_MAX_UTF8_BYTES = 32_768;
const REPLAY_ARTIFACT_MAX_UTF8_BYTES = 32_768;
const REPLAY_ARTIFACT_MAX_NODES = 1_024;

type PreparedTrustedEffect<T extends TrustedRunV2PendingEffect> = Readonly<{
  effect: T;
  operation: 'issue' | 'reconcile';
}>;

export type ScheduleFakeRunInput = {
  scheduleId: string;
  userId: string;
  dueAt: number;
  occurrenceAt: number;
  candidate?: DeliveryCandidate;
};

type ScheduleTrustedRunInput = Readonly<{
  admission: TrustedInvocationAdmission;
  snapshot_ref: string;
  snapshot_at: number;
}>;

export type RunLoopTraceEvent = {
  event: string;
  detail: Record<string, unknown>;
};

export type RunLoopProof = {
  fsm: string[];
  trace: RunLoopTraceEvent[];
  context: Record<string, unknown> | null;
  outbox: { kind: string; status: string; attempts: number }[];
  sink: { deliveries: number; attempts: number };
  delivery_journal: { state: string; verdict: string | null };
  current: { state: string; failure_reason: string | null };
};

type RuntimeRunSqlRow = {
  run_id: string;
  user_id: string;
  trigger: string;
  variant: string | null;
  state: string;
  step: number;
  attempts: number;
  run_nonce: string;
  context_json: string | null;
  scratch_json: string | null;
  created_at: number;
  updated_at: number;
  next_expected_wake: number | null;
  failure_reason: string | null;
  invocation_format: string | null;
  trusted_snapshot_binding: string | null;
};

type TraceSqlRow = {
  seq: number;
  event_key: string | null;
  event: string;
  detail_json: string;
  created_at: number;
};

type RuntimeRunIdentitySqlRow = {
  run_id: string;
};

type TrustedRunV2SqlRow = {
  run_id: string;
  canonical_identity_hash: string;
  state_json: string;
};

type LocalIngressRateSqlRow = {
  count: number;
};

type ScratchState = RuntimeRunScratch;
type ToolResultSummary = NonNullable<RuntimeRunScratch['tool_results']>[number];

type ProviderSpendPreflight =
  | { ok: true; spend: RouteSpendState | undefined }
  | { ok: false };

type TrustedCompositionResult =
  | Readonly<{
      ok: true;
      prompt: string;
      checkpoint: RuntimeContextCheckpoint;
      evidence: Readonly<{
        prompt_digest: string;
        recall: Readonly<{ status: 'partial' | 'failed' | 'skipped' }>;
      }>;
    }>
  | Readonly<{
      ok: false;
      failure: Readonly<{ code: RuntimeContextFailureReason }>;
    }>;

type LlmFailureTrace = {
  fallbackStep: RuntimeRunFallbackStep;
  routingLogs: readonly RoutingLogEvent[];
};

type ScheduleFakeRunIngress = {
  schedule_id: string;
  user_id: string;
  candidate: DeliveryCandidate;
};

const scheduleFakeRunIngressSchema: StrictSchema<ScheduleFakeRunIngress> = {
  safeParse(value) {
    if (!isRecord(value)) return { success: false };
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3 ||
      !Object.prototype.hasOwnProperty.call(value, 'schedule_id') ||
      !Object.prototype.hasOwnProperty.call(value, 'user_id') ||
      !Object.prototype.hasOwnProperty.call(value, 'candidate') ||
      typeof value.schedule_id !== 'string' ||
      value.schedule_id.length === 0 ||
      typeof value.user_id !== 'string' ||
      value.user_id.length === 0
    ) {
      return { success: false };
    }
    const candidate = deliveryCandidateSchema.safeParse(value.candidate);
    return candidate.success
      ? {
          success: true,
          data: {
            schedule_id: value.schedule_id,
            user_id: value.user_id,
            candidate: candidate.data,
          },
        }
      : { success: false };
  },
};

const deliveryTextSchema: StrictSchema<string> = {
  safeParse(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4_096
      ? { success: true, data: value }
      : { success: false };
  },
};

export class RunLoopDO extends DurableObject<Cloudflare.Env> {
  private adapters: RunLoopAdapters;
  private deps: Deps;
  private readonly envBindings: Cloudflare.Env;
  private readonly scheduler: Scheduler;
  private journalOutbox: RunJournalOutbox;
  private llm: RuntimeLLMProvider;
  private readonly waldoCoordinator: WaldoCoordinator;
  private testCircuitBreaker: CircuitBreaker | undefined;
  private readonly trustedDrivePromises = new Map<string, Promise<void>>();

  __runLoopCrashAfter?: RuntimeRunState;
  __runLoopOutboxCrashPoint?: RunJournalOutboxCrashPoint;
  __runLoopCrashAfterTrustedAdmission?: boolean;
  __runLoopCrashAfterTrustedGateCommit?: boolean;
  __runLoopCrashAfterTrustedGateTerminal?: boolean;
  __runLoopCrashAfterTrustedGovernorDeny?: boolean;
  __runLoopCrashAfterTrustedProviderEffect?: 'provider_plan' | 'provider_observe';
  __runLoopCrashAfterTrustedToolEffect?: boolean;
  __runLoopCrashAfterTrustedToolCheckpoint?: boolean;
  __runLoopCrashAfterTrustedSynthesisReceipt?: boolean;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ensureSchema(ctx.storage);
    ensureRunLoopSchema(ctx.storage);
    provisionDoSchema(ctx.storage);
    this.envBindings = env;
    this.adapters = resolveRunLoopAdapters(env);
    this.deps = this.adapters.deps;
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, this.deps);
    this.journalOutbox = this.#createJournalOutbox(this.adapters.sink);
    this.llm = new RuntimeLLMProvider({ gateway: this.adapters.gateway });
    this.waldoCoordinator = new WaldoCoordinator(ctx.storage);
  }

  async __waldoCaptureResponsibilityForTest(
    admission: ResponsibilityCaptureAdmission,
  ): Promise<ResponsibilityCaptureResult> {
    this.#assertLocalTestSeam();
    return this.waldoCoordinator.captureResponsibility(admission);
  }

  async captureResponsibilityFromWorker(
    admission: ResponsibilityCaptureAdmission,
    ingress: SignedResponsibilityIngressContext,
  ): Promise<ResponsibilityCaptureResult> {
    await this.#assertResponsibilityIngress(admission, ingress);
    this.#admitResponsibilityIngress(ingress.authenticatedSessionId);
    return this.waldoCoordinator.captureResponsibility(admission);
  }

  async readResponsibilityProjectionFromWorker(
    input: ResponsibilityProjectionRead,
    ingress: SignedResponsibilityIngressContext,
  ) {
    await this.#assertResponsibilityIngressContext(ingress, 'projection');
    const expectedDigest = `sha256:${await this.deps.sha256Hex(JSON.stringify([
      input.protocolVersion ?? '0.2', input.fromExclusiveCursor, input.limit,
      input.snapshotId ?? null,
    ]))}`;
    if (
      ingress.ownerId !== input.routedOwnerId ||
      ingress.requestDigest !== expectedDigest ||
      ingress.operationDigest !== expectedDigest
    ) {
      throw new Error('responsibility ingress authority mismatch');
    }
    this.#admitResponsibilityIngress(ingress.authenticatedSessionId);
    return this.waldoCoordinator.readResponsibilityProjection(input);
  }

  __waldoReadResponsibilityProjectionForTest(
    input: ResponsibilityProjectionRead,
  ) {
    this.#assertLocalTestSeam();
    return this.waldoCoordinator.readResponsibilityProjection(input);
  }

  __waldoReplayResponsibilityForTest(ownerId: string): ResponsibilityReplay {
    this.#assertLocalTestSeam();
    return this.waldoCoordinator.replayResponsibility(ownerId);
  }

  // Test-only seam: lets integration tests exercise governor and adapter branches without making
  // live provider/channel calls or widening the production Worker fetch surface.
  __runLoopSetTestOverrides(overrides: RunLoopTestOverrides): void {
    this.#assertLocalTestSeam();
    this.testCircuitBreaker = overrides.circuitBreaker ?? this.testCircuitBreaker;
    this.adapters = {
      ...this.adapters,
      gateway: overrides.gateway ?? this.adapters.gateway,
      sink: overrides.sink ?? this.adapters.sink,
      spend: overrides.spend === null ? undefined : (overrides.spend ?? this.adapters.spend),
      spendReader: overrides.spendReader ?? this.adapters.spendReader,
      providerMode: overrides.providerMode ?? this.adapters.providerMode,
      deliveryTextFallback:
        overrides.deliveryTextFallback ?? this.adapters.deliveryTextFallback,
      contextComposer: overrides.contextComposer ?? this.adapters.contextComposer,
      replayArtifacts: overrides.replayArtifacts ?? this.adapters.replayArtifacts,
      trustedToolHandlers: overrides.trustedToolHandlers ?? this.adapters.trustedToolHandlers,
      safety: {
        ...this.adapters.safety,
        rateLimitCheck: overrides.rateLimitCheck ?? this.adapters.safety.rateLimitCheck,
      },
    };
    this.journalOutbox = this.#createJournalOutbox(this.adapters.sink);
    this.llm = new RuntimeLLMProvider({
      gateway: this.adapters.gateway,
      circuitBreaker: this.testCircuitBreaker,
    });
  }

  __runLoopSetKillFlag(input: SetLoopKillFlagInput): void {
    this.#assertLocalTestSeam();
    this.journalOutbox.setLoopKillFlag(input);
  }

  async __runLoopIngestExternalToolResultForTest(runId: string): Promise<DispatchToolResult> {
    this.#assertLocalTestSeam();
    const run = this.#requireRuntimeRun(runId);
    const ctx = await this.#rebuildInvocationContext(run);
    ctx.trigger = 'handoff_explore';
    ctx.session = buildSessionState({
      trigger: 'handoff_explore',
      canary_tokens: CANARY_TOKENS,
      started_at: this.deps.now(),
    });
    ctx.sourceTaint = null;
    ctx.toolArgSourceTaint = null;
    const handler: ToolHandler<
      WebSearchArgs,
      { hits: string[] },
      ToolDispatcherContext
    > = {
      name: 'web_search',
      description: 'Synthetic external-result tracer.',
      schema: webSearchArgsSchema,
      trigger_allowlist: triggerAllowlistFor('web_search'),
      autonomy_gated: false,
      async handle() {
        return { ok: true, data: { hits: ['synthetic safe result'] }, source_taint: 'external' };
      },
    };
    const result = await dispatchTool(
      { id: 'call-external-result-tracer', name: 'web_search', args: { query: 'safe query' } },
      toolContext(ctx),
      { handlers: [handler] },
    );
    if (result.ok) {
      const scratch = parseScratch(this.#requireRuntimeRun(runId).scratch_json);
      this.#updateRunScratch(runId, {
        ...scratch,
        source_taint: mergeSourceTaint(scratch.source_taint, result.source_taint),
      });
    }
    return result;
  }

  async __runLoopProbePrivilegedToolForTest(runId: string): Promise<{
    result: DispatchToolResult;
    handler_calls: number;
  }> {
    this.#assertLocalTestSeam();
    const ctx = await this.#rebuildInvocationContext(this.#requireRuntimeRun(runId));
    ctx.trigger = 'user_message';
    ctx.session = buildSessionState({
      trigger: 'user_message',
      canary_tokens: CANARY_TOKENS,
      started_at: this.deps.now(),
    });
    let handlerCalls = 0;
    const handler: ToolHandler<
      WriteTaskArgs,
      { queued: true },
      ToolDispatcherContext
    > = {
      name: 'write_task',
      description: 'Synthetic privileged-gate tracer.',
      schema: writeTaskArgsSchema,
      trigger_allowlist: triggerAllowlistFor('write_task'),
      autonomy_gated: true,
      async handle() {
        handlerCalls += 1;
        return { ok: true, data: { queued: true }, source_taint: null };
      },
    };
    const result = await dispatchTool(
      {
        id: 'call-privileged-gate-tracer',
        name: 'write_task',
        args: {
          title: 'Synthetic safe task',
          reasoning: 'Synthetic gate verification',
        },
      },
      toolContext(ctx),
      { handlers: [handler] },
    );
    return { result, handler_calls: handlerCalls };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const trustedPath =
      url.pathname === '/local/runs' || /^\/local\/runs\/[^/]+$/.test(url.pathname);
    const fakePath =
      url.pathname === '/local/fake-runs' || /^\/local\/fake-runs\/[^/]+$/.test(url.pathname);
    if (!trustedPath && !fakePath) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    if (!isLocalRunLoopEnvironment(this.envBindings.WALDO_ENV)) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    const localToken = this.#localIngressToken();
    if (
      localToken === null ||
      request.headers.get(LOCAL_RUN_TOKEN_HEADER) !== localToken
    ) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    if (!this.#admitLocalIngress()) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    try {
      if (request.method === 'POST' && url.pathname === '/local/runs') {
        const body = (await request.json()) as unknown;
        parseLocalTrustedBriefIngress(body);
        const runId = await this.#scheduleLocalTrustedBrief();
        return jsonResponse({ run_id: runId }, 202);
      }

      // Legacy fake runs remain a visibly separate local test seam. They never pass through
      // TrustedInvocationEnvelope or masquerade as ContextComposer V2 proof.
      if (request.method === 'POST' && url.pathname === '/local/fake-runs') {
        const body = (await request.json()) as unknown;
        const runId = await this.scheduleFakeRun(body as ScheduleFakeRunInput);
        return jsonResponse({ run_id: runId }, 202);
      }

      if (request.method === 'GET') {
        const match = /^\/local\/(runs|fake-runs)\/([^/]+)$/.exec(url.pathname);
        if (match === null) return jsonResponse({ error: 'not_found' }, 404);
        const route = match[1];
        const runId = match[2];
        if (runId === undefined) return jsonResponse({ error: 'not_found' }, 404);
        return jsonResponse(
          route === 'runs'
            ? await this.readTrustedRunProof(decodeURIComponent(runId))
            : await this.readRunProof(decodeURIComponent(runId)),
          200,
        );
      }
    } catch (error) {
      if (isLocalIngressBadRequest(error)) {
        return jsonResponse({ error: 'bad_request' }, 400);
      }
      throw error;
    }

    return jsonResponse({ error: 'not_found' }, 404);
  }

  async scheduleFakeRun(input: ScheduleFakeRunInput): Promise<string> {
    this.#assertLocalTestSeam();
    const parsed = parseScheduleFakeRunInput(input);
    const candidate =
      parsed.candidate ??
      ({
        push_class: PUSH_CLASS,
        trigger: TRIGGER,
        event_id: parsed.scheduleId,
        expires_at: null,
      } satisfies DeliveryCandidate);
    const ingress = prepareWithScribe(
      {
        schedule_id: parsed.scheduleId,
        user_id: parsed.userId,
        candidate,
      },
      scheduleFakeRunIngressSchema,
      'internal_context',
      null,
      CANARY_TOKENS,
    );
    if (!ingress.ok) throw new Error(`scribe:${ingress.reason}`);
    if (
      ingress.value.schedule_id !== parsed.scheduleId ||
      ingress.value.user_id !== parsed.userId ||
      ingress.value.candidate.event_id !== candidate.event_id
    ) {
      throw new Error('scribe:invalid_payload');
    }

    const decision = triage({
      kind: 'alarm',
      alarmName: ingress.value.schedule_id,
      scheduleKind: TRIGGER,
    });
    if (!decision.ok || decision.trigger !== TRIGGER) {
      throw new Error('run-loop schedule requires a brief alarm');
    }
    const runNonce = await this.#scheduledRunNonce({
      userId: ingress.value.user_id,
      variant: decision.variant ?? null,
      scheduleId: ingress.value.schedule_id,
      occurrenceAt: parsed.occurrenceAt,
    });
    const existingRunId = this.#findRuntimeRunByIdentity(ingress.value.user_id, runNonce);
    if (existingRunId !== null) {
      await this.scheduler.schedule({
        id: ingress.value.schedule_id,
        kind: TRIGGER,
        occurrenceAt: parsed.occurrenceAt,
        dueAt: parsed.dueAt,
        payloadRefs: {
          id: ingress.value.schedule_id,
          run_id: existingRunId,
          user_id: ingress.value.user_id,
        },
      });
      return existingRunId;
    }

    const runId = this.journalOutbox.startRun({
      userId: ingress.value.user_id,
      trigger: TRIGGER,
      occurrenceAt: parsed.occurrenceAt,
      occurrenceId: runNonce,
      candidate: ingress.value.candidate,
    });

    this.#openRuntimeRun({
      runId,
      userId: ingress.value.user_id,
      variant: decision.variant ?? null,
      runNonce,
      scheduleId: ingress.value.schedule_id,
      occurrenceAt: parsed.occurrenceAt,
    });

    await this.scheduler.schedule({
      id: ingress.value.schedule_id,
      kind: TRIGGER,
      occurrenceAt: parsed.occurrenceAt,
      dueAt: parsed.dueAt,
      payloadRefs: {
        id: ingress.value.schedule_id,
        run_id: runId,
        user_id: ingress.value.user_id,
      },
    });

    return runId;
  }

  // Only the authenticated local ingress can use this fixed fixture. It deliberately has no
  // caller-selected authority, trigger, tenant, routing, ACL, output, delivery, snapshot, or
  // source vocabulary.
  async #scheduleLocalTrustedBrief(): Promise<string> {
    return this.#scheduleAcceptedTrustedRun(localTrustedBriefScheduleInput());
  }

  // The real admission implementation remains private so no RPC binding can submit a
  // caller-shaped trusted envelope. The explicitly named test seam below is the sole full-input
  // entrypoint and is locally gated.
  async #scheduleAcceptedTrustedRun(input: ScheduleTrustedRunInput): Promise<string> {
    const { parsed, invocation } = this.#acceptTrustedScheduleInput(input);
    if (invocation.runtime_binding.trigger !== TRIGGER) {
      throw new Error('trusted scheduled run requires the brief trigger');
    }
    const opened = await this.#openTrustedInvocation(
      parsed,
      invocation,
      (canonicalIdentityHash) => `brief:trusted-${canonicalIdentityHash.slice(0, 32)}`,
    );
    await this.scheduler.schedule({
      id: opened.scheduleId,
      kind: TRIGGER,
      occurrenceAt: invocation.occurrence.occurred_at,
      dueAt: Math.max(invocation.occurrence.occurred_at, this.deps.now() + 500),
      payloadRefs: {
        id: opened.scheduleId,
        run_id: opened.runId,
        user_id: invocation.verified_authority.principal_ref,
      },
    });
    return opened.runId;
  }

  async __runLoopScheduleTrustedRunForTest(input: ScheduleTrustedRunInput): Promise<string> {
    this.#assertLocalTestSeam();
    return this.#scheduleAcceptedTrustedRun(input);
  }

  // Test-only lifecycle controls intentionally reuse the exact admission and drive methods above;
  // they do not create an HTTP/CLI/MCP execution surface or a second runtime.
  async __runLoopOpenTrustedRunForTest(input: ScheduleTrustedRunInput): Promise<string> {
    this.#assertLocalTestSeam();
    const { parsed, invocation } = this.#acceptTrustedScheduleInput(input);
    const opened = await this.#openTrustedInvocation(
      parsed,
      invocation,
      (canonicalIdentityHash) => `trusted:test-${canonicalIdentityHash.slice(0, 32)}`,
    );
    return opened.runId;
  }

  async __runLoopDriveRunForTest(runId: string): Promise<void> {
    this.#assertLocalTestSeam();
    await this.#driveRun(runtimeOperationalRefSchema.parse(runId));
  }

  __runLoopAuditTrustedV2ForTest(): void {
    this.#assertLocalTestSeam();
    this.ctx.storage.transactionSync(() => auditTrustedV2Rows(this.ctx.storage.sql));
  }

  #acceptTrustedScheduleInput(input: ScheduleTrustedRunInput): {
    parsed: ScheduleTrustedRunInput;
    invocation: TrustedInvocationEnvelope;
  } {
    const parsed = parseScheduleTrustedRunInput(input);
    const accepted = acceptTrustedInvocation(parsed.admission);
    if (!accepted.ok) {
      throw new Error(`trusted invocation admission rejected: ${accepted.error.code}`);
    }
    return { parsed, invocation: accepted.value };
  }

  async #openTrustedInvocation(
    parsed: ScheduleTrustedRunInput,
    invocation: TrustedInvocationEnvelope,
    scheduleIdFor: (canonicalIdentityHash: string) => string,
  ): Promise<{
    runId: string;
    created: boolean;
    canonicalIdentityHash: string;
    scheduleId: string;
  }> {
    const canonicalIdentityHash = await this.deps.sha256Hex(
      canonicalInvocationIdempotencySerialization(invocation),
    );
    const ownerScope = await this.#trustedOperationalOwnerScope(invocation);
    // Freeze source selection separately from duplicate identity. A duplicate with another
    // caller-supplied snapshot still resolves the original run, while the V2 sidecar cannot
    // replace the snapshot that ContextComposer is permitted to consume.
    const snapshotBinding = await this.#trustedSnapshotBinding({
      snapshot_ref: parsed.snapshot_ref,
      snapshot_at: parsed.snapshot_at,
    });
    const scheduleId = scheduleIdFor(canonicalIdentityHash);
    let runId: string | null = null;
    let created = false;
    this.ctx.storage.transactionSync(() => {
      const existing = this.#findTrustedRunByCanonicalIdentity(canonicalIdentityHash);
      if (existing !== null) {
        runId = existing;
        return;
      }
      const newRunId = this.deps.newRunId();
      const at = this.deps.now();
      const record = runtimeInvocationV2RecordSchema.parse({
        format: 'invocation_contract_v2',
        record_version: 2,
        invocation,
        context: null,
        tool_checkpoints: [],
        persisted_at: at,
      });
      const state = initialTrustedRunV2State({
        canonicalIdentityHash,
        snapshotRef: parsed.snapshot_ref,
        snapshotAt: parsed.snapshot_at,
        record,
      });
      this.#openRuntimeRunInCurrentTransaction({
        runId: newRunId,
        userId: invocation.verified_authority.principal_ref,
        trigger: invocation.runtime_binding.trigger,
        variant: invocation.runtime_binding.variant,
        runNonce: canonicalIdentityHash,
        occurrenceAt: invocation.occurrence.occurred_at,
        invocationFormat: 'invocation_contract_v2',
        trustedSnapshotBinding: snapshotBinding,
      });
      this.journalOutbox.openTrustedInvocationInCurrentTransaction({
        runId: newRunId,
        invocation,
        ownerScope,
      });
      this.#insertTrustedV2StateInCurrentTransaction(newRunId, state, at);
      this.#recordTraceInCurrentTransaction(
        newRunId,
        'scheduled_wake',
        {
          schedule_id: scheduleId,
          occurrence_at: invocation.occurrence.occurred_at,
          trigger: invocation.runtime_binding.trigger,
        },
        null,
      );
      runId = newRunId;
      created = true;
    });
    if (runId === null) throw new Error('trusted invocation admission did not resolve a run');
    if (!created && !this.#hasRuntimeTraceEvent(runId, 'scheduled_wake')) {
      this.#recordTrace(runId, 'scheduled_wake', {
        schedule_id: scheduleId,
        occurrence_at: invocation.occurrence.occurred_at,
        trigger: invocation.runtime_binding.trigger,
      });
    }
    return { runId, created, canonicalIdentityHash, scheduleId };
  }

  async readRunProof(runId: string): Promise<RunLoopProof> {
    this.#assertLocalTestSeam();
    const run = this.#readRuntimeRun(runId);
    if (run === null) throw new Error(`readRunProof: no run ${runId}`);
    const trace = this.ctx.storage.sql
      .exec<TraceSqlRow>(
        'SELECT seq, event_key, event, detail_json, created_at FROM runtime_trace WHERE run_id = ? ORDER BY seq',
        runId,
      )
      .toArray()
      .map((row) => ({
        event: row.event,
        detail: parseJsonObject(row.detail_json),
      }));
    const fsm = this.ctx.storage.sql
      .exec<{ state: string }>(
        'SELECT state FROM runtime_journal WHERE run_id = ? ORDER BY step',
        runId,
      )
      .toArray()
      .map((row) => row.state);
    const outbox = this.ctx.storage.sql
      .exec<{ kind: string; status: string; attempts: number; idempotency_key: string }>(
        'SELECT kind, status, attempts, idempotency_key FROM outbox WHERE run_id = ? ORDER BY kind',
        runId,
      )
      .toArray();
    const sinkKeys = outbox.map((row) => row.idempotency_key);
    const deliveryJournal = journalRowSchema.parse(
      this.ctx.storage.sql
        .exec('SELECT * FROM journal WHERE run_id = ?', runId)
        .one(),
    );

    return {
      fsm,
      trace,
      context: run.context_json,
      outbox: outbox.map(({ kind, status, attempts }) => ({ kind, status, attempts })),
      sink: {
        ...fakeSinkStats(sinkKeys),
      },
      delivery_journal: {
        state: deliveryJournal.state,
        verdict: deliveryJournal.verdict,
      },
      current: { state: run.state, failure_reason: run.failure_reason },
    };
  }

  async readTrustedRunProof(runId: string): Promise<RunLoopProof & {
    v2: {
      canonical_identity_hash: string;
      snapshot: TrustedRunV2State['snapshot'];
      invocation: TrustedInvocationEnvelope;
      context: RuntimeInvocationV2Record['context'];
      tool_checkpoints: RuntimeToolCheckpoint[];
      evidence: TrustedRunV2State['evidence'];
    };
  }> {
    this.#assertLocalTestSeam();
    const proof = await this.readRunProof(runId);
    const state = await this.#requireTrustedV2State(runId);
    return {
      ...proof,
      v2: {
        canonical_identity_hash: state.canonical_identity_hash,
        snapshot: state.snapshot,
        invocation: state.record.invocation,
        context: state.record.context,
        tool_checkpoints: [...state.record.tool_checkpoints],
        evidence: state.evidence,
      },
    };
  }

  async readRunEvidence(runId: string): Promise<RuntimeReplayFixture> {
    this.#assertLocalTestSeam();
    return this.#buildRunEvidence(runId);
  }

  async replayFixture(runId: string): Promise<RuntimeReplayFixture> {
    this.#assertLocalTestSeam();
    return this.#buildRunEvidence(runId);
  }

  async scoreRun(traceId: string): Promise<RuntimeTraceEval> {
    this.#assertLocalTestSeam();
    return scoreRuntimeFixture(this.#buildRunEvidence(traceId));
  }

  override async alarm(): Promise<void> {
    await this.scheduler.dispatchDue(this.#scheduleExecutors());
  }

  #scheduleExecutors(): ScheduleExecutors {
    return {
      brief: async (entry) => this.#driveScheduledRun(entry),
    };
  }

  #createJournalOutbox(sink: DeliverySink): RunJournalOutbox {
    return new RunJournalOutbox(this.ctx.storage, this.deps, sink, {
      crashPoint: () => this.__runLoopOutboxCrashPoint,
    });
  }

  #localIngressToken(): string | null {
    const token = this.envBindings.RUN_LOOP_LOCAL_INGRESS_TOKEN;
    return typeof token === 'string' && token.length >= 16 ? token : null;
  }

  #assertLocalTestSeam(): void {
    if (!isLocalRunLoopEnvironment(this.envBindings.WALDO_ENV)) {
      throw new Error('run-loop test seam is local-only');
    }
  }

  #admitLocalIngress(): boolean {
    const now = this.deps.now();
    const bucket = Math.floor(now / LOCAL_INGRESS_RATE_WINDOW_MS);
    let admitted = false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM local_ingress_rate WHERE bucket < ?', bucket);
      const row = this.ctx.storage.sql
        .exec<LocalIngressRateSqlRow>(
          'SELECT count FROM local_ingress_rate WHERE bucket = ?',
          bucket,
        )
        .toArray()[0];
      const count = (row?.count ?? 0) + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO local_ingress_rate (bucket, count, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
        bucket,
        count,
        now,
      );
      admitted = count <= LOCAL_INGRESS_MAX_REQUESTS_PER_WINDOW;
    });
    return admitted;
  }

  async #assertResponsibilityIngress(
    admission: ResponsibilityCaptureAdmission,
    ingress: SignedResponsibilityIngressContext,
  ): Promise<void> {
    await this.#assertResponsibilityIngressContext(ingress, 'capture');
    const envelope = admission.trustedEnvelope;
    if (
      envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) ||
      ingress.ownerId !== admission.routedOwnerId ||
      (envelope as Record<string, unknown>).ownerId !== ingress.ownerId ||
      (envelope as Record<string, unknown>).presenceId !== ingress.presenceId ||
      (envelope as Record<string, unknown>).authenticatedSessionId !==
        ingress.authenticatedSessionId ||
      (envelope as Record<string, unknown>).ownerPolicyRevision !== ingress.ownerPolicyRevision ||
      (envelope as Record<string, unknown>).ownerRootRoutingVersion !==
        ingress.ownerRootRoutingVersion ||
      (envelope as Record<string, unknown>).requestDigest !== ingress.requestDigest
    ) {
      throw new Error('responsibility ingress authority mismatch');
    }
    const envelopeDigest = `sha256:${await this.deps.sha256Hex(
      (envelope as { protocolVersion?: unknown }).protocolVersion === '0.1'
        ? canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest(envelope)
        : canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest(envelope),
    )}`;
    if (ingress.operationDigest !== envelopeDigest) {
      throw new Error('responsibility ingress authority mismatch');
    }
  }

  async #assertResponsibilityIngressContext(
    ingress: SignedResponsibilityIngressContext,
    operation: 'capture' | 'projection',
  ): Promise<void> {
    const now = this.deps.now();
    const secret = this.envBindings.RESPONSIBILITY_INGRESS_HMAC_SECRET;
    if (
      !ingress ||
      typeof secret !== 'string' || secret.length < 32 ||
      ingress.operation !== operation ||
      typeof ingress.ownerId !== 'string' ||
      typeof ingress.presenceId !== 'string' ||
      typeof ingress.presenceRegistrationId !== 'string' ||
      typeof ingress.authenticatedSessionId !== 'string' ||
      !/^authenticated_session_[a-f0-9]{64}$/.test(ingress.authenticatedSessionId) ||
      !Number.isSafeInteger(ingress.ownerPolicyRevision) ||
      ingress.ownerPolicyRevision < 0 ||
      !Number.isSafeInteger(ingress.ownerRootRoutingVersion) ||
      ingress.ownerRootRoutingVersion < 0 ||
      !Number.isSafeInteger(ingress.issuedAt) ||
      ingress.issuedAt > now + 5_000 || now - ingress.issuedAt > 60_000 ||
      !/^sha256:[a-f0-9]{64}$/.test(ingress.requestDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(ingress.operationDigest) ||
      !(await verifyResponsibilityIngress(ingress, secret))
    ) {
      throw new Error('responsibility ingress authority mismatch');
    }
  }

  #admitResponsibilityIngress(authenticatedSessionId: string): void {
    const now = this.deps.now();
    const bucket = Math.floor(now / RESPONSIBILITY_INGRESS_RATE_WINDOW_MS);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'DELETE FROM responsibility_ingress_rate WHERE bucket < ?',
        bucket,
      );
      for (const [rateKey, maximum] of [
        [`session:${authenticatedSessionId}`, RESPONSIBILITY_INGRESS_MAX_REQUESTS_PER_WINDOW],
        ['owner', RESPONSIBILITY_OWNER_MAX_REQUESTS_PER_WINDOW],
      ] as const) {
        const row = this.ctx.storage.sql.exec<{ count: number }>(
          `SELECT count FROM responsibility_ingress_rate
            WHERE rate_key = ? AND bucket = ?`,
          rateKey,
          bucket,
        ).toArray()[0];
        const count = (row?.count ?? 0) + 1;
        if (count > maximum) throw new Error('responsibility ingress rate limited');
        this.ctx.storage.sql.exec(
          `INSERT INTO responsibility_ingress_rate
            (rate_key, bucket, count, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(rate_key, bucket)
           DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
          rateKey,
          bucket,
          count,
          now,
        );
      }
    });
  }

  async #driveScheduledRun(entry: ScheduleEntry): Promise<void> {
    const decision = triage({
      kind: 'alarm',
      alarmName: entry.id,
      scheduleKind: entry.kind,
    });
    if (!decision.ok || decision.trigger !== TRIGGER) {
      throw new Error('scheduled run-loop wake did not triage to brief');
    }
    await this.#driveRun(requiredPayloadRef(entry, 'run_id'));
  }

  async #driveRun(runId: string): Promise<void> {
    const invocationFormat = this.#readRuntimeInvocationFormat(runId);
    if (invocationFormat === 'invocation_contract_v2') {
      await this.#coalesceTrustedDrive(runId);
      return;
    }
    // A sidecar without its immutable runtime marker is corruption, not a historical V1 row.
    // Never let it enter buildFakeContext or silently acquire fake-derived provenance.
    if (invocationFormat !== null || this.#readTrustedV2SqlRow(runId) !== null) {
      this.#failTrustedRun(runId, 'replay:artifact_invalid', { scrubSidecar: true });
      return;
    }
    let run = this.#requireRuntimeRun(runId);
    if (run.state === 'DONE' || run.state === 'FAILED') return;
    let ctx: HookRuntimeContext | null = null;

    while (run.state !== 'DONE' && run.state !== 'FAILED') {
      switch (run.state) {
        case 'PENDING':
          let admissionDecision: GovernorDecision;
          {
            try {
              admissionDecision = this.#admitGovernor(run.run_id);
            } catch (error) {
              const scribeReason = scribeFailureReasonFromError(error);
              if (scribeReason === null) throw error;
              run = this.#failFromScribe(run.run_id, 'internal_context', scribeReason);
              break;
            }
            if (admissionDecision.verdict === 'deny') {
              this.#recordGovernorDenied(run.run_id, admissionDecision);
              run = this.#failRun(run.run_id, governorFailureReason(admissionDecision));
              break;
            }
          }
          this.#recordTrace(run.run_id, 'governor_admitted', {
            loop_type: admissionDecision.loopType,
          });
          ctx = await this.#rebuildInvocationContext(run);
          run = this.#advanceRun(run.run_id, 'CONTEXT_BUILT', {
            context: this.#buildFakeContext(run, ctx.session),
          });
          this.#recordTrace(run.run_id, 'context_built', { source: 'fake-derived' });
          this.#crashAfter('CONTEXT_BUILT');
          break;
        case 'CONTEXT_BUILT':
          ctx ??= await this.#rebuildInvocationContext(run);
          run = await this.#callLlm(run, ctx);
          this.#crashAfter('LLM_CALLED');
          break;
        case 'LLM_CALLED':
          ctx ??= await this.#rebuildInvocationContext(run);
          run = await this.#dispatchTools(run, ctx);
          this.#crashAfter('TOOLS_DONE');
          break;
        case 'TOOLS_DONE':
          run = await this.#synthesiseDelivery(run, ctx);
          if (run.state === 'FAILED') break;
          if (run.state === 'LLM_CALLED') {
            this.#crashAfter('LLM_CALLED');
          } else {
            run = await this.#gate(run);
            this.#crashAfter('GATED');
          }
          break;
        case 'GATED':
          try {
            await this.journalOutbox.tickRun(run.run_id);
          } catch (error) {
            const scribeReason = scribeFailureReasonFromError(error);
            if (scribeReason === null) throw error;
            run = this.#failFromScribe(run.run_id, 'outbox', scribeReason);
            break;
          }
          if (this.journalOutbox.readRunState(run.run_id) === 'FAILED') {
            run = this.#failFromScribe(run.run_id, 'outbox', 'invalid_payload');
            break;
          }
          run = this.#advanceRun(run.run_id, 'DELIVERED');
          this.#recordTrace(run.run_id, 'delivered', { sink: 'fake', status: 'acked' });
          this.#crashAfter('DELIVERED');
          break;
        case 'DELIVERED':
          run = this.#advanceRun(run.run_id, 'DONE');
          this.#recordTrace(run.run_id, 'done', { terminal: true });
          break;
        default:
          assertNever(run.state);
      }
    }
  }

  // A Durable Object can interleave a second event while a provider adapter is awaited. Coalesce
  // only the resident V2 drive so every scheduler/test caller shares one in-flight execution;
  // this is resident-event suppression only. A crash/reset before a durable provider receipt
  // needs a durable source/effect receipt protocol; this map cannot provide that guarantee.
  async #coalesceTrustedDrive(runId: string): Promise<void> {
    const active = this.trustedDrivePromises.get(runId);
    if (active !== undefined) return active;
    // Start on a later microtask so the map is populated before any trusted drive reaches an
    // adapter await. This keeps the external interface at driveRun while hiding coalescing here.
    const driving = Promise.resolve().then(() => this.#driveTrustedRunOnce(runId));
    this.trustedDrivePromises.set(runId, driving);
    try {
      await driving;
    } finally {
      if (this.trustedDrivePromises.get(runId) === driving) {
        this.trustedDrivePromises.delete(runId);
      }
    }
  }

  async #driveTrustedRunOnce(runId: string): Promise<void> {
    try {
      await this.#requireTrustedV2State(runId);
    } catch (error) {
      if (!(error instanceof TrustedV2IntegrityError)) throw error;
      this.#failTrustedRun(runId, 'replay:artifact_invalid', { scrubSidecar: true });
      return;
    }
    await this.#driveTrustedRun(runId);
  }

  // V2 stays inside the original durable loop. The explicit branch is selected from the immutable
  // runtime marker, never from caller input or a best-effort parse of legacy JSON.
  async #driveTrustedRun(runId: string): Promise<void> {
    let run = this.#requireRuntimeRun(runId);
    // Validate the reduced delivery journal even when the runtime FSM is already terminal. A
    // terminal V2 row must never hide a corrupted completion mode or outbox invariant merely
    // because no further effect is scheduled.
    this.journalOutbox.validateTrustedRun(runId);
    if (run.state === 'DONE' || run.state === 'FAILED') return;
    let ctx: HookRuntimeContext | null = null;

    while (run.state !== 'DONE' && run.state !== 'FAILED') {
      const state = await this.#requireTrustedV2State(run.run_id);
      // Every pending V2 effect has crossed an external boundary but has no durable receipt.
      // Reconcile it before terminal policy, ContextComposer, replay artifacts, spend, normal
      // invocation-start hooks, or circuit checks. Receipt settlement still applies its governed
      // post-effect safety hooks, but cannot be blocked by a new rate-limit/session rebuild.
      if (state.pending_effect !== null) {
        if (this.journalOutbox.readRunState(run.run_id) !== 'GOVERNOR_ADMITTED') {
          run = this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
          break;
        }
        const recoveryCtx = this.#buildTrustedReceiptRecoveryContext(run, state);
        if (state.pending_effect.kind === 'tool') {
          if (run.state !== 'LLM_CALLED') {
            run = this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
            break;
          }
          run = await this.#reconcileTrustedToolReceipt(
            run,
            state,
            recoveryCtx,
            state.pending_effect,
          );
        } else {
          run = await this.#reconcileTrustedProviderEffect(
            run,
            state,
            recoveryCtx,
            state.pending_effect,
          );
        }
        // The recovery context is intentionally not a resume witness. The next fresh boundary
        // must rebuild and recompose from the frozen snapshot, so a changed/unavailable source
        // cannot be skipped merely because receipt reconciliation succeeded.
        ctx = null;
        continue;
      }
      const governorTerminal = this.#reconcileTrustedGovernorTerminal(run.run_id);
      if (governorTerminal !== null) {
        run = governorTerminal;
        break;
      }
      const invocation = state.record.invocation;
      // This lane has no production-grade replay/artifact owner or configured real sink yet.
      // Once a run has entered the V2 lane, gateway mode is therefore closed before *any* resumed
      // provider, tool, or delivery effect—not just before a fresh plan request.
      if (this.adapters.providerMode === 'gateway' && run.state !== 'DELIVERED') {
        run = this.#failTrustedRun(run.run_id, 'llm:spend_state_unavailable');
        break;
      }
      // A new drive (after eviction, alarm retry, or explicit restart) owns no ephemeral prompt
      // or ContextComposer lease. Handlers that will issue a provider call recompose themselves;
      // this guard covers the remaining resumed effect boundaries (tools, persisted synthesis,
      // gate/sink, and post-ack terminal bookkeeping) without paying a second composition in
      // provider-owning handlers. An acknowledged delivery remains immutable in the reduced
      // journal, but a changed witness still yields a typed runtime integrity failure.
      const needsResumeWitness =
        run.state === 'LLM_CALLED' ||
        run.state === 'GATED' ||
        run.state === 'DELIVERED' ||
        (run.state === 'TOOLS_DONE' && state.synthesis !== null);
      if (ctx === null && state.record.context !== null && needsResumeWitness) {
        ctx = await this.#rebuildTrustedInvocationContext(run, state);
        const composition = await this.#composeTrustedV2(state);
        if (!composition.ok) {
          run = this.#failTrustedRun(run.run_id, `context:${composition.failure.code}`, {
            allowPostAckIntegrityFailure: run.state === 'DELIVERED',
          });
          break;
        }
        this.#seedTrustedContext(ctx, this.#trustedEffectiveSourceTaint(state));
      }
      switch (run.state) {
        case 'PENDING': {
          let admission: GovernorDecision;
          try {
            admission = this.journalOutbox.admitTrustedInvocation(run.run_id, invocation);
          } catch (error) {
            const scribeReason = scribeFailureReasonFromError(error);
            if (scribeReason === null) throw error;
            run = this.#failTrustedRun(run.run_id, `scribe:${scribeReason}`);
            break;
          }
          if (admission.verdict === 'deny') {
            run = this.#failTrustedGovernorDenied(run.run_id, admission);
            break;
          }
          if (!this.#hasRuntimeTraceEvent(run.run_id, 'governor_admitted')) {
            this.#recordTrace(run.run_id, 'governor_admitted', { loop_type: admission.loopType });
          }
          this.#crashAfterTrustedAdmission();
          ctx = await this.#rebuildTrustedInvocationContext(run, state);
          const composition = await this.#composeTrustedV2(state);
          if (!composition.ok) {
            run = this.#failTrustedRun(run.run_id, `context:${composition.failure.code}`);
            break;
          }
          this.#seedTrustedContext(ctx, composition.checkpoint.source_taint);
          const committed = this.#withTrustedComposition(state, composition);
          run = this.#advanceTrustedRun(run.run_id, 'CONTEXT_BUILT', committed, {
            trace: {
              event: 'context_built',
              detail: {
                source: 'context-composer-v2',
                context_ref: composition.checkpoint.context_ref,
                source_count: composition.checkpoint.sources.length,
                source_taint: composition.checkpoint.source_taint,
              },
              sourceTaint: composition.checkpoint.source_taint,
            },
          });
          this.#crashAfter('CONTEXT_BUILT');
          break;
        }
        case 'CONTEXT_BUILT':
          ctx ??= await this.#rebuildTrustedInvocationContext(run, state);
          run = await this.#callTrustedPlan(run, state, ctx);
          this.#crashAfter('LLM_CALLED');
          break;
        case 'LLM_CALLED':
          ctx ??= await this.#rebuildTrustedInvocationContext(run, state);
          run = await this.#dispatchTrustedTools(run, state, ctx);
          this.#crashAfter('TOOLS_DONE');
          break;
        case 'TOOLS_DONE':
          ctx ??= await this.#rebuildTrustedInvocationContext(run, state);
          run = await this.#synthesiseTrustedOutput(run, state, ctx);
          if (run.state === 'LLM_CALLED') {
            this.#crashAfter('LLM_CALLED');
          } else if (run.state === 'GATED') {
            this.#crashAfter('GATED');
          }
          break;
        case 'GATED':
          try {
            await this.journalOutbox.tickRun(run.run_id);
          } catch (error) {
            const scribeReason = scribeFailureReasonFromError(error);
            if (scribeReason === null) throw error;
            run = this.#failTrustedRun(run.run_id, `scribe:${scribeReason}`);
            break;
          }
          if (this.journalOutbox.readRunState(run.run_id) === 'FAILED') {
            run = this.#failTrustedRun(run.run_id, 'scribe:invalid_payload');
            break;
          }
          run = this.#advanceTrustedRun(run.run_id, 'DELIVERED', state, {
            trace: { event: 'delivered', detail: { sink: 'fake', status: 'acked' } },
          });
          this.#crashAfter('DELIVERED');
          break;
        case 'DELIVERED':
          run = this.#advanceTrustedRun(run.run_id, 'DONE', state, {
            trace: {
              event: 'done',
              detail: { terminal: true, disposition: 'proactive_delivery' },
            },
          });
          break;
        default:
          assertNever(run.state);
      }
    }
  }

  async #rebuildTrustedInvocationContext(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
  ): Promise<HookRuntimeContext> {
    // A V2 hook context must never start from legacy scratch, even transiently before the
    // checkpoint taint is restored. The absence of a checkpoint at PENDING is itself null taint.
    return this.#rebuildInvocationContextWithTaint(run, this.#trustedEffectiveSourceTaint(state));
  }

  #buildTrustedReceiptRecoveryContext(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
  ): HookRuntimeContext {
    const invocation = state.record.invocation;
    if (
      run.user_id !== invocation.verified_authority.principal_ref ||
      run.trigger !== invocation.runtime_binding.trigger
    ) {
      throw new TrustedV2IntegrityError('trusted receipt recovery runtime binding mismatch');
    }
    const sourceTaint = this.#trustedEffectiveSourceTaint(state);
    return {
      authenticatedUserId: invocation.verified_authority.principal_ref,
      trigger: invocation.runtime_binding.trigger,
      canaryTokens: CANARY_TOKENS,
      now: this.deps.now,
      session: buildSessionState({
        trigger: invocation.runtime_binding.trigger,
        canary_tokens: CANARY_TOKENS,
        // This is a deterministic immutable receipt context, never a new invocation session.
        started_at: invocation.accepted_at,
      }),
      hasApproval: this.adapters.safety.hasApproval,
      sanitise: this.adapters.safety.sanitise,
      medicalGate: this.adapters.safety.medicalGate,
      sourceTaint,
      toolArgSourceTaint: sourceTaint,
    };
  }

  #seedTrustedContext(ctx: HookRuntimeContext, sourceTaint: SourceTaint): void {
    // V2 never derives taint from legacy scratch. The committed ContextComposer checkpoint is the
    // only durable witness that may govern tool arguments and egress.
    ctx.sourceTaint = sourceTaint;
    ctx.toolArgSourceTaint = sourceTaint;
  }

  #trustedEffectiveSourceTaint(state: TrustedRunV2State): SourceTaint {
    return v2CompletedToolCheckpoints(state).reduce(
      (taint, checkpoint) => mergeSourceTaint(taint, checkpoint.guards.result_taint),
      state.record.context?.source_taint ?? null,
    );
  }

  async #composeTrustedV2(state: TrustedRunV2State): Promise<TrustedCompositionResult> {
    const composer = this.adapters.contextComposer;
    if (composer === undefined) {
      return { ok: false, failure: { code: 'materials_unavailable' } };
    }
    try {
      // Reparse a fresh copy before crossing the adapter boundary so a hostile/test Composer
      // cannot mutate the trusted state object that will later be committed.
      const invocation = runtimeInvocationV2RecordSchema.parse(state.record).invocation;
      const composition = normaliseTrustedCompositionResult(await composer.compose(invocation, {
        snapshot_ref: state.snapshot.snapshot_ref,
        snapshot_at: state.snapshot.snapshot_at,
        canary_tokens: CANARY_TOKENS,
        replay_context_ref: state.record.context?.context_ref ?? null,
      }));
      if (!composition.ok) return composition;
      if (
        composition.checkpoint.principal_ref !== invocation.verified_authority.principal_ref ||
        composition.checkpoint.tenant_ref !== invocation.verified_authority.tenant_ref ||
        composition.checkpoint.invocation_idempotency_ref !== invocation.idempotency.key_ref
      ) {
        return { ok: false, failure: { code: 'provenance_invalid' } };
      }
      const promptDigest = `sha256:${await this.deps.sha256Hex(composition.prompt)}`;
      if (
        promptDigest !== composition.evidence.prompt_digest ||
        !this.#compositionMatchesTrustedWitness(state, composition)
      ) {
        return { ok: false, failure: { code: 'provenance_invalid' } };
      }
      return composition;
    } catch {
      return { ok: false, failure: { code: 'assembly_failed' } };
    }
  }

  #compositionMatchesTrustedWitness(
    state: TrustedRunV2State,
    composition: Extract<TrustedCompositionResult, { ok: true }>,
  ): boolean {
    const witness = state.record.context;
    if (witness === null) return true;
    return (
      stableJsonStringify(composition.checkpoint) === stableJsonStringify(witness) &&
      composition.evidence.prompt_digest === state.evidence.prompt_digest &&
      composition.evidence.recall.status === state.evidence.recall_status
    );
  }

  #withTrustedComposition(
    state: TrustedRunV2State,
    composition: Extract<TrustedCompositionResult, { ok: true }>,
  ): TrustedRunV2State {
    const at = this.deps.now();
    return updateTrustedRunV2State(state, {
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        context: composition.checkpoint,
        persisted_at: at,
      }),
      evidence: {
        ...state.evidence,
        prompt_digest: composition.evidence.prompt_digest,
        source_count: composition.checkpoint.sources.length,
        source_taint: composition.checkpoint.source_taint,
        recall_status: composition.evidence.recall.status,
      },
    });
  }

  async #callTrustedPlan(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    // There is no real durable source/artifact owner or configured real sink. Gateway mode is
    // therefore deliberately closed before an external provider request, even if a future test
    // override happens to inject a Composer.
    if (this.adapters.providerMode === 'gateway') {
      return this.#failTrustedRun(run.run_id, 'llm:spend_state_unavailable');
    }
    const preflight = this.#checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      return this.#failTrustedGovernorDenied(run.run_id, preflight);
    }
    const composition = await this.#composeTrustedV2(state);
    if (!composition.ok) {
      return this.#failTrustedRun(run.run_id, `context:${composition.failure.code}`);
    }
    if (state.record.context === null) {
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    this.#seedTrustedContext(ctx, this.#trustedEffectiveSourceTaint(state));
    const spend = await this.#readSpendBeforeProvider();
    if (!spend.ok) return this.#failTrustedRun(run.run_id, 'llm:spend_state_unavailable');

    let preparedEffect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    > | null = null;
    let result: Awaited<ReturnType<RuntimeLLMProvider['completeTrusted']>>;
    try {
      result = await this.llm.completeTrusted(
        {
          trigger: run.trigger,
          spend: spend.spend,
          renderRequest: ({ step, context }) => ({
            system: `${RUN_LOOP_PLAN_SYSTEM_PREFIX}:${context}:${step.provider}`,
            messages: [{ role: 'user', content: composition.prompt }],
            max_tokens: 256,
            temperature: 0,
          }),
          renderTemplate: () => '[]',
          prepareEffect: async (request) => {
            const prepared = await this.#prepareTrustedProviderEffect(
              run.run_id,
              state,
              'provider_plan',
              request,
            );
            if (prepared.operation !== 'issue') {
              throw new TrustedV2IntegrityError('fresh trusted provider issue reused a pending effect');
            }
            preparedEffect = prepared.effect;
            return { ...prepared.effect, operation: prepared.operation };
          },
        },
        ctx,
      );
    } catch (error) {
      if (error instanceof TrustedV2IntegrityError) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      throw error;
    }
    return this.#settleTrustedProviderResult({
      run,
      state,
      ctx,
      effect: preparedEffect,
      result,
      phase: 'provider_plan',
      crashAfterIssue: true,
      deferPostReceiptWork: false,
    });
  }

  // Both fresh issue and key-only recovery converge here. The adapter result is settled before
  // parsing can select another tool/provider branch, so there is one receipt path regardless of
  // whether a resident DO or an evicted DO observed the response.
  async #settleTrustedProviderResult(input: {
    run: RuntimeRunRecord;
    state: TrustedRunV2State;
    ctx: HookRuntimeContext;
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    > | null;
    result: Awaited<ReturnType<RuntimeLLMProvider['completeTrusted']>>;
    phase: 'provider_plan' | 'provider_observe';
    crashAfterIssue: boolean;
    // A resumed keyed receipt must not cross any fresh output/replay boundary until the outer
    // loop has recomposed the frozen ContextComposer witness.
    deferPostReceiptWork: boolean;
  }): Promise<RuntimeRunRecord> {
    // A keyed success or explicit rejected receipt both prove the provider boundary was crossed.
    // Exercise the same post-I/O/pre-commit crash window for each; an unavailable receipt is
    // deliberately not treated as proof that an external effect occurred.
    if (
      input.effect !== null &&
      input.crashAfterIssue &&
      (input.result.ok || input.result.effect_receipt !== undefined)
    ) {
      this.#crashAfterTrustedProviderEffect(input.phase);
    }
    if (!input.result.ok) {
      if (input.result.effect_receipt !== undefined) {
        if (input.effect === null) throw new Error('trusted provider receipt has no prepared effect');
        return this.#settleTrustedRejectedProviderEffect({
          run: input.run,
          state: input.state,
          effect: input.effect,
          receipt: input.result.effect_receipt,
          failureReason: this.#trustedLlmFailureReason(
            input.result,
            input.phase === 'provider_plan' ? 'llm' : 'llm_observe',
          ),
          phase: input.phase,
          fallbackStep: input.result.fallback_step,
          routingLogs: input.result.routing_logs,
          scribe: input.result.scribe,
        });
      }
      return this.#failTrustedLlmResult(
        input.run.run_id,
        input.result,
        input.phase === 'provider_plan' ? 'llm' : 'llm_observe',
      );
    }
    if (input.effect === null) throw new Error('trusted provider effect was not prepared');
    return input.phase === 'provider_plan'
      ? this.#settleTrustedPlanResponse(input.run, input.state, input.ctx, input.effect, input.result)
      : this.#settleTrustedObserveResponse(
          input.run,
          input.state,
          input.ctx,
          input.effect,
          input.result,
          input.deferPostReceiptWork,
        );
  }

  async #reconcileTrustedProviderEffect(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >,
  ): Promise<RuntimeRunRecord> {
    if (!(await this.#trustedEffectIdentityMatches(run.run_id, state, effect))) {
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    let result: Awaited<ReturnType<RuntimeLLMProvider['reconcileTrusted']>>;
    try {
      result = await this.llm.reconcileTrusted({ ...effect, operation: 'reconcile' }, ctx);
    } catch (error) {
      if (error instanceof TrustedV2IntegrityError) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      throw error;
    }
    return this.#settleTrustedProviderResult({
      run,
      state,
      ctx,
      effect,
      result,
      phase: effect.kind,
      crashAfterIssue: false,
      deferPostReceiptWork: true,
    });
  }

  async #settleTrustedPlanResponse(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >,
    result: Extract<Awaited<ReturnType<RuntimeLLMProvider['completeTrusted']>>, { ok: true }>,
  ): Promise<RuntimeRunRecord> {
    const parsed = await parseToolCalls(result.tool_call_source.text);
    const validated = parsed.ok ? this.#validatedTrustedCalls(parsed.calls, ctx) : null;
    const calls = validated?.ok ? validated.calls : null;
    // A successful provider effect receives its receipt and Governor usage before parsing may
    // reject its output. For malformed output this hashes the opaque response witness rather
    // than storing text; a restart cannot issue a second physical request in that narrow window.
    const planDigest = await this.deps.sha256Hex(
      stableJsonStringify(calls ?? result.tool_call_source.text),
    );
    const planRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: run.run_id, phase: 'plan', plan_digest: planDigest }),
    );
    const accounting = this.#trustedProviderAccounting(
      state,
      result.usage.input_tokens + result.usage.output_tokens,
    );
    const committed = this.#withTrustedProviderPlan(
      state,
      {
        iteration: state.evidence.provider_calls + 1,
        plan_ref: v2OpaqueRef('pln', planRefDigest),
        plan_digest: planDigest,
      },
      effect,
      accounting.evidence_tokens,
    );
    const settled = this.#settleTrustedProviderPlan(
      run.run_id,
      committed,
      accounting.governor_tokens,
      {
        trace: {
          event: 'llm_called',
          detail: {
            model: result.response.model,
            fallback_step: result.fallback_step,
            tool_call_count: calls?.length ?? 0,
            routing_logs: result.routing_logs,
          },
          sourceTaint: this.#trustedEffectiveSourceTaint(committed),
        },
      },
    );
    if (settled.state === 'FAILED') return settled;
    if (!parsed.ok) {
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: parsed.code });
      return this.#failTrustedRun(run.run_id, `tool_parse:${parsed.code}`);
    }
    if (validated === null || !validated.ok) {
      const reason = validated === null ? 'invalid_args' : validated.reason;
      this.#recordToolDispatchTrace(run.run_id, [
        {
          tool: parsed.calls.find((call) => checkpointCallFailure(call, ctx) === reason)?.name ?? null,
          ok: false,
          reason,
        },
      ]);
      return this.#failTrustedRun(run.run_id, `tool_dispatch:${reason}`);
    }
    if (state.record.tool_checkpoints.length + validated.calls.length > 16) {
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: 'invalid_args' });
      return this.#failTrustedRun(run.run_id, 'tool_parse:invalid_args');
    }
    return settled;
  }

  #validatedTrustedCalls(
    calls: readonly RuntimeToolCall[],
    ctx: HookRuntimeContext,
  ):
    | Readonly<{ ok: true; calls: RuntimeToolCall[] }>
    | Readonly<{ ok: false; reason: ReturnType<typeof checkpointCallFailure> }> {
    const parsed = calls.map((call) => runtimeRunToolCallSchema.safeParse(call));
    const invalidIndex = parsed.findIndex((call) => !call.success);
    if (invalidIndex < 0) {
      return { ok: true, calls: parsed.map((call) => runtimeRunToolCallSchema.parse(call.data)) };
    }
    const invalid = calls[invalidIndex];
    const reason = checkpointCallFailure(invalid, ctx);
    return { ok: false, reason };
  }

  #withTrustedProviderPlan(
    state: TrustedRunV2State,
    plan: Omit<NonNullable<TrustedRunV2State['plan']>, 'effect'>,
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >,
    tokens: number,
  ): TrustedRunV2State {
    const at = this.deps.now();
    return updateTrustedRunV2State(state, {
      record: runtimeInvocationV2RecordSchema.parse({ ...state.record, persisted_at: at }),
      plan: { ...plan, effect },
      synthesis: null,
      pending_effect: null,
      evidence: {
        ...state.evidence,
        provider_calls: state.evidence.provider_calls + 1,
        total_tokens: state.evidence.total_tokens + tokens,
      },
    });
  }

  async #prepareTrustedProviderEffect(
    runId: string,
    state: TrustedRunV2State,
    kind: Extract<TrustedRunV2PendingEffect['kind'], 'provider_plan' | 'provider_observe'>,
    request: LLMGatewayRequest,
  ): Promise<
    PreparedTrustedEffect<
      Extract<TrustedRunV2PendingEffect, { kind: 'provider_plan' | 'provider_observe' }>
    >
  > {
    const requestDigest = await this.#trustedEffectRequestDigest(request);
    const iteration = state.evidence.provider_calls + 1;
    const execution: TrustedRunV2ProviderExecutionWitness = {
      step: request.step,
      context: request.context,
      fallback_step: request.fallback_step,
    };
    const identity = await this.#mintTrustedEffectIdentity(runId, state, kind, requestDigest, {
      iteration,
      execution,
    });
    return this.#prepareTrustedEffect(state, runId, {
      kind,
      ...identity,
      request_digest: requestDigest,
      iteration,
      execution,
    });
  }

  async #prepareTrustedToolEffect(input: {
    runId: string;
    state: TrustedRunV2State;
    callRef: string;
    tool: ToolName;
    argsHash: string;
    argumentTaint: SourceTaint;
  }): Promise<PreparedTrustedEffect<Extract<TrustedRunV2PendingEffect, { kind: 'tool' }>>> {
    const requestDigest = await this.deps.sha256Hex(
      stableJsonStringify({
        call_ref: input.callRef,
        tool: input.tool,
        args_hash: input.argsHash,
      }),
    );
    const identity = await this.#mintTrustedEffectIdentity(
      input.runId,
      input.state,
      'tool',
      requestDigest,
      {
        call_ref: input.callRef,
        tool: input.tool,
        args_hash: input.argsHash,
        argument_taint: input.argumentTaint,
      },
    );
    return this.#prepareTrustedEffect(input.state, input.runId, {
      kind: 'tool',
      ...identity,
      request_digest: requestDigest,
      call_ref: input.callRef,
      tool: input.tool,
      args_hash: input.argsHash,
      argument_taint: input.argumentTaint,
    });
  }

  async #trustedEffectRequestDigest(request: LLMGatewayRequest): Promise<string> {
    // The exact post-hook gateway envelope is bound into the idempotency witness, including
    // routing and constant-header metadata. Only its digest is persisted; prompt text remains
    // ephemeral.
    return this.deps.sha256Hex(stableJsonStringify(request));
  }

  async #mintTrustedEffectIdentity(
    runId: string,
    state: TrustedRunV2State,
    kind: TrustedRunV2PendingEffect['kind'],
    requestDigest: string,
    coordinates: Record<string, unknown>,
  ): Promise<Pick<TrustedRunV2PendingEffect, 'effect_ref' | 'idempotency_key'>> {
    const digest = await this.deps.sha256Hex(
      stableJsonStringify({
        run_id: runId,
        canonical_identity_hash: state.canonical_identity_hash,
        snapshot_ref: state.snapshot.snapshot_ref,
        snapshot_at: state.snapshot.snapshot_at,
        kind,
        request_digest: requestDigest,
        coordinates,
      }),
    );
    return {
      effect_ref: v2OpaqueRef('eff', digest),
      idempotency_key: v2OpaqueRef('idk', digest),
    };
  }

  async #trustedEffectIdentityMatches(
    runId: string,
    state: TrustedRunV2State,
    effect: TrustedRunV2PendingEffect,
  ): Promise<boolean> {
    let coordinates: Record<string, unknown>;
    if (effect.kind === 'tool') {
      const expectedRequestDigest = await this.deps.sha256Hex(
        stableJsonStringify({
          call_ref: effect.call_ref,
          tool: effect.tool,
          args_hash: effect.args_hash,
        }),
      );
      if (effect.request_digest !== expectedRequestDigest) return false;
      coordinates = {
        call_ref: effect.call_ref,
        tool: effect.tool,
        args_hash: effect.args_hash,
        argument_taint: effect.argument_taint,
      };
    } else {
      coordinates = { iteration: effect.iteration, execution: effect.execution };
    }
    const expected = await this.#mintTrustedEffectIdentity(
      runId,
      state,
      effect.kind,
      effect.request_digest,
      coordinates,
    );
    return (
      effect.effect_ref === expected.effect_ref && effect.idempotency_key === expected.idempotency_key
    );
  }

  #prepareTrustedEffect<T extends TrustedRunV2PendingEffect>(
    state: TrustedRunV2State,
    runId: string,
    effect: T,
  ): PreparedTrustedEffect<T> {
    const existing = state.pending_effect;
    if (existing !== null) {
      if (trustedEffectsMatch(existing, effect)) {
        return { effect: existing as T, operation: 'reconcile' };
      }
      throw new TrustedV2IntegrityError('pending effect does not match the resumed operation');
    }
    const prepared = updateTrustedRunV2State(state, {
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        persisted_at: this.deps.now(),
      }),
      pending_effect: effect,
    });
    // The sidecar intent is committed before any provider or tool adapter is invoked.
    this.#persistTrustedV2State(runId, prepared);
    return { effect, operation: 'issue' };
  }

  #settleTrustedProviderPlan(
    runId: string,
    committed: TrustedRunV2State,
    governorTokens: number,
    transition: Readonly<{
      trace: Readonly<{
        event: string;
        detail: Record<string, unknown>;
        sourceTaint?: SourceTaint;
      }>;
    }>,
  ): RuntimeRunRecord {
    const settled = this.ctx.storage.transactionSync(() => {
      const decision = this.journalOutbox.recordTrustedProviderReceiptUsageInCurrentTransaction({
        runId,
        tokensUsed: governorTokens,
        iterations: 1,
        subagentSpawns: 0,
      });
      if (decision.verdict === 'deny') {
        // Keep the runtime FSM aligned with the committed provider receipt even when the
        // Governor's post-effect metering denies it. A reset can then recover the typed Governor
        // terminal rather than treating CONTEXT_BUILT plus a real receipt as corruption.
        return {
          decision,
          next: this.#advanceTrustedRunInCurrentTransaction(runId, 'LLM_CALLED', committed, transition),
        };
      }
      return {
        decision,
        next: this.#advanceTrustedRunInCurrentTransaction(runId, 'LLM_CALLED', committed, transition),
      };
    });
    if (settled.decision.verdict === 'deny') {
      return this.#failTrustedGovernorDenied(runId, settled.decision);
    }
    if (settled.next === null) throw new Error('trusted provider receipt did not advance the runtime');
    return settled.next;
  }

  #settleTrustedSynthesisReceipt(
    runId: string,
    committed: TrustedRunV2State,
    governorTokens: number,
    trace: Readonly<{
      event: string;
      detail: Record<string, unknown>;
      sourceTaint?: SourceTaint;
    }>,
  ): GovernorDecision {
    return this.ctx.storage.transactionSync(() => {
      const decision = this.journalOutbox.recordTrustedProviderReceiptUsageInCurrentTransaction({
        runId,
        tokensUsed: governorTokens,
        iterations: 1,
        subagentSpawns: 0,
      });
      this.#writeTrustedV2StateInCurrentTransaction(runId, committed, this.deps.now());
      this.#recordTraceInCurrentTransaction(
        runId,
        trace.event,
        trace.detail,
        trace.sourceTaint ?? this.#trustedEffectiveSourceTaint(committed),
      );
      return decision;
    });
  }

  #trustedProviderAccounting(
    state: TrustedRunV2State,
    governorTokens: number,
  ): Readonly<{ evidence_tokens: number; governor_tokens: number }> {
    if (!Number.isSafeInteger(governorTokens) || governorTokens < 0) {
      throw new TrustedV2IntegrityError('trusted provider receipt has invalid metering');
    }
    const boundedGovernorTokens = Math.min(governorTokens, TRUSTED_PROVIDER_EFFECT_METERING_CAP);
    const remainingEvidence = Math.max(
      0,
      TRUSTED_PROVIDER_EFFECT_METERING_CAP - state.evidence.total_tokens,
    );
    // Keep the independently committed Governor counter exactly equal to the bounded V2
    // aggregate. `requireTrustedV2State` cross-checks them on every resume, so a receipt can
    // never make a new provider effect eligible by lowering only one representation.
    const chargedTokens = Math.min(boundedGovernorTokens, remainingEvidence);
    return {
      evidence_tokens: chargedTokens,
      governor_tokens: chargedTokens,
    };
  }

  async #settleTrustedRejectedProviderEffect(input: {
    run: RuntimeRunRecord;
    state: TrustedRunV2State;
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >;
    receipt: TrustedProviderEffectReceipt;
    failureReason: string;
    phase: 'provider_plan' | 'provider_observe';
    fallbackStep: RuntimeRunFallbackStep;
    routingLogs: readonly RoutingLogEvent[];
    scribe: RuntimeLLMFailure['scribe'];
  }): Promise<RuntimeRunRecord> {
    const accounting = this.#trustedProviderAccounting(input.state, input.receipt.metered_tokens);
    const iteration = input.state.evidence.provider_calls + 1;
    const planDigest = await this.deps.sha256Hex(
      stableJsonStringify({
        effect_ref: input.effect.effect_ref,
        request_digest: input.effect.request_digest,
        outcome: input.receipt.outcome,
      }),
    );
    const phase = iteration === 1 ? 'plan' : 'continuation';
    const planRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: input.run.run_id, phase, plan_digest: planDigest }),
    );
    const committed = this.#withTrustedProviderPlan(
      input.state,
      {
        iteration,
        plan_ref: v2OpaqueRef('pln', planRefDigest),
        plan_digest: planDigest,
      },
      input.effect,
      accounting.evidence_tokens,
    );
    const failureReason = runtimeRunFailureReasonSchema.parse(input.failureReason);
    let terminal: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const decision = this.journalOutbox.recordTrustedProviderReceiptUsageInCurrentTransaction({
        runId: input.run.run_id,
        tokensUsed: accounting.governor_tokens,
        iterations: 1,
        subagentSpawns: 0,
      });
      // The receipt, its content-free rejected-effect trace, the Governor charge, and terminal
      // failure share one SQLite transaction. A post-effect eviction therefore finds either an
      // unresolved intent or this exact terminal receipt—never a synthetic plan that later turns
      // into a generic replay failure.
      this.#writeTrustedV2StateInCurrentTransaction(input.run.run_id, committed, this.deps.now());
      this.#recordTraceInCurrentTransaction(
        input.run.run_id,
        'provider_effect_rejected',
        {
          phase: input.phase,
          outcome: input.receipt.outcome,
          fallback_step: input.fallbackStep,
          routing_logs: input.routingLogs,
        },
        this.#trustedEffectiveSourceTaint(committed),
      );
      if (input.scribe !== undefined) {
        this.#recordTraceInCurrentTransaction(
          input.run.run_id,
          'scribe_denied',
          input.scribe,
          null,
        );
      }
      const terminalReason =
        decision.verdict === 'deny'
          ? runtimeRunFailureReasonSchema.parse(governorFailureReason(decision))
          : failureReason;
      if (decision.verdict === 'deny' && !this.#hasRuntimeTraceEvent(input.run.run_id, 'governor_denied')) {
        this.#recordTraceInCurrentTransaction(
          input.run.run_id,
          'governor_denied',
          { reason: decision.reason, disposition: decision.disposition },
          null,
        );
      }
      terminal = this.#failTrustedRunInCurrentTransaction(input.run.run_id, terminalReason);
    });
    if (terminal === null) throw new Error('trusted rejected provider effect did not terminalize');
    return terminal;
  }

  #failTrustedLlmResult(
    runId: string,
    result: RuntimeLLMFailure,
    prefix: 'llm' | 'llm_observe',
  ): RuntimeRunRecord {
    if (result.scribe !== undefined) {
      this.#recordTrace(runId, 'scribe_denied', result.scribe);
      return this.#failTrustedRun(runId, this.#trustedLlmFailureReason(result, prefix));
    }
    return this.#failTrustedRun(runId, this.#trustedLlmFailureReason(result, prefix));
  }

  #trustedLlmFailureReason(
    result: RuntimeLLMFailure,
    prefix: 'llm' | 'llm_observe',
  ): string {
    return result.scribe !== undefined ? `scribe:${result.scribe.reason}` : `${prefix}:${result.reason}`;
  }

  async #reconcileTrustedToolReceipt(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
    effect: Extract<NonNullable<TrustedRunV2State['pending_effect']>, { kind: 'tool' }>,
  ): Promise<RuntimeRunRecord> {
    if (
      state.record.tool_checkpoints.some((checkpoint) => checkpoint.call_ref === effect.call_ref) ||
      state.tool_effect_witnesses.some((witness) => witness.call_ref === effect.call_ref) ||
      !(await this.#trustedEffectIdentityMatches(run.run_id, state, effect))
    ) {
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    let result: DispatchToolResult;
    try {
      result = await reconcileTrustedToolEffect({
        callRef: effect.call_ref,
        tool: effect.tool,
        ctx: toolContext(ctx),
        effect: {
          idempotency_key: effect.idempotency_key,
          request_digest: effect.request_digest,
          operation: 'reconcile',
        },
        handlers: this.adapters.trustedToolHandlers ?? [getCrsHandler],
      });
    } catch (error) {
      if (error instanceof TrustedV2IntegrityError) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      throw error;
    }
    const settledEffect = result.trusted_effect;
    if (settledEffect === undefined) {
      // receipt_status: unavailable is deliberately not a receipt. Retain the intent for audit
      // and never issue a replacement tool effect on a later drive.
      return this.#failTrustedRun(
        run.run_id,
        `tool_dispatch:${result.ok ? 'invalid_tool_result' : result.reason}`,
      );
    }
    if (
      settledEffect.operation !== 'reconcile' ||
      settledEffect.idempotency_key !== effect.idempotency_key ||
      settledEffect.request_digest !== effect.request_digest
    ) {
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    const resultHash = await this.deps.sha256Hex(stableJsonStringify(governorObservationResult(result)));
    const checkpoint = await this.#trustedToolCheckpoint({
      runId: run.run_id,
      call: { id: effect.call_ref, name: effect.tool, args: null },
      callRef: effect.call_ref,
      paramsHash: effect.args_hash,
      resultHash,
      result,
      argumentTaint: effect.argument_taint,
      effectSettled: true,
    });
    const committed = this.#withTrustedToolCheckpoint(state, checkpoint, effect, true);
    let decision: GovernorDecision;
    try {
      decision = this.ctx.storage.transactionSync(() => {
        const observed = this.journalOutbox.recordTrustedToolReceiptObservationInCurrentTransaction({
          runId: run.run_id,
          toolName: effect.tool,
          canonicalParamsHash: effect.args_hash,
          resultHash,
          success: result.ok,
        });
        this.#writeTrustedV2StateInCurrentTransaction(run.run_id, committed, this.deps.now());
        return observed;
      });
    } catch (error) {
      if (error instanceof TrustedV2IntegrityError) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      throw error;
    }
    if (decision.verdict === 'deny') {
      this.#recordToolDispatchTrace(run.run_id, [
        result.ok
          ? { tool: effect.tool, ok: true }
          : { tool: effect.tool, ok: false, reason: result.reason },
      ]);
      return this.#failTrustedGovernorDenied(run.run_id, decision);
    }
    if (!result.ok) {
      this.#recordToolDispatchTrace(run.run_id, [{ tool: effect.tool, ok: false, reason: result.reason }]);
      return this.#failTrustedRun(run.run_id, `tool_dispatch:${result.reason}`);
    }
    return this.#requireRuntimeRun(run.run_id);
  }

  async #dispatchTrustedTools(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    const blockedCheckpoint = state.record.tool_checkpoints.find(
      (checkpoint) => checkpoint.status === 'blocked',
    );
    if (blockedCheckpoint !== undefined) {
      this.#recordToolDispatchTrace(run.run_id, [
        { tool: blockedCheckpoint.tool, ok: false, reason: blockedCheckpoint.reason },
      ]);
      return this.#failTrustedRun(run.run_id, `tool_dispatch:${blockedCheckpoint.reason}`);
    }
    // Validate every prior result witness before any new tool may run. This is both replay
    // integrity and a side-effect boundary: a missing earlier result must not be masked by a
    // later tool invocation in a multi-call plan or a resumed next iteration.
    const priorResults = await this.#resolveTrustedToolResults(run.run_id, state);
    if (!priorResults.ok) return this.#failTrustedRun(run.run_id, `replay:${priorResults.reason}`);
    const plan = state.plan;
    if (plan === null) return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    const replay = await this.#resolveTrustedPlan(run.run_id, state);
    if (!replay.ok) return this.#failTrustedRun(run.run_id, `replay:${replay.reason}`);
    const plannedCalls = await Promise.all(
      replay.calls.map(async (call, index) => {
        const paramsHash = await this.deps.sha256Hex(stableJsonStringify(call.args));
        const callDigest = await this.deps.sha256Hex(
          stableJsonStringify({
            run_id: run.run_id,
            iteration: plan.iteration,
            index,
            call_id: call.id,
          }),
        );
        return { call, paramsHash, callRef: v2OpaqueRef('call', callDigest) };
      }),
    );
    const pendingTool = state.pending_effect;
    if (pendingTool !== null && pendingTool.kind === 'tool') {
      // The schema prevents a pending tool intent from reusing a completed call. Bind it again
      // to the replayed active plan before any handler runs: a raw SQLite mutation must not turn
      // an unrelated opaque intent into permission to cross a later tool boundary.
      const activeCall = plannedCalls.find(
        ({ call, callRef, paramsHash }) =>
          callRef === pendingTool.call_ref &&
          call.name === pendingTool.tool &&
          paramsHash === pendingTool.args_hash,
      );
      if (
        activeCall === undefined ||
        state.record.tool_checkpoints.some(
          (checkpoint) => checkpoint.call_ref === pendingTool.call_ref,
        ) ||
        state.tool_effect_witnesses.some((witness) => witness.call_ref === pendingTool.call_ref) ||
        !(await this.#trustedEffectIdentityMatches(run.run_id, state, pendingTool))
      ) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
    }
    // On retry, checkpoints already committed for this very plan are part of the fixed total;
    // count only plan calls that still need a checkpoint. This preserves the 16-call ceiling
    // without turning a valid partial-plan restart into a false over-cap failure.
    const newCheckpointCount = plannedCalls.filter(
      ({ callRef }) =>
        !state.record.tool_checkpoints.some((checkpoint) => checkpoint.call_ref === callRef),
    ).length;
    if (state.record.tool_checkpoints.length + newCheckpointCount > 16) {
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: 'invalid_args' });
      return this.#failTrustedRun(run.run_id, 'tool_parse:invalid_args');
    }

    const traceResults: { tool: ToolName | null; ok: boolean; reason?: string }[] = [];
    let durableState = state;
    for (const { call, paramsHash, callRef } of plannedCalls) {
      const prior = durableState.record.tool_checkpoints.find(
        (checkpoint) => checkpoint.call_ref === callRef,
      );
      if (prior !== undefined) {
        const restored = await this.#restoreTrustedToolCheckpoint({
          runId: run.run_id,
          call,
          callRef,
          paramsHash,
          checkpoint: prior,
        });
        if (!restored.ok) return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
        traceResults.push(
          restored.checkpoint.status === 'completed'
            ? { tool: call.name, ok: true }
            : { tool: call.name, ok: false, reason: restored.checkpoint.reason },
        );
        if (restored.checkpoint.status === 'blocked') {
          this.#recordToolDispatchTrace(run.run_id, traceResults);
          return this.#failTrustedRun(run.run_id, `tool_dispatch:${restored.checkpoint.reason}`);
        }
        ctx.sourceTaint = mergeSourceTaint(
          ctx.sourceTaint,
          restored.checkpoint.guards.result_taint,
        );
        continue;
      }

      // This is a fresh external tool boundary. A kill/policy decision must happen before the
      // durable intent is written and before handler I/O; settled receipt accounting below is
      // reserved for a tool that has already crossed that boundary.
      if (durableState.pending_effect === null) {
        const preflight = this.#checkGovernorBeforeToolEffect(run.run_id);
        if (preflight.verdict === 'deny') {
          return this.#failTrustedGovernorDenied(run.run_id, preflight);
        }
      }

      const preparedEffect: {
        value: PreparedTrustedEffect<
          Extract<TrustedRunV2PendingEffect, { kind: 'tool' }>
        > | null;
      } = { value: null };
      let result: DispatchToolResult;
      try {
        ctx.toolArgSourceTaint = ctx.sourceTaint;
        result = await dispatchTool(call, toolContext(ctx), {
          handlers: this.adapters.trustedToolHandlers ?? [getCrsHandler],
          trustedEffect: {
            prepare: async ({ tool, args }) => {
              const actualArgsHash = await this.deps.sha256Hex(stableJsonStringify(args));
              // V2 replays the admitted plan exactly. A hook may validate/sanitise the arguments,
              // but cannot silently substitute a different adapter request after the plan receipt.
              if (tool !== call.name || actualArgsHash !== paramsHash) {
                throw new TrustedV2IntegrityError('trusted tool arguments changed before effect');
              }
              const prepared = await this.#prepareTrustedToolEffect({
                runId: run.run_id,
                state: durableState,
                callRef,
                tool,
                argsHash: actualArgsHash,
                argumentTaint: ctx.toolArgSourceTaint,
              });
              preparedEffect.value = prepared;
              return {
                idempotency_key: prepared.effect.idempotency_key,
                request_digest: prepared.effect.request_digest,
                operation: prepared.operation,
              };
            },
          },
        });
      } catch (error) {
        if (error instanceof TrustedV2IntegrityError) {
          return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
        }
        throw error;
      }
      const settledEffect = result.trusted_effect;
      const effectSettled = settledEffect !== undefined;
      if (settledEffect !== undefined) {
        const prepared = preparedEffect.value;
        if (
          prepared === null ||
          settledEffect.idempotency_key !== prepared.effect.idempotency_key ||
          settledEffect.request_digest !== prepared.effect.request_digest ||
          settledEffect.operation !== prepared.operation
        ) {
          return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
        }
      }
      // A missing receipt is not evidence: retain the pending intent and fail closed. A declared
      // post-effect rejection, by contrast, is a bounded receipt and must be checkpointed before
      // terminalizing so a later retry cannot reissue the effect.
      if (preparedEffect.value !== null && !effectSettled) {
        if (result.ok || result.reason !== 'effect_receipt_unavailable') {
          return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
        }
        this.#recordToolDispatchTrace(run.run_id, [
          ...traceResults,
          { tool: call.name, ok: false, reason: result.reason },
        ]);
        return this.#failTrustedRun(run.run_id, `tool_dispatch:${result.reason}`);
      }
      if (effectSettled) this.#crashAfterTrustedToolEffect();
      traceResults.push(
        result.ok
          ? { tool: call.name, ok: true }
          : { tool: call.name, ok: false, reason: result.reason },
      );
      const observation = governorObservationResult(result);
      const resultHash = await this.deps.sha256Hex(stableJsonStringify(observation));
      const checkpoint = await this.#trustedToolCheckpoint({
        runId: run.run_id,
        call,
        callRef,
        paramsHash,
        resultHash,
        result,
        argumentTaint: ctx.toolArgSourceTaint,
        effectSettled,
      });
      const nextState = this.#withTrustedToolCheckpoint(
        durableState,
        checkpoint,
        preparedEffect.value?.effect ?? null,
        effectSettled,
      );
      let decision: GovernorDecision;
      try {
        decision = this.ctx.storage.transactionSync(() => {
          const observed = effectSettled
            ? this.journalOutbox.recordTrustedToolReceiptObservationInCurrentTransaction({
                runId: run.run_id,
                toolName: call.name,
                canonicalParamsHash: paramsHash,
                resultHash,
                success: result.ok,
              })
            : this.journalOutbox.recordLoopObservationInCurrentTransaction({
            runId: run.run_id,
            toolName: call.name,
            canonicalParamsHash: paramsHash,
            resultHash,
            success: result.ok,
              });
          this.#writeTrustedV2StateInCurrentTransaction(run.run_id, nextState, this.deps.now());
          return observed;
        });
      } catch (error) {
        if (error instanceof TrustedV2IntegrityError) {
          return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
        }
        throw error;
      }
      durableState = nextState;
      this.#crashAfterTrustedToolCheckpoint();
      if (decision.verdict === 'deny') {
        this.#recordToolDispatchTrace(run.run_id, traceResults);
        return this.#failTrustedGovernorDenied(run.run_id, decision);
      }
      if (!result.ok) {
        this.#recordToolDispatchTrace(run.run_id, traceResults);
        return this.#failTrustedRun(run.run_id, `tool_dispatch:${result.reason}`);
      }
      if (checkpoint.status !== 'completed') {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      const committedResult = await this.#resolveTrustedToolResult(
        run.run_id,
        durableState,
        checkpoint,
      );
      if (!committedResult.ok) {
        return this.#failTrustedRun(run.run_id, `replay:${committedResult.reason}`);
      }
      ctx.sourceTaint = mergeSourceTaint(ctx.sourceTaint, result.source_taint);
    }

    const at = this.deps.now();
    const committed = updateTrustedRunV2State(durableState, {
      record: runtimeInvocationV2RecordSchema.parse({
        ...durableState.record,
        persisted_at: at,
      }),
      plan: null,
    });
    return this.#advanceTrustedRun(run.run_id, 'TOOLS_DONE', committed, {
      trace: {
        event: 'tool_dispatched',
        detail: this.#toolDispatchTraceDetail(traceResults),
        sourceTaint: this.#trustedEffectiveSourceTaint(committed),
      },
    });
  }

  #reconcileTrustedGovernorTerminal(runId: string): RuntimeRunRecord | null {
    if (this.journalOutbox.readRunState(runId) !== 'FAILED') return null;
    const decision = this.journalOutbox.readGovernorDecision(runId);
    if (decision?.verdict === 'deny') {
      return this.#failTrustedGovernorDenied(runId, decision);
    }
    // DeliveryGate may commit a hold/drop into the reduced journal before the runtime FSM gets
    // its disposition-specific terminal reason. Leave that branch to gateTrustedOutput; only a
    // Governor denial is a loop-level terminal reconciliation.
    return null;
  }

  async #restoreTrustedToolCheckpoint(input: {
    runId: string;
    call: RuntimeToolCall;
    callRef: string;
    paramsHash: string;
    checkpoint: RuntimeToolCheckpoint;
  }): Promise<{ ok: true; checkpoint: RuntimeToolCheckpoint } | { ok: false }> {
    const { call, callRef, checkpoint, paramsHash, runId } = input;
    if (checkpoint.call_ref !== callRef || checkpoint.tool !== call.name) return { ok: false };
    if (checkpoint.status === 'blocked') {
      if (
        checkpoint.effect_receipt !== undefined &&
        checkpoint.effect_receipt.args_hash !== paramsHash
      ) {
        return { ok: false };
      }
      const auditDigest = await this.deps.sha256Hex(
        stableJsonStringify({
          run_id: runId,
          call_ref: callRef,
          status: 'blocked',
          reason: checkpoint.reason,
          effect_receipt: checkpoint.effect_receipt ?? null,
        }),
      );
      return checkpoint.audit_ref === v2OpaqueRef('aud', auditDigest)
        ? { ok: true, checkpoint }
        : { ok: false };
    }
    if (checkpoint.args_hash !== paramsHash) return { ok: false };
    return (await this.#trustedCompletedCheckpointRefsMatch(runId, checkpoint))
      ? { ok: true, checkpoint }
      : { ok: false };
  }

  async #trustedToolCheckpoint(input: {
    runId: string;
    call: RuntimeToolCall;
    callRef: string;
    paramsHash: string;
    resultHash: string;
    result: DispatchToolResult;
    argumentTaint: SourceTaint;
    effectSettled: boolean;
  }): Promise<RuntimeToolCheckpoint> {
    if (!input.result.ok) {
      const effectReceipt = input.effectSettled
        ? {
            outcome: 'rejected' as const,
            args_hash: input.paramsHash,
            result_hash: input.resultHash,
            argument_taint: input.argumentTaint,
          }
        : undefined;
      const auditRefDigest = await this.deps.sha256Hex(
        stableJsonStringify({
          run_id: input.runId,
          call_ref: input.callRef,
          status: 'blocked',
          reason: input.result.reason,
          effect_receipt: effectReceipt ?? null,
        }),
      );
      return runtimeToolCheckpointSchema.parse({
        checkpoint_version: 2,
        status: 'blocked',
        call_ref: input.callRef,
        tool: input.call.name,
        stage: trustedToolFailureStage(input.result.reason),
        reason: input.result.reason,
        ...(effectReceipt === undefined ? {} : { effect_receipt: effectReceipt }),
        audit_ref: v2OpaqueRef('aud', auditRefDigest),
      });
    }
    const argsRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: input.runId, params_hash: input.paramsHash }),
    );
    const resultRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: input.runId, result_hash: input.resultHash }),
    );
    const auditRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({
        run_id: input.runId,
        call_ref: input.callRef,
        result_hash: input.resultHash,
      }),
    );
    return runtimeToolCheckpointSchema.parse({
      checkpoint_version: 2,
      status: 'completed',
      call_ref: input.callRef,
      tool: input.call.name,
      args_ref: v2OpaqueRef('arg', argsRefDigest),
      args_hash: input.paramsHash,
      result_ref: v2OpaqueRef('res', resultRefDigest),
      result_hash: input.resultHash,
      audit_ref: v2OpaqueRef('aud', auditRefDigest),
      guards: v2CheckpointGuards({
        argumentTaint: input.argumentTaint,
        resultTaint: input.result.source_taint ?? null,
      }),
    });
  }

  #withTrustedToolCheckpoint(
    state: TrustedRunV2State,
    checkpoint: RuntimeToolCheckpoint,
    effect: Extract<TrustedRunV2PendingEffect, { kind: 'tool' }> | null,
    effectSettled: boolean,
  ): TrustedRunV2State {
    if (effectSettled && effect === null) {
      throw new TrustedV2IntegrityError('trusted tool receipt has no prepared effect');
    }
    const rejectedReceipt =
      checkpoint.status === 'blocked' && checkpoint.effect_receipt !== undefined;
    if (effectSettled && checkpoint.status !== 'completed' && !rejectedReceipt) {
      throw new TrustedV2IntegrityError('trusted tool receipt requires a settled checkpoint');
    }
    return updateTrustedRunV2State(state, {
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        tool_checkpoints: [...state.record.tool_checkpoints, checkpoint],
        persisted_at: this.deps.now(),
      }),
      // Any keyed adapter result, including a rejected one, settles the intent with a bounded
      // receipt. Only a throw or explicit receipt-unavailable result remains in doubt.
      pending_effect: effectSettled ? null : state.pending_effect,
      tool_effect_witnesses: effectSettled && effect !== null
        ? [...state.tool_effect_witnesses, effect]
        : state.tool_effect_witnesses,
    });
  }

  async #resolveTrustedPlan(
    runId: string,
    state: TrustedRunV2State,
  ): Promise<
    | { ok: true; calls: RuntimeToolCall[] }
    | { ok: false; reason: 'artifact_unavailable' | 'artifact_invalid' | 'artifact_mismatch' }
  > {
    if (state.plan === null || this.adapters.replayArtifacts === undefined) {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    if (!(await this.#trustedEffectIdentityMatches(runId, state, state.plan.effect))) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    const phase = state.plan.iteration === 1 ? 'plan' : 'continuation';
    const expectedRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: runId, phase, plan_digest: state.plan.plan_digest }),
    );
    if (state.plan.plan_ref !== v2OpaqueRef('pln', expectedRefDigest)) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    let value: unknown;
    try {
      value = await this.adapters.replayArtifacts.resolvePlan({
        iteration: state.plan.iteration,
        plan_ref: state.plan.plan_ref,
        plan_digest: state.plan.plan_digest,
        snapshot_ref: state.snapshot.snapshot_ref,
        snapshot_at: state.snapshot.snapshot_at,
      });
    } catch {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    const snapshot = snapshotReplayArtifact(value);
    if (!snapshot.ok) return { ok: false, reason: 'artifact_invalid' };
    let parsed: Awaited<ReturnType<typeof parseToolCalls>>;
    try {
      parsed = await parseToolCalls(snapshot.value);
    } catch {
      return { ok: false, reason: 'artifact_invalid' };
    }
    if (!parsed.ok) return { ok: false, reason: 'artifact_invalid' };
    const calls = parsed.calls.map((call) => runtimeRunToolCallSchema.safeParse(call));
    if (calls.some((call) => !call.success)) return { ok: false, reason: 'artifact_invalid' };
    const normalized = calls.map((call) => runtimeRunToolCallSchema.parse(call.data));
    const digest = await this.deps.sha256Hex(stableJsonStringify(normalized));
    return digest === state.plan.plan_digest
      ? { ok: true, calls: normalized }
      : { ok: false, reason: 'artifact_mismatch' };
  }

  async #synthesiseTrustedOutput(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    if (state.synthesis !== null) {
      const replayed = await this.#resolveTrustedSynthesis(run.run_id, state);
      return replayed.ok
        ? this.#completeTrustedOutput(run, state, replayed.text)
        : this.#failTrustedRun(run.run_id, `replay:${replayed.reason}`);
    }
    if (this.adapters.providerMode === 'gateway') {
      return this.#failTrustedRun(run.run_id, 'llm_observe:spend_state_unavailable');
    }
    const composition = await this.#composeTrustedV2(state);
    if (!composition.ok) {
      return this.#failTrustedRun(run.run_id, `context:${composition.failure.code}`);
    }
    const toolResults = await this.#resolveTrustedToolResults(run.run_id, state);
    if (!toolResults.ok) return this.#failTrustedRun(run.run_id, `replay:${toolResults.reason}`);
    let observePayload: string | undefined;
    try {
      observePayload = JSON.stringify({ prompt: composition.prompt, tool_results: toolResults.values });
    } catch {
      return this.#failTrustedRun(run.run_id, 'llm_observe:request_oversize');
    }
    // Keep the exact ephemeral synthesis envelope bounded before it crosses into the provider
    // runtime. Individual Composer and replay artifacts have their own limits; this closes the
    // aggregate amplification path across a multi-tool run without persisting the payload.
    if (
      typeof observePayload !== 'string' ||
      utf8ByteLengthWithinLimit(observePayload, TRUSTED_V2_SYNTHESIS_MESSAGE_MAX_UTF8_BYTES) ===
        null
    ) {
      return this.#failTrustedRun(run.run_id, 'llm_observe:request_oversize');
    }
    const preflight = this.#checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      return this.#failTrustedGovernorDenied(run.run_id, preflight);
    }
    const spend = await this.#readSpendBeforeProvider();
    if (!spend.ok) return this.#failTrustedRun(run.run_id, 'llm_observe:spend_state_unavailable');

    let preparedEffect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    > | null = null;
    let result: Awaited<ReturnType<RuntimeLLMProvider['completeTrusted']>>;
    try {
      result = await this.llm.completeTrusted(
        {
          trigger: run.trigger,
          spend: spend.spend,
          renderRequest: ({ step, context }) => ({
            system: `${RUN_LOOP_OBSERVE_SYSTEM_PREFIX}:${context}:${step.provider}`,
            messages: [
              {
                role: 'user',
                content: observePayload,
              },
            ],
            max_tokens: 256,
            temperature: 0,
          }),
          renderTemplate: () => this.adapters.deliveryTextFallback,
          prepareEffect: async (request) => {
            const prepared = await this.#prepareTrustedProviderEffect(
              run.run_id,
              state,
              'provider_observe',
              request,
            );
            if (prepared.operation !== 'issue') {
              throw new TrustedV2IntegrityError('fresh trusted provider issue reused a pending effect');
            }
            preparedEffect = prepared.effect;
            return { ...prepared.effect, operation: prepared.operation };
          },
        },
        ctx,
      );
    } catch (error) {
      if (error instanceof TrustedV2IntegrityError) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      throw error;
    }
    return this.#settleTrustedProviderResult({
      run,
      state,
      ctx,
      effect: preparedEffect,
      result,
      phase: 'provider_observe',
      crashAfterIssue: true,
      deferPostReceiptWork: false,
    });
  }

  async #settleTrustedObserveResponse(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    ctx: HookRuntimeContext,
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >,
    result: Extract<Awaited<ReturnType<RuntimeLLMProvider['completeTrusted']>>, { ok: true }>,
    deferPostReceiptWork: boolean,
  ): Promise<RuntimeRunRecord> {
    const accounting = this.#trustedProviderAccounting(
      state,
      result.usage.input_tokens + result.usage.output_tokens,
    );
    const observedTrace = {
      event: 'llm_observed',
      detail: {
        model: result.response.model,
        fallback_step: result.fallback_step,
        output_disposition: state.record.invocation.output.disposition,
        routing_logs: result.routing_logs,
      },
    } as const;
    const continuation = await parseObserveContinuation(result.tool_call_source.text);
    if (continuation.kind === 'malformed') {
      const planDigest = await this.deps.sha256Hex(stableJsonStringify(result.tool_call_source.text));
      const planRefDigest = await this.deps.sha256Hex(
        stableJsonStringify({ run_id: run.run_id, phase: 'continuation', plan_digest: planDigest }),
      );
      const committed = this.#withTrustedProviderPlan(
        state,
        {
          iteration: state.evidence.provider_calls + 1,
          plan_ref: v2OpaqueRef('pln', planRefDigest),
          plan_digest: planDigest,
        },
        effect,
        accounting.evidence_tokens,
      );
      const settled = this.#settleTrustedProviderPlan(run.run_id, committed, accounting.governor_tokens, {
        trace: { ...observedTrace, sourceTaint: this.#trustedEffectiveSourceTaint(committed) },
      });
      if (settled.state === 'FAILED') return settled;
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: continuation.code });
      return this.#failTrustedRun(run.run_id, `tool_parse:${continuation.code}`);
    }
    if (continuation.kind === 'tool_calls') {
      const validated = this.#validatedTrustedCalls(continuation.calls, ctx);
      const calls = validated.ok ? validated.calls : null;
      const planDigest = await this.deps.sha256Hex(
        stableJsonStringify(calls ?? result.tool_call_source.text),
      );
      const planRefDigest = await this.deps.sha256Hex(
        stableJsonStringify({ run_id: run.run_id, phase: 'continuation', plan_digest: planDigest }),
      );
      const committed = this.#withTrustedProviderPlan(
        state,
        {
          iteration: state.evidence.provider_calls + 1,
          plan_ref: v2OpaqueRef('pln', planRefDigest),
          plan_digest: planDigest,
        },
        effect,
        accounting.evidence_tokens,
      );
      const settled = this.#settleTrustedProviderPlan(run.run_id, committed, accounting.governor_tokens, {
        trace: {
          ...observedTrace,
          sourceTaint: this.#trustedEffectiveSourceTaint(committed),
        },
      });
      if (settled.state === 'FAILED') return settled;
      if (!validated.ok) {
        const failedCall = continuation.calls.find(
          (call) => checkpointCallFailure(call, ctx) === validated.reason,
        );
        this.#recordToolDispatchTrace(run.run_id, [
          { tool: failedCall?.name ?? null, ok: false, reason: validated.reason },
        ]);
        return this.#failTrustedRun(run.run_id, `tool_dispatch:${validated.reason}`);
      }
      if (state.record.tool_checkpoints.length + validated.calls.length > 16) {
        this.#recordTrace(run.run_id, 'tool_parse_failed', { code: 'invalid_args' });
        return this.#failTrustedRun(run.run_id, 'tool_parse:invalid_args');
      }
      return settled;
    }

    const synthesisDigest = await this.deps.sha256Hex(stableJsonStringify(result.response.text));
    const synthesisRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({ run_id: run.run_id, phase: 'synthesis', result_digest: synthesisDigest }),
    );
    const committed = this.#withTrustedSynthesis(
      state,
      {
        result_ref: v2OpaqueRef('syn', synthesisRefDigest),
        result_digest: synthesisDigest,
      },
      effect,
      accounting.evidence_tokens,
    );
    // The receipt commits before any egress/terminal transition. A restart at this boundary
    // resolves it from frozen runtime-owned artifacts rather than re-calling the provider or
    // persisting the output text.
    const usage = this.#settleTrustedSynthesisReceipt(run.run_id, committed, accounting.governor_tokens, {
      ...observedTrace,
      sourceTaint: this.#trustedEffectiveSourceTaint(committed),
    });
    if (usage.verdict === 'deny') return this.#failTrustedGovernorDenied(run.run_id, usage);
    if (deferPostReceiptWork) {
      // A reconciliation may settle an already-issued terminal provider receipt, but it has no
      // fresh ContextComposer witness. Leave the runtime at TOOLS_DONE so the outer drive loop
      // clears its recovery context and validates the frozen snapshot before replay, egress,
      // internal completion, or any disposition-specific delivery work.
      return this.#requireRuntimeRun(run.run_id);
    }
    this.#crashAfterTrustedSynthesisReceipt();
    const replayed = await this.#resolveTrustedSynthesis(run.run_id, committed);
    return replayed.ok
      ? this.#completeTrustedOutput(run, committed, replayed.text)
      : this.#failTrustedRun(run.run_id, `replay:${replayed.reason}`);
  }

  #withTrustedSynthesis(
    state: TrustedRunV2State,
    synthesis: Omit<NonNullable<TrustedRunV2State['synthesis']>, 'effect'>,
    effect: Extract<
      NonNullable<TrustedRunV2State['pending_effect']>,
      { kind: 'provider_plan' | 'provider_observe' }
    >,
    tokens: number,
  ): TrustedRunV2State {
    const at = this.deps.now();
    return updateTrustedRunV2State(state, {
      record: runtimeInvocationV2RecordSchema.parse({ ...state.record, persisted_at: at }),
      plan: null,
      synthesis: { ...synthesis, effect },
      pending_effect: null,
      evidence: {
        ...state.evidence,
        provider_calls: state.evidence.provider_calls + 1,
        total_tokens: state.evidence.total_tokens + tokens,
      },
    });
  }

  async #resolveTrustedToolResults(
    runId: string,
    state: TrustedRunV2State,
  ): Promise<
    | { ok: true; values: unknown[] }
    | { ok: false; reason: 'artifact_unavailable' | 'artifact_invalid' | 'artifact_mismatch' }
  > {
    if (this.adapters.replayArtifacts === undefined) {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    if (!this.#trustedCompletedCheckpointsMatchObservations(runId, state)) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    const values: unknown[] = [];
    for (const checkpoint of v2CompletedToolCheckpoints(state)) {
      const resolved = await this.#resolveTrustedToolResult(runId, state, checkpoint);
      if (!resolved.ok) return resolved;
      values.push(resolved.value);
    }
    return { ok: true, values };
  }

  // The V2 sidecar records content-free checkpoint metadata; the Governor's observation table is
  // the independently committed runtime witness for each completed tool effect. Match the sets
  // before replaying any result so an extra or rewritten sidecar checkpoint cannot enter a later
  // synthesis prompt merely because its opaque fields parse.
  #trustedCompletedCheckpointsMatchObservations(
    runId: string,
    state: TrustedRunV2State,
  ): boolean {
    const observations = this.ctx.storage.sql
      .exec<{ tool_name: string; canonical_params_hash: string; result_hash: string }>(
        `SELECT tool_name, canonical_params_hash, result_hash
           FROM loop_observations
          WHERE run_id = ?`,
        runId,
      )
      .toArray();
    const checkpoints = v2CompletedToolCheckpoints(state);
    if (observations.length !== checkpoints.length) return false;
    const unmatched = new Set(
      observations.map(
        (observation) =>
          `${observation.tool_name}\u0000${observation.canonical_params_hash}\u0000${observation.result_hash}`,
      ),
    );
    for (const checkpoint of checkpoints) {
      const key = `${checkpoint.tool}\u0000${checkpoint.args_hash}\u0000${checkpoint.result_hash}`;
      if (!unmatched.delete(key)) return false;
    }
    return unmatched.size === 0;
  }

  // Successful checkpoints are replayable prompt artifacts; rejected receipts are not. Both,
  // however, crossed the tool boundary and require one independently committed Governor
  // observation. Verify this on every V2 state read, including terminal rows.
  #trustedSettledToolCheckpointsMatchObservations(
    runId: string,
    state: TrustedRunV2State,
  ): boolean {
    const observations = this.ctx.storage.sql
      .exec<{ tool_name: string; canonical_params_hash: string; result_hash: string }>(
        `SELECT tool_name, canonical_params_hash, result_hash
           FROM loop_observations
          WHERE run_id = ?`,
        runId,
      )
      .toArray();
    const checkpoints = v2SettledToolCheckpoints(state);
    if (observations.length !== checkpoints.length) return false;
    const unmatched = new Set(
      observations.map(
        (observation) =>
          `${observation.tool_name}\u0000${observation.canonical_params_hash}\u0000${observation.result_hash}`,
      ),
    );
    for (const checkpoint of checkpoints) {
      const argsHash =
        checkpoint.status === 'completed'
          ? checkpoint.args_hash
          : checkpoint.effect_receipt.args_hash;
      const resultHash =
        checkpoint.status === 'completed'
          ? checkpoint.result_hash
          : checkpoint.effect_receipt.result_hash;
      const key = `${checkpoint.tool}\u0000${argsHash}\u0000${resultHash}`;
      if (!unmatched.delete(key)) return false;
    }
    return unmatched.size === 0;
  }

  async #trustedCompletedCheckpointRefsMatch(
    runId: string,
    checkpoint: Extract<RuntimeToolCheckpoint, { status: 'completed' }>,
  ): Promise<boolean> {
    const [argsRefDigest, resultRefDigest, auditRefDigest] = await Promise.all([
      this.deps.sha256Hex(
        stableJsonStringify({ run_id: runId, params_hash: checkpoint.args_hash }),
      ),
      this.deps.sha256Hex(
        stableJsonStringify({ run_id: runId, result_hash: checkpoint.result_hash }),
      ),
      this.deps.sha256Hex(
        stableJsonStringify({
          run_id: runId,
          call_ref: checkpoint.call_ref,
          result_hash: checkpoint.result_hash,
        }),
      ),
    ]);
    return (
      checkpoint.args_ref === v2OpaqueRef('arg', argsRefDigest) &&
      checkpoint.result_ref === v2OpaqueRef('res', resultRefDigest) &&
      checkpoint.audit_ref === v2OpaqueRef('aud', auditRefDigest)
    );
  }

  async #resolveTrustedToolResult(
    runId: string,
    state: TrustedRunV2State,
    checkpoint: Extract<RuntimeToolCheckpoint, { status: 'completed' }>,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; reason: 'artifact_unavailable' | 'artifact_invalid' | 'artifact_mismatch' }
  > {
    if (this.adapters.replayArtifacts === undefined) {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    const effect = state.tool_effect_witnesses.find(
      (candidate) => candidate.call_ref === checkpoint.call_ref,
    );
    if (effect === undefined || !(await this.#trustedEffectIdentityMatches(runId, state, effect))) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    if (!(await this.#trustedCompletedCheckpointRefsMatch(runId, checkpoint))) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    let value: unknown;
    try {
      value = await this.adapters.replayArtifacts.resolveToolResult({
        result_ref: checkpoint.result_ref,
        result_hash: checkpoint.result_hash,
        snapshot_ref: state.snapshot.snapshot_ref,
        snapshot_at: state.snapshot.snapshot_at,
      });
    } catch {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    const snapshot = snapshotReplayArtifact(value);
    if (!snapshot.ok) return { ok: false, reason: 'artifact_invalid' };
    if (!isTrustedCompletedToolObservation(snapshot.value, checkpoint)) {
      return { ok: false, reason: 'artifact_invalid' };
    }
    const digest = await this.deps.sha256Hex(stableJsonStringify(snapshot.value));
    if (digest !== checkpoint.result_hash) return { ok: false, reason: 'artifact_mismatch' };
    const sourceTaint = ownDataProperty(snapshot.value, 'source_taint');
    if (sourceTaint !== checkpoint.guards.result_taint) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    return { ok: true, value: snapshot.value };
  }

  async #resolveTrustedSynthesis(
    runId: string,
    state: TrustedRunV2State,
  ): Promise<
    | { ok: true; text: string }
    | { ok: false; reason: 'artifact_unavailable' | 'artifact_invalid' | 'artifact_mismatch' }
  > {
    if (state.synthesis === null || this.adapters.replayArtifacts === undefined) {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    if (!(await this.#trustedEffectIdentityMatches(runId, state, state.synthesis.effect))) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    const expectedRefDigest = await this.deps.sha256Hex(
      stableJsonStringify({
        run_id: runId,
        phase: 'synthesis',
        result_digest: state.synthesis.result_digest,
      }),
    );
    if (state.synthesis.result_ref !== v2OpaqueRef('syn', expectedRefDigest)) {
      return { ok: false, reason: 'artifact_mismatch' };
    }
    let value: unknown;
    try {
      value = await this.adapters.replayArtifacts.resolveSynthesis({
        result_ref: state.synthesis.result_ref,
        result_digest: state.synthesis.result_digest,
        snapshot_ref: state.snapshot.snapshot_ref,
        snapshot_at: state.snapshot.snapshot_at,
      });
    } catch {
      return { ok: false, reason: 'artifact_unavailable' };
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
      return { ok: false, reason: 'artifact_invalid' };
    }
    const digest = await this.deps.sha256Hex(stableJsonStringify(value));
    return digest === state.synthesis.result_digest
      ? { ok: true, text: value }
      : { ok: false, reason: 'artifact_mismatch' };
  }

  async #completeTrustedOutput(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    text: string,
  ): Promise<RuntimeRunRecord> {
    const disposition = state.record.invocation.output.disposition;
    if (disposition === 'proactive_delivery') {
      return this.#gateTrustedOutput(run, state, text);
    }
    if (disposition === 'solicited_reply') {
      const candidate = prepareWithScribe(
        text,
        deliveryTextSchema,
        'send_message',
        this.#trustedEffectiveSourceTaint(state),
        CANARY_TOKENS,
      );
      if (!candidate.ok) return this.#failTrustedRun(run.run_id, `scribe:${candidate.reason}`);
      const egress = this.journalOutbox.checkLoopEgress({ runId: run.run_id, text: candidate.value });
      // A reply has no proactive DeliveryGate budget, but its text still crosses the safety and
      // Governor egress boundary. Persist only the decision witness, never the reply text.
      this.#recordTrace(run.run_id, 'egress_checked', {
        disposition,
        verdict: egress.verdict,
        reason: egress.reason,
      });
      if (egress.verdict === 'deny') {
        this.#crashAfterTrustedGovernorDeny();
        return this.#failTrustedGovernorDenied(run.run_id, egress);
      }
      // This runtime deliberately has no Chat/surface response transport. Never mark a user-visible
      // reply complete while discarding its ephemeral text; fail closed after safety and egress.
      return this.#failTrustedRun(run.run_id, 'output:transport_unconfigured');
    }
    const terminal = this.#touchTrustedState(state, { synthesis: null });
    return this.#advanceTrustedRun(run.run_id, 'DONE', terminal, {
      completeNonProactive: true,
      trace: {
        event: 'done',
        detail: { terminal: true, disposition },
        sourceTaint: this.#trustedEffectiveSourceTaint(terminal),
      },
    });
  }

  async #gateTrustedOutput(
    run: RuntimeRunRecord,
    state: TrustedRunV2State,
    text: string,
  ): Promise<RuntimeRunRecord> {
    const durableState = this.journalOutbox.readRunState(run.run_id);
    if (durableState === 'GATED') {
      // DeliveryGate/outbox committed before the runtime FSM in a prior attempt. Its committed
      // evidence is now the authority: do not re-run egress or spend a second gate budget.
      const gated = await this.journalOutbox.gateRun(run.run_id);
      if (gated.state !== 'GATED') {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      return this.#advanceTrustedRun(
        run.run_id,
        'GATED',
        this.#touchTrustedState(state, { synthesis: null }),
        this.#hasRuntimeTraceEvent(run.run_id, 'gated')
          ? {}
          : {
              trace: {
                event: 'gated',
                detail: {
                  verdict: gated.verdict,
                  outbox_kind: this.#readOutboxKind(run.run_id),
                  delivery_text_source: 'llm',
                },
                sourceTaint: this.#trustedEffectiveSourceTaint(state),
              },
            },
      );
    }
    if (durableState === 'FAILED') {
      const failed = this.journalOutbox.validateTrustedRun(run.run_id);
      if (
        (failed.verdict === 'hold' || failed.verdict === 'drop') &&
        failed.gate_reason !== null
      ) {
        return this.#failTrustedRun(run.run_id, `delivery_gate:${failed.gate_reason}`, {
          precedingTrace: this.#hasRuntimeTraceEvent(run.run_id, 'gated')
            ? undefined
            : {
                event: 'gated',
                detail: {
                  verdict: failed.verdict,
                  reason: failed.gate_reason,
                  delivery_text_source: 'llm',
                },
              },
        });
      }
      const governor = this.journalOutbox.readGovernorDecision(run.run_id);
      if (governor?.verdict === 'deny') {
        return this.#failTrustedGovernorDenied(run.run_id, governor);
      }
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    if (durableState !== 'GOVERNOR_ADMITTED') {
      return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
    }
    const sourceTaint = this.#trustedEffectiveSourceTaint(state);
    const outboxCandidate = prepareWithScribe(
      text,
      deliveryTextSchema,
      'outbox',
      sourceTaint,
      CANARY_TOKENS,
    );
    if (!outboxCandidate.ok) return this.#failTrustedRun(run.run_id, `scribe:${outboxCandidate.reason}`);
    const sendCandidate = prepareWithScribe(
      outboxCandidate.value,
      deliveryTextSchema,
      'send_message',
      sourceTaint,
      CANARY_TOKENS,
    );
    if (!sendCandidate.ok) return this.#failTrustedRun(run.run_id, `scribe:${sendCandidate.reason}`);
    const egress = this.journalOutbox.checkLoopEgress({
      runId: run.run_id,
      text: sendCandidate.value,
    });
    if (egress.verdict === 'deny') {
      this.#crashAfterTrustedGovernorDeny();
      return this.#failTrustedGovernorDenied(run.run_id, egress);
    }
    const gated = await this.journalOutbox.gateRun(run.run_id);
    if (gated.verdict === null) throw new Error(`trusted gate did not stamp a verdict for ${run.run_id}`);
    if (gated.verdict === 'hold' || gated.verdict === 'drop') {
      this.#crashAfterTrustedGateTerminal();
      if (gated.gate_reason === null) {
        return this.#failTrustedRun(run.run_id, 'replay:artifact_invalid');
      }
      return this.#failTrustedRun(run.run_id, `delivery_gate:${gated.gate_reason}`, {
        precedingTrace: {
          event: 'gated',
          detail: {
            verdict: gated.verdict,
            reason: gated.gate_reason,
            delivery_text_source: 'llm',
          },
        },
      });
    }
    this.#crashAfterTrustedGateCommit();
    return this.#advanceTrustedRun(
      run.run_id,
      'GATED',
      this.#touchTrustedState(state, { synthesis: null }),
      {
        trace: {
          event: 'gated',
          detail: {
            verdict: gated.verdict,
            outbox_kind: this.#readOutboxKind(run.run_id),
            delivery_text_source: 'llm',
          },
          sourceTaint: this.#trustedEffectiveSourceTaint(state),
        },
      },
    );
  }

  #touchTrustedState(
    state: TrustedRunV2State,
    patch: Partial<Pick<TrustedRunV2State, 'plan' | 'synthesis' | 'evidence'>> = {},
  ): TrustedRunV2State {
    return updateTrustedRunV2State(state, {
      ...patch,
      record: runtimeInvocationV2RecordSchema.parse({
        ...state.record,
        persisted_at: this.deps.now(),
      }),
    });
  }

  async #rebuildInvocationContext(run: RuntimeRunRecord): Promise<HookRuntimeContext> {
    const sourceTaint = parseScratch(run.scratch_json).source_taint;
    return this.#rebuildInvocationContextWithTaint(run, sourceTaint);
  }

  async #rebuildInvocationContextWithTaint(
    run: RuntimeRunRecord,
    sourceTaint: SourceTaint,
  ): Promise<HookRuntimeContext> {
    const ctx: HookRuntimeContext = {
      authenticatedUserId: run.user_id,
      trigger: run.trigger,
      canaryTokens: CANARY_TOKENS,
      now: this.deps.now,
      rateLimitCheck: this.adapters.safety.rateLimitCheck,
      hasApproval: this.adapters.safety.hasApproval,
      sanitise: this.adapters.safety.sanitise,
      medicalGate: this.adapters.safety.medicalGate,
      sourceTaint,
      toolArgSourceTaint: sourceTaint,
    };
    await runHooks(
      'OnInvocationStart',
      { event: 'OnInvocationStart', trace_id: run.run_id },
      ctx,
    );
    if (ctx.session === undefined) {
      throw new Error('OnInvocationStart did not rebuild session');
    }
    this.#recordTrace(run.run_id, 'session_reset', {
      started_at: ctx.session.rate_limit_window.started_at,
      tool_count: ctx.session.tool_permissions.length,
    });
    return ctx;
  }

  #buildFakeContext(
    run: RuntimeRunRecord,
    session: SessionState | undefined,
  ): RuntimeRunContext {
    if (session === undefined) throw new Error('buildFakeContext requires a session');
    return runtimeRunContextSchema.parse({
      source: 'fake-derived',
      trigger: run.trigger,
      body_state: 'steady',
      session_started_at: session.rate_limit_window.started_at,
      tool_permissions: session.tool_permissions,
      source_taint: parseScratch(run.scratch_json).source_taint,
    });
  }

  async #callLlm(
    run: RuntimeRunRecord,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    const preflight = this.#checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      this.#recordGovernorDenied(run.run_id, preflight);
      return this.#failRun(run.run_id, governorFailureReason(preflight));
    }
    const spend = await this.#readSpendBeforeProvider();
    if (!spend.ok) {
      return this.#failRun(run.run_id, 'llm:spend_state_unavailable');
    }

    const result = await this.llm.complete(
      {
        trigger: run.trigger,
        spend: spend.spend,
        renderRequest({ step, context }) {
          return {
            system: `${RUN_LOOP_PLAN_SYSTEM_PREFIX}:${context}:${step.provider}`,
            messages: [{ role: 'user', content: 'derived brief context only' }],
            max_tokens: 256,
            temperature: 0,
          };
        },
        renderTemplate: () => '[]',
      },
      ctx,
    );

    if (!result.ok) {
      if (result.scribe !== undefined) {
        this.#recordTrace(run.run_id, 'scribe_denied', result.scribe);
        return this.#failRun(run.run_id, `scribe:${result.scribe.reason}`, {
          fallbackStep: result.fallback_step,
          routingLogs: result.routing_logs,
        });
      }
      return this.#failRun(run.run_id, `llm:${result.reason}`, {
        fallbackStep: result.fallback_step,
        routingLogs: result.routing_logs,
      });
    }

    const parsedCalls = await parseToolCalls(result.tool_call_source.text);
    if (!parsedCalls.ok) {
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: parsedCalls.code });
      return this.#failRun(run.run_id, `tool_parse:${parsedCalls.code}`);
    }

    const persistedCalls = parsedCalls.calls.map((call) => runtimeRunToolCallSchema.safeParse(call));
    const invalidCallIndex = persistedCalls.findIndex((call) => !call.success);
    if (invalidCallIndex >= 0) {
      const invalidCall = parsedCalls.calls[invalidCallIndex];
      const reason = checkpointCallFailure(invalidCall, ctx);
      this.#recordToolDispatchTrace(run.run_id, [
        { tool: invalidCall?.name ?? null, ok: false, reason },
      ]);
      return this.#failRun(run.run_id, `tool_dispatch:${reason}`);
    }

    const scratch: ScratchState = {
      tool_calls: parsedCalls.calls.map((call) => runtimeRunToolCallSchema.parse(call)),
      tool_results: [],
      llm: {
        model: result.response.model,
        fallback_step: result.fallback_step,
        degraded: result.degraded,
        tool_call_count: parsedCalls.calls.length,
      },
      source_taint: ctx.sourceTaint,
    };
    const usageDecision = this.journalOutbox.recordLoopUsage({
      runId: run.run_id,
      tokensUsed: result.usage.input_tokens + result.usage.output_tokens,
      iterations: 1,
      subagentSpawns: 0,
    });
    this.#recordTrace(run.run_id, 'llm_called', {
      model: result.response.model,
      fallback_step: result.fallback_step,
      tool_call_count: parsedCalls.calls.length,
      routing_logs: result.routing_logs,
    });
    if (usageDecision.verdict === 'deny') {
      this.#recordGovernorDenied(run.run_id, usageDecision);
      return this.#failRun(run.run_id, governorFailureReason(usageDecision));
    }
    const next = this.#advanceRun(run.run_id, 'LLM_CALLED', { scratch });
    return next;
  }

  async #dispatchTools(
    run: RuntimeRunRecord,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    const scratch = parseScratch(run.scratch_json);
    const calls = scratch.tool_calls ?? [];
    const results: ToolResultSummary[] = [];
    for (const call of calls) {
      ctx.toolArgSourceTaint = ctx.sourceTaint;
      const result = await dispatchTool(call, toolContext(ctx), {
        handlers: [getCrsHandler],
      });
      results.push(
        result.ok
          ? { tool: 'get_crs', ok: true }
          : { tool: 'get_crs', ok: false, reason: result.reason },
      );
      const paramsHash = await this.deps.sha256Hex(stableJsonStringify(call.args));
      const resultHash = await this.deps.sha256Hex(
        stableJsonStringify(governorObservationResult(result)),
      );
      const decision = this.journalOutbox.recordLoopObservation({
        runId: run.run_id,
        toolName: call.name,
        canonicalParamsHash: paramsHash,
        resultHash,
        success: result.ok,
      });
      if (decision.verdict === 'deny') {
        this.#recordToolDispatchTrace(run.run_id, results);
        this.#recordGovernorDenied(run.run_id, decision);
        return this.#failRun(run.run_id, governorFailureReason(decision));
      }
      if (!result.ok) {
        this.#recordToolDispatchTrace(run.run_id, results);
        return this.#failRun(run.run_id, `tool_dispatch:${result.reason}`);
      }
      ctx.sourceTaint = mergeSourceTaint(ctx.sourceTaint, result.source_taint);
    }

    const next = this.#advanceRun(run.run_id, 'TOOLS_DONE', {
      scratch: {
        ...scratch,
        tool_results: [...(scratch.tool_results ?? []), ...results],
        source_taint: ctx.sourceTaint,
      },
    });
    this.#recordToolDispatchTrace(run.run_id, results);
    return next;
  }

  async #synthesiseDelivery(
    run: RuntimeRunRecord,
    ctx: HookRuntimeContext | null,
  ): Promise<RuntimeRunRecord> {
    const scratch = parseScratch(run.scratch_json);
    if (scratch.delivery_text !== undefined) return run;
    const preflight = this.#checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      this.#recordGovernorDenied(run.run_id, preflight);
      return this.#failRun(run.run_id, governorFailureReason(preflight));
    }
    const spend = await this.#readSpendBeforeProvider();
    if (!spend.ok) {
      return this.#failRun(run.run_id, 'llm_observe:spend_state_unavailable');
    }

    const invocationContext = ctx ?? (await this.#rebuildInvocationContext(run));
    const result = await this.llm.complete(
      {
        trigger: run.trigger,
        spend: spend.spend,
        renderRequest({ step, context }) {
          return {
            system: `${RUN_LOOP_OBSERVE_SYSTEM_PREFIX}:${context}:${step.provider}`,
            messages: [
              {
                role: 'user',
                content: JSON.stringify({
                  context:
                    run.context_json === null
                      ? null
                      : {
                          source: run.context_json.source,
                          trigger: run.context_json.trigger,
                          body_state: run.context_json.body_state,
                        },
                  tool_results: scratch.tool_results ?? [],
                }),
              },
            ],
            max_tokens: 256,
            temperature: 0,
          };
        },
        renderTemplate: () => this.adapters.deliveryTextFallback,
      },
      invocationContext,
    );

    if (!result.ok) {
      if (result.scribe !== undefined) {
        this.#recordTrace(run.run_id, 'scribe_denied', result.scribe);
        return this.#failRun(run.run_id, `scribe:${result.scribe.reason}`, {
          fallbackStep: result.fallback_step,
          routingLogs: result.routing_logs,
        });
      }
      return this.#failRun(run.run_id, `llm_observe:${result.reason}`, {
        fallbackStep: result.fallback_step,
        routingLogs: result.routing_logs,
      });
    }

    const usageDecision = this.journalOutbox.recordLoopUsage({
      runId: run.run_id,
      tokensUsed: result.usage.input_tokens + result.usage.output_tokens,
      iterations: 1,
      subagentSpawns: 0,
    });
    this.#recordTrace(run.run_id, 'llm_observed', {
      model: result.response.model,
      fallback_step: result.fallback_step,
      delivery_text_source: result.fallback_step === 'template' ? 'fallback' : 'llm',
      routing_logs: result.routing_logs,
    });
    if (usageDecision.verdict === 'deny') {
      this.#recordGovernorDenied(run.run_id, usageDecision);
      return this.#failRun(run.run_id, governorFailureReason(usageDecision));
    }

    const continuation = await parseObserveContinuation(result.tool_call_source.text);
    if (continuation.kind === 'malformed') {
      this.#recordTrace(run.run_id, 'tool_parse_failed', { code: continuation.code });
      return this.#failRun(run.run_id, `tool_parse:${continuation.code}`);
    }
    if (continuation.kind === 'tool_calls') {
      const {
        delivery_text: _deliveryText,
        delivery_text_source: _deliveryTextSource,
        ...continuingScratch
      } = scratch;
      const persistedCalls = continuation.calls.map((call) =>
        runtimeRunToolCallSchema.safeParse(call),
      );
      const invalidCallIndex = persistedCalls.findIndex((call) => !call.success);
      if (invalidCallIndex >= 0) {
        const invalidCall = continuation.calls[invalidCallIndex];
        const reason = checkpointCallFailure(invalidCall, invocationContext);
        this.#recordToolDispatchTrace(run.run_id, [
          { tool: invalidCall?.name ?? null, ok: false, reason },
        ]);
        return this.#failRun(run.run_id, `tool_dispatch:${reason}`);
      }
      return this.#advanceRun(run.run_id, 'LLM_CALLED', {
        scratch: {
          ...continuingScratch,
          tool_calls: continuation.calls.map((call) => runtimeRunToolCallSchema.parse(call)),
          llm: {
            model: result.response.model,
            fallback_step: result.fallback_step,
            degraded: result.degraded,
            tool_call_count: continuation.calls.length,
          },
        },
      });
    }

    return this.#updateRunScratch(run.run_id, {
      ...scratch,
      delivery_text: result.response.text,
      delivery_text_source: result.fallback_step === 'template' ? 'fallback' : 'llm',
    });
  }

  async #gate(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
    const scratch = parseScratch(run.scratch_json);
    const candidateText = scratch.delivery_text ?? this.adapters.deliveryTextFallback;
    const outboxCandidate = prepareWithScribe(
      candidateText,
      deliveryTextSchema,
      'outbox',
      scratch.source_taint,
      CANARY_TOKENS,
    );
    if (!outboxCandidate.ok) {
      return this.#failDeliveryFromScribe(run.run_id, scratch, 'outbox', outboxCandidate.reason);
    }
    const sendCandidate = prepareWithScribe(
      outboxCandidate.value,
      deliveryTextSchema,
      'send_message',
      scratch.source_taint,
      CANARY_TOKENS,
    );
    if (!sendCandidate.ok) {
      return this.#failDeliveryFromScribe(
        run.run_id,
        scratch,
        'send_message',
        sendCandidate.reason,
      );
    }
    const deliveryText = sendCandidate.value;
    if (scratch.delivery_text !== undefined && scratch.delivery_text !== deliveryText) {
      const updated = this.#updateRunScratch(run.run_id, { ...scratch, delivery_text: deliveryText });
      if (updated.state === 'FAILED') return updated;
    }
    const egressDecision = this.journalOutbox.checkLoopEgress({
      runId: run.run_id,
      text: deliveryText,
    });
    if (egressDecision.verdict === 'deny') {
      this.#recordGovernorDenied(run.run_id, egressDecision);
      return this.#failRun(run.run_id, `governor:${egressDecision.reason}`);
    }
    const gated = await this.journalOutbox.gateRun(run.run_id);
    if (gated.verdict === null) {
      throw new Error(`gate did not stamp a verdict for ${run.run_id}`);
    }
    if (gated.verdict === 'hold' || gated.verdict === 'drop') {
      this.#recordTrace(run.run_id, 'gated', {
        verdict: gated.verdict,
        reason: gated.gate_reason,
        delivery_text_source: scratch.delivery_text_source ?? 'fallback',
      });
      return this.#failRun(run.run_id, `delivery_gate:${gated.gate_reason}`);
    }
    const next = this.#advanceRun(run.run_id, 'GATED');
    this.#recordTrace(run.run_id, 'gated', {
      verdict: gated.verdict,
      outbox_kind: this.#readOutboxKind(run.run_id),
      delivery_text_source: scratch.delivery_text_source ?? 'fallback',
    });
    return next;
  }

  #openRuntimeRun(input: {
    runId: string;
    userId: string;
    variant: 'morning' | 'midday' | 'evening' | 'event' | null;
    runNonce: string;
    scheduleId: string;
    occurrenceAt: number;
    trigger?: TriggerType;
  }): void {
    const record = this.ctx.storage.transactionSync(() =>
      this.#openRuntimeRunInCurrentTransaction({
        ...input,
        trigger: input.trigger ?? TRIGGER,
        invocationFormat: null,
      }),
    );
    this.#recordTrace(record.run_id, 'scheduled_wake', {
      schedule_id: input.scheduleId,
      occurrence_at: input.occurrenceAt,
      trigger: record.trigger,
    });
  }

  #openRuntimeRunInCurrentTransaction(input: {
    runId: string;
    userId: string;
    trigger: TriggerType;
    variant: 'morning' | 'midday' | 'evening' | 'event' | null;
    runNonce: string;
    occurrenceAt: number;
    invocationFormat: 'invocation_contract_v2' | null;
    trustedSnapshotBinding?: string;
  }): RuntimeRunRecord {
    const at = this.deps.now();
    const record = runtimeRunRecordSchema.parse({
      run_id: input.runId,
      user_id: input.userId,
      trigger: input.trigger,
      variant: input.variant,
      state: 'PENDING',
      step: 0,
      attempts: 0,
      run_nonce: input.runNonce,
      context_json: null,
      scratch_json: null,
      created_at: at,
      updated_at: at,
      next_expected_wake: input.occurrenceAt,
      failure_reason: null,
    });

    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_runs
         (run_id, user_id, trigger, variant, state, step, attempts, run_nonce,
          context_json, scratch_json, created_at, updated_at, next_expected_wake, failure_reason,
          invocation_format, trusted_snapshot_binding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)`,
      record.run_id,
      record.user_id,
      record.trigger,
      record.variant,
      record.state,
      record.step,
      record.attempts,
      record.run_nonce,
      record.created_at,
      record.updated_at,
      record.next_expected_wake,
      input.invocationFormat,
      input.trustedSnapshotBinding ?? null,
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, 0, ?, ?)',
      record.run_id,
      record.state,
      record.created_at,
    );
    markRuntimeRunScribeAudited(this.ctx.storage.sql, record.run_id);
    return record;
  }

  #advanceTrustedRun(
    runId: string,
    to: RuntimeRunState,
    state: TrustedRunV2State,
    options: {
      completeNonProactive?: boolean;
      trace?: Readonly<{
        event: string;
        detail: Record<string, unknown>;
        sourceTaint?: SourceTaint;
      }>;
    } = {},
  ): RuntimeRunRecord {
    const checked = parseTrustedRunV2State(state);
    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      next = this.#advanceTrustedRunInCurrentTransaction(runId, to, checked, options);
    });
    if (next === null) throw new Error(`advanceTrustedRun failed for ${runId}`);
    return next;
  }

  // Provider receipt settlement uses this narrow form to combine its Governor usage, V2 sidecar
  // receipt, and exactly one runtime FSM transition in the existing SQLite transaction. It is a
  // transactional helper, not an alternate loop or writer.
  #advanceTrustedRunInCurrentTransaction(
    runId: string,
    to: RuntimeRunState,
    checked: TrustedRunV2State,
    options: {
      completeNonProactive?: boolean;
      trace?: Readonly<{
        event: string;
        detail: Record<string, unknown>;
        sourceTaint?: SourceTaint;
      }>;
    } = {},
  ): RuntimeRunRecord {
    const run = this.#requireRuntimeRun(runId);
    if (this.#readRuntimeInvocationFormat(runId) !== 'invocation_contract_v2') {
      throw new Error(`trusted V2 runtime marker missing for ${runId}`);
    }
    const disposition = checked.record.invocation.output.disposition;
    const directNonProactiveDone =
      to === 'DONE' &&
      options.completeNonProactive === true &&
      disposition === 'internal_no_output' &&
      run.state === 'TOOLS_DONE';
    if (!runtimeRunCanAdvance(run.state, to) && !directNonProactiveDone) {
      throw new Error(`illegal trusted runtime transition ${run.state} -> ${to}`);
    }
    if (to === 'DONE') {
      if (options.completeNonProactive) {
        if (!directNonProactiveDone) {
          throw new Error('only internal_no_output V2 runs may complete from TOOLS_DONE');
        }
      } else if (disposition !== 'proactive_delivery' || run.state !== 'DELIVERED') {
        throw new Error('only delivered proactive V2 runs may advance to DONE directly');
      }
    }
    const step = run.step + 1;
    const at = this.deps.now();
    this.ctx.storage.sql.exec(
      `UPDATE runtime_runs
          SET state = ?, step = ?, context_json = NULL, scratch_json = NULL,
              updated_at = ?, next_expected_wake = NULL, failure_reason = NULL
        WHERE run_id = ?`,
      to,
      step,
      at,
      runId,
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, ?, ?, ?)',
      runId,
      step,
      to,
      at,
    );
    this.#writeTrustedV2StateInCurrentTransaction(runId, checked, at);
    if (options.completeNonProactive) {
      this.journalOutbox.completeTrustedInvocationWithoutProactiveDeliveryInCurrentTransaction(
        runId,
        checked.record.invocation,
      );
    }
    if (options.trace !== undefined) {
      this.#recordTraceInCurrentTransaction(
        runId,
        options.trace.event,
        options.trace.detail,
        options.trace.sourceTaint ?? this.#trustedEffectiveSourceTaint(checked),
      );
    }
    return this.#requireRuntimeRun(runId);
  }

  #failTrustedRun(
    runId: string,
    reason: string,
    options: {
      scrubSidecar?: boolean;
      allowPostAckIntegrityFailure?: boolean;
      precedingTrace?: Readonly<{ event: string; detail: Record<string, unknown> }>;
    } = {},
  ): RuntimeRunRecord {
    const failureReason = runtimeRunFailureReasonSchema.parse(reason);
    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      next = this.#failTrustedRunInCurrentTransaction(runId, failureReason, options);
    });
    if (next === null) throw new Error(`failTrustedRun failed for ${runId}`);
    return next as RuntimeRunRecord;
  }

  #failTrustedRunInCurrentTransaction(
    runId: string,
    failureReason: RuntimeRunFailureReason,
    options: {
      scrubSidecar?: boolean;
      allowPostAckIntegrityFailure?: boolean;
      precedingTrace?: Readonly<{ event: string; detail: Record<string, unknown> }>;
    } = {},
  ): RuntimeRunRecord {
    const run = this.#requireRuntimeRun(runId);
    if (options.scrubSidecar) this.#scrubTrustedV2SidecarInCurrentTransaction(runId);
    if (run.state === 'FAILED' || (run.state === 'DONE' && !options.scrubSidecar)) return run;
    // The generic FSM intentionally keeps DELIVERED/DONE terminal. A malformed V2 sidecar is
    // the narrow exception: preserve irreversible journal/outbox evidence, but record that the
    // runtime's own trusted witness was invalid rather than silently retaining a clean DONE.
    const terminalIntegrityFailure =
      (run.state === 'DELIVERED' &&
        (options.scrubSidecar || options.allowPostAckIntegrityFailure === true)) ||
      (run.state === 'DONE' && options.scrubSidecar);
    if (!runtimeRunCanAdvance(run.state, 'FAILED') && !terminalIntegrityFailure) {
      throw new Error(`illegal trusted runtime transition ${run.state} -> FAILED`);
    }
    const step = run.step + 1;
    const at = this.deps.now();
    this.ctx.storage.sql.exec(
      `UPDATE runtime_runs
          SET state = 'FAILED', step = ?, updated_at = ?, next_expected_wake = NULL,
              failure_reason = ?, context_json = NULL, scratch_json = NULL
        WHERE run_id = ?`,
      step,
      at,
      failureReason,
      runId,
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, ?, ?, ?)',
      runId,
      step,
      'FAILED',
      at,
    );
    this.journalOutbox.failTrustedRunInCurrentTransaction(runId);
    if (options.precedingTrace !== undefined) {
      this.#recordTraceInCurrentTransaction(
        runId,
        options.precedingTrace.event,
        options.precedingTrace.detail,
        null,
      );
    }
    this.#recordTraceInCurrentTransaction(runId, 'failed', { reason: failureReason }, null);
    return this.#requireRuntimeRun(runId);
  }

  #scrubTrustedV2SidecarInCurrentTransaction(runId: string): void {
    const row = this.ctx.storage.sql
      .exec<{ rowid: number }>('SELECT rowid FROM runtime_invocation_v2 WHERE run_id = ?', runId)
      .toArray()[0];
    if (row !== undefined) scrubTrustedV2SqlRow(this.ctx.storage.sql, runId, row.rowid);
  }

  #insertTrustedV2StateInCurrentTransaction(
    runId: string,
    state: TrustedRunV2State,
    at: number,
  ): void {
    const checked = parseTrustedRunV2State(state);
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_invocation_v2
         (run_id, canonical_identity_hash, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      checked.canonical_identity_hash,
      JSON.stringify(checked),
      at,
      at,
    );
    markTrustedV2ScribeAudited(this.ctx.storage.sql, runId);
  }

  #writeTrustedV2StateInCurrentTransaction(
    runId: string,
    state: TrustedRunV2State,
    at: number,
  ): void {
    const checked = parseTrustedRunV2State(state);
    this.ctx.storage.sql.exec(
      `UPDATE runtime_invocation_v2
          SET canonical_identity_hash = ?, state_json = ?, updated_at = ?
        WHERE run_id = ?`,
      checked.canonical_identity_hash,
      JSON.stringify(checked),
      at,
      runId,
    );
    if (this.#readTrustedV2SqlRow(runId) === null) {
      throw new Error(`trusted V2 state missing for ${runId}`);
    }
    markTrustedV2ScribeAudited(this.ctx.storage.sql, runId);
  }

  #persistTrustedV2State(
    runId: string,
    state: TrustedRunV2State,
    trace?: Readonly<{
      event: string;
      detail: Record<string, unknown>;
      sourceTaint?: SourceTaint;
    }>,
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.#writeTrustedV2StateInCurrentTransaction(runId, state, this.deps.now());
      if (trace !== undefined) {
        this.#recordTraceInCurrentTransaction(
          runId,
          trace.event,
          trace.detail,
          trace.sourceTaint ?? this.#trustedEffectiveSourceTaint(state),
        );
      }
    });
  }

  #advanceRun(
    runId: string,
    to: RuntimeRunState,
    updates: { context?: RuntimeRunContext; scratch?: ScratchState } = {},
  ): RuntimeRunRecord {
    let context = updates.context;
    if (context !== undefined) {
      const prepared = prepareWithScribe(
        context,
        runtimeRunContextSchema,
        'internal_context',
        context.source_taint,
        CANARY_TOKENS,
      );
      if (!prepared.ok) return this.#failFromScribe(runId, 'internal_context', prepared.reason);
      context = prepared.value;
    }
    let scratch = updates.scratch;
    if (scratch !== undefined) {
      const prepared = prepareWithScribe(
        scratch,
        runtimeRunScratchSchema,
        'internal_context',
        scratch.source_taint,
        CANARY_TOKENS,
      );
      if (!prepared.ok) return this.#failFromScribe(runId, 'internal_context', prepared.reason);
      scratch = prepared.value;
    }

    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.#requireRuntimeRun(runId);
      // Keep the security boundary explicit even though the generic FSM currently also rejects
      // this edge. V2 owns its narrowly-authorized non-proactive completion separately above.
      if (to === 'DONE' && run.state !== 'DELIVERED') {
        throw new Error('legacy runtime runs cannot bypass the proactive delivery path');
      }
      if (!runtimeRunCanAdvance(run.state, to)) {
        throw new Error(`illegal runtime transition ${run.state} -> ${to}`);
      }
      const step = run.step + 1;
      const at = this.deps.now();
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs
            SET state = ?,
                step = ?,
                context_json = ?,
                scratch_json = ?,
                updated_at = ?,
                next_expected_wake = NULL,
                failure_reason = NULL
          WHERE run_id = ?`,
        to,
        step,
        jsonOrNull(context ?? run.context_json),
        jsonOrNull(scratch ?? run.scratch_json),
        at,
        runId,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, ?, ?, ?)',
        runId,
        step,
        to,
        at,
      );
      next = this.#requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`advanceRun failed for ${runId}`);
    return next;
  }

  #updateRunScratch(runId: string, scratch: ScratchState): RuntimeRunRecord {
    const prepared = prepareWithScribe(
      scratch,
      runtimeRunScratchSchema,
      'internal_context',
      scratch.source_taint,
      CANARY_TOKENS,
    );
    if (!prepared.ok) return this.#failFromScribe(runId, 'internal_context', prepared.reason);

    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.#requireRuntimeRun(runId);
      const at = this.deps.now();
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs
            SET scratch_json = ?,
                updated_at = ?
          WHERE run_id = ?`,
        jsonOrNull(prepared.value),
        at,
        runId,
      );
      next = this.#requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`updateRunScratch failed for ${runId}`);
    return next;
  }

  #failRun(
    runId: string,
    reason: string,
    llmFailure?: LlmFailureTrace,
  ): RuntimeRunRecord {
    const failureReason = runtimeRunFailureReasonSchema.parse(reason);
    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.#requireRuntimeRun(runId);
      if (!runtimeRunCanAdvance(run.state, 'FAILED')) {
        throw new Error(`illegal runtime transition ${run.state} -> FAILED`);
      }
      const step = run.step + 1;
      const at = this.deps.now();
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs
            SET state = 'FAILED',
                step = ?,
                updated_at = ?,
                failure_reason = ?
          WHERE run_id = ?`,
        step,
        at,
        failureReason,
        runId,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, ?, ?, ?)',
        runId,
        step,
        'FAILED',
        at,
      );
      next = this.#requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`failRun failed for ${runId}`);
    if (llmFailure !== undefined && llmFailure.routingLogs.length > 0) {
      this.#recordTrace(runId, 'failed', {
        reason: failureReason,
        fallback_step: llmFailure.fallbackStep,
        routing_logs: [...llmFailure.routingLogs],
      });
    }
    return next;
  }

  #failFromScribe(
    runId: string,
    destination: SanitiseDestination,
    reason: SanitiseFailureReason,
  ): RuntimeRunRecord {
    this.#recordTrace(runId, 'scribe_denied', { destination, reason });
    return this.#failRun(runId, `scribe:${reason}`);
  }

  #failDeliveryFromScribe(
    runId: string,
    scratch: ScratchState,
    destination: Extract<SanitiseDestination, 'outbox' | 'send_message'>,
    reason: SanitiseFailureReason,
  ): RuntimeRunRecord {
    const {
      delivery_text: _deliveryText,
      delivery_text_source: _deliveryTextSource,
      ...safeScratch
    } = scratch;
    const scrubbed = this.#updateRunScratch(runId, safeScratch);
    if (scrubbed.state === 'FAILED') return scrubbed;
    return this.#failFromScribe(runId, destination, reason);
  }

  #admitGovernor(runId: string): GovernorDecision {
    const legacy = this.journalOutbox.resumeRun(runId);
    if (legacy === null) throw new Error(`admitGovernor: no journal row for ${runId}`);
    if (legacy.state === 'GOVERNOR_ADMITTED') {
      const decision = this.journalOutbox.readGovernorDecision(runId);
      if (decision === null) {
        throw new Error(`admitGovernor: admitted run has no governor decision for ${runId}`);
      }
      return decision;
    }
    const decision = this.journalOutbox.admitRun(runId);
    return decision;
  }

  #readRuntimeRun(runId: string): RuntimeRunRecord | null {
    return this.#readRuntimeRunWithTrustedBinding(runId)?.run ?? null;
  }

  #readRuntimeRunWithTrustedBinding(runId: string): Readonly<{
    run: RuntimeRunRecord;
    invocationFormat: string | null;
    trustedSnapshotBinding: string | null;
  }> | null {
    const row = this.ctx.storage.sql
      .exec<RuntimeRunSqlRow>('SELECT * FROM runtime_runs WHERE run_id = ?', runId)
      .toArray()[0];
    if (row === undefined) return null;
    return {
      run: toRuntimeRunRecord(row),
      invocationFormat: row.invocation_format,
      trustedSnapshotBinding: row.trusted_snapshot_binding,
    };
  }

  #readRuntimeInvocationFormat(runId: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ invocation_format: string | null }>(
        'SELECT invocation_format FROM runtime_runs WHERE run_id = ?',
        runId,
      )
      .toArray()[0];
    return row?.invocation_format ?? null;
  }

  async #trustedSnapshotBinding(snapshot: Readonly<{
    snapshot_ref: string;
    snapshot_at: number;
  }>): Promise<string> {
    return this.deps.sha256Hex(
      stableJsonStringify({
        snapshot_ref: snapshot.snapshot_ref,
        snapshot_at: snapshot.snapshot_at,
      }),
    );
  }

  #findTrustedRunByCanonicalIdentity(canonicalIdentityHash: string): string | null {
    const sidecar = this.ctx.storage.sql
      .exec<{ run_id: string }>(
        'SELECT run_id FROM runtime_invocation_v2 WHERE canonical_identity_hash = ?',
        canonicalIdentityHash,
      )
      .toArray()[0];
    if (sidecar !== undefined) return sidecar.run_id;
    // Scrubbing hostile sidecar bytes intentionally destroys the sidecar hash. The immutable
    // V2 marker plus run nonce still retain only the canonical identity witness, so duplicate
    // admission must resolve that failed run rather than collide on the unique runtime identity.
    const runtime = this.ctx.storage
      .sql.exec<{ run_id: string }>(
        `SELECT run_id
           FROM runtime_runs
          WHERE invocation_format = 'invocation_contract_v2' AND run_nonce = ?`,
        canonicalIdentityHash,
      )
      .toArray()[0];
    return runtime?.run_id ?? null;
  }

  #readTrustedV2SqlRow(runId: string): TrustedRunV2SqlRow | null {
    const row = this.ctx.storage.sql
      .exec<TrustedRunV2SqlRow>(
        `SELECT run_id, canonical_identity_hash, state_json
           FROM runtime_invocation_v2
          WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    return row ?? null;
  }

  async #requireTrustedV2State(runId: string): Promise<TrustedRunV2State> {
    const row = this.#readTrustedV2SqlRow(runId);
    const runtime = this.#readRuntimeRunWithTrustedBinding(runId);
    if (runtime === null) throw new Error(`runtime run not found: ${runId}`);
    const { run, trustedSnapshotBinding: runtimeSnapshotBinding } = runtime;
    if (row === null) throw new TrustedV2IntegrityError(`trusted V2 state missing for ${runId}`);
    let raw: unknown;
    try {
      raw = JSON.parse(row.state_json) as unknown;
    } catch {
      throw new TrustedV2IntegrityError(`trusted V2 state is not JSON for ${runId}`);
    }
    let state: TrustedRunV2State;
    try {
      state = parseTrustedRunV2State(raw);
    } catch {
      throw new TrustedV2IntegrityError(`trusted V2 state failed its contract schema for ${runId}`);
    }
    const expectedCanonicalIdentityHash = await this.deps.sha256Hex(
      canonicalInvocationIdempotencySerialization(state.record.invocation),
    );
    const expectedOwnerScope = await this.#trustedOperationalOwnerScope(state.record.invocation);
    const expectedSnapshotBinding = await this.#trustedSnapshotBinding(state.snapshot);
    if (
      state.canonical_identity_hash !== row.canonical_identity_hash ||
      state.canonical_identity_hash !== expectedCanonicalIdentityHash ||
      run.run_nonce !== state.canonical_identity_hash ||
      run.user_id !== state.record.invocation.verified_authority.principal_ref ||
      run.trigger !== state.record.invocation.runtime_binding.trigger ||
      run.variant !== state.record.invocation.runtime_binding.variant ||
      run.context_json !== null ||
      run.scratch_json !== null ||
      this.#readRuntimeInvocationFormat(runId) !== 'invocation_contract_v2' ||
      runtimeSnapshotBinding !== expectedSnapshotBinding
    ) {
      throw new TrustedV2IntegrityError(`trusted V2 runtime binding mismatch for ${runId}`);
    }
    try {
      assertTrustedStateMatchesRuntimeState(run.state, state);
    } catch {
      throw new TrustedV2IntegrityError(`trusted V2 state/runtime mismatch for ${runId}`);
    }
    try {
      this.journalOutbox.validateTrustedRun(runId, expectedOwnerScope);
    } catch (error) {
      if (error instanceof TrustedRunOwnerScopeMismatchError) {
        throw new TrustedV2IntegrityError(`trusted V2 owner scope mismatch for ${runId}`);
      }
      throw error;
    }
    // Every durable effect key is runtime-derived. Validate settled and pending witnesses on
    // every read, rather than waiting for a replayable prompt path: terminal/rejected receipts
    // are still audit evidence and must not expose a schema-valid but key-mismatched sidecar.
    const effectWitnesses: TrustedRunV2PendingEffect[] = [
      ...(state.plan === null ? [] : [state.plan.effect]),
      ...(state.synthesis === null ? [] : [state.synthesis.effect]),
      ...state.tool_effect_witnesses,
      ...(state.pending_effect === null ? [] : [state.pending_effect]),
    ];
    for (const effect of effectWitnesses) {
      if (!(await this.#trustedEffectIdentityMatches(runId, state, effect))) {
        throw new TrustedV2IntegrityError(`trusted V2 effect identity mismatch for ${runId}`);
      }
    }
    const governor = this.ctx.storage.sql
      .exec<{ tokens_used: number; iterations: number }>(
        `SELECT tokens_used, iterations
           FROM loop_governor_runs
          WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    if (
      governor === undefined ||
      !Number.isSafeInteger(governor.tokens_used) ||
      !Number.isSafeInteger(governor.iterations) ||
      governor.tokens_used < 0 ||
      governor.iterations < 0 ||
      governor.tokens_used !== state.evidence.total_tokens ||
      governor.iterations !== state.evidence.provider_calls
    ) {
      throw new TrustedV2IntegrityError(`trusted V2 Governor receipt mismatch for ${runId}`);
    }
    const providerTraceCount = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM runtime_trace
          WHERE run_id = ?
            AND event IN ('llm_called', 'llm_observed', 'provider_effect_rejected')`,
        runId,
      )
      .toArray()[0]?.count;
    if (
      !Number.isSafeInteger(providerTraceCount) ||
      providerTraceCount !== state.evidence.provider_calls
    ) {
      throw new TrustedV2IntegrityError(`trusted V2 provider trace mismatch for ${runId}`);
    }
    if (!this.#trustedSettledToolCheckpointsMatchObservations(runId, state)) {
      throw new TrustedV2IntegrityError(`trusted V2 tool receipt mismatch for ${runId}`);
    }
    return state;
  }

  #findRuntimeRunByIdentity(userId: string, runNonce: string): string | null {
    const row = this.ctx.storage.sql
      .exec<RuntimeRunIdentitySqlRow>(
        'SELECT run_id FROM runtime_runs WHERE user_id = ? AND run_nonce = ?',
        userId,
        runNonce,
      )
      .toArray()[0];
    return row?.run_id ?? null;
  }

  #readOutboxKind(runId: string): string {
    const row = this.ctx.storage.sql
      .exec<{ kind: string }>('SELECT kind FROM outbox WHERE run_id = ? ORDER BY kind LIMIT 1', runId)
      .toArray()[0];
    if (row === undefined) throw new Error(`readOutboxKind: no outbox row for ${runId}`);
    return row.kind;
  }

  async #scheduledRunNonce(input: {
    userId: string;
    variant: 'morning' | 'midday' | 'evening' | 'event' | null;
    scheduleId: string;
    occurrenceAt: number;
  }): Promise<string> {
    return this.deps.sha256Hex(
      canonicalRuntimeRunIdempotencySerialization({
        kind: 'scheduled_occurrence',
        user_id: input.userId,
        trigger: TRIGGER,
        variant: input.variant,
        schedule_id: input.scheduleId,
        occurrence_at: input.occurrenceAt,
      }),
    );
  }

  async #trustedOperationalOwnerScope(
    invocation: TrustedInvocationEnvelope,
  ): Promise<string> {
    const digest = await this.deps.sha256Hex(
      canonicalTrustedOperationalScopeSerialization(invocation.verified_authority),
    );
    return runtimeOperationalRefSchema.parse(`own_${digest.slice(0, 32)}`);
  }

  #buildRunEvidence(runId: string): RuntimeReplayFixture {
    const runtime = this.#readRuntimeRunWithTrustedBinding(runId);
    if (runtime === null) throw new Error(`buildRunEvidence: no run ${runId}`);
    const run = runtime.run;
    const traceRows = this.ctx.storage.sql
      .exec<RuntimeTraceSqlRow>(
        'SELECT seq, event_key, event, detail_json, created_at FROM runtime_trace WHERE run_id = ? ORDER BY seq',
        runId,
      )
      .toArray();
    const fsm = this.ctx.storage.sql
      .exec<{ state: RuntimeRunState }>(
        'SELECT state FROM runtime_journal WHERE run_id = ? ORDER BY step',
        runId,
      )
      .toArray()
      .map((row) => row.state);
    const outbox = this.ctx.storage.sql
      .exec<{ kind: string; status: string; attempts: number }>(
        'SELECT kind, status, attempts FROM outbox WHERE run_id = ? ORDER BY kind',
        runId,
      )
      .toArray()
      .map((row) => ({
        kind: pushClassSchema.parse(row.kind),
        status: outboxStatusSchema.parse(row.status),
        attempts: row.attempts,
      }));
    // Parse the full durable journal row rather than projecting just the fields consumed by the
    // evaluator. In particular, an internal-no-output completion without its explicit mode must
    // fail closed instead of being scored as an ordinary no-effect terminal run.
    const deliveryJournal = journalRowSchema.parse(
      this.ctx.storage.sql.exec('SELECT * FROM journal WHERE run_id = ?', runId).one(),
    );
    return buildRuntimeReplayFixture({
      runId,
      // Historical rows retain their V1 reader semantics. A V2 marker is immutable runtime
      // authority, so damaged/missing trace evidence cannot silently downgrade this fixture.
      evidenceFlavor:
        runtime.invocationFormat === 'invocation_contract_v2' ? 'trusted_v2' : 'historical_v1',
      traceRows,
      fsm,
      outbox,
      deliveryJournal: {
        state: runStateSchema.parse(deliveryJournal.state),
        verdict: deliveryVerdictSchema.nullable().parse(deliveryJournal.verdict),
        completion_mode: deliveryJournal.completion_mode,
      },
      current: { state: run.state, failure_reason: run.failure_reason },
    });
  }

  #requireRuntimeRun(runId: string): RuntimeRunRecord {
    const run = this.#readRuntimeRun(runId);
    if (run === null) throw new Error(`runtime run not found: ${runId}`);
    return run;
  }

  #recordTrace(runId: string, event: string, detail: Record<string, unknown>): void {
    const sourceTaint = parseScratch(this.#requireRuntimeRun(runId).scratch_json).source_taint;
    this.#recordTraceInCurrentTransaction(runId, event, detail, sourceTaint);
  }

  // Callers that commit a V2 state transition use this inside their existing SQLite transaction.
  // This keeps the durable FSM and its public trace evidence indivisible across eviction/restart.
  #recordTraceInCurrentTransaction(
    runId: string,
    event: string,
    detail: Record<string, unknown>,
    sourceTaint: SourceTaint,
  ): void {
    let storedEvent = event;
    let storedDetail: Record<string, unknown>;
    try {
      const strictDetail = normaliseRuntimeTraceDetail(event, detail);
      const prepared = prepareWithScribe(
        strictDetail,
        runtimeTraceDetailSchema,
        'audit_log',
        sourceTaint,
        CANARY_TOKENS,
      );
      if (!prepared.ok) {
        storedEvent = 'scribe_denied';
        storedDetail = { destination: 'audit_log', reason: prepared.reason };
      } else {
        storedDetail = normaliseRuntimeTraceDetail(
          event,
          prepared.value as Record<string, unknown>,
        ) as Record<string, unknown>;
      }
    } catch {
      storedEvent = 'scribe_denied';
      storedDetail = { destination: 'audit_log', reason: 'invalid_payload' };
    }
    const nextSeq = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM runtime_trace WHERE run_id = ?',
        runId,
      )
      .one().seq;
    const eventKey = runtimeTraceEventKey({ runId, event: storedEvent, seq: nextSeq });
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO runtime_trace (run_id, seq, event_key, event, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      runId,
      nextSeq,
      eventKey,
      storedEvent,
      JSON.stringify(storedDetail),
      this.deps.now(),
    );
  }

  #hasRuntimeTraceEvent(runId: string, event: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          'SELECT COUNT(*) AS n FROM runtime_trace WHERE run_id = ? AND event = ?',
          runId,
          event,
        )
        .one().n > 0
    );
  }

  #crashAfter(state: RuntimeRunState): void {
    if (this.__runLoopCrashAfter === state) {
      throw new Error(`crash-injection:${state}`);
    }
  }

  #crashAfterTrustedAdmission(): void {
    if (this.__runLoopCrashAfterTrustedAdmission === true) {
      throw new Error('crash-injection:TRUSTED_ADMISSION');
    }
  }

  #crashAfterTrustedGateCommit(): void {
    if (this.__runLoopCrashAfterTrustedGateCommit === true) {
      throw new Error('crash-injection:TRUSTED_GATE_COMMIT');
    }
  }

  #crashAfterTrustedGateTerminal(): void {
    if (this.__runLoopCrashAfterTrustedGateTerminal === true) {
      throw new Error('crash-injection:TRUSTED_GATE_TERMINAL');
    }
  }

  #crashAfterTrustedToolCheckpoint(): void {
    if (this.__runLoopCrashAfterTrustedToolCheckpoint === true) {
      throw new Error('crash-injection:TRUSTED_TOOL_CHECKPOINT');
    }
  }

  #crashAfterTrustedProviderEffect(
    phase: 'provider_plan' | 'provider_observe',
  ): void {
    if (this.__runLoopCrashAfterTrustedProviderEffect === phase) {
      throw new Error(`crash-injection:TRUSTED_${phase.toUpperCase()}_EFFECT`);
    }
  }

  #crashAfterTrustedToolEffect(): void {
    if (this.__runLoopCrashAfterTrustedToolEffect === true) {
      throw new Error('crash-injection:TRUSTED_TOOL_EFFECT');
    }
  }

  #crashAfterTrustedSynthesisReceipt(): void {
    if (this.__runLoopCrashAfterTrustedSynthesisReceipt === true) {
      throw new Error('crash-injection:TRUSTED_SYNTHESIS_RECEIPT');
    }
  }

  #crashAfterTrustedGovernorDeny(): void {
    if (this.__runLoopCrashAfterTrustedGovernorDeny === true) {
      throw new Error('crash-injection:TRUSTED_GOVERNOR_DENY');
    }
  }

  #failTrustedGovernorDenied(
    runId: string,
    decision: Extract<GovernorDecision, { verdict: 'deny' }>,
  ): RuntimeRunRecord {
    return this.#failTrustedRun(runId, governorFailureReason(decision), {
      precedingTrace: this.#hasRuntimeTraceEvent(runId, 'governor_denied')
        ? undefined
        : {
            event: 'governor_denied',
            detail: { reason: decision.reason, disposition: decision.disposition },
          },
    });
  }

  #recordGovernorDenied(runId: string, decision: GovernorDecision): void {
    this.#recordTrace(runId, 'governor_denied', {
      reason: decision.reason,
      disposition: decision.disposition,
    });
  }

  #checkGovernorBeforeLlm(runId: string): GovernorDecision {
    return this.journalOutbox.checkLoopUsageBudget({
      runId,
      tokensUsed: 0,
      iterations: 1,
      subagentSpawns: 0,
    });
  }

  #checkGovernorBeforeToolEffect(runId: string): GovernorDecision {
    return this.journalOutbox.checkLoopUsageBudget({
      runId,
      tokensUsed: 0,
      iterations: 0,
      subagentSpawns: 0,
    });
  }

  async #readSpendBeforeProvider(): Promise<ProviderSpendPreflight> {
    if (this.adapters.providerMode !== 'gateway') {
      const configuredSpend = this.adapters.spend;
      if (configuredSpend === undefined) return { ok: true, spend: undefined };
      const spend = normaliseRouteSpendState(configuredSpend);
      return spend === null ? { ok: false } : { ok: true, spend };
    }
    try {
      const result = await this.adapters.spendReader?.read();
      if (ownDataProperty(result, 'ok') !== true) return { ok: false };
      const spend = normaliseRouteSpendState(ownDataProperty(result, 'data'));
      return spend === null ? { ok: false } : { ok: true, spend };
    } catch {
      return { ok: false };
    }
  }

  #recordToolDispatchTrace(
    runId: string,
    results: { tool: ToolName | null; ok: boolean; reason?: string }[],
  ): void {
    this.#recordTrace(runId, 'tool_dispatched', this.#toolDispatchTraceDetail(results));
  }

  #toolDispatchTraceDetail(
    results: readonly { tool: ToolName | null; ok: boolean; reason?: string }[],
  ): Record<string, unknown> {
    const denied = results.filter((result) => !result.ok);
    const detail: Record<string, unknown> = {
      tools: results.filter((result) => result.ok).map((result) => result.tool),
      denied: denied.map((result) => result.tool),
    };
    if (denied.length > 0) {
      detail.reasons = denied.map((result) => result.reason);
    }
    return detail;
  }
}

const MISSING_OWN_DATA_PROPERTY = Symbol('missing-own-data-property');

function ownDataProperty(value: unknown, key: string): unknown | typeof MISSING_OWN_DATA_PROPERTY {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return MISSING_OWN_DATA_PROPERTY;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined || !('value' in descriptor)
    ? MISSING_OWN_DATA_PROPERTY
    : descriptor.value;
}

// A completed checkpoint can only replay the redacted success observation that was hashed before
// its Governor observation committed. Hash equality alone is not a type witness: a hostile source
// must not relabel a failed tool payload as completed and feed it into synthesis.
function isTrustedCompletedToolObservation(
  value: unknown,
  checkpoint: Extract<RuntimeToolCheckpoint, { status: 'completed' }>,
): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ['card', 'data', 'ok', 'source_taint', 'tool'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  return (
      ownDataProperty(value, 'ok') === true &&
      ownDataProperty(value, 'tool') === checkpoint.tool &&
      ownDataProperty(value, 'data') !== MISSING_OWN_DATA_PROPERTY &&
      ownDataProperty(value, 'card') !== MISSING_OWN_DATA_PROPERTY &&
      (ownDataProperty(value, 'source_taint') === null ||
        ownDataProperty(value, 'source_taint') === 'external')
  );
}

// ContextComposer is an adapter boundary. Keep only the facts this durable runtime owns and
// validate even its typed failure path: a hostile adapter must never turn a raw error string into
// a persisted failure reason or escape the fail-closed branch.
function normaliseTrustedCompositionResult(value: unknown): TrustedCompositionResult {
  const fail = (code: RuntimeContextFailureReason = 'assembly_failed'): TrustedCompositionResult =>
    Object.freeze({ ok: false as const, failure: Object.freeze({ code }) });
  const ok = ownDataProperty(value, 'ok');
  if (ok === false) {
    const failure = ownDataProperty(value, 'failure');
    const code = ownDataProperty(failure, 'code');
    const parsed = runtimeContextFailureReasonSchema.safeParse(code);
    return parsed.success ? fail(parsed.data) : fail();
  }
  if (ok !== true) return fail();

  const prompt = ownDataProperty(value, 'prompt');
  if (
    typeof prompt !== 'string' ||
    prompt.length === 0 ||
    prompt.length > 32_768 ||
    utf8ByteLengthWithinLimit(prompt, 32_768) === null
  ) {
    return fail();
  }
  const checkpointSnapshot = snapshotReplayArtifact(ownDataProperty(value, 'checkpoint'));
  if (!checkpointSnapshot.ok) return fail();
  const checkpoint = runtimeContextCheckpointSchema.safeParse(checkpointSnapshot.value);
  if (!checkpoint.success) return fail();

  const evidence = ownDataProperty(value, 'evidence');
  const promptDigest = ownDataProperty(evidence, 'prompt_digest');
  const recall = ownDataProperty(evidence, 'recall');
  const recallStatus = ownDataProperty(recall, 'status');
  if (
    typeof promptDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(promptDigest) ||
    (recallStatus !== 'partial' && recallStatus !== 'failed' && recallStatus !== 'skipped')
  ) {
    return fail();
  }
  return Object.freeze({
    ok: true as const,
    prompt,
    checkpoint: checkpoint.data,
    evidence: Object.freeze({
      prompt_digest: promptDigest,
      recall: Object.freeze({ status: recallStatus }),
    }),
  });
}

function normaliseRouteSpendState(value: unknown): RouteSpendState | null {
  try {
    const spent = ownDataProperty(value, 'spent_cents_today');
    const cap = ownDataProperty(value, 'cap_cents');
    if (spent === MISSING_OWN_DATA_PROPERTY || cap === MISSING_OWN_DATA_PROPERTY) return null;
    if (
      typeof spent !== 'number' ||
      !Number.isSafeInteger(spent) ||
      spent < 0 ||
      (cap !== null &&
        (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0))
    ) {
      return null;
    }
    return Object.freeze({ spent_cents_today: spent, cap_cents: cap });
  } catch {
    return null;
  }
}

function ensureRunLoopSchema(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_runs (
      run_id             TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      trigger            TEXT NOT NULL,
      variant            TEXT,
      state              TEXT NOT NULL,
      step               INTEGER NOT NULL,
      attempts           INTEGER NOT NULL DEFAULT 0,
      run_nonce          TEXT NOT NULL,
      context_json       TEXT,
      scratch_json       TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      next_expected_wake INTEGER,
      failure_reason     TEXT,
      invocation_format  TEXT,
      trusted_snapshot_binding TEXT
    );
  `);
  ensureRuntimeInvocationFormat(sql);
  ensureRuntimeTrustedSnapshotBinding(sql);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_identity ON runtime_runs(user_id, run_nonce)');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_invocation_v2 (
      run_id                  TEXT PRIMARY KEY,
      canonical_identity_hash TEXT NOT NULL UNIQUE,
      state_json              TEXT NOT NULL,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_invocation_v2_scribe_audit (
      run_id  TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_journal (
      run_id     TEXT NOT NULL,
      step       INTEGER NOT NULL,
      state      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, step)
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_trace (
      run_id      TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      event_key   TEXT,
      event       TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS local_ingress_rate (
      bucket     INTEGER PRIMARY KEY,
      count      INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS responsibility_ingress_rate (
      rate_key   TEXT NOT NULL,
      bucket     INTEGER NOT NULL,
      count      INTEGER NOT NULL CHECK (count > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (rate_key, bucket)
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_run_scribe_audit (
      run_id  TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  ensureRuntimeTraceEventKey(sql);
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_trace_event_key_idx
      ON runtime_trace (run_id, event_key)
      WHERE event_key IS NOT NULL;
  `);
  storage.transactionSync(() => {
    migrateLegacyRuntimeRows(sql);
    auditTrustedV2Rows(sql);
  });
}

function ensureRuntimeInvocationFormat(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(runtime_runs)').toArray();
  if (!columns.some((column) => column.name === 'invocation_format')) {
    sql.exec('ALTER TABLE runtime_runs ADD COLUMN invocation_format TEXT');
  }
}

function ensureRuntimeTrustedSnapshotBinding(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(runtime_runs)').toArray();
  if (!columns.some((column) => column.name === 'trusted_snapshot_binding')) {
    // Do not backfill from mutable V2 JSON. Historical V2 rows without this runtime-owned
    // admission binding fail closed on their next drive rather than silently trusting a source
    // snapshot that was never frozen at admission.
    sql.exec('ALTER TABLE runtime_runs ADD COLUMN trusted_snapshot_binding TEXT');
  }
}

function auditTrustedV2Rows(sql: SqlStorage): void {
  const rows = sql
    .exec<{
      rowid: number;
      run_id: string;
      canonical_identity_hash: string;
      state_json: string;
    }>(
      `SELECT runtime_invocation_v2.rowid, runtime_invocation_v2.run_id,
              runtime_invocation_v2.canonical_identity_hash, runtime_invocation_v2.state_json
         FROM runtime_invocation_v2
         LEFT JOIN runtime_invocation_v2_scribe_audit
           ON runtime_invocation_v2_scribe_audit.run_id = runtime_invocation_v2.run_id
        WHERE runtime_invocation_v2_scribe_audit.run_id IS NULL
           OR runtime_invocation_v2_scribe_audit.version < ?`,
      TRUSTED_V2_SCRIBE_AUDIT_VERSION,
    )
    .toArray();
  for (const row of rows) {
    const state = parseTrustedV2AuditState(row);
    if (state === null) {
      // Remove malformed/raw content without recording it in an error, trace, or replacement row.
      // The immutable runtime marker makes the next drive fail closed as V2 rather than V1.
      scrubTrustedV2SqlRow(sql, row.run_id, row.rowid);
      continue;
    }
    sql.exec(
      `UPDATE runtime_invocation_v2
          SET canonical_identity_hash = ?, state_json = ?
        WHERE run_id = ?`,
      state.canonical_identity_hash,
      JSON.stringify(state),
      row.run_id,
    );
    markTrustedV2ScribeAudited(sql, row.run_id);
  }
}

function parseTrustedV2AuditState(row: {
  canonical_identity_hash: string;
  state_json: string;
}): TrustedRunV2State | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.state_json) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  try {
    const state = parseTrustedRunV2State(raw);
    return state.canonical_identity_hash === row.canonical_identity_hash ? state : null;
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') return null;
    throw error;
  }
}

function scrubTrustedV2SqlRow(sql: SqlStorage, runId: string, rowid: number): void {
  sql.exec(
    `UPDATE runtime_invocation_v2
        SET canonical_identity_hash = ?, state_json = '{"format":"corrupt_v2_state"}'
      WHERE run_id = ?`,
    `corrupt-${rowid}`,
    runId,
  );
  markTrustedV2ScribeAudited(sql, runId);
}

function migrateLegacyRuntimeRows(sql: SqlStorage): void {
  const rows = sql
    .exec<{
      run_id: string;
      state: RuntimeRunState;
      step: number;
      updated_at: number;
      failure_reason: string | null;
      context_json: string | null;
      scratch_json: string | null;
    }>(
      `SELECT runtime_runs.run_id, runtime_runs.state, runtime_runs.step,
              runtime_runs.updated_at, runtime_runs.failure_reason,
              runtime_runs.context_json, runtime_runs.scratch_json
         FROM runtime_runs
         LEFT JOIN runtime_run_scribe_audit
           ON runtime_run_scribe_audit.run_id = runtime_runs.run_id
        WHERE runtime_run_scribe_audit.run_id IS NULL
           OR runtime_run_scribe_audit.version < ?`,
      RUNTIME_RUN_SCRIBE_AUDIT_VERSION,
    )
    .toArray();

  for (const row of rows) {
    const context = auditPersistedRuntimePayload(row.context_json, runtimeRunContextSchema);
    const scratch = auditPersistedRuntimePayload(row.scratch_json, runtimeRunScratchSchema);
    if (!context.ok || !scratch.ok) {
      scrubUnsafeRuntimeRow(sql, row);
      markRuntimeRunScribeAudited(sql, row.run_id);
      continue;
    }
    sql.exec(
      'UPDATE runtime_runs SET context_json = ?, scratch_json = ? WHERE run_id = ?',
      context.value === null ? null : JSON.stringify(context.value),
      scratch.value === null ? null : JSON.stringify(scratch.value),
      row.run_id,
    );
    markRuntimeRunScribeAudited(sql, row.run_id);
  }
}

function auditPersistedRuntimePayload<T>(
  text: string | null,
  schema: StrictSchema<T>,
): { ok: true; value: T | null } | { ok: false } {
  if (text === null) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  const current = schema.safeParse(parsed);
  const candidate = current.success
    ? current.data
    : isRecord(parsed) && !Object.prototype.hasOwnProperty.call(parsed, 'source_taint')
      ? { ...parsed, source_taint: null }
      : undefined;
  if (candidate === undefined) return { ok: false };
  const prepared = prepareWithScribe(
    candidate,
    schema,
    'internal_context',
    null,
    CANARY_TOKENS,
  );
  return prepared.ok
    ? { ok: true, value: prepared.value }
    : { ok: false };
}

function scrubUnsafeRuntimeRow(
  sql: SqlStorage,
  row: {
    run_id: string;
    state: RuntimeRunState;
    step: number;
    updated_at: number;
    failure_reason: string | null;
  },
): void {
  appendRuntimeMigrationTrace(sql, row.run_id, 'scribe_denied', {
    destination: 'internal_context',
    reason: 'invalid_payload',
  }, row.updated_at);

  if (runtimeRunCanAdvance(row.state, 'FAILED')) {
    const failedStep = row.step + 1;
    sql.exec(
      `INSERT INTO runtime_journal (run_id, step, state, created_at)
       VALUES (?, ?, 'FAILED', ?)
       ON CONFLICT(run_id, step)
       DO UPDATE SET state = 'FAILED', created_at = excluded.created_at`,
      row.run_id,
      failedStep,
      row.updated_at,
    );
    sql.exec(
      `UPDATE runtime_runs
          SET state = 'FAILED', step = ?, context_json = NULL, scratch_json = NULL,
              next_expected_wake = NULL, failure_reason = 'scribe:invalid_payload'
        WHERE run_id = ?`,
      failedStep,
      row.run_id,
    );
    appendRuntimeMigrationTrace(
      sql,
      row.run_id,
      'failed',
      { reason: 'scribe:invalid_payload' },
      row.updated_at,
    );
    return;
  }

  sql.exec(
    'UPDATE runtime_runs SET context_json = NULL, scratch_json = NULL WHERE run_id = ?',
    row.run_id,
  );
  if (row.state === 'FAILED' && !runtimeTraceHasEvent(sql, row.run_id, 'failed')) {
    const failureReason = runtimeRunFailureReasonSchema.safeParse(row.failure_reason);
    appendRuntimeMigrationTrace(
      sql,
      row.run_id,
      'failed',
      { reason: failureReason.success ? failureReason.data : 'unknown' },
      row.updated_at,
    );
  }
}

function appendRuntimeMigrationTrace(
  sql: SqlStorage,
  runId: string,
  event: 'scribe_denied' | 'failed',
  detail: Record<string, unknown>,
  createdAt: number,
): void {
  const prepared = prepareWithScribe(
    detail,
    runtimeTraceDetailSchema,
    'audit_log',
    null,
    CANARY_TOKENS,
  );
  if (!prepared.ok) throw new Error(`legacy runtime trace rejected: ${prepared.reason}`);
  const seq = sql
    .exec<{ seq: number }>(
      'SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM runtime_trace WHERE run_id = ?',
      runId,
    )
    .one().seq;
  sql.exec(
    `INSERT OR IGNORE INTO runtime_trace
       (run_id, seq, event_key, event, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    runId,
    seq,
    runtimeTraceEventKey({ runId, event, seq }),
    event,
    JSON.stringify(prepared.value),
    createdAt,
  );
}

function runtimeTraceHasEvent(sql: SqlStorage, runId: string, event: string): boolean {
  return sql
    .exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM runtime_trace WHERE run_id = ? AND event = ?',
      runId,
      event,
    )
    .one().n > 0;
}

function markRuntimeRunScribeAudited(sql: SqlStorage, runId: string): void {
  sql.exec(
    `INSERT INTO runtime_run_scribe_audit (run_id, version)
     VALUES (?, ?)
     ON CONFLICT(run_id) DO UPDATE SET version = excluded.version`,
    runId,
    RUNTIME_RUN_SCRIBE_AUDIT_VERSION,
  );
}

function markTrustedV2ScribeAudited(sql: SqlStorage, runId: string): void {
  sql.exec(
    `INSERT INTO runtime_invocation_v2_scribe_audit (run_id, version)
     VALUES (?, ?)
     ON CONFLICT(run_id) DO UPDATE SET version = excluded.version`,
    runId,
    TRUSTED_V2_SCRIBE_AUDIT_VERSION,
  );
}

function ensureRuntimeTraceEventKey(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(runtime_trace)').toArray();
  if (!columns.some((column) => column.name === 'event_key')) {
    sql.exec('ALTER TABLE runtime_trace ADD COLUMN event_key TEXT');
  }
}

function parseScheduleFakeRunInput(input: ScheduleFakeRunInput): ScheduleFakeRunInput {
  const scheduleId = runtimeOperationalRefSchema.safeParse(input.scheduleId);
  if (!scheduleId.success) {
    throw new Error('scheduleFakeRun requires an opaque scheduleId');
  }
  const userId = runtimeOperationalRefSchema.safeParse(input.userId);
  if (!userId.success) {
    throw new Error('scheduleFakeRun requires an opaque userId');
  }
  if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
    throw new Error('scheduleFakeRun requires a non-negative occurrenceAt');
  }
  if (!Number.isInteger(input.dueAt) || input.dueAt < input.occurrenceAt) {
    throw new Error('scheduleFakeRun requires dueAt at or after occurrenceAt');
  }
  return {
    ...input,
    scheduleId: scheduleId.data,
    userId: userId.data,
    candidate: input.candidate === undefined ? undefined : deliveryCandidateSchema.parse(input.candidate),
  };
}

// The trusted local fixture deliberately takes no caller-selected execution vocabulary. The
// authenticated caller may ask to run it, but authority, tenant, trigger, routing, ACL, output,
// delivery, snapshot, and sources are all selected by the local server fixture above.
function parseLocalTrustedBriefIngress(input: unknown): void {
  if (!isRecord(input) || Reflect.ownKeys(input).length !== 0) {
    throw new Error('local trusted brief ingress requires an empty object');
  }
}

function parseScheduleTrustedRunInput(input: unknown): ScheduleTrustedRunInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('trusted invocation schedule requires an object');
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    !Object.prototype.hasOwnProperty.call(input, 'admission') ||
    !Object.prototype.hasOwnProperty.call(input, 'snapshot_ref') ||
    !Object.prototype.hasOwnProperty.call(input, 'snapshot_at')
  ) {
    throw new Error('trusted invocation schedule has an invalid shape');
  }
  const admission = ownDataProperty(input, 'admission');
  const snapshotRef = ownDataProperty(input, 'snapshot_ref');
  const snapshotAt = ownDataProperty(input, 'snapshot_at');
  if (
    admission === MISSING_OWN_DATA_PROPERTY ||
    snapshotRef === MISSING_OWN_DATA_PROPERTY ||
    snapshotAt === MISSING_OWN_DATA_PROPERTY ||
    typeof snapshotRef !== 'string' ||
    !/^snp_[a-f0-9]{32}$/.test(snapshotRef) ||
    typeof snapshotAt !== 'number' ||
    !Number.isSafeInteger(snapshotAt) ||
    snapshotAt < 0
  ) {
    throw new Error('trusted invocation schedule has invalid runtime-owned inputs');
  }
  const parsedAdmission = trustedInvocationAdmissionSchema.safeParse(admission);
  if (!parsedAdmission.success) throw new Error('trusted invocation schedule has invalid admission');
  return {
    admission: parsedAdmission.data,
    snapshot_ref: snapshotRef,
    snapshot_at: snapshotAt,
  };
}

function requiredPayloadRef(entry: ScheduleEntry, key: string): string {
  const value = entry.payload_refs[key];
  if (value === undefined) throw new Error(`schedule ${entry.id} missing payload ref ${key}`);
  return value;
}

const trustedGetCrsReceipts = new Map<
  string,
  Readonly<{
    request_digest: string;
    result: Awaited<ReturnType<ToolHandler<GetCrsArgs, { summary: string; body_state: string }, ToolDispatcherContext>['handle']>>;
  }>
>();
const MAX_TRUSTED_GET_CRS_RECEIPTS = 1_024;

const getCrsHandler: ToolHandler<
  GetCrsArgs,
  { summary: string; body_state: string },
  ToolDispatcherContext
> = {
  name: 'get_crs',
  description: 'Return a derived CRS summary.',
  schema: getCrsArgsSchema,
  trigger_allowlist: triggerAllowlistFor('get_crs'),
  autonomy_gated: false,
  idempotentOnKey: true,
  async handle() {
    return {
      ok: true,
      data: { summary: 'derived steady', body_state: 'steady' },
      source_taint: null,
    };
  },
  async executeOrReconcile(args, ctx, effect) {
    const prior = trustedGetCrsReceipts.get(effect.idempotency_key);
    if (prior !== undefined) {
      if (prior.request_digest !== effect.request_digest) {
        return { ok: false, error: 'tool effect request mismatch', code: 'invalid_args' };
      }
      return prior.result;
    }
    if (effect.operation === 'reconcile') {
      return {
        ok: false,
        error: 'trusted tool effect receipt unavailable after reset',
        code: 'transient',
        receipt_status: 'unavailable',
      };
    }
    // This local-only fake stands in for adapter-owned reconciliation storage. Refuse before
    // invoking the handler when full so a bounded test seam cannot disguise unbounded state.
    if (trustedGetCrsReceipts.size >= MAX_TRUSTED_GET_CRS_RECEIPTS) {
      return {
        ok: false,
        error: 'trusted_tool_effect_receipt_capacity_exhausted',
        code: 'transient',
      };
    }
    const result = await getCrsHandler.handle(args, ctx);
    trustedGetCrsReceipts.set(effect.idempotency_key, {
      request_digest: effect.request_digest,
      result,
    });
    return result;
  },
  async reconcileTrustedEffect(effect) {
    const prior = trustedGetCrsReceipts.get(effect.idempotency_key);
    if (prior === undefined) {
      return {
        ok: false,
        error: 'trusted tool effect receipt unavailable after reset',
        code: 'transient',
        receipt_status: 'unavailable',
      };
    }
    return prior.request_digest === effect.request_digest
      ? prior.result
      : { ok: false, error: 'tool effect request mismatch', code: 'invalid_args' };
  },
};

function triggerAllowlistFor(tool: ToolName): TriggerType[] {
  return (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) =>
    TOOL_PERMISSIONS[trigger].includes(tool),
  );
}

function toolContext(ctx: HookRuntimeContext): ToolDispatcherContext {
  if (ctx.session === undefined) throw new Error('tool dispatch requires a session');
  if (
    typeof ctx.authenticatedUserId !== 'string' ||
    ctx.authenticatedUserId.trim().length === 0
  ) {
    throw new Error('tool dispatch requires an authenticated subject');
  }
  return {
    ...ctx,
    authenticatedUserId: ctx.authenticatedUserId,
    session: ctx.session,
  };
}

function checkpointCallFailure(
  call: RuntimeToolCall | undefined,
  ctx: HookRuntimeContext,
): 'invalid_args' | 'acl_denied' | 'handler_unavailable' {
  if (call === undefined || call.name === 'get_crs') return 'invalid_args';
  return ctx.session?.tool_permissions.includes(call.name) === true
    ? 'handler_unavailable'
    : 'acl_denied';
}

function trustedToolFailureStage(
  reason: Extract<DispatchToolResult, { ok: false }>['reason'],
):
  | 'parse'
  | 'validation'
  | 'acl'
  | 'hook'
  | 'approval'
  | 'sanitisation'
  | 'egress'
  | 'handler'
  | 'result'
  | 'size' {
  switch (reason) {
    case 'unknown_tool':
      return 'parse';
    case 'invalid_args':
      return 'validation';
    case 'acl_denied':
      return 'acl';
    case 'hook_halt':
      return 'hook';
    case 'approval_denied':
      return 'approval';
    case 'sanitise_denied':
      return 'sanitisation';
    case 'egress_denied':
      return 'egress';
    case 'handler_unavailable':
    case 'effect_receipt_unavailable':
    case 'handler_acl_drift':
    case 'handler_failed':
    case 'invalid_handler_result':
      return 'handler';
    case 'tool_result_error':
    case 'invalid_tool_result':
      return 'result';
    case 'result_oversize':
      return 'size';
    default:
      return assertNever(reason);
  }
}

function mergeSourceTaint(current: SourceTaint, next: SourceTaint): SourceTaint {
  return current === 'external' || next === 'external' ? 'external' : null;
}

function toRuntimeRunRecord(row: RuntimeRunSqlRow): RuntimeRunRecord {
  return runtimeRunRecordSchema.parse({
    run_id: row.run_id,
    user_id: row.user_id,
    trigger: row.trigger,
    variant: row.variant,
    state: row.state,
    step: row.step,
    attempts: row.attempts,
    run_nonce: row.run_nonce,
    context_json: parseNullableJsonObject(row.context_json),
    scratch_json: parseNullableJsonObject(row.scratch_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_expected_wake: row.next_expected_wake,
    failure_reason: row.failure_reason,
  });
}

function parseScratch(value: RuntimeRunRecord['scratch_json']): ScratchState {
  return runtimeRunScratchSchema.parse(value ?? { source_taint: null });
}

function parseNullableJsonObject(text: string | null): Record<string, unknown> | null {
  return text === null ? null : parseJsonObject(text);
}

function scribeFailureReasonFromError(error: unknown): SanitiseFailureReason | null {
  if (!(error instanceof Error) || !error.message.startsWith('scribe:')) return null;
  const parsed = sanitiseFailureReasonSchema.safeParse(error.message.slice('scribe:'.length));
  return parsed.success ? parsed.data : null;
}

function jsonOrNull(value: Record<string, unknown> | ScratchState | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

type ObserveContinuation =
  | { kind: 'terminal' }
  | { kind: 'tool_calls'; calls: RuntimeToolCall[] }
  | { kind: 'malformed'; code: ErrorCode };

async function parseObserveContinuation(text: string): Promise<ObserveContinuation> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { kind: 'terminal' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.includes('tool_calls')
      ? { kind: 'malformed', code: 'invalid_args' }
      : { kind: 'terminal' };
  }

  const envelopeKind = observeToolCallEnvelopeKind(parsed);
  if (envelopeKind === 'malformed') {
    return { kind: 'malformed', code: 'invalid_args' };
  }
  if (envelopeKind === 'terminal') {
    return { kind: 'terminal' };
  }

  const parsedCalls = await parseToolCalls(parsed);
  if (!parsedCalls.ok) {
    return { kind: 'malformed', code: parsedCalls.code };
  }
  if (parsedCalls.calls.length === 0) {
    return { kind: 'terminal' };
  }
  return { kind: 'tool_calls', calls: parsedCalls.calls };
}

function observeToolCallEnvelopeKind(value: unknown): 'terminal' | 'candidate' | 'malformed' {
  if (Array.isArray(value)) {
    return value.some(isToolCallCandidateShape) ? 'candidate' : 'terminal';
  }
  if (!isRecord(value)) return 'terminal';
  if (Object.prototype.hasOwnProperty.call(value, 'tool_calls')) {
    return Array.isArray(value.tool_calls) ? 'candidate' : 'malformed';
  }
  if (Array.isArray(value.content)) {
    return value.content.some(isToolCallCandidateShape) ? 'candidate' : 'terminal';
  }
  if (Array.isArray(value.choices)) {
    return value.choices.some(choiceHasToolCalls) ? 'candidate' : 'terminal';
  }
  return 'terminal';
}

function isToolCallCandidateShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' ||
    typeof value.name === 'string' ||
    typeof value.tool === 'string' ||
    isRecord(value.function) ||
    Object.prototype.hasOwnProperty.call(value, 'input') ||
    Object.prototype.hasOwnProperty.call(value, 'args') ||
    Object.prototype.hasOwnProperty.call(value, 'arguments') ||
    value.type === 'tool_use' ||
    value.type === 'tool_call'
  );
}

function choiceHasToolCalls(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const source = isRecord(value.message) ? value.message : value;
  return Array.isArray(source.tool_calls) && source.tool_calls.some(isToolCallCandidateShape);
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(',')}}`;
}

// `TextEncoder.encode()` allocates an output-sized buffer. Hostile adapters can hand us a very
// large string, so count scalar UTF-8 bytes with a UTF-16 fast reject before copying anything.
function utf8ByteLengthWithinLimit(value: string, maximumBytes: number): number | null {
  if (value.length > maximumBytes) return null;
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteLength += 4;
      index += 1;
    } else {
      // UTF-8 replaces unpaired UTF-16 surrogates with U+FFFD, which is three bytes.
      byteLength += 3;
    }
    if (byteLength > maximumBytes) return null;
  }
  return byteLength;
}

type ReplayArtifactSnapshot =
  | { ok: true; value: unknown }
  | { ok: false };

// Replay adapters are treated as hostile boundaries. Copy only plain, bounded data without ever
// invoking accessors, preserving raw material in memory only long enough to hash/validate it.
function snapshotReplayArtifact(value: unknown): ReplayArtifactSnapshot {
  const seen = new WeakSet<object>();
  const budget = {
    remainingBytes: REPLAY_ARTIFACT_MAX_UTF8_BYTES,
    remainingNodes: REPLAY_ARTIFACT_MAX_NODES,
  };
  try {
    return { ok: true, value: snapshotReplayValue(value, seen, budget, 0) };
  } catch {
    return { ok: false };
  }
}

function snapshotReplayValue(
  value: unknown,
  seen: WeakSet<object>,
  budget: { remainingBytes: number; remainingNodes: number },
  depth: number,
): unknown {
  if (depth > 16) throw new Error('replay artifact depth exceeded');
  if (value === null) {
    consumeReplayArtifactBudget(budget, 4);
    return value;
  }
  if (typeof value === 'boolean') {
    consumeReplayArtifactBudget(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('replay artifact number invalid');
    consumeReplayArtifactBudget(budget, String(value).length);
    return value;
  }
  if (typeof value === 'string') {
    const byteLength = utf8ByteLengthWithinLimit(value, budget.remainingBytes);
    if (byteLength === null) throw new Error('replay artifact string budget exceeded');
    consumeReplayArtifactBudget(budget, byteLength);
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error('replay artifact must be acyclic data');
  }
  consumeReplayArtifactBudget(budget, 2);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('replay artifact array too large');
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key)))) {
      throw new Error('replay artifact array contains an unsupported key');
    }
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('replay artifact array contains an accessor or hole');
      }
      copy.push(snapshotReplayValue(descriptor.value, seen, budget, depth + 1));
    }
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('replay artifact object prototype is unsupported');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) {
    throw new Error('replay artifact object shape is unsupported');
  }
  const stringKeys = keys as string[];
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of stringKeys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('replay artifact object contains an accessor');
    }
    const keyByteLength = utf8ByteLengthWithinLimit(key, Math.max(0, budget.remainingBytes - 1));
    if (keyByteLength === null) throw new Error('replay artifact key budget exceeded');
    consumeReplayArtifactBudget(budget, keyByteLength + 1);
    copy[key] = snapshotReplayValue(descriptor.value, seen, budget, depth + 1);
  }
  return copy;
}

function consumeReplayArtifactBudget(
  budget: { remainingBytes: number; remainingNodes: number },
  bytes: number,
): void {
  budget.remainingNodes -= 1;
  budget.remainingBytes -= bytes;
  if (budget.remainingNodes < 0 || budget.remainingBytes < 0) {
    throw new Error('replay artifact budget exceeded');
  }
}

// Only explicitly classified durable-witness contradictions are converted into the typed
// replay failure. Storage and programming faults must retain their original cause.
class TrustedV2IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedV2IntegrityError';
  }
}

function trustedEffectsMatch(
  left: TrustedRunV2PendingEffect,
  right: TrustedRunV2PendingEffect,
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function assertTrustedStateMatchesRuntimeState(
  runtimeState: RuntimeRunState,
  state: TrustedRunV2State,
): void {
  const hasContext = state.record.context !== null;
  const hasPlan = state.plan !== null;
  const hasSynthesis = state.synthesis !== null;
  const invalid = (message: string): never => {
    throw new Error(`trusted V2 state/runtime mismatch: ${message}`);
  };
  if (state.pending_effect !== null) {
    const expectedState =
      state.pending_effect.kind === 'provider_plan'
        ? 'CONTEXT_BUILT'
        : state.pending_effect.kind === 'provider_observe'
          ? 'TOOLS_DONE'
          : 'LLM_CALLED';
    if (runtimeState !== expectedState && runtimeState !== 'FAILED') {
      invalid('pending effect belongs to a different runtime boundary');
    }
  }
  switch (runtimeState) {
    case 'PENDING':
      if (hasContext || hasPlan || hasSynthesis || state.record.tool_checkpoints.length !== 0) {
        invalid('pending state carries execution facts');
      }
      return;
    case 'CONTEXT_BUILT':
      if (!hasContext || hasPlan || hasSynthesis || state.record.tool_checkpoints.length !== 0) {
        invalid('context-built state is incomplete');
      }
      return;
    case 'LLM_CALLED':
      if (!hasContext || !hasPlan || hasSynthesis) invalid('LLM state has no replayable plan');
      return;
    case 'TOOLS_DONE':
      if (!hasContext || hasPlan) invalid('tools-done state carries a plan');
      return;
    case 'GATED':
    case 'DELIVERED':
    case 'DONE':
      if (!hasContext || hasPlan || hasSynthesis) invalid('terminal delivery state has replay work');
      return;
    case 'FAILED':
      return;
    default:
      assertNever(runtimeState);
  }
}

function governorObservationResult(result: DispatchToolResult): unknown {
  if (result.ok) {
    return {
      ok: true,
      tool: result.tool,
      data: result.data,
      card: result.card ?? null,
      source_taint: result.source_taint,
    };
  }
  return {
    ok: false,
    tool: result.tool,
    code: result.code,
    reason: result.reason,
    error: result.error,
    source_taint: result.source_taint ?? null,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unreachable runtime state: ${String(value)}`);
}

function governorFailureReason(decision: GovernorDecision): string {
  return `governor:${decision.reason}`;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isLocalIngressBadRequest(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ZodError' ||
    error.message.startsWith('scheduleFakeRun requires') ||
    error.message === 'local trusted brief ingress requires an empty object' ||
    error.message === 'run-loop schedule requires a brief alarm'
  );
}
