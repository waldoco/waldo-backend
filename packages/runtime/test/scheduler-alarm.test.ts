import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';
import { FakeSink } from '../src/tracer/sink';
import type { TracerDO } from '../src/tracer/tracer-do';

const FETCH = 'fetch_alert';

type SchedulerStub = DurableObjectStub<TracerDO> & {
  startRun(input: Parameters<TracerDO['startRun']>[0]): Promise<string>;
  scheduleRun(input: { runId: string; dueAt: number }): Promise<void>;
  scheduleOutboxRetry(input: { runId: string; dueAt: number }): Promise<void>;
  scheduleProactiveWake(input: {
    id: string;
    kind: 'brief' | 'pre_activity_spot';
    userId: string;
    dueAt: number;
    occurrenceAt: number;
  }): Promise<void>;
};

afterEach(() => {
  FakeSink.resetAll();
});

let seq = 0;
function freshStub(): SchedulerStub {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`scheduler-alarm-${seq}`);
  return env.TRACER_DO.get(id) as SchedulerStub;
}

function soon(): number {
  return Date.now() + 500;
}

async function tick(stub: SchedulerStub, runId: string): Promise<void> {
  await runInDurableObject(stub, async (instance: TracerDO) => {
    await instance.tickRun(runId);
  });
}

