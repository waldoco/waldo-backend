import { DurableObject } from 'cloudflare:workers';
import {
  TOOL_PERMISSIONS,
  canonicalRuntimeRunIdempotencySerialization,
  deliveryCandidateSchema,
  getCrsArgsSchema,
  runtimeRunCanAdvance,
  runtimeRunRecordSchema,
  type AdapterResult,
  type DeliveryCandidate,
  type DeliverySink,
  type ErrorCode,
  type GetCrsArgs,
  type LLMResponse,
  type RuntimeReplayFixture,
  type RuntimeRunRecord,
  type RuntimeRunState,
  type RuntimeTraceEval,
  type ScheduleEntry,
  type SessionState,
  type SinkAck,
  type SinkRequest,
  type ToolHandler,
  type ToolName,
  type TriggerType,
} from '@waldo/contracts';
import { runHooks, type HookRuntimeContext } from '../hooks/registry';
import {
  RuntimeLLMProvider,
  type LLMGatewayAdapter,
  type LLMGatewayRequest,
  type RouteSpendState,
} from '../llm/provider';
import {
  RunJournalOutbox,
  type RunJournalOutboxCrashPoint,
} from '../run-journal/outbox-runtime';
import type { GovernorDecision, SetLoopKillFlagInput } from '../loop-governor/governor';
import { Scheduler, type ScheduleExecutors } from '../scheduler/multiplexer';
import { productionDeps, type Deps } from '../seams/deps';
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
  buildRuntimeReplayFixture,
  normaliseRuntimeTraceDetail,
  runtimeTraceEventKey,
  scoreRuntimeFixture,
  type RuntimeTraceSqlRow,
} from './evidence';

const TRIGGER = 'brief' satisfies TriggerType;
const PUSH_CLASS = 'brief' as const;
const CANARY_TOKENS = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
const DELIVERY_TEXT = 'Derived steady-state brief ready for delivery.';
const PLAN_SYSTEM_PREFIX = 'run-loop:plan';
const OBSERVE_SYSTEM_PREFIX = 'run-loop:observe';
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

type ScratchState = {
  tool_calls?: RuntimeToolCall[];
  tool_results?: { tool: ToolName | null; ok: boolean; reason?: string }[];
  delivery_text?: string;
  delivery_text_source?: 'fallback' | 'llm';
  llm?: {
    model: string;
    fallback_step: string;
    degraded: boolean;
    tool_call_count: number;
  };
};

class FakeRunLoopGateway implements LLMGatewayAdapter {
  async complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    if ((request.request.system ?? '').startsWith(OBSERVE_SYSTEM_PREFIX)) {
      return {
        ok: true,
        data: {
          model: request.request.model,
          text: DELIVERY_TEXT,
          input_tokens: 16,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          latency_ms: 1,
        },
      };
    }

    return {
      ok: true,
      data: {
        model: request.request.model,
        text: JSON.stringify({
          tool_calls: [
            {
              id: 'call-get-crs',
              name: 'get_crs',
              arguments: { range_days: 1 },
            },
          ],
        }),
        input_tokens: 24,
        output_tokens: 12,
        cache_read_input_tokens: 0,
        latency_ms: 1,
      },
    };
  }
}

const runLoopAcks = new Map<string, SinkAck>();
const runLoopAttempts = new Map<string, number>();

class RunLoopFakeSink implements DeliverySink {
  readonly idempotentOnKey = true;

  send(req: SinkRequest): SinkAck {
    runLoopAttempts.set(req.idempotency_key, (runLoopAttempts.get(req.idempotency_key) ?? 0) + 1);
    const prior = runLoopAcks.get(req.idempotency_key);
    if (prior !== undefined) return prior;
    const ack: SinkAck = { idempotency_key: req.idempotency_key, accepted: true };
    runLoopAcks.set(req.idempotency_key, ack);
    return ack;
  }
}

export type RunLoopTestOverrides = {
  gateway?: LLMGatewayAdapter;
  sink?: DeliverySink;
  spend?: RouteSpendState | null;
  deliveryTextFallback?: string;
};

type RunLoopAdapters = {
  deps: Deps;
  gateway: LLMGatewayAdapter;
  sink: DeliverySink;
  spend?: RouteSpendState;
  deliveryTextFallback: string;
};

