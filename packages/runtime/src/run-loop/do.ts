import { DurableObject } from 'cloudflare:workers';
import {
  TOOL_PERMISSIONS,
  buildSessionState,
  canonicalRuntimeRunIdempotencySerialization,
  deliveryVerdictSchema,
  deliveryCandidateSchema,
  getCrsArgsSchema,
  outboxStatusSchema,
  pushClassSchema,
  runStateSchema,
  runtimeOperationalRefSchema,
  runtimeRunCanAdvance,
  runtimeRunContextSchema,
  runtimeRunFailureReasonSchema,
  runtimeRunRecordSchema,
  runtimeRunScratchSchema,
  runtimeRunToolCallSchema,
  runtimeTraceDetailSchema,
  sanitiseFailureReasonSchema,
  webSearchArgsSchema,
  writeTaskArgsSchema,
  type DeliveryCandidate,
  type DeliverySink,
  type ErrorCode,
  type GetCrsArgs,
  type RuntimeReplayFixture,
  type RuntimeRunContext,
  type RuntimeRunFallbackStep,
  type RuntimeRunFailureReason,
  type RuntimeRunRecord,
  type RuntimeRunScratch,
  type RuntimeRunState,
  type RoutingLogEvent,
  type SanitiseDestination,
  type SanitiseFailureReason,
  type SourceTaint,
  type RuntimeTraceEval,
  type ScheduleEntry,
  type SessionState,
  type ToolHandler,
  type ToolName,
  type TriggerType,
  type WebSearchArgs,
  type WriteTaskArgs,
} from '@waldo/contracts';
import { runHooks, type HookRuntimeContext } from '../hooks/registry';
import {
  RuntimeLLMProvider,
  type RouteSpendState,
} from '../llm/provider';
import {
  RunJournalOutbox,
  type RunJournalOutboxCrashPoint,
} from '../run-journal/outbox-runtime';
import type { GovernorDecision, SetLoopKillFlagInput } from '../loop-governor/governor';
import { Scheduler, type ScheduleExecutors } from '../scheduler/multiplexer';
import type { Deps } from '../seams/deps';
import { prepareWithScribe, type StrictSchema } from '../scribe/prepare';
import {
  dispatchTool,
  parseToolCalls,
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

const TRIGGER = 'brief' satisfies TriggerType;
const PUSH_CLASS = 'brief' as const;
const CANARY_TOKENS = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
const RUNTIME_RUN_SCRIBE_AUDIT_VERSION = 1;
const LOCAL_RUN_TOKEN_HEADER = 'x-waldo-local-run-token';
const LOCAL_INGRESS_RATE_WINDOW_MS = 60_000;
const LOCAL_INGRESS_MAX_REQUESTS_PER_WINDOW = 32;

export type ScheduleFakeRunInput = {
  scheduleId: string;
  userId: string;
  dueAt: number;
  occurrenceAt: number;
  candidate?: DeliveryCandidate;
};

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

type LocalIngressRateSqlRow = {
  count: number;
};

type ScratchState = RuntimeRunScratch;
type ToolResultSummary = NonNullable<RuntimeRunScratch['tool_results']>[number];

type ProviderSpendPreflight =
  | { ok: true; spend: RouteSpendState | undefined }
  | { ok: false };

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

  __runLoopCrashAfter?: RuntimeRunState;
  __runLoopOutboxCrashPoint?: RunJournalOutboxCrashPoint;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ensureSchema(ctx.storage);
    ensureRunLoopSchema(ctx.storage);
    this.envBindings = env;
    this.adapters = resolveRunLoopAdapters(env);
    this.deps = this.adapters.deps;
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, this.deps);
    this.journalOutbox = this.createJournalOutbox(this.adapters.sink);
    this.llm = new RuntimeLLMProvider({ gateway: this.adapters.gateway });
  }

  // Test-only seam: lets integration tests exercise governor and adapter branches without making
  // live provider/channel calls or widening the production Worker fetch surface.
  __runLoopSetTestOverrides(overrides: RunLoopTestOverrides): void {
    this.adapters = {
      ...this.adapters,
      gateway: overrides.gateway ?? this.adapters.gateway,
      sink: overrides.sink ?? this.adapters.sink,
      spend: overrides.spend === null ? undefined : (overrides.spend ?? this.adapters.spend),
      spendReader: overrides.spendReader ?? this.adapters.spendReader,
      providerMode: overrides.providerMode ?? this.adapters.providerMode,
      deliveryTextFallback:
        overrides.deliveryTextFallback ?? this.adapters.deliveryTextFallback,
    };
    this.journalOutbox = this.createJournalOutbox(this.adapters.sink);
    this.llm = new RuntimeLLMProvider({ gateway: this.adapters.gateway });
  }

  __runLoopSetKillFlag(input: SetLoopKillFlagInput): void {
    this.journalOutbox.setLoopKillFlag(input);
  }

  async __runLoopIngestExternalToolResultForTest(runId: string): Promise<DispatchToolResult> {
    this.assertLocalTestSeam();
    const run = this.requireRuntimeRun(runId);
    const ctx = await this.rebuildInvocationContext(run);
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
      const scratch = parseScratch(this.requireRuntimeRun(runId).scratch_json);
      this.updateRunScratch(runId, {
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
    this.assertLocalTestSeam();
    const ctx = await this.rebuildInvocationContext(this.requireRuntimeRun(runId));
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
    if (!url.pathname.startsWith('/local/runs')) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    if (!isLocalRunLoopEnvironment(this.envBindings.WALDO_ENV)) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    const localToken = this.localIngressToken();
    if (
      localToken === null ||
      request.headers.get(LOCAL_RUN_TOKEN_HEADER) !== localToken
    ) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    if (!this.admitLocalIngress()) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    try {
      if (request.method === 'POST' && url.pathname === '/local/runs') {
        const body = (await request.json()) as unknown;
        const runId = await this.scheduleFakeRun(body as ScheduleFakeRunInput);
        return jsonResponse({ run_id: runId }, 202);
      }

      if (request.method === 'GET') {
        const match = /^\/local\/runs\/([^/]+)$/.exec(url.pathname);
        if (match === null) return jsonResponse({ error: 'not_found' }, 404);
        const runId = match[1];
        if (runId === undefined) return jsonResponse({ error: 'not_found' }, 404);
        return jsonResponse(await this.readRunProof(decodeURIComponent(runId)), 200);
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
    const runNonce = await this.scheduledRunNonce({
      userId: ingress.value.user_id,
      variant: decision.variant ?? null,
      scheduleId: ingress.value.schedule_id,
      occurrenceAt: parsed.occurrenceAt,
    });
    const existingRunId = this.findRuntimeRunByIdentity(ingress.value.user_id, runNonce);
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

    this.openRuntimeRun({
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

  async readRunProof(runId: string): Promise<RunLoopProof> {
    const run = this.readRuntimeRun(runId);
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
    const deliveryJournal = this.ctx.storage.sql
      .exec<{ state: string; verdict: string | null }>(
        'SELECT state, verdict FROM journal WHERE run_id = ?',
        runId,
      )
      .one();

    return {
      fsm,
      trace,
      context: run.context_json,
      outbox: outbox.map(({ kind, status, attempts }) => ({ kind, status, attempts })),
      sink: {
        ...fakeSinkStats(sinkKeys),
      },
      delivery_journal: deliveryJournal,
      current: { state: run.state, failure_reason: run.failure_reason },
    };
  }

  async readRunEvidence(runId: string): Promise<RuntimeReplayFixture> {
    return this.buildRunEvidence(runId);
  }

  async replayFixture(runId: string): Promise<RuntimeReplayFixture> {
    return this.buildRunEvidence(runId);
  }

  async scoreRun(traceId: string): Promise<RuntimeTraceEval> {
    return scoreRuntimeFixture(this.buildRunEvidence(traceId));
  }

  override async alarm(): Promise<void> {
    await this.scheduler.dispatchDue(this.scheduleExecutors());
  }

  private scheduleExecutors(): ScheduleExecutors {
    return {
      brief: async (entry) => this.driveScheduledRun(entry),
    };
  }

  private createJournalOutbox(sink: DeliverySink): RunJournalOutbox {
    return new RunJournalOutbox(this.ctx.storage, this.deps, sink, {
      crashPoint: () => this.__runLoopOutboxCrashPoint,
    });
  }

  private localIngressToken(): string | null {
    const token = this.envBindings.RUN_LOOP_LOCAL_INGRESS_TOKEN;
    return typeof token === 'string' && token.length >= 16 ? token : null;
  }

  private assertLocalTestSeam(): void {
    if (!isLocalRunLoopEnvironment(this.envBindings.WALDO_ENV)) {
      throw new Error('run-loop test seam is local-only');
    }
  }

  private admitLocalIngress(): boolean {
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

  private async driveScheduledRun(entry: ScheduleEntry): Promise<void> {
    const decision = triage({
      kind: 'alarm',
      alarmName: entry.id,
      scheduleKind: entry.kind,
    });
    if (!decision.ok || decision.trigger !== TRIGGER) {
      throw new Error('scheduled run-loop wake did not triage to brief');
    }
    await this.driveRun(requiredPayloadRef(entry, 'run_id'));
  }

  private async driveRun(runId: string): Promise<void> {
    let run = this.requireRuntimeRun(runId);
    if (run.state === 'DONE' || run.state === 'FAILED') return;
    let ctx: HookRuntimeContext | null = null;

    while (run.state !== 'DONE' && run.state !== 'FAILED') {
      switch (run.state) {
        case 'PENDING':
          let admissionDecision: GovernorDecision;
          {
            try {
              admissionDecision = this.admitGovernor(run.run_id);
            } catch (error) {
              const scribeReason = scribeFailureReasonFromError(error);
              if (scribeReason === null) throw error;
              run = this.failFromScribe(run.run_id, 'internal_context', scribeReason);
              break;
            }
            if (admissionDecision.verdict === 'deny') {
              this.recordGovernorDenied(run.run_id, admissionDecision);
              run = this.failRun(run.run_id, governorFailureReason(admissionDecision));
              break;
            }
          }
          this.recordTrace(run.run_id, 'governor_admitted', {
            loop_type: admissionDecision.loopType,
          });
          ctx = await this.rebuildInvocationContext(run);
          run = this.advanceRun(run.run_id, 'CONTEXT_BUILT', {
            context: this.buildFakeContext(run, ctx.session),
          });
          this.recordTrace(run.run_id, 'context_built', { source: 'fake-derived' });
          this.crashAfter('CONTEXT_BUILT');
          break;
        case 'CONTEXT_BUILT':
          ctx ??= await this.rebuildInvocationContext(run);
          run = await this.callLlm(run, ctx);
          this.crashAfter('LLM_CALLED');
          break;
        case 'LLM_CALLED':
          ctx ??= await this.rebuildInvocationContext(run);
          run = await this.dispatchTools(run, ctx);
          this.crashAfter('TOOLS_DONE');
          break;
        case 'TOOLS_DONE':
          run = await this.synthesiseDelivery(run, ctx);
          if (run.state === 'FAILED') break;
          if (run.state === 'LLM_CALLED') {
            this.crashAfter('LLM_CALLED');
          } else {
            run = await this.gate(run);
            this.crashAfter('GATED');
          }
          break;
        case 'GATED':
          try {
            await this.journalOutbox.tickRun(run.run_id);
          } catch (error) {
            const scribeReason = scribeFailureReasonFromError(error);
            if (scribeReason === null) throw error;
            run = this.failFromScribe(run.run_id, 'outbox', scribeReason);
            break;
          }
          if (this.journalOutbox.readRunState(run.run_id) === 'FAILED') {
            run = this.failFromScribe(run.run_id, 'outbox', 'invalid_payload');
            break;
          }
          run = this.advanceRun(run.run_id, 'DELIVERED');
          this.recordTrace(run.run_id, 'delivered', { sink: 'fake', status: 'acked' });
          this.crashAfter('DELIVERED');
          break;
        case 'DELIVERED':
          run = this.advanceRun(run.run_id, 'DONE');
          this.recordTrace(run.run_id, 'done', { terminal: true });
          break;
        default:
          assertNever(run.state);
      }
    }
  }

  private async rebuildInvocationContext(run: RuntimeRunRecord): Promise<HookRuntimeContext> {
    const sourceTaint = parseScratch(run.scratch_json).source_taint;
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
    this.recordTrace(run.run_id, 'session_reset', {
      started_at: ctx.session.rate_limit_window.started_at,
      tool_count: ctx.session.tool_permissions.length,
    });
    return ctx;
  }

  private buildFakeContext(
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

  private async callLlm(
    run: RuntimeRunRecord,
    ctx: HookRuntimeContext,
  ): Promise<RuntimeRunRecord> {
    const preflight = this.checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      this.recordGovernorDenied(run.run_id, preflight);
      return this.failRun(run.run_id, governorFailureReason(preflight));
    }
    const spend = await this.readSpendBeforeProvider();
    if (!spend.ok) {
      return this.failRun(run.run_id, 'llm:spend_state_unavailable');
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
        this.recordTrace(run.run_id, 'scribe_denied', result.scribe);
        return this.failRun(run.run_id, `scribe:${result.scribe.reason}`, {
          fallbackStep: result.fallback_step,
          routingLogs: result.routing_logs,
        });
      }
      return this.failRun(run.run_id, `llm:${result.reason}`, {
        fallbackStep: result.fallback_step,
        routingLogs: result.routing_logs,
      });
    }

    const parsedCalls = await parseToolCalls(result.tool_call_source.text);
    if (!parsedCalls.ok) {
      this.recordTrace(run.run_id, 'tool_parse_failed', { code: parsedCalls.code });
      return this.failRun(run.run_id, `tool_parse:${parsedCalls.code}`);
    }

    const persistedCalls = parsedCalls.calls.map((call) => runtimeRunToolCallSchema.safeParse(call));
    const invalidCallIndex = persistedCalls.findIndex((call) => !call.success);
    if (invalidCallIndex >= 0) {
      const invalidCall = parsedCalls.calls[invalidCallIndex];
      const reason = checkpointCallFailure(invalidCall, ctx);
      this.recordToolDispatchTrace(run.run_id, [
        { tool: invalidCall?.name ?? null, ok: false, reason },
      ]);
      return this.failRun(run.run_id, `tool_dispatch:${reason}`);
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
    this.recordTrace(run.run_id, 'llm_called', {
      model: result.response.model,
      fallback_step: result.fallback_step,
      tool_call_count: parsedCalls.calls.length,
      routing_logs: result.routing_logs,
    });
    if (usageDecision.verdict === 'deny') {
      this.recordGovernorDenied(run.run_id, usageDecision);
      return this.failRun(run.run_id, governorFailureReason(usageDecision));
    }
    const next = this.advanceRun(run.run_id, 'LLM_CALLED', { scratch });
    return next;
  }

  private async dispatchTools(
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
        this.recordToolDispatchTrace(run.run_id, results);
        this.recordGovernorDenied(run.run_id, decision);
        return this.failRun(run.run_id, governorFailureReason(decision));
      }
      if (!result.ok) {
        this.recordToolDispatchTrace(run.run_id, results);
        return this.failRun(run.run_id, `tool_dispatch:${result.reason}`);
      }
      ctx.sourceTaint = mergeSourceTaint(ctx.sourceTaint, result.source_taint);
    }

    const next = this.advanceRun(run.run_id, 'TOOLS_DONE', {
      scratch: {
        ...scratch,
        tool_results: [...(scratch.tool_results ?? []), ...results],
        source_taint: ctx.sourceTaint,
      },
    });
    this.recordToolDispatchTrace(run.run_id, results);
    return next;
  }

  private async synthesiseDelivery(
    run: RuntimeRunRecord,
    ctx: HookRuntimeContext | null,
  ): Promise<RuntimeRunRecord> {
    const scratch = parseScratch(run.scratch_json);
    if (scratch.delivery_text !== undefined) return run;
    const preflight = this.checkGovernorBeforeLlm(run.run_id);
    if (preflight.verdict === 'deny') {
      this.recordGovernorDenied(run.run_id, preflight);
      return this.failRun(run.run_id, governorFailureReason(preflight));
    }
    const spend = await this.readSpendBeforeProvider();
    if (!spend.ok) {
      return this.failRun(run.run_id, 'llm_observe:spend_state_unavailable');
    }

    const invocationContext = ctx ?? (await this.rebuildInvocationContext(run));
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
        this.recordTrace(run.run_id, 'scribe_denied', result.scribe);
        return this.failRun(run.run_id, `scribe:${result.scribe.reason}`, {
          fallbackStep: result.fallback_step,
          routingLogs: result.routing_logs,
        });
      }
      return this.failRun(run.run_id, `llm_observe:${result.reason}`, {
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
    this.recordTrace(run.run_id, 'llm_observed', {
      model: result.response.model,
      fallback_step: result.fallback_step,
      delivery_text_source: result.fallback_step === 'template' ? 'fallback' : 'llm',
      routing_logs: result.routing_logs,
    });
    if (usageDecision.verdict === 'deny') {
      this.recordGovernorDenied(run.run_id, usageDecision);
      return this.failRun(run.run_id, governorFailureReason(usageDecision));
    }

    const continuation = await parseObserveContinuation(result.tool_call_source.text);
    if (continuation.kind === 'malformed') {
      this.recordTrace(run.run_id, 'tool_parse_failed', { code: continuation.code });
      return this.failRun(run.run_id, `tool_parse:${continuation.code}`);
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
        this.recordToolDispatchTrace(run.run_id, [
          { tool: invalidCall?.name ?? null, ok: false, reason },
        ]);
        return this.failRun(run.run_id, `tool_dispatch:${reason}`);
      }
      return this.advanceRun(run.run_id, 'LLM_CALLED', {
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

    return this.updateRunScratch(run.run_id, {
      ...scratch,
      delivery_text: result.response.text,
      delivery_text_source: result.fallback_step === 'template' ? 'fallback' : 'llm',
    });
  }

  private async gate(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
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
      return this.failDeliveryFromScribe(run.run_id, scratch, 'outbox', outboxCandidate.reason);
    }
    const sendCandidate = prepareWithScribe(
      outboxCandidate.value,
      deliveryTextSchema,
      'send_message',
      scratch.source_taint,
      CANARY_TOKENS,
    );
    if (!sendCandidate.ok) {
      return this.failDeliveryFromScribe(
        run.run_id,
        scratch,
        'send_message',
        sendCandidate.reason,
      );
    }
    const deliveryText = sendCandidate.value;
    if (scratch.delivery_text !== undefined && scratch.delivery_text !== deliveryText) {
      const updated = this.updateRunScratch(run.run_id, { ...scratch, delivery_text: deliveryText });
      if (updated.state === 'FAILED') return updated;
    }
    const egressDecision = this.journalOutbox.checkLoopEgress({
      runId: run.run_id,
      text: deliveryText,
    });
    if (egressDecision.verdict === 'deny') {
      this.recordGovernorDenied(run.run_id, egressDecision);
      return this.failRun(run.run_id, `governor:${egressDecision.reason}`);
    }
    const gated = await this.journalOutbox.gateRun(run.run_id);
    if (gated.verdict === null) {
      throw new Error(`gate did not stamp a verdict for ${run.run_id}`);
    }
    if (gated.verdict === 'hold' || gated.verdict === 'drop') {
      this.recordTrace(run.run_id, 'gated', {
        verdict: gated.verdict,
        reason: gated.gate_reason,
        delivery_text_source: scratch.delivery_text_source ?? 'fallback',
      });
      return this.failRun(run.run_id, `delivery_gate:${gated.gate_reason}`);
    }
    const next = this.advanceRun(run.run_id, 'GATED');
    this.recordTrace(run.run_id, 'gated', {
      verdict: gated.verdict,
      outbox_kind: this.readOutboxKind(run.run_id),
      delivery_text_source: scratch.delivery_text_source ?? 'fallback',
    });
    return next;
  }

  private openRuntimeRun(input: {
    runId: string;
    userId: string;
    variant: 'morning' | 'midday' | 'evening' | 'event' | null;
    runNonce: string;
    scheduleId: string;
    occurrenceAt: number;
  }): void {
    const at = this.deps.now();
    const record = runtimeRunRecordSchema.parse({
      run_id: input.runId,
      user_id: input.userId,
      trigger: TRIGGER,
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

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO runtime_runs
           (run_id, user_id, trigger, variant, state, step, attempts, run_nonce,
            context_json, scratch_json, created_at, updated_at, next_expected_wake, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
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
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO runtime_journal (run_id, step, state, created_at) VALUES (?, 0, ?, ?)',
        record.run_id,
        record.state,
        record.created_at,
      );
      markRuntimeRunScribeAudited(this.ctx.storage.sql, record.run_id);
    });
    this.recordTrace(record.run_id, 'scheduled_wake', {
      schedule_id: input.scheduleId,
      occurrence_at: input.occurrenceAt,
      trigger: TRIGGER,
    });
  }

  private advanceRun(
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
      if (!prepared.ok) return this.failFromScribe(runId, 'internal_context', prepared.reason);
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
      if (!prepared.ok) return this.failFromScribe(runId, 'internal_context', prepared.reason);
      scratch = prepared.value;
    }

    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.requireRuntimeRun(runId);
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
      next = this.requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`advanceRun failed for ${runId}`);
    return next;
  }

  private updateRunScratch(runId: string, scratch: ScratchState): RuntimeRunRecord {
    const prepared = prepareWithScribe(
      scratch,
      runtimeRunScratchSchema,
      'internal_context',
      scratch.source_taint,
      CANARY_TOKENS,
    );
    if (!prepared.ok) return this.failFromScribe(runId, 'internal_context', prepared.reason);

    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.requireRuntimeRun(runId);
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
      next = this.requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`updateRunScratch failed for ${runId}`);
    return next;
  }

  private failRun(
    runId: string,
    reason: string,
    llmFailure?: LlmFailureTrace,
  ): RuntimeRunRecord {
    const failureReason = runtimeRunFailureReasonSchema.parse(reason);
    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.requireRuntimeRun(runId);
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
      next = this.requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`failRun failed for ${runId}`);
    if (llmFailure !== undefined && llmFailure.routingLogs.length > 0) {
      this.recordTrace(runId, 'failed', {
        reason: failureReason,
        fallback_step: llmFailure.fallbackStep,
        routing_logs: [...llmFailure.routingLogs],
      });
    }
    return next;
  }

  private failFromScribe(
    runId: string,
    destination: SanitiseDestination,
    reason: SanitiseFailureReason,
  ): RuntimeRunRecord {
    this.recordTrace(runId, 'scribe_denied', { destination, reason });
    return this.failRun(runId, `scribe:${reason}`);
  }

  private failDeliveryFromScribe(
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
    const scrubbed = this.updateRunScratch(runId, safeScratch);
    if (scrubbed.state === 'FAILED') return scrubbed;
    return this.failFromScribe(runId, destination, reason);
  }

  private admitGovernor(runId: string): GovernorDecision {
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

  private readRuntimeRun(runId: string): RuntimeRunRecord | null {
    const row = this.ctx.storage.sql
      .exec<RuntimeRunSqlRow>('SELECT * FROM runtime_runs WHERE run_id = ?', runId)
      .toArray()[0];
    return row === undefined ? null : toRuntimeRunRecord(row);
  }

  private findRuntimeRunByIdentity(userId: string, runNonce: string): string | null {
    const row = this.ctx.storage.sql
      .exec<RuntimeRunIdentitySqlRow>(
        'SELECT run_id FROM runtime_runs WHERE user_id = ? AND run_nonce = ?',
        userId,
        runNonce,
      )
      .toArray()[0];
    return row?.run_id ?? null;
  }

  private readOutboxKind(runId: string): string {
    const row = this.ctx.storage.sql
      .exec<{ kind: string }>('SELECT kind FROM outbox WHERE run_id = ? ORDER BY kind LIMIT 1', runId)
      .toArray()[0];
    if (row === undefined) throw new Error(`readOutboxKind: no outbox row for ${runId}`);
    return row.kind;
  }

  private async scheduledRunNonce(input: {
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

  private buildRunEvidence(runId: string): RuntimeReplayFixture {
    const run = this.readRuntimeRun(runId);
    if (run === null) throw new Error(`buildRunEvidence: no run ${runId}`);
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
    const deliveryJournal = this.ctx.storage.sql
      .exec<{ state: string; verdict: string | null }>(
        'SELECT state, verdict FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    return buildRuntimeReplayFixture({
      runId,
      traceRows,
      fsm,
      outbox,
      deliveryJournal: {
        state: runStateSchema.parse(deliveryJournal.state),
        verdict: deliveryVerdictSchema.nullable().parse(deliveryJournal.verdict),
      },
      current: { state: run.state, failure_reason: run.failure_reason },
    });
  }

  private requireRuntimeRun(runId: string): RuntimeRunRecord {
    const run = this.readRuntimeRun(runId);
    if (run === null) throw new Error(`runtime run not found: ${runId}`);
    return run;
  }

  private recordTrace(runId: string, event: string, detail: Record<string, unknown>): void {
    const sourceTaint = parseScratch(this.requireRuntimeRun(runId).scratch_json).source_taint;
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

  private crashAfter(state: RuntimeRunState): void {
    if (this.__runLoopCrashAfter === state) {
      throw new Error(`crash-injection:${state}`);
    }
  }

  private recordGovernorDenied(runId: string, decision: GovernorDecision): void {
    this.recordTrace(runId, 'governor_denied', {
      reason: decision.reason,
      disposition: decision.disposition,
    });
  }

  private checkGovernorBeforeLlm(runId: string): GovernorDecision {
    return this.journalOutbox.recordLoopUsage({
      runId,
      tokensUsed: 0,
      iterations: 0,
      subagentSpawns: 0,
    });
  }

  private async readSpendBeforeProvider(): Promise<ProviderSpendPreflight> {
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

  private recordToolDispatchTrace(
    runId: string,
    results: { tool: ToolName | null; ok: boolean; reason?: string }[],
  ): void {
    const denied = results.filter((result) => !result.ok);
    const detail: Record<string, unknown> = {
      tools: results.filter((result) => result.ok).map((result) => result.tool),
      denied: denied.map((result) => result.tool),
    };
    if (denied.length > 0) {
      detail.reasons = denied.map((result) => result.reason);
    }
    this.recordTrace(runId, 'tool_dispatched', detail);
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
      failure_reason     TEXT
    );
  `);
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_identity ON runtime_runs(user_id, run_nonce)');
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
  storage.transactionSync(() => migrateLegacyRuntimeRows(sql));
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

function requiredPayloadRef(entry: ScheduleEntry, key: string): string {
  const value = entry.payload_refs[key];
  if (value === undefined) throw new Error(`schedule ${entry.id} missing payload ref ${key}`);
  return value;
}

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
  async handle() {
    return {
      ok: true,
      data: { summary: 'derived steady', body_state: 'steady' },
      source_taint: null,
    };
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

function governorObservationResult(result: DispatchToolResult): unknown {
  if (result.ok) {
    return {
      ok: true,
      tool: result.tool,
      data: result.data,
      card: result.card ?? null,
    };
  }
  return {
    ok: false,
    tool: result.tool,
    code: result.code,
    reason: result.reason,
    error: result.error,
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
    error.message === 'run-loop schedule requires a brief alarm'
  );
}
