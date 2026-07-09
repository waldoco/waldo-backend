import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ROSTER,
  RUNTIME_RUN_STATE_SEQUENCE,
  type DeliveryCandidate,
  type LLMResponse,
  type RuntimeReplayFixture,
  type RuntimeTraceEval,
} from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

const USER = 'user-run-loop-01';
const FSM = RUNTIME_RUN_STATE_SEQUENCE.filter((state) => state !== 'FAILED');
const LOCAL_RUN_TOKEN = (env as unknown as { RUN_LOOP_LOCAL_INGRESS_TOKEN: string })
  .RUN_LOOP_LOCAL_INGRESS_TOKEN;

type RunLoopProof = {
  fsm: string[];
  trace: { event: string; detail: Record<string, unknown> }[];
  context: Record<string, unknown> | null;
  outbox: { kind: string; status: string; attempts: number }[];
  sink: { deliveries: number; attempts: number };
  delivery_journal: { state: string; verdict: string | null };
  current: { state: string; failure_reason: string | null };
};

type RuntimeRunCountRow = { n: number };

type RunLoopStub = DurableObjectStub & {
  scheduleFakeRun(input: {
    scheduleId: string;
    userId: string;
    dueAt: number;
    occurrenceAt: number;
    candidate?: DeliveryCandidate;
  }): Promise<string>;
  readRunProof(runId: string): Promise<RunLoopProof>;
  readRunEvidence(runId: string): Promise<RuntimeReplayFixture>;
  replayFixture(runId: string): Promise<RuntimeReplayFixture>;
  scoreRun(traceId: string): Promise<RuntimeTraceEval>;
};

type CrashableRunLoopInstance = {
  __runLoopCrashAfter?: string;
  __runLoopOutboxCrashPoint?: string;
  __runLoopSetKillFlag(input: {
    scope: 'global' | 'loop';
    loopType: 'brief' | null;
    active: boolean;
  }): void;
  __runLoopSetTestOverrides(input: { gateway?: LLMGatewayAdapter }): void;
  alarm(): Promise<void>;
};

let seq = 0;
function freshStub(): RunLoopStub {
  seq += 1;
  const namespace = (env as unknown as { RUN_LOOP_DO: DurableObjectNamespace }).RUN_LOOP_DO;
  const id = namespace.idFromName(`run-loop-${seq}`);
  return namespace.get(id) as RunLoopStub;
}

function soon(): number {
  return Date.now() + 500;
}

function utcLocalDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function response(model: string, text: string, inputTokens = 24, outputTokens = 12): LLMResponse {
  return {
    model,
    text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: 0,
    latency_ms: 1,
  } as LLMResponse;
}

function getCrsToolCallText(id: string, rangeDays: number): string {
  return JSON.stringify({
    tool_calls: [
      {
        id,
        name: 'get_crs',
        arguments: { range_days: rangeDays },
      },
    ],
  });
}

function runtimePassSystems(gateway: ScriptedRunLoopGateway): string[] {
  return gateway.requests.map((request) =>
    (request.request.system ?? '').split(':').slice(0, 2).join(':'),
  );
}

class ScriptedRunLoopGateway implements LLMGatewayAdapter {
  readonly requests: LLMGatewayRequest[] = [];

  constructor(private readonly completeWith: (request: LLMGatewayRequest) => LLMResponse) {}

  async complete(request: LLMGatewayRequest) {
    this.requests.push(request);
    return { ok: true as const, data: this.completeWith(request) };
  }
}