function defaultRunLoopAdapters(): RunLoopAdapters {
  return {
    deps: productionDeps(),
    gateway: new FakeRunLoopGateway(),
    sink: new RunLoopFakeSink(),
    deliveryTextFallback: DELIVERY_TEXT,
  };
}

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
    ensureRunLoopSchema(ctx.storage.sql);
    this.envBindings = env;
    this.adapters = defaultRunLoopAdapters();
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
      deliveryTextFallback:
        overrides.deliveryTextFallback ?? this.adapters.deliveryTextFallback,
    };
    this.journalOutbox = this.createJournalOutbox(this.adapters.sink);
    this.llm = new RuntimeLLMProvider({ gateway: this.adapters.gateway });
  }

  __runLoopSetKillFlag(input: SetLoopKillFlagInput): void {
    this.journalOutbox.setLoopKillFlag(input);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/local/runs')) {
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
    const decision = triage({
      kind: 'alarm',
      alarmName: parsed.scheduleId,
      scheduleKind: TRIGGER,
    });
    if (!decision.ok || decision.trigger !== TRIGGER) {
      throw new Error('run-loop schedule requires a brief alarm');
    }
    const runNonce = await this.scheduledRunNonce({
      userId: parsed.userId,
      variant: decision.variant ?? null,
      scheduleId: parsed.scheduleId,
      occurrenceAt: parsed.occurrenceAt,
    });
    const existingRunId = this.findRuntimeRunByIdentity(parsed.userId, runNonce);
    if (existingRunId !== null) {
      await this.scheduler.schedule({
        id: parsed.scheduleId,
        kind: TRIGGER,
        occurrenceAt: parsed.occurrenceAt,
        dueAt: parsed.dueAt,
        payloadRefs: { id: parsed.scheduleId, run_id: existingRunId, user_id: parsed.userId },
      });
      return existingRunId;
    }

    const candidate =
      parsed.candidate ??
      ({
        push_class: PUSH_CLASS,
        trigger: TRIGGER,
        event_id: parsed.scheduleId,
        expires_at: null,
      } satisfies DeliveryCandidate);

    const runId = this.journalOutbox.startRun({
      userId: parsed.userId,
      trigger: TRIGGER,
      occurrenceAt: parsed.occurrenceAt,
      occurrenceId: runNonce,
      candidate,
    });

    this.openRuntimeRun({
      runId,
      userId: parsed.userId,
      variant: decision.variant ?? null,
      runNonce,
      scheduleId: parsed.scheduleId,
      occurrenceAt: parsed.occurrenceAt,
    });

    await this.scheduler.schedule({
      id: parsed.scheduleId,
      kind: TRIGGER,
      occurrenceAt: parsed.occurrenceAt,
      dueAt: parsed.dueAt,
      payloadRefs: { id: parsed.scheduleId, run_id: runId, user_id: parsed.userId },
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
        deliveries: sinkKeys.filter((key) => runLoopAcks.has(key)).length,
        attempts: sinkKeys.reduce((sum, key) => sum + (runLoopAttempts.get(key) ?? 0), 0),
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
            admissionDecision = this.admitGovernor(run.run_id);
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
          await this.journalOutbox.tickRun(run.run_id);
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
    const ctx: HookRuntimeContext = {
      authenticatedUserId: run.user_id,
      trigger: run.trigger,
      canaryTokens: CANARY_TOKENS,
      now: this.deps.now,
      rateLimitCheck: () => true,
      hasApproval: () => true,
      sanitise: ({ text }) => ({ ok: true, output: text, redactions: [] }),
      medicalGate: () => true,
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
  ): Record<string, unknown> {
    if (session === undefined) throw new Error('buildFakeContext requires a session');
    return {
      source: 'fake-derived',
      trigger: run.trigger,
      body_state: 'steady',
      session_started_at: session.rate_limit_window.started_at,
      tool_permissions: session.tool_permissions,
    };
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

    const result = await this.llm.complete(
      {
        trigger: run.trigger,
        spend: this.adapters.spend,
        renderRequest({ step, context }) {
          return {
            system: `${PLAN_SYSTEM_PREFIX}:${context}:${step.provider}`,
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
      return this.failRun(run.run_id, `llm:${result.reason}`);
    }

    const parsedCalls = await parseToolCalls(result.tool_call_source.text);
    if (!parsedCalls.ok) {
      this.recordTrace(run.run_id, 'tool_parse_failed', { code: parsedCalls.code });
      return this.failRun(run.run_id, `tool_parse:${parsedCalls.code}`);
    }

    const scratch: ScratchState = {
      tool_calls: parsedCalls.calls,
      tool_results: [],
      llm: {
        model: result.response.model,
        fallback_step: result.fallback_step,
        degraded: result.degraded,
        tool_call_count: parsedCalls.calls.length,
      },
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
    const results: { tool: ToolName | null; ok: boolean; reason?: string }[] = [];
    for (const call of calls) {
      const result = await dispatchTool(call, toolContext(ctx), {
        handlers: [getCrsHandler],
      });
      results.push(
        result.ok
          ? { tool: result.tool, ok: true }
          : { tool: result.tool, ok: false, reason: result.reason },
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
    }

    const next = this.advanceRun(run.run_id, 'TOOLS_DONE', {
      scratch: { ...scratch, tool_results: [...(scratch.tool_results ?? []), ...results] },
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

    const result = await this.llm.complete(
      {
        trigger: run.trigger,
        spend: this.adapters.spend,
        renderRequest({ step, context }) {
          return {
            system: `${OBSERVE_SYSTEM_PREFIX}:${context}:${step.provider}`,
            messages: [
              {
                role: 'user',
                content: JSON.stringify({
                  context: run.context_json,
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
      ctx ?? (await this.rebuildInvocationContext(run)),
    );

    if (!result.ok) {
      return this.failRun(run.run_id, `llm_observe:${result.reason}`);
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
      return this.advanceRun(run.run_id, 'LLM_CALLED', {
        scratch: {
          ...scratch,
          tool_calls: continuation.calls,
          delivery_text: undefined,
          delivery_text_source: undefined,
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
    const deliveryText = scratch.delivery_text ?? this.adapters.deliveryTextFallback;
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
      this.recordTrace(record.run_id, 'scheduled_wake', {
        schedule_id: input.scheduleId,
        occurrence_at: input.occurrenceAt,
        trigger: TRIGGER,
      });
    });
  }

  private advanceRun(
    runId: string,
    to: RuntimeRunState,
    updates: { context?: Record<string, unknown>; scratch?: ScratchState } = {},
  ): RuntimeRunRecord {
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
        jsonOrNull(updates.context ?? run.context_json),
        jsonOrNull(updates.scratch ?? run.scratch_json),
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
    let next: RuntimeRunRecord | null = null;
    this.ctx.storage.transactionSync(() => {
      const run = this.requireRuntimeRun(runId);
      const at = this.deps.now();
      this.ctx.storage.sql.exec(
        `UPDATE runtime_runs
            SET scratch_json = ?,
                updated_at = ?
          WHERE run_id = ?`,
        jsonOrNull(scratch),
        at,
        runId,
      );
      next = this.requireRuntimeRun(runId);
    });
    if (next === null) throw new Error(`updateRunScratch failed for ${runId}`);
    return next;
  }

  private failRun(runId: string, reason: string): RuntimeRunRecord {
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
        reason,
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
    return next;
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
      .toArray();
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
      deliveryJournal,
      current: { state: run.state, failure_reason: run.failure_reason },
    });
  }

  private requireRuntimeRun(runId: string): RuntimeRunRecord {
    const run = this.readRuntimeRun(runId);
    if (run === null) throw new Error(`runtime run not found: ${runId}`);
    return run;
  }

  private recordTrace(runId: string, event: string, detail: Record<string, unknown>): void {
    const step = this.ctx.storage.sql
      .exec<{ step: number }>('SELECT step FROM runtime_runs WHERE run_id = ?', runId)
      .one().step;
    const eventKey = runtimeTraceEventKey({ runId, event, step });
    const safeDetail = normaliseRuntimeTraceDetail(event, detail);
    const nextSeq = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM runtime_trace WHERE run_id = ?',
        runId,
      )
      .one().seq;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO runtime_trace (run_id, seq, event_key, event, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      runId,
      nextSeq,
      eventKey,
      event,
      JSON.stringify(safeDetail),
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

function ensureRunLoopSchema(sql: SqlStorage): void {
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
  ensureRuntimeTraceEventKey(sql);
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_trace_event_key_idx
      ON runtime_trace (run_id, event_key)
      WHERE event_key IS NOT NULL;
  `);
}

function ensureRuntimeTraceEventKey(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(runtime_trace)').toArray();
  if (!columns.some((column) => column.name === 'event_key')) {
    sql.exec('ALTER TABLE runtime_trace ADD COLUMN event_key TEXT');
  }
}

function parseScheduleFakeRunInput(input: ScheduleFakeRunInput): ScheduleFakeRunInput {
  if (typeof input.scheduleId !== 'string' || input.scheduleId.length === 0) {
    throw new Error('scheduleFakeRun requires a scheduleId');
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new Error('scheduleFakeRun requires a userId');
  }
  if (!Number.isInteger(input.occurrenceAt) || input.occurrenceAt < 0) {
    throw new Error('scheduleFakeRun requires a non-negative occurrenceAt');
  }
  if (!Number.isInteger(input.dueAt) || input.dueAt < input.occurrenceAt) {
    throw new Error('scheduleFakeRun requires dueAt at or after occurrenceAt');
  }
  return {
    ...input,
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
    return { ok: true, data: { summary: 'derived steady', body_state: 'steady' } };
  },
};

function triggerAllowlistFor(tool: ToolName): TriggerType[] {
  return (Object.keys(TOOL_PERMISSIONS) as TriggerType[]).filter((trigger) =>
    TOOL_PERMISSIONS[trigger].includes(tool),
  );
}

function toolContext(ctx: HookRuntimeContext): ToolDispatcherContext {
  if (ctx.session === undefined) throw new Error('tool dispatch requires a session');
  return { ...ctx, session: ctx.session };
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
  if (value === null) return {};
  return value as ScratchState;
}

function parseNullableJsonObject(text: string | null): Record<string, unknown> | null {
  return text === null ? null : parseJsonObject(text);
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
