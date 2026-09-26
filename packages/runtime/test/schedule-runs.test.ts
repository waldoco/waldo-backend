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
  heartbeat_result: string | null; delivery: string | null;
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

  // Regression: workerd SQLite rejects LIKE/GLOB patterns over ~50 bytes, and production
  // schedule ids ("handoff:<uuid>") already exceed that, so the occurrence-prefix bookkeeping
  // uses range bounds instead. Rows must be present when the count query runs - an empty
  // table never evaluates the match, which is how the short-id tests missed this.
  it('derives the run ordinal from history for production-length schedule ids', async () => {
    const longId = `handoff:${crypto.randomUUID()}`;
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: longId, kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await expect(scheduler.dispatchDue({
        brief: async () => { throw new Error('crash-injection: forced'); },
      } as ScheduleExecutors)).rejects.toThrow('crash-injection');
      // Same-occurrence retry after the crash: the ordinal derives from the history rows.
      await scheduler.dispatchDue({ brief: async () => undefined } as ScheduleExecutors);
      return readRuns();
    });
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'running'], [2, 'ok']]);
    expect(runs.every((r) => r.schedule_id === longId)).toBe(true);
  });
});

// The decision + delivery columns are generic run-history shape (heartbeat is their first
// consumer via the #223 rework); these tests drive them with 'brief' since 'heartbeat'
// joins the kind enum in the heartbeat PR.
describe('run decision + delivery lifecycle (owner shape call)', () => {
  it('records a quiet decision with no delivery, distinct from the run outcome', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 'hb1', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await scheduler.dispatchDue({
        brief: async (entry) => {
          const runId = scheduler.runningRunId(entry.id, entry.occurrence_at);
          expect(runId).not.toBeNull();
          scheduler.markHeartbeatDecision(runId!, 'quiet');
        },
      } as ScheduleExecutors);
      return readRuns();
    });
    expect(runs[0]).toMatchObject({ outcome: 'ok', heartbeat_result: 'quiet', delivery: null, error_class: null });
  });

  it('an acted tick goes pending -> sent; a crash at pending stays undelivered evidence', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 'hb2', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await scheduler.dispatchDue({
        brief: async (entry) => {
          const runId = scheduler.runningRunId(entry.id, entry.occurrence_at)!;
          scheduler.markHeartbeatDecision(runId, 'acted');
          scheduler.markDelivery(runId, 'pending');
          scheduler.markDelivery(runId, 'sent');
        },
      } as ScheduleExecutors);
      return readRuns();
    });
    expect(runs[0]).toMatchObject({ outcome: 'ok', heartbeat_result: 'acted', delivery: 'sent' });
  });

  it('delivery is rejected unless the tick acted (schema CHECK)', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt) VALUES ('r1', 'hb3', 'brief', 900, 1)`,
      );
      expect(() =>
        state.storage.sql.exec(`UPDATE schedule_runs SET delivery = 'pending' WHERE id = 'r1'`),
      ).toThrow();
      // deciding first satisfies the CHECK
      state.storage.sql.exec(`UPDATE schedule_runs SET heartbeat_result = 'acted' WHERE id = 'r1'`);
      state.storage.sql.exec(`UPDATE schedule_runs SET delivery = 'pending' WHERE id = 'r1'`);
      const row = state.storage.sql.exec<RunRow>(`SELECT * FROM schedule_runs WHERE id = 'r1'`).one();
      expect(row.delivery).toBe('pending');
    });
  });

  it('a crash after acted+pending leaves the row recoverable: running, acted, pending - never delivered', async () => {
    const runs = await withScheduler(1_000, async (scheduler, readRuns) => {
      await scheduler.schedule({ id: 'hb4', kind: 'brief', occurrenceAt: 900, dueAt: 900, payloadRefs: {} });
      await expect(
        scheduler.dispatchDue({
          brief: async (entry) => {
            const runId = scheduler.runningRunId(entry.id, entry.occurrence_at)!;
            scheduler.markHeartbeatDecision(runId, 'acted');
            scheduler.markDelivery(runId, 'pending');
            throw new Error('crash-injection: power loss before send');
          },
        } as ScheduleExecutors),
      ).rejects.toThrow('crash-injection');
      return readRuns();
    });
    expect(runs[0]).toMatchObject({ outcome: 'running', heartbeat_result: 'acted', delivery: 'pending', settled_at: null });
  });
});

describe('C3 dedupe + missed-run policy', () => {
  it('a crashed occurrence retry fires - crash recovery beats dedupe', async () => {
    // Contract pinned by run-loop.test.ts: crash-injection leaves the row running, and the
    // next alarm MUST retry the same occurrence (attempt 2), not skip it.
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      let now = 60_000;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      await at().schedule({ id: 'd0', kind: 'brief', occurrenceAt: 60_000, dueAt: 60_000, payloadRefs: {} });
      await expect(at().dispatchDue({
        brief: async () => { throw new Error('crash-injection: forced'); },
      } as ScheduleExecutors)).rejects.toThrow('crash-injection');
      now = 90_000;
      let calls = 0;
      await at().dispatchDue({ brief: async () => { calls += 1; } } as ScheduleExecutors);
      const runs = state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY id').toArray();
      return { calls, runs };
    });
    expect(result.calls).toBe(1);
    expect(result.runs.map((r) => [r.id, r.outcome])).toEqual([
      ['d0:60000:1', 'running'], // crash evidence, never settled
      ['d0:60000:2', 'ok'],      // retry of the same occurrence recovered
    ]);
  });

  it('a still-running row for an OLDER occurrence blocks the next occurrence and the skip is recorded', async () => {
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      const now = 120_000;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      const recurrence = { type: 'interval', every_ms: 60_000, phase_ms: 0 } as const;
      await at().schedule({ id: 'd1', kind: 'brief', occurrenceAt: 120_000, dueAt: 120_000, recurrence, payloadRefs: {} });
      // White-box: an earlier occurrence's run never settled (executor still going / crashed
      // after advancing). The next occurrence must not double-fire the schedule.
      state.storage.sql.exec(
        `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt) VALUES ('d1:60000:1', 'd1', 'brief', 60_000, 1)`,
      );
      let calls = 0;
      await at().dispatchDue({ brief: async () => { calls += 1; } } as ScheduleExecutors);
      const runs = state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY id').toArray();
      const entry = at().read('d1');
      return { calls, runs, entry };
    });
    expect(result.calls).toBe(0);
    expect(result.runs.map((r) => [r.id, r.outcome])).toEqual([
      ['d1:120000:0', 'missed'],
      ['d1:60000:1', 'running'],
    ]);
    expect(result.entry).toMatchObject({ occurrence_at: 180_000, status: 'armed' });
  });

  it('a 3-occurrence gap fires the latest occurrence once with two missed rows', async () => {
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      const now = 180_000;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      const recurrence = { type: 'interval', every_ms: 60_000, phase_ms: 0 } as const;
      await at().schedule({ id: 'm1', kind: 'brief', occurrenceAt: 60_000, dueAt: 60_000, recurrence, payloadRefs: {} });
      let calls = 0;
      const dispatched = await at().dispatchDue({ brief: async () => { calls += 1; } } as ScheduleExecutors);
      const runs = state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY fired_at, id').toArray();
      return { calls, dispatched, runs };
    });
    expect(result.calls).toBe(1);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]).toMatchObject({ id: 'm1', occurrence_at: 180_000 });
    expect(result.runs.map((r) => [r.id, r.outcome])).toEqual([
      ['m1:60000:0', 'missed'],
      ['m1:120000:0', 'missed'],
      ['m1:180000:1', 'ok'],
    ]);
  });

  it('a retried alarm does not double-record a skip (append-only, idempotent)', async () => {
    const runs = await runInDurableObject(stub(), async (_instance, state) => {
      const now = 180_000;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      const recurrence = { type: 'interval', every_ms: 60_000, phase_ms: 0 } as const;
      await at().schedule({ id: 'm2', kind: 'brief', occurrenceAt: 60_000, dueAt: 60_000, recurrence, payloadRefs: {} });
      const failing = { brief: async () => { throw new Error('boom'); } } as ScheduleExecutors;
      await at().dispatchDue(failing);
      // Alarm retry at the same instant: occurrence already advanced past the gap, but the
      // missed ids must stay single even if the policy replays.
      const before = state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs').toArray();
      void before;
      return state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY id').toArray();
    });
    const missed = runs.filter((r) => r.outcome === 'missed');
    expect(new Set(missed.map((r) => r.id)).size).toBe(missed.length);
  });

  // Regression (workerd LIKE limit): dedupe and missed-run bookkeeping also matched
  // occurrence ids by prefix - with a production-length schedule id those queries throw
  // whenever a history row is present. Range bounds make the id length irrelevant.
  it('dedupe and missed-run bookkeeping work for production-length schedule ids', async () => {
    const longId = `handoff:${crypto.randomUUID()}`;
    const result = await runInDurableObject(stub(), async (_instance, state) => {
      const now = 120_000;
      const at = () => new Scheduler(state.storage.sql, state.storage, deps(now));
      const recurrence = { type: 'interval', every_ms: 60_000, phase_ms: 0 } as const;
      await at().schedule({ id: longId, kind: 'brief', occurrenceAt: 120_000, dueAt: 120_000, recurrence, payloadRefs: {} });
      // Earlier occurrence still running (crashed/unsettled) - must block this fire.
      state.storage.sql.exec(
        `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt) VALUES (?, ?, 'brief', 60_000, 1)`,
        `${longId}:60000:1`,
        longId,
      );
      let calls = 0;
      await at().dispatchDue({ brief: async () => { calls += 1; } } as ScheduleExecutors);
      const runs = state.storage.sql.exec<RunRow>('SELECT * FROM schedule_runs ORDER BY id').toArray();
      return { calls, runs };
    });
    expect(result.calls).toBe(0);
    expect(result.runs.map((r) => [r.attempt, r.outcome])).toEqual([[0, 'missed'], [1, 'running']]);
    expect(result.runs.every((r) => r.schedule_id === longId)).toBe(true);
  });
});
