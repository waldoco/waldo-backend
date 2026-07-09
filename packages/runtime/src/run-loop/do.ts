import { DurableObject } from 'cloudflare:workers';
import {
  TOOL_PERMISSIONS,
  getCrsArgsSchema,
  runtimeRunCanAdvance,
  runtimeRunRecordSchema,
  type AdapterResult,
  type DeliverySink,
  type GetCrsArgs,
  type LLMResponse,
  type RuntimeRunRecord,
  type RuntimeRunState,
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
} from '../llm/provider';
import { RunJournalOutbox } from '../run-journal/outbox-runtime';
import { Scheduler, type ScheduleExecutors } from '../scheduler/multiplexer';
import { productionDeps, type Deps } from '../seams/deps';
import {
  dispatchTool,
  parseToolCalls,
  type RuntimeToolCall,
  type ToolDispatcherContext,
} from '../tools/dispatcher';
import { ensureSchema } from '../tracer/schema';
import { triage } from '../triage/dispatcher';

const TRIGGER = 'brief' satisfies TriggerType;
const PUSH_CLASS = 'brief' as const;
const CANARY_TOKENS = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
const DELIVERY_TEXT = 'Derived steady-state brief ready for delivery.';

export type ScheduleFakeRunInput = {
  scheduleId: string;
  userId: string;
  dueAt: number;
  occurrenceAt: number;
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
  event: string;
  detail_json: string;
};

type ScratchState = {
  tool_calls?: RuntimeToolCall[];
  tool_results?: { tool: ToolName | null; ok: boolean; reason?: string }[];
  llm?: {
    model: string;
    fallback_step: string;
    degraded: boolean;
    tool_call_count: number;
  };
};

class FakeRunLoopGateway implements LLMGatewayAdapter {
  async complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
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

export class RunLoopDO extends DurableObject<Cloudflare.Env> {
  private readonly deps: Deps;
  private readonly scheduler: Scheduler;
  private readonly journalOutbox: RunJournalOutbox;
  private readonly llm: RuntimeLLMProvider;

  __runLoopCrashAfter?: RuntimeRunState;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ensureSchema(ctx.storage);
    ensureRunLoopSchema(ctx.storage.sql);
    this.deps = productionDeps();
    this.scheduler = new Scheduler(ctx.storage.sql, ctx.storage, this.deps);
    this.journalOutbox = new RunJournalOutbox(ctx.storage, this.deps, new RunLoopFakeSink());
    this.llm = new RuntimeLLMProvider({ gateway: new FakeRunLoopGateway() });
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

    const runId = this.journalOutbox.startRun({
      userId: parsed.userId,
      trigger: TRIGGER,
      occurrenceAt: parsed.occurrenceAt,
      candidate: {
        push_class: PUSH_CLASS,
        trigger: TRIGGER,
        event_id: parsed.scheduleId,
        expires_at: null,
      },
    });

