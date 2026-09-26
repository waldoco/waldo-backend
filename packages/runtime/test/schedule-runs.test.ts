import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';
import type { TracerDO } from '../src/tracer/tracer-do';

let seq = 0;
const stub = () => env.TRACER_DO.get(env.TRACER_DO.idFromName(`schedule-runs-${(seq += 1)}`)) as DurableObjectStub<TracerDO>;
const deps = (now: number): Deps => ({ now: () => now, newRunId: () => 'run-fixed', newOutboxId: () => 'out-fixed', sha256Hex: async () => 'sha-fixed' });

type RunRow = {
  id: string; schedule_id: string; kind: string; fired_at: number; attempt: number;
  outcome: string; error_class: string | null; settled_at: number | null; duration_ms: number | null;
};

const withScheduler = async <T>(now: number, work: (scheduler: Scheduler, readRuns: () => RunRow[]) => Promise<T> | T) =>
  runInDurableObject(stub(), async (_instance, state) => {
    const scheduler = new Scheduler(state.storage.sql, state.storage, deps(now));
    const readRuns = () =>
      state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY fired_at, id').toArray();
    return work(scheduler, readRuns);
  });

describe('schedule_runs history (C4)', () => {
  it('writes one settled ok row per fire with its real duration', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 's1', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await scheduler.dispatchDue({ brief: async () => undefined } as ScheduleExecutors);
      return readRuns();
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ schedule_id: 's1', kind: 'brief', fired_at: 1_000, attempt: 1, outcome: 'ok', error_class: null, settled_at: 1_000 });
    expect(runs[0]?.duration_ms).toBe(0);
  });

  it('records a failed run with error_class run, not a generic failure', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 's2', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await scheduler.dispatchDue({ brief: async () => { throw new Error('provider exploded'); } } as ScheduleExecutors);
      return readRuns();
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'failed', error_class: 'run', settled_at: 1_000 });
    // The schedule itself retried per policy, not deleted.
  });

  it('marks the third consecutive failure as quarantined', async () => {
    const runs = await runInDurableObject(stub(), async (_instance, state) => {
      let now = 1_000;
      const failing = { brief: async () => { throw new Error('still broken'); } } as ScheduleExecutors;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      await at().schedule({ id: 's3', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      for (let fire = 0; fire < 3; fire += 1) {
        await at().dispatchDue(failing);
        now = (at().read('s3')?.due_at ?? now) + 1; // hop to the policy-set retry time
      }
      return state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY fired_at, id').toArray();
    });
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'quarantined']]);
  });

  it('records a missing executor as a scheduler_handoff failure', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 's4', kind: 'reminder', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await scheduler.dispatchDue({} as ScheduleExecutors);
      return readRuns();
    });
    expect(runs[0]).toMatchObject({ outcome: 'failed', error_class: 'scheduler_handoff' });
  });

  it('leaves the row running on a crash-injection abort - the unsettled row is the evidence', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 's5', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await expect(scheduler.dispatchDue({
        brief: async () => { throw new Error('crash-injection: forced'); },
      } as ScheduleExecutors)).rejects.toThrow('crash-injection');
      return readRuns();
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'running', settled_at: null });
  });
});
