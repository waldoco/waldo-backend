import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { LoopType, TriggerType } from '@waldo/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { compareLoopAdmission } from '../src/loop-governor/governor';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

// ADR-0074: an unregistered loop policy is denied before DeliveryGate or outbox state can mutate.
const USER = 'user-loop-governor-01';

type RuntimeStub = DurableObjectStub<TracerDO> & {
  startRun(input: {
    userId: string;
    trigger: TriggerType;
    occurrenceAt: number;
    loopType?: LoopType;
    occurrenceId?: string;
    candidate: {
      push_class: 'brief' | 'fetch_alert';
      trigger: 'brief' | 'fetch_alert';
      event_id: string;
      expires_at: null;
    };
  }): Promise<string>;
  admitRun(runId: string): Promise<unknown>;
  recordLoopUsage(input: {
    runId: string;
    tokensUsed?: number;
    iterations?: number;
    subagentSpawns?: number;
  }): Promise<unknown>;
  setLoopKillFlag(input: {
    scope: 'global' | 'loop';
    loopType: LoopType | null;
    active: boolean;
  }): Promise<void>;
  recordLoopObservation(input: {
    runId: string;
    toolName: 'read_memory';
    canonicalParamsHash: string;
    resultHash: string;
    success: boolean;
  }): Promise<unknown>;
  checkLoopEgress(input: { runId: string; text: string }): Promise<unknown>;
  tickRun(runId: string): Promise<void>;
};

beforeEach(() => {
  FakeSink.shared.reset();
});

let seq = 0;
function freshRuntimeStub(): RuntimeStub {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`loop-governor-${seq}`);
  return env.TRACER_DO.get(id) as RuntimeStub;
}

function futureOccurrence(): number {
  return Date.now() + 3_600_000;
}

async function tick(stub: RuntimeStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as TracerDO).tickRun(runId);
  });
}

async function admit(stub: RuntimeStub, runId: string): Promise<unknown> {
  return runInDurableObject(stub, async (instance) => {
    return (instance as TracerDO & { admitRun(runId: string): Promise<unknown> }).admitRun(runId);
  });
}

async function recordUsage(
  stub: RuntimeStub,
  input: { runId: string; tokensUsed?: number; iterations?: number; subagentSpawns?: number },
): Promise<unknown> {
  return runInDurableObject(stub, async (instance) => {
    const runtime = instance as TracerDO & {
      recordLoopUsage(input: {
        runId: string;
        tokensUsed?: number;
        iterations?: number;
        subagentSpawns?: number;
      }): Promise<unknown>;
    };
    return runtime.recordLoopUsage(input);
  });
}

async function setKillFlag(
  stub: RuntimeStub,
  input: { scope: 'global' | 'loop'; loopType: LoopType | null; active: boolean },
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const runtime = instance as TracerDO & {
      setLoopKillFlag(input: {
        scope: 'global' | 'loop';
        loopType: LoopType | null;
        active: boolean;
      }): Promise<void>;
    };
    await runtime.setLoopKillFlag(input);
  });
}

async function recordObservation(
  stub: RuntimeStub,
  input: {
    runId: string;
    toolName: 'read_memory';
    canonicalParamsHash: string;
    resultHash: string;
    success: boolean;
  },
): Promise<unknown> {
  return runInDurableObject(stub, async (instance) => {
    const runtime = instance as TracerDO & {
      recordLoopObservation(input: {
        runId: string;
        toolName: 'read_memory';
        canonicalParamsHash: string;
        resultHash: string;
        success: boolean;
      }): Promise<unknown>;
    };
    return runtime.recordLoopObservation(input);
  });
}

async function checkEgress(
  stub: RuntimeStub,
  input: { runId: string; text: string },
): Promise<unknown> {
  return runInDurableObject(stub, async (instance) => {
    const runtime = instance as TracerDO & {
      checkLoopEgress(input: { runId: string; text: string }): Promise<unknown>;
    };
    return runtime.checkLoopEgress(input);
  });
}