    this.openRuntimeRun({
      runId,
      userId: parsed.userId,
      variant: decision.variant ?? null,
      runNonce: parsed.scheduleId,
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
        'SELECT event, detail_json FROM runtime_trace WHERE run_id = ? ORDER BY seq',
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

  override async alarm(): Promise<void> {
    await this.scheduler.dispatchDue(this.scheduleExecutors());
  }

  private scheduleExecutors(): ScheduleExecutors {
    return {
      brief: async (entry) => this.driveScheduledRun(entry),
    };
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
          this.admitGovernor(run.run_id);
          this.recordTrace(run.run_id, 'governor_admitted', { loop_type: 'brief' });
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
          run = await this.gate(run);
          this.crashAfter('GATED');
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
    const result = await this.llm.complete(
      {
        trigger: run.trigger,
        renderRequest({ step, context }) {
          return {
            system: `run-loop:${context}:${step.provider}`,
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
      return this.failRun(run.run_id, `tool_parse:${parsedCalls.code}`);
    }

    const scratch: ScratchState = {
      tool_calls: parsedCalls.calls,
      llm: {
        model: result.response.model,
        fallback_step: result.fallback_step,
        degraded: result.degraded,
        tool_call_count: parsedCalls.calls.length,
      },
    };
    this.journalOutbox.recordLoopUsage({
      runId: run.run_id,
      tokensUsed: result.usage.input_tokens + result.usage.output_tokens,
      iterations: 1,
      subagentSpawns: 0,
    });
    const next = this.advanceRun(run.run_id, 'LLM_CALLED', { scratch });
    this.recordTrace(run.run_id, 'llm_called', {
      model: result.response.model,
      fallback_step: result.fallback_step,
      tool_call_count: parsedCalls.calls.length,
    });
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
      const paramsHash = await this.deps.sha256Hex(JSON.stringify(call.args));
      const resultHash = await this.deps.sha256Hex(JSON.stringify(result));
      this.journalOutbox.recordLoopObservation({
        runId: run.run_id,
        toolName: call.name,
        canonicalParamsHash: paramsHash,
        resultHash,
        success: result.ok,
      });
    }

    const next = this.advanceRun(run.run_id, 'TOOLS_DONE', {
      scratch: { ...scratch, tool_results: results },
    });
    this.recordTrace(run.run_id, 'tool_dispatched', {
      tools: results.filter((result) => result.ok).map((result) => result.tool),
      denied: results.filter((result) => !result.ok).map((result) => result.tool),
    });
    return next;
  }

  private async gate(run: RuntimeRunRecord): Promise<RuntimeRunRecord> {
    const egressDecision = this.journalOutbox.checkLoopEgress({
      runId: run.run_id,
      text: DELIVERY_TEXT,
    });
    if (egressDecision.verdict === 'deny') {
      return this.failRun(run.run_id, `governor:${egressDecision.reason}`);
    }
    const outbox = await this.journalOutbox.enqueueOutbox({
      run_id: run.run_id,
      kind: PUSH_CLASS,
      created_at: this.deps.now(),
      verdict: 'send',
      admissionAt: this.deps.now(),
    });
    const next = this.advanceRun(run.run_id, 'GATED');
    this.recordTrace(run.run_id, 'gated', {
      verdict: 'send',
      outbox_kind: outbox.kind,
    });
    return next;
  }

  private openRuntimeRun(input: {
    runId: string;
    userId: string;
    variant: 'morning' | 'midday' | 'evening' | 'event' | null;
    runNonce: string;
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
        schedule_id: input.runNonce,
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

  private admitGovernor(runId: string): void {
    const legacy = this.journalOutbox.resumeRun(runId);
    if (legacy === null) throw new Error(`admitGovernor: no journal row for ${runId}`);
    if (legacy.state === 'GOVERNOR_ADMITTED') return;
    const decision = this.journalOutbox.admitRun(runId);
    if (decision.verdict === 'deny') {
      throw new Error(`governor denied run: ${decision.reason}`);
    }
  }

  private readRuntimeRun(runId: string): RuntimeRunRecord | null {
    const row = this.ctx.storage.sql
      .exec<RuntimeRunSqlRow>('SELECT * FROM runtime_runs WHERE run_id = ?', runId)
      .toArray()[0];
    return row === undefined ? null : toRuntimeRunRecord(row);
  }

  private requireRuntimeRun(runId: string): RuntimeRunRecord {
    const run = this.readRuntimeRun(runId);
    if (run === null) throw new Error(`runtime run not found: ${runId}`);
    return run;
  }

  private recordTrace(runId: string, event: string, detail: Record<string, unknown>): void {
    const nextSeq = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM runtime_trace WHERE run_id = ?',
        runId,
      )
      .one().seq;
    this.ctx.storage.sql.exec(
      `INSERT INTO runtime_trace (run_id, seq, event, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      nextSeq,
      event,
      JSON.stringify(detail),
      this.deps.now(),
    );
  }

  private crashAfter(state: RuntimeRunState): void {
    if (this.__runLoopCrashAfter === state) {
      throw new Error(`crash-injection:${state}`);
    }
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
      event       TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
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
  return input;
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

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function assertNever(value: never): never {
  throw new Error(`unreachable runtime state: ${String(value)}`);
}