async function readState(stub: SchedulerStub) {
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const journal = sql
      .exec<{ trigger: string; state: string }>(
        'SELECT trigger, state FROM journal ORDER BY created_at, run_id',
      )
      .toArray();
    const schedules = sql
      .exec<{ id: string; kind: string; status: string }>(
        'SELECT id, kind, status FROM schedule ORDER BY id',
      )
      .toArray();
    const outbox = sql
      .exec<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM outbox ORDER BY created_at, run_id`,
      )
      .toArray();
    return { journal, schedules, outbox };
  });
}

async function readScheduleRows(stub: SchedulerStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        id: string;
        kind: string;
        status: string;
        attempts: number;
        due_at: number;
        payload_json: string;
        quarantined_until: number | null;
      }>(
        `SELECT id, kind, status, attempts, due_at, payload_json, quarantined_until
           FROM schedule
          ORDER BY kind, due_at, id`,
      )
      .toArray(),
  );
}

async function forceSchedulesDue(stub: SchedulerStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      'UPDATE schedule SET due_at = MAX(occurrence_at, ?), updated_at = ?',
      now,
      now,
    );
  });
}

async function deleteAlarm(stub: SchedulerStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
}

async function runAlarmEntrypoint(stub: SchedulerStub): Promise<void> {
  await runInDurableObject(stub, async (instance: TracerDO) => {
    await instance.alarm();
  });
}

async function startScheduledRun(
  stub: SchedulerStub,
  input: { userId: string; dueAt: number },
): Promise<string> {
  const runId = await stub.startRun({
    userId: input.userId,
    trigger: FETCH,
    occurrenceAt: input.dueAt,
  });
  await stub.scheduleRun({ runId, dueAt: input.dueAt });
  return runId;
}

function fixedDeps(nowRef: { value: number }): Deps {
  return {
    now: () => nowRef.value,
    newRunId: () => 'test-run-id',
    newOutboxId: () => 'test-outbox-id',
    sha256Hex: async () => '0'.repeat(64),
  };
}

async function dispatchRecurringBrief(input: {
  id: string;
  now: number;
  time: string;
  timezone: string;
}) {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance, state) => {
    const nowRef = { value: input.now };
    const scheduler = new Scheduler(state.storage.sql, state.storage, fixedDeps(nowRef));
    await scheduler.schedule({
      id: input.id,
      kind: 'brief',
      occurrenceAt: input.now,
      dueAt: input.now,
      payloadRefs: { id: input.id, user_id: `${input.id}:user` },
      recurrence: { type: 'daily_local', time: input.time, timezone: input.timezone },
    });
    await scheduler.dispatchDue({
      brief: async () => {
        // The recurrence assertion lives in the durable schedule row after successful dispatch.
      },
    });
    return state.storage.sql
      .exec<{ due_at: number; occurrence_at: number; attempts: number; status: string }>(
        'SELECT due_at, occurrence_at, attempts, status FROM schedule WHERE id = ?',
        input.id,
      )
      .one();
  });
}

describe('scheduler alarm multiplexer', () => {
  it('rejects a forbidden proactive schedule identity before persistence', async () => {
    const stub = freshStub();
    const dueAt = soon();

    await expect(
      runInDurableObject(stub, (instance) =>
        (instance as TracerDO).scheduleProactiveWake({
          id: 'brief:hrv:58',
          kind: 'brief',
          userId: 'user-scheduler-brief',
          dueAt,
          occurrenceAt: dueAt,
        }),
      ),
    ).rejects.toThrow('scribe:health_value_leak');

    expect(await readScheduleRows(stub)).toEqual([]);
  });

  it('rejects a forbidden proactive schedule user identity before persistence', async () => {
    const stub = freshStub();
    const dueAt = soon();

    await expect(
      runInDurableObject(stub, (instance) =>
        (instance as TracerDO).scheduleProactiveWake({
          id: 'brief:safe-schedule-id',
          kind: 'brief',
          userId: 'sb_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          dueAt,
          occurrenceAt: dueAt,
        }),
      ),
    ).rejects.toThrow('scribe:secret_leak');

    expect(await readScheduleRows(stub)).toEqual([]);
  });

  it('dispatches due run resume, outbox retry, and scheduled proactive wake from one alarm', async () => {
    const stub = freshStub();
    const sink = FakeSink.forDO(stub.id.toString());
    const dueAt = soon();

    const resumeRunId = await stub.startRun({
      userId: 'user-scheduler-resume',
      trigger: FETCH,
      occurrenceAt: dueAt,
    });
    await stub.scheduleRun({ runId: resumeRunId, dueAt });

    const retryRunId = await stub.startRun({
      userId: 'user-scheduler-retry',
      trigger: FETCH,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (instance: TracerDO) => {
      instance.__crashAfter = 'post_sink_pre_ack';
    });
    await expect(tick(stub, retryRunId)).rejects.toThrow('post_sink_pre_ack');
    await runInDurableObject(stub, (instance: TracerDO) => {
      instance.__crashAfter = undefined;
    });
    expect(sink.observedDeliveries()).toBe(1);
    await stub.scheduleOutboxRetry({ runId: retryRunId, dueAt });

    await stub.scheduleProactiveWake({
      id: 'brief:morning',
      kind: 'brief',
      userId: 'user-scheduler-brief',
      dueAt,
      occurrenceAt: dueAt,
    });

    const scheduled = await readScheduleRows(stub);
    expect(scheduled).toHaveLength(3);
    expect(
      scheduled.map((row) => [row.kind, Object.keys(JSON.parse(row.payload_json)).sort()]),
    ).toEqual(
      expect.arrayContaining([
        ['journal', ['run_id']],
        ['handoff', ['run_id']],
        ['brief', ['id', 'user_id']],
      ]),
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await readState(stub);
    expect(state.schedules).toEqual([]);
    expect(state.journal).toEqual(
      expect.arrayContaining([
        { trigger: FETCH, state: 'DONE' },
        { trigger: FETCH, state: 'DONE' },
        { trigger: 'brief', state: 'DONE' },
      ]),
    );
    expect(state.outbox).toEqual(
      expect.arrayContaining([
        { status: 'acked', attempts: 1 },
        { status: 'acked', attempts: 2 },
        { status: 'acked', attempts: 1 },
      ]),
    );
    expect(sink.observedDeliveries()).toBe(3);
  });

  it('survives eviction before the alarm and treats duplicate delivery after success as a no-op', async () => {
    const stub = freshStub();
    const sink = FakeSink.forDO(stub.id.toString());
    const dueAt = soon();

    await startScheduledRun(stub, { userId: 'user-scheduler-evict', dueAt });
    expect(await readScheduleRows(stub)).toHaveLength(1);

    await runInDurableObject(stub, () => {
      // Touch the live instance before eviction so this test proves reconstruction from storage.
    });
    await evictDurableObject(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await readState(stub)).schedules).toEqual([]);
    expect(sink.observedDeliveries()).toBe(1);

    await runAlarmEntrypoint(stub);
    expect(sink.observedDeliveries()).toBe(1);
  });

  it('selects a deterministic due batch by kind priority, due time, and schedule id', async () => {
    const stub = freshStub();
    const dueAt = soon();

    for (let i = 0; i < 9; i += 1) {
      await startScheduledRun(stub, { userId: `user-scheduler-order-${i}`, dueAt });
    }
    const orderedIds = (await readScheduleRows(stub)).map((row) => row.id).sort();

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const remaining = await readScheduleRows(stub);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(orderedIds[8]);
    expect((await readState(stub)).journal.filter((row) => row.state === 'DONE')).toHaveLength(8);
  });

  it('picks up a lost due schedule row on the next in-scope wake', async () => {
    const stub = freshStub();
    const sink = FakeSink.forDO(stub.id.toString());
    const dueAt = soon();

    await startScheduledRun(stub, { userId: 'user-scheduler-lost', dueAt });
    await deleteAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    await stub.scheduleProactiveWake({
      id: 'brief:lost-alarm-wake',
      kind: 'brief',
      userId: 'user-scheduler-lost-brief',
      dueAt,
      occurrenceAt: dueAt,
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await readState(stub)).schedules).toEqual([]);
    expect(sink.observedDeliveries()).toBe(2);
  });

  it('quarantines a repeatedly failing product schedule instead of wedging the alarm slot', async () => {
    const stub = freshStub();
    const dueAt = soon();

    await stub.scheduleProactiveWake({
      id: 'brief:poison',
      kind: 'brief',
      userId: 'user-scheduler-poison',
      dueAt,
      occurrenceAt: dueAt,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE schedule
            SET payload_json = ?,
                updated_at = ?
          WHERE id = ?`,
        JSON.stringify({ id: 'brief:poison' }),
        Date.now(),
        'brief:poison',
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await forceSchedulesDue(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await forceSchedulesDue(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const [row] = await readScheduleRows(stub);
    expect(row!).toMatchObject({ id: 'brief:poison', kind: 'brief', status: 'quarantined' });
    expect(row!.attempts).toBe(3);
    expect(row!.quarantined_until).not.toBeNull();

    const healthyAt = soon();
    await stub.scheduleProactiveWake({
      id: 'brief:healthy-after-poison',
      kind: 'brief',
      userId: 'user-scheduler-healthy',
      dueAt: healthyAt,
      occurrenceAt: healthyAt,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterHealthy = await readScheduleRows(stub);
    expect(afterHealthy.map((schedule) => schedule.id)).toEqual(['brief:poison']);
    expect(afterHealthy[0]!.status).toBe('quarantined');
  });

  it('advances daily local recurrence across DST gaps without double-firing a repeated hour', async () => {
    const spring = await dispatchRecurringBrief({
      id: 'brief:spring-forward',
      now: Date.parse('2026-03-08T06:00:00.000Z'),
      time: '02:30',
      timezone: 'America/New_York',
    });
    expect(spring).toMatchObject({
      due_at: Date.parse('2026-03-08T07:00:00.000Z'),
      occurrence_at: Date.parse('2026-03-08T07:00:00.000Z'),
      attempts: 0,
      status: 'armed',
    });

    const fall = await dispatchRecurringBrief({
      id: 'brief:fall-back',
      now: Date.parse('2026-11-01T05:30:00.000Z'),
      time: '01:30',
      timezone: 'America/New_York',
    });
    expect(fall).toMatchObject({
      due_at: Date.parse('2026-11-02T06:30:00.000Z'),
      occurrence_at: Date.parse('2026-11-02T06:30:00.000Z'),
      attempts: 0,
      status: 'armed',
    });
  });
});