async function readState(stub: RuntimeStub, runId: string) {
  return runInDurableObject(stub, (_instance, state) => {
    const journal = state.storage.sql
      .exec<{ state: string; verdict: string | null; gate_reason: string | null }>(
        'SELECT state, verdict, gate_reason FROM journal WHERE run_id = ?',
        runId,
      )
      .one();
    const outboxRows = state.storage.sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE run_id = ?', runId)
      .one().n;
    const classRows = state.storage.sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM class_state WHERE user_id = ?', USER)
      .one().n;
    const budgetRows = state.storage.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM daily_push_budget WHERE user_id = ?',
        USER,
      )
      .one().n;
    const governor = state.storage.sql
      .exec<{
        verdict: string | null;
        reason: string | null;
        disposition: string | null;
        tokens_used: number;
      }>(
        'SELECT verdict, reason, disposition, tokens_used FROM loop_governor_runs WHERE run_id = ?',
        runId,
      )
      .one();
    return { ...journal, outboxRows, classRows, budgetRows, governor };
  });
}

describe('Loop Governor runtime gate', () => {
  it('arbitrates contended windows by policy tier, then occurrence time', () => {
    const contenders = [
      { loopType: 'brief' as const, occurrenceAt: 2_000, sequence: 0 },
      { loopType: 'fetch' as const, occurrenceAt: 3_000, sequence: 1 },
      { loopType: 'brief' as const, occurrenceAt: 1_000, sequence: 2 },
    ].sort(compareLoopAdmission);

    expect(contenders.map((candidate) => [candidate.loopType, candidate.occurrenceAt])).toEqual([
      ['fetch', 3_000],
      ['brief', 1_000],
      ['brief', 2_000],
    ]);
  });

  it('denies an unregistered loop before DeliveryGate or outbox side effects', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'brief',
      occurrenceAt: futureOccurrence(),
      loopType: 'chat',
      candidate: {
        push_class: 'brief',
        trigger: 'brief',
        event_id: 'chat-loop-open-decision',
        expires_at: null,
      },
    });

    await tick(runtime, runId);

    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'policy_missing',
        disposition: null,
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('kills an admitted run when token budget is exhausted without DeliveryGate side effects', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-budget-kill',
        expires_at: null,
      },
    });

    expect(await admit(runtime, runId)).toMatchObject({
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
    });

    expect(await recordUsage(runtime, { runId, tokensUsed: 16_001 })).toMatchObject({
      verdict: 'deny',
      reason: 'token_budget_exhausted',
      disposition: 'killed',
    });

    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'token_budget_exhausted',
        disposition: 'killed',
        tokens_used: 16_001,
      },
    });

    expect(
      await checkEgress(runtime, {
        runId,
        text: 'Recovery looks constrained; keep the next block quiet.',
      }),
    ).toMatchObject({
      verdict: 'deny',
      reason: 'token_budget_exhausted',
      disposition: 'killed',
    });
    expect(await readState(runtime, runId)).toMatchObject({
      state: 'FAILED',
      governor: {
        verdict: 'deny',
        reason: 'token_budget_exhausted',
        disposition: 'killed',
        tokens_used: 16_001,
      },
    });
  });

  it('marks max-iteration exhaustion as couldnt_converge without DeliveryGate side effects', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-iteration-exhausted',
        expires_at: null,
      },
    });
    await admit(runtime, runId);

    expect(await recordUsage(runtime, { runId, iterations: 9 })).toMatchObject({
      verdict: 'deny',
      reason: 'iteration_budget_exhausted',
      disposition: 'couldnt_converge',
    });

    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'iteration_budget_exhausted',
        disposition: 'couldnt_converge',
        tokens_used: 0,
      },
    });
  });

  it('kills an admitted run when subagent budget is exhausted without DeliveryGate side effects', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'brief',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'brief',
        trigger: 'brief',
        event_id: 'brief-subagent-exhausted',
        expires_at: null,
      },
    });
    await admit(runtime, runId);

    expect(await recordUsage(runtime, { runId, subagentSpawns: 3 })).toMatchObject({
      verdict: 'deny',
      reason: 'subagent_budget_exhausted',
      disposition: 'killed',
    });

    expect(await readState(runtime, runId)).toMatchObject({
      state: 'FAILED',
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'subagent_budget_exhausted',
        disposition: 'killed',
      },
    });
  });

  it('persists a global kill flag across eviction and blocks before DeliveryGate', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    await setKillFlag(runtime, { scope: 'global', loopType: null, active: true });
    await evictDurableObject(runtime);

    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-global-kill',
        expires_at: null,
      },
    });

    await tick(runtime, runId);
    await tick(runtime, runId);

    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'kill_flag_active',
        disposition: 'killed',
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('fails closed on malformed kill flags before DeliveryGate side effects', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO loop_kill_flags (flag_key, scope, loop_type, active, updated_at)
         VALUES ('global', 'global', NULL, 2, 1)`,
      );
    });
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-corrupt-kill-flag',
        expires_at: null,
      },
    });

    await expect(tick(runtime, runId)).rejects.toThrow(/kill flag active value/i);

    expect(await readState(runtime, runId)).toMatchObject({
      state: 'RUN_OPENED',
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: null,
        reason: null,
        disposition: null,
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('honors a loop kill flag set after admission before the next governed seam', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-post-admission-kill',
        expires_at: null,
      },
    });
    await admit(runtime, runId);
    await setKillFlag(runtime, { scope: 'loop', loopType: 'fetch', active: true });

    expect(
      await checkEgress(runtime, {
        runId,
        text: 'Recovery looks constrained; keep the next block quiet.',
      }),
    ).toMatchObject({
      verdict: 'deny',
      reason: 'kill_flag_active',
      disposition: 'killed',
    });

    expect(await readState(runtime, runId)).toMatchObject({
      state: 'FAILED',
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'kill_flag_active',
        disposition: 'killed',
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('marks no-progress when repeated observations have low diversity and low success', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      loopType: 'patrol',
      occurrenceId: 'patrol-stuck-window',
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'patrol-stuck-window',
        expires_at: null,
      },
    });
    await admit(runtime, runId);

    let decision: unknown = null;
    for (let i = 0; i < 5; i += 1) {
      decision = await recordObservation(runtime, {
        runId,
        toolName: 'read_memory',
        canonicalParamsHash: 'a'.repeat(64),
        resultHash: i.toString(16).repeat(64),
        success: false,
      });
    }

    expect(decision).toMatchObject({
      verdict: 'deny',
      reason: 'no_progress',
      disposition: 'no_progress',
    });
    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'no_progress',
        disposition: 'no_progress',
        tokens_used: 0,
      },
    });
  });

  it('marks no-progress across resumed runs in the same loop window', async () => {
    const runtime = freshRuntimeStub();
    const occurrenceAt = futureOccurrence();
    let lastRunId = '';
    let decision: unknown = null;

    for (let i = 0; i < 5; i += 1) {
      if (i === 2) {
        await evictDurableObject(runtime);
      }
      lastRunId = await runtime.startRun({
        userId: USER,
        trigger: 'fetch_alert',
        occurrenceAt,
        loopType: 'patrol',
        candidate: {
          push_class: 'fetch_alert',
          trigger: 'fetch_alert',
          event_id: `patrol-cross-run-window-${i}`,
          expires_at: null,
        },
      });
      await admit(runtime, lastRunId);
      decision = await recordObservation(runtime, {
        runId: lastRunId,
        toolName: 'read_memory',
        canonicalParamsHash: '1'.repeat(64),
        resultHash: (i + 1).toString(16).repeat(64),
        success: false,
      });
    }

    expect(decision).toMatchObject({
      verdict: 'deny',
      reason: 'no_progress',
      disposition: 'no_progress',
    });
    expect(await readState(runtime, lastRunId)).toMatchObject({
      state: 'FAILED',
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'no_progress',
        disposition: 'no_progress',
      },
    });
  });

  it('short-circuits duplicate tool observations within a run', async () => {
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      loopType: 'patrol',
      occurrenceId: 'patrol-duplicate-observation',
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'patrol-duplicate-observation',
        expires_at: null,
      },
    });
    await admit(runtime, runId);
    const observation = {
      runId,
      toolName: 'read_memory' as const,
      canonicalParamsHash: 'e'.repeat(64),
      resultHash: 'f'.repeat(64),
      success: false,
    };

    expect(await recordObservation(runtime, observation)).toMatchObject({
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
    });
    expect(await recordObservation(runtime, observation)).toMatchObject({
      verdict: 'deny',
      reason: 'duplicate_observation',
      disposition: 'couldnt_converge',
    });

    expect(await readState(runtime, runId)).toMatchObject({
      state: 'FAILED',
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'duplicate_observation',
        disposition: 'couldnt_converge',
        tokens_used: 0,
      },
    });
  });

  it('admits floor-safe egress without DeliveryGate side effects', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-egress-floor',
        expires_at: null,
      },
    });
    await admit(runtime, runId);

    expect(
      await checkEgress(runtime, {
        runId,
        text: 'Recovery looks constrained; keep the next block quiet.',
      }),
    ).toMatchObject({
      verdict: 'admit',
      reason: 'policy_admitted',
      disposition: null,
    });

    expect(await readState(runtime, runId)).toEqual({
      state: 'GOVERNOR_ADMITTED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'admit',
        reason: 'policy_admitted',
        disposition: null,
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('blocks floor-unsafe egress before DeliveryGate side effects', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'fetch-egress-blocked',
        expires_at: null,
      },
    });
    await admit(runtime, runId);

    const metricToken = String.fromCharCode(104, 114, 118);
    const unitToken = String.fromCharCode(109, 115);
    expect(
      await checkEgress(runtime, {
        runId,
        text: `${metricToken}_${unitToken}: "${'0'.repeat(6)}"`,
      }),
    ).toMatchObject({
      verdict: 'deny',
      reason: 'art9_egress_blocked',
      disposition: 'killed',
    });

    expect(await readState(runtime, runId)).toEqual({
      state: 'FAILED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'deny',
        reason: 'art9_egress_blocked',
        disposition: 'killed',
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });

  it('fails closed on malformed loop progress rows before outbox side effects', async () => {
    const sink = FakeSink.shared;
    const runtime = freshRuntimeStub();
    const runId = await runtime.startRun({
      userId: USER,
      trigger: 'fetch_alert',
      occurrenceAt: futureOccurrence(),
      loopType: 'patrol',
      occurrenceId: 'patrol-corrupt-progress',
      candidate: {
        push_class: 'fetch_alert',
        trigger: 'fetch_alert',
        event_id: 'patrol-corrupt-progress',
        expires_at: null,
      },
    });
    await admit(runtime, runId);
    await runInDurableObject(runtime, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO loop_progress
           (user_id, loop_type, occurrence_id, call_count, unique_param_hashes, successes, updated_at)
         VALUES (?, 'patrol', 'patrol-corrupt-progress', 1, 2, 0, 1)`,
        USER,
      );
    });

    await expect(
      recordObservation(runtime, {
        runId,
        toolName: 'read_memory',
        canonicalParamsHash: 'c'.repeat(64),
        resultHash: 'd'.repeat(64),
        success: false,
      }),
    ).rejects.toThrow(/unique_param_hashes/i);

    expect(await readState(runtime, runId)).toEqual({
      state: 'GOVERNOR_ADMITTED',
      verdict: null,
      gate_reason: null,
      outboxRows: 0,
      classRows: 0,
      budgetRows: 0,
      governor: {
        verdict: 'admit',
        reason: 'policy_admitted',
        disposition: null,
        tokens_used: 0,
      },
    });
    expect(sink.observedSendAttempts()).toBe(0);
  });
});