describe('RunLoopDO full contract FSM', () => {
  it('walks a scheduled fake-backed run through the full FSM with trace and delivery proof', async () => {
    const stub = freshStub();
    const dueAt = soon();

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:morning',
      userId: USER,
      dueAt,
      occurrenceAt: dueAt,
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual(FSM);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'llm_called',
      'tool_dispatched',
      'llm_observed',
      'gated',
      'delivered',
      'done',
    ]);
    expect(proof.trace.find((event) => event.event === 'tool_dispatched')?.detail).toEqual({
      tools: ['get_crs'],
      denied: [],
    });
    expect(proof.context).toMatchObject({
      source: 'fake-derived',
      trigger: 'brief',
      body_state: 'steady',
    });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    expect(JSON.stringify(proof)).not.toContain('raw');

    const evidence = await stub.readRunEvidence(runId);
    expect(evidence.trace.map((event) => [event.seq, event.family, event.event, event.status])).toEqual([
      [0, 'wake', 'scheduled_wake', 'scheduled'],
      [1, 'governor', 'governor_admitted', 'admitted'],
      [2, 'session', 'session_reset', 'ok'],
      [3, 'context', 'context_built', 'ok'],
      [4, 'llm', 'llm_called', 'ok'],
      [5, 'tool', 'tool_dispatched', 'ok'],
      [6, 'llm', 'llm_observed', 'ok'],
      [7, 'gate', 'gated', 'send'],
      [8, 'delivery', 'delivered', 'acked'],
      [9, 'outcome', 'done', 'done'],
    ]);
    expect(evidence.trace.every((event) => event.trace_id === runId)).toBe(true);
    expect(evidence.trace.every((event) => event.run_id === runId)).toBe(true);
    expect(evidence.trace.every((event) => event.event_key.startsWith(`${runId}:`))).toBe(true);
    expect(evidence.eval).toMatchObject({
      trace_id: runId,
      run_id: runId,
      result: 'pass',
      wis: { available: false, reason: 'not_observed_fake_first' },
    });
    expect(evidence.eval.rules.every((rule) => rule.status === 'pass')).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('prompt');
    expect(JSON.stringify(evidence)).not.toContain('raw_health');

    await expect(stub.replayFixture(runId)).resolves.toEqual(evidence);
    await expect(stub.scoreRun(runId)).resolves.toEqual(evidence.eval);
  });

  it('treats duplicate fake schedule attempts as the same scheduled occurrence', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-duplicate-schedule`;

    const firstRunId = await stub.scheduleFakeRun({
      scheduleId: 'brief:duplicate',
      userId,
      dueAt,
      occurrenceAt: dueAt,
    });
    const secondRunId = await stub.scheduleFakeRun({
      scheduleId: 'brief:duplicate',
      userId,
      dueAt,
      occurrenceAt: dueAt,
    });

    expect(secondRunId).toBe(firstRunId);
    const openedRuns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<RuntimeRunCountRow>('SELECT COUNT(*) AS n FROM runtime_runs WHERE user_id = ?', userId)
        .one().n,
    );
    expect(openedRuns).toBe(1);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as CrashableRunLoopInstance;
      await runLoop.alarm();
    });

    const proof = await stub.readRunProof(firstRunId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('fails closed for unauthenticated local RunLoopDO ingress', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-unauth-ingress`;

    const response = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      body: JSON.stringify({
        scheduleId: 'brief:unauth-ingress',
        userId,
        dueAt,
        occurrenceAt: dueAt,
      }),
    });

    expect(response.status).toBe(401);
    const openedRuns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<RuntimeRunCountRow>('SELECT COUNT(*) AS n FROM runtime_runs WHERE user_id = ?', userId)
        .one().n,
    );
    expect(openedRuns).toBe(0);
  });

  it('schedules and inspects a fake run through authenticated local ingress', async () => {
    const stub = freshStub();
    const dueAt = soon();

    const scheduleResponse = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-waldo-local-run-token': LOCAL_RUN_TOKEN,
      },
      body: JSON.stringify({
        scheduleId: 'brief:local-ingress',
        userId: `${USER}-local-ingress`,
        dueAt,
        occurrenceAt: dueAt,
      }),
    });

    expect(scheduleResponse.status).toBe(202);
    const scheduled = (await scheduleResponse.json()) as { run_id: string };
    expect(scheduled.run_id).toMatch(/[0-9a-f-]{36}/);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const inspectResponse = await stub.fetch(
      `https://run-loop.local/local/runs/${scheduled.run_id}`,
      {
        headers: { 'x-waldo-local-run-token': LOCAL_RUN_TOKEN },
      },
    );

    expect(inspectResponse.status).toBe(200);
    const proof = (await inspectResponse.json()) as RunLoopProof;
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('fails closed for malformed authenticated local ingress without opening a run', async () => {
    const stub = freshStub();

    const response = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-waldo-local-run-token': LOCAL_RUN_TOKEN,
      },
      body: '{',
    });

    expect(response.status).toBe(400);
    const openedRuns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<RuntimeRunCountRow>('SELECT COUNT(*) AS n FROM runtime_runs').one()
        .n,
    );
    expect(openedRuns).toBe(0);
  });

  it('rate-limits authenticated local ingress without opening a run', async () => {
    const stub = freshStub();

    for (let i = 0; i < 32; i += 1) {
      const response = await stub.fetch('https://run-loop.local/local/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-waldo-local-run-token': LOCAL_RUN_TOKEN,
        },
        body: '{',
      });
      expect(response.status).toBe(400);
    }

    const limited = await stub.fetch('https://run-loop.local/local/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-waldo-local-run-token': LOCAL_RUN_TOKEN,
      },
      body: '{',
    });

    expect(limited.status).toBe(429);
    const openedRuns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<RuntimeRunCountRow>('SELECT COUNT(*) AS n FROM runtime_runs').one()
        .n,
    );
    expect(openedRuns).toBe(0);
  });

  it('exercises the DeliveryGate degrade branch through RunLoopDO when budget is exhausted', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-gate-degrade`;

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:gate-degrade',
      userId,
      dueAt,
      occurrenceAt: dueAt,
      candidate: {
        push_class: 'spot_digest',
        trigger: 'brief',
        event_id: 'synthetic-gate-degrade',
        expires_at: null,
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO daily_push_budget (user_id, local_date, sends_total)
         VALUES (?, ?, 3)`,
        userId,
        utcLocalDate(dueAt),
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.find((event) => event.event === 'gated')?.detail).toMatchObject({
      verdict: 'degrade',
      outbox_kind: 'spot_digest',
    });
    expect(proof.outbox).toEqual([{ kind: 'spot_digest', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
    expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'degrade' });
  });

  it('exercises the DeliveryGate hold branch through RunLoopDO without outbox delivery', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-gate-hold`;

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:gate-hold',
      userId,
      dueAt,
      occurrenceAt: dueAt,
      candidate: {
        push_class: 'spot_digest',
        trigger: 'brief',
        event_id: 'synthetic-gate-hold',
        expires_at: null,
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO class_state (user_id, local_date, push_class, count, last_sent_at)
         VALUES (?, ?, 'spot_digest', 1, ?)`,
        userId,
        utcLocalDate(dueAt),
        dueAt - 1,
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'delivery_gate:class_cap_exhausted',
    });
    expect(proof.trace.find((event) => event.event === 'gated')?.detail).toMatchObject({
      verdict: 'hold',
      reason: 'class_cap_exhausted',
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: 'hold' });
  });

  it('exercises the DeliveryGate drop branch through RunLoopDO without outbox delivery', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-gate-drop`;

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:gate-drop',
      userId,
      dueAt,
      occurrenceAt: dueAt,
      candidate: {
        push_class: 'spot_digest',
        trigger: 'brief',
        event_id: 'synthetic-gate-drop',
        expires_at: dueAt - 1,
      },
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'delivery_gate:candidate_expired',
    });
    expect(proof.trace.find((event) => event.event === 'gated')?.detail).toMatchObject({
      verdict: 'drop',
      reason: 'candidate_expired',
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: 'drop' });
  });

  it('fails closed when the governor denies admission before context or delivery', async () => {
    const stub = freshStub();
    const dueAt = soon();

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:admission-kill',
      userId: `${USER}-admission-kill`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetKillFlag({
        scope: 'global',
        loopType: null,
        active: true,
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual(['PENDING', 'FAILED']);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:kill_flag_active',
    });
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_denied',
    ]);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
    expect(proof.delivery_journal).toEqual({ state: 'FAILED', verdict: null });

    const evidence = await stub.readRunEvidence(runId);
    expect(evidence.trace.map((event) => [event.family, event.event, event.status])).toEqual([
      ['wake', 'scheduled_wake', 'scheduled'],
      ['governor', 'governor_denied', 'denied'],
      ['outcome', 'failed', 'failed'],
    ]);
    expect(evidence.eval.result).toBe('pass');
    expect(evidence.eval.rules.find((rule) => rule.id === 'failure_visible')).toMatchObject({
      status: 'pass',
    });
  });

  it('stops before tools and delivery when LLM usage exhausts governor budget', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-get-crs',
              name: 'get_crs',
              arguments: { range_days: 1 },
            },
          ],
        }),
        24_001,
        0,
      ),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:budget-kill',
      userId: `${USER}-budget-kill`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual(['PENDING', 'CONTEXT_BUILT', 'FAILED']);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:token_budget_exhausted',
    });
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'llm_called',
      'governor_denied',
    ]);
    expect(proof.trace.find((event) => event.event === 'tool_dispatched')).toBeUndefined();
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });

    const evidence = await stub.readRunEvidence(runId);
    expect(evidence.trace.find((event) => event.event === 'governor_denied')).toMatchObject({
      family: 'governor',
      status: 'denied',
      privacy: 'policy_metadata',
    });
    expect(evidence.eval.rules.find((rule) => rule.id === 'failure_visible')).toMatchObject({
      status: 'pass',
    });
  });

  it('fails durably when the LLM emits malformed tool-call JSON', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(request.request.model, 'not-json'),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:malformed-tools',
      userId: `${USER}-malformed-tools`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual(['PENDING', 'CONTEXT_BUILT', 'FAILED']);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_parse:invalid_args',
    });
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'tool_parse_failed',
    ]);
    expect(proof.trace.find((event) => event.event === 'tool_parse_failed')?.detail).toEqual({
      code: 'invalid_args',
    });
    expect(proof.outbox).toEqual([]);
  });

  it('fails durably when a tool is denied by the trigger ACL', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-write-task',
              name: 'write_task',
              arguments: { title: 'synthetic denied task', reasoning: 'synthetic' },
            },
          ],
        }),
      ),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:denied-tool',
      userId: `${USER}-denied-tool`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_dispatch:acl_denied',
    });
    expect(proof.trace.find((event) => event.event === 'tool_dispatched')?.detail).toEqual({
      tools: [],
      denied: ['write_task'],
      reasons: ['acl_denied'],
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('fails durably when tool arguments fail schema validation', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-bad-get-crs',
              name: 'get_crs',
              arguments: { range_days: 999 },
            },
          ],
        }),
      ),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:bad-tool-args',
      userId: `${USER}-bad-tool-args`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_dispatch:invalid_args',
    });
    expect(proof.trace.find((event) => event.event === 'tool_dispatched')?.detail).toEqual({
      tools: [],
      denied: ['get_crs'],
      reasons: ['invalid_args'],
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('fails durably when the governor detects no progress from tool observations', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const userId = `${USER}-no-progress`;
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-get-crs',
              name: 'get_crs',
              arguments: { range_days: 1 },
            },
          ],
        }),
      ),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:no-progress',
      userId,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, async (instance, state) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
      const occurrenceId = state.storage.sql
        .exec<{ occurrence_id: string }>(
          'SELECT occurrence_id FROM loop_governor_runs WHERE run_id = ?',
          runId,
        )
        .one().occurrence_id;
      state.storage.sql.exec(
        `INSERT INTO loop_progress
           (user_id, loop_type, occurrence_id, call_count, unique_param_hashes, successes, updated_at)
         VALUES (?, 'brief', ?, 4, 0, 0, ?)`,
        userId,
        occurrenceId,
        dueAt,
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:no_progress',
    });
    expect(proof.trace.map((event) => event.event)).toContain('governor_denied');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('accumulates plan and observe usage before applying the governor budget', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, 'Synthesized brief after get_crs observation.', 12_001, 0);
      }
      return response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-get-crs',
              name: 'get_crs',
              arguments: { range_days: 1 },
            },
          ],
        }),
        12_000,
        0,
      );
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:cumulative-budget-kill',
      userId: `${USER}-cumulative-budget-kill`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual(['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'FAILED']);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:token_budget_exhausted',
    });
    expect(proof.trace.map((event) => event.event)).toEqual([
      'scheduled_wake',
      'governor_admitted',
      'session_reset',
      'context_built',
      'llm_called',
      'tool_dispatched',
      'llm_observed',
      'governor_denied',
    ]);
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('synthesizes delivery from tool observations instead of gating a constant payload', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, 'Synthesized brief after get_crs observation.');
      }
      return response(request.request.model, getCrsToolCallText('call-get-crs', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:observe-pass',
      userId: `${USER}-observe-pass`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(runtimePassSystems(gateway)).toEqual(['run-loop:plan', 'run-loop:observe']);
    expect(proof.trace.find((event) => event.event === 'llm_observed')?.detail).toEqual({
      model: ROSTER.primary,
      fallback_step: 'configured_model',
      delivery_text_source: 'llm',
    });
    expect(proof.trace.find((event) => event.event === 'gated')?.detail).toEqual({
      verdict: 'send',
      outbox_kind: 'brief',
      delivery_text_source: 'llm',
    });
  });

  it('runs multiple governed model/tool/observe passes before terminal gate and delivery', async () => {
    const stub = freshStub();
    const dueAt = soon();
    let observeCalls = 0;
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        observeCalls += 1;
        if (observeCalls === 1) {
          return response(request.request.model, getCrsToolCallText('call-get-crs-2', 2));
        }
        return response(request.request.model, 'Synthesized brief after two get_crs observations.');
      }
      return response(request.request.model, getCrsToolCallText('call-get-crs-1', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:multi-pass',
      userId: `${USER}-multi-pass`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(runtimePassSystems(gateway)).toEqual([
      'run-loop:plan',
      'run-loop:observe',
      'run-loop:observe',
    ]);
    expect(
      proof.trace
        .map((event) => event.event)
        .filter((event) => event === 'llm_called' || event === 'tool_dispatched' || event === 'llm_observed'),
    ).toEqual([
      'llm_called',
      'tool_dispatched',
      'llm_observed',
      'tool_dispatched',
      'llm_observed',
    ]);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });

    const evidence = await stub.readRunEvidence(runId);
    expect(new Set(evidence.trace.map((event) => event.event_key)).size).toBe(
      evidence.trace.length,
    );
    expect(evidence.fsm).toEqual(proof.fsm);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('raw_health');
    expect(serialized).not.toContain('provider_body');
    expect(serialized).not.toContain('credentials');
  });

  it('fails durably when an observe pass emits a malformed tool-call envelope', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, JSON.stringify({ tool_calls: 'oops' }));
      }
      return response(request.request.model, getCrsToolCallText('call-observe-malformed', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:observe-malformed-tools',
      userId: `${USER}-observe-malformed-tools`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'FAILED',
    ]);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_parse:invalid_args',
    });
    expect(runtimePassSystems(gateway)).toEqual(['run-loop:plan', 'run-loop:observe']);
    expect(proof.trace.map((event) => event.event)).toContain('llm_observed');
    expect(proof.trace.find((event) => event.event === 'tool_parse_failed')?.detail).toEqual({
      code: 'invalid_args',
    });
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('treats unrelated terminal JSON from observe as delivery text', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, JSON.stringify(['Synthesized brief as JSON.']));
      }
      return response(request.request.model, getCrsToolCallText('call-observe-json-terminal', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:observe-json-terminal',
      userId: `${USER}-observe-json-terminal`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.map((event) => event.event)).not.toContain('tool_parse_failed');
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('accumulates usage across every loop pass and stops before gate when budget is exhausted', async () => {
    const stub = freshStub();
    const dueAt = soon();
    let observeCalls = 0;
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        observeCalls += 1;
        if (observeCalls === 1) {
          return response(request.request.model, getCrsToolCallText('call-budget-2', 2), 8_000, 0);
        }
        return response(request.request.model, 'Synthesized brief after budget edge.', 8_001, 0);
      }
      return response(request.request.model, getCrsToolCallText('call-budget-1', 1), 8_000, 0);
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:multi-pass-budget-kill',
      userId: `${USER}-multi-pass-budget-kill`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'FAILED',
    ]);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:token_budget_exhausted',
    });
    expect(runtimePassSystems(gateway)).toEqual([
      'run-loop:plan',
      'run-loop:observe',
      'run-loop:observe',
    ]);
    expect(proof.trace.map((event) => event.event).at(-1)).toBe('governor_denied');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('terminates deterministically when the governed iteration budget is exhausted', async () => {
    const stub = freshStub();
    const dueAt = soon();
    let llmCalls = 0;
    const gateway = new ScriptedRunLoopGateway((request) => {
      llmCalls += 1;
      return response(request.request.model, getCrsToolCallText(`call-iteration-${llmCalls}`, llmCalls));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:iteration-budget-exhausted',
      userId: `${USER}-iteration-budget-exhausted`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(gateway.requests).toHaveLength(11);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:iteration_budget_exhausted',
    });
    expect(proof.trace.map((event) => event.event)).toContain('governor_denied');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('fails durably when an observe pass repeats the same tool observation', async () => {
    const stub = freshStub();
    const dueAt = soon();
    let observeCalls = 0;
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        observeCalls += 1;
        if (observeCalls === 1) {
          return response(request.request.model, getCrsToolCallText('call-duplicate-2', 1));
        }
        return response(request.request.model, 'Should not gate after duplicate observation.');
      }
      return response(request.request.model, getCrsToolCallText('call-duplicate-1', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:duplicate-observation',
      userId: `${USER}-duplicate-observation`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:duplicate_observation',
    });
    expect(proof.trace.map((event) => event.event)).toContain('governor_denied');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('resumes a multi-pass run from TOOLS_DONE without re-executing completed tools', async () => {
    const stub = freshStub();
    const dueAt = soon();
    let observeCalls = 0;
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        observeCalls += 1;
        if (observeCalls === 1) {
          return response(request.request.model, getCrsToolCallText('call-resume-2', 2));
        }
        return response(request.request.model, 'Synthesized brief after resumed observations.');
      }
      return response(request.request.model, getCrsToolCallText('call-resume-1', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:multi-pass-resume',
      userId: `${USER}-multi-pass-resume`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as CrashableRunLoopInstance;
      runLoop.__runLoopCrashAfter = 'TOOLS_DONE';
      runLoop.__runLoopSetTestOverrides({ gateway });
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TOOLS_DONE');
    const atCrash = await stub.readRunProof(runId);
    expect(atCrash.fsm).toEqual(['PENDING', 'CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE']);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
      await (instance as unknown as CrashableRunLoopInstance).alarm();

      const progress = state.storage.sql
        .exec<{ call_count: number }>(
          `SELECT call_count
             FROM loop_progress
            WHERE user_id = ? AND loop_type = 'brief'`,
          `${USER}-multi-pass-resume`,
        )
        .one();
      expect(progress.call_count).toBe(2);
    });

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.fsm).toEqual([
      'PENDING',
      'CONTEXT_BUILT',
      'LLM_CALLED',
      'TOOLS_DONE',
      'LLM_CALLED',
      'TOOLS_DONE',
      'GATED',
      'DELIVERED',
      'DONE',
    ]);
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it('honors a kill flag before the next observe LLM call after resume', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, 'Should not be called after kill flag.');
      }
      return response(request.request.model, getCrsToolCallText('call-kill-before-observe', 1));
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:kill-before-observe',
      userId: `${USER}-kill-before-observe`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      const runLoop = instance as unknown as CrashableRunLoopInstance;
      runLoop.__runLoopCrashAfter = 'TOOLS_DONE';
      runLoop.__runLoopSetTestOverrides({ gateway });
    });

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('crash-injection:TOOLS_DONE');
    expect(gateway.requests).toHaveLength(1);

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      const runLoop = instance as unknown as CrashableRunLoopInstance;
      runLoop.__runLoopSetTestOverrides({ gateway });
      runLoop.__runLoopSetKillFlag({ scope: 'loop', loopType: 'brief', active: true });
      await runLoop.alarm();
    });

    const proof = await stub.readRunProof(runId);
    expect(gateway.requests).toHaveLength(1);
    expect(proof.current).toEqual({
      state: 'FAILED',
      failure_reason: 'governor:kill_flag_active',
    });
    expect(proof.trace.map((event) => event.event)).toContain('governor_denied');
    expect(proof.outbox).toEqual([]);
    expect(proof.sink).toEqual({ deliveries: 0, attempts: 0 });
  });

  it('exposes malformed LLM output as a terminal replayable failure', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) =>
      response(request.request.model, 'not-json-tool-call'),
    );

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:malformed-llm',
      userId: `${USER}-malformed-llm`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const evidence = await stub.readRunEvidence(runId);
    expect(evidence.current).toEqual({
      state: 'FAILED',
      failure_reason: 'tool_parse:invalid_args',
    });
    expect(evidence.trace.map((event) => [event.family, event.event])).toEqual([
      ['wake', 'scheduled_wake'],
      ['governor', 'governor_admitted'],
      ['session', 'session_reset'],
      ['context', 'context_built'],
      ['tool', 'tool_parse_failed'],
      ['outcome', 'failed'],
    ]);
    expect(evidence.eval.rules.find((rule) => rule.id === 'failure_visible')).toMatchObject({
      status: 'pass',
    });
  });

  it('records denied tool outcomes without storing tool result bodies', async () => {
    const stub = freshStub();
    const dueAt = soon();
    const gateway = new ScriptedRunLoopGateway((request) => {
      if ((request.request.system ?? '').startsWith('run-loop:observe')) {
        return response(request.request.model, 'Synthesized brief after denied tool observation.');
      }
      return response(
        request.request.model,
        JSON.stringify({
          tool_calls: [
            {
              id: 'call-unknown',
              name: 'get_crs',
              arguments: { range_days: 999 },
            },
          ],
        }),
      );
    });

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:tool-denial',
      userId: `${USER}-tool-denial`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({ gateway });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const evidence = await stub.readRunEvidence(runId);
    const toolEvent = evidence.trace.find((event) => event.event === 'tool_dispatched');
    expect(toolEvent).toMatchObject({
      family: 'tool',
      status: 'denied',
      detail: { tools: [], denied: ['get_crs'] },
    });
    expect(JSON.stringify(toolEvent)).not.toContain('result');
  });

  it('resumes governor admission from the stored decision instead of fabricating brief', async () => {
    const stub = freshStub();
    const dueAt = soon();

    const runId = await stub.scheduleFakeRun({
      scheduleId: 'brief:stored-governor-decision',
      userId: `${USER}-stored-governor-decision`,
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `UPDATE journal
              SET state = 'GOVERNOR_ADMITTED',
                  updated_at = ?
            WHERE run_id = ?`,
          dueAt,
          runId,
        );
        state.storage.sql.exec(
          `UPDATE loop_governor_runs
              SET loop_type = 'patrol',
                  verdict = 'admit',
                  reason = 'policy_admitted',
                  disposition = NULL,
                  updated_at = ?
            WHERE run_id = ?`,
          dueAt,
          runId,
        );
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const proof = await stub.readRunProof(runId);
    expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
    expect(proof.trace.find((event) => event.event === 'governor_admitted')?.detail).toEqual({
      loop_type: 'patrol',
    });
    expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
    expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
  });

  it.each(['CONTEXT_BUILT', 'LLM_CALLED', 'TOOLS_DONE', 'GATED', 'DELIVERED'] as const)(
    'resumes after eviction from %s without duplicate delivery',
    async (crashAfter) => {
      const stub = freshStub();
      const dueAt = soon();

      const runId = await stub.scheduleFakeRun({
        scheduleId: `brief:${crashAfter.toLowerCase()}`,
        userId: `${USER}-${crashAfter.toLowerCase()}`,
        dueAt,
        occurrenceAt: dueAt,
      });
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as CrashableRunLoopInstance;
        runLoop.__runLoopCrashAfter = crashAfter;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:${crashAfter}`,
      );
      const atCrash = await stub.readRunProof(runId);
      expect(atCrash.fsm.at(-1)).toBe(crashAfter);

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as CrashableRunLoopInstance;
        await runLoop.alarm();
      });

      const proof = await stub.readRunProof(runId);
      expect(proof.fsm).toEqual(FSM);
      expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
      expect(proof.outbox).toEqual([{ kind: 'brief', status: 'acked', attempts: 1 }]);
      expect(proof.sink).toEqual({ deliveries: 1, attempts: 1 });
      expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });

      const evidence = await stub.readRunEvidence(runId);
      expect(new Set(evidence.trace.map((event) => event.event_key)).size).toBe(
        evidence.trace.length,
      );
    },
  );

  it.each([
    {
      crashPoint: 'post_gate_pre_flush',
      atCrashOutbox: [{ kind: 'brief', status: 'pending', attempts: 0 }],
      atCrashSink: { deliveries: 0, attempts: 0 },
      finalOutbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      finalSink: { deliveries: 1, attempts: 1 },
    },
    {
      crashPoint: 'post_attempt_pre_send',
      atCrashOutbox: [{ kind: 'brief', status: 'sent_unacked', attempts: 1 }],
      atCrashSink: { deliveries: 0, attempts: 0 },
      finalOutbox: [{ kind: 'brief', status: 'acked', attempts: 2 }],
      finalSink: { deliveries: 1, attempts: 1 },
    },
    {
      crashPoint: 'post_sink_pre_ack',
      atCrashOutbox: [{ kind: 'brief', status: 'sent_unacked', attempts: 1 }],
      atCrashSink: { deliveries: 1, attempts: 1 },
      finalOutbox: [{ kind: 'brief', status: 'acked', attempts: 2 }],
      finalSink: { deliveries: 1, attempts: 2 },
    },
    {
      crashPoint: 'post_ack_pre_return',
      atCrashOutbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      atCrashSink: { deliveries: 1, attempts: 1 },
      finalOutbox: [{ kind: 'brief', status: 'acked', attempts: 1 }],
      finalSink: { deliveries: 1, attempts: 1 },
    },
  ] as const)(
    'resumes after outbox crash at $crashPoint without duplicate delivery',
    async ({ crashPoint, atCrashOutbox, atCrashSink, finalOutbox, finalSink }) => {
      const stub = freshStub();
      const dueAt = soon();

      const runId = await stub.scheduleFakeRun({
        scheduleId: `brief:${crashPoint}`,
        userId: `${USER}-${crashPoint}`,
        dueAt,
        occurrenceAt: dueAt,
      });
      await runInDurableObject(stub, (instance) => {
        const runLoop = instance as unknown as CrashableRunLoopInstance;
        runLoop.__runLoopOutboxCrashPoint = crashPoint;
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
        `crash-injection:${crashPoint}`,
      );
      const atCrash = await stub.readRunProof(runId);
      expect(atCrash.current).toEqual({ state: 'GATED', failure_reason: null });
      expect(atCrash.outbox).toEqual(atCrashOutbox);
      expect(atCrash.sink).toEqual(atCrashSink);

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        const runLoop = instance as unknown as CrashableRunLoopInstance;
        await runLoop.alarm();
      });

      const proof = await stub.readRunProof(runId);
      expect(proof.current).toEqual({ state: 'DONE', failure_reason: null });
      expect(proof.outbox).toEqual(finalOutbox);
      expect(proof.sink).toEqual(finalSink);
      expect(proof.delivery_journal).toEqual({ state: 'DONE', verdict: 'send' });
    },
  );
});
