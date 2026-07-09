import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RUNTIME_RUN_STATE_SEQUENCE } from '@waldo/contracts';

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
