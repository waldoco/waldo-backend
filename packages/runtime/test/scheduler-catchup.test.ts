import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Scheduler } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';

let seq = 0;
function freshStub(): Parameters<typeof runInDurableObject>[0] {
  seq += 1;
  const id = (env as never as { TRACER_DO: { idFromName(n: string): unknown; get(i: unknown): unknown } }).TRACER_DO.idFromName(`wedge-repro-${seq}`);
  return (env as never as { TRACER_DO: { get(i: unknown): never } }).TRACER_DO.get(id);
}

function liveDeps(): Deps {
  return {
    now: () => Date.now(),
    newRunId: () => 'test-run-id',
    newOutboxId: () => 'test-outbox-id',
    sha256Hex: async () => '0'.repeat(64),
  };
}

describe('scheduler wall-stale catch-up (C3 regression)', () => {
  it('a 200-day-stale daily occurrence drains and fires exactly once', async () => {
    const stub = freshStub();
    const stale = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const fires: string[] = [];
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, liveDeps());
      await scheduler.schedule({
        id: 'stale-daily',
        kind: 'brief',
        occurrenceAt: stale,
        dueAt: stale,
        payloadRefs: { id: 'stale-daily', user_id: 'stale-daily:user' },
        recurrence: { type: 'daily_local', time: '02:30', timezone: 'America/New_York' },
      });
      let rounds = 0;
      for (let i = 0; i < 40; i += 1) {
        rounds = i + 1;
        const dispatched = await scheduler.dispatchDue({
          brief: async (entry: { id: string; occurrence_at: number }) => {
            fires.push(`${entry.id}@${entry.occurrence_at}`);
          },
        });
        const dueRows = state.storage.sql
          .exec<{ c: number }>("SELECT COUNT(*) AS c FROM schedule WHERE status = 'armed' AND due_at <= ?", Date.now() + 1000)
          .one().c;
        if (dispatched.length === 0 && dueRows === 0) break;
      }
      const missed = state.storage.sql
        .exec<{ c: number }>("SELECT COUNT(*) AS c FROM schedule_runs WHERE schedule_id = 'stale-daily' AND outcome = 'missed'")
        .one().c;
      return { missed, rounds };
    });
    expect(fires.length).toBe(1);
    expect(result.missed).toBeGreaterThan(0);
  }, 60000);
});
