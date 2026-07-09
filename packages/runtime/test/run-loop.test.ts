import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ROSTER, RUNTIME_RUN_STATE_SEQUENCE, type LLMResponse } from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

const USER = 'user-run-loop-01';
const FSM = RUNTIME_RUN_STATE_SEQUENCE.filter((state) => state !== 'FAILED');

type RunLoopProof = {
  fsm: string[];
  trace: { event: string; detail: Record<string, unknown> }[];
  context: Record<string, unknown> | null;
  outbox: { kind: string; status: string; attempts: number }[];
  sink: { deliveries: number; attempts: number };
  delivery_journal: { state: string; verdict: string | null };
  current: { state: string; failure_reason: string | null };
};

type RunLoopStub = DurableObjectStub & {
  scheduleFakeRun(input: {
    scheduleId: string;
    userId: string;
    dueAt: number;
    occurrenceAt: number;
  }): Promise<string>;
  readRunProof(runId: string): Promise<RunLoopProof>;
};

type CrashableRunLoopInstance = {
  __runLoopCrashAfter?: string;
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
      );
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
    expect(
      gateway.requests.map((request) =>
        (request.request.system ?? '').split(':').slice(0, 2).join(':'),
      ),
    ).toEqual(['run-loop:plan', 'run-loop:observe']);
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
    },
  );
});
