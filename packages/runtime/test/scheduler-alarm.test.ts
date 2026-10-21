import { env } from 'cloudflare:workers';
import { rearmSharedAlarm } from '../src/scheduler/alarm-slot';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';
import type { TestStorageDO } from './support/worker-entry';

let seq = 0;
function freshStub(): DurableObjectStub<TestStorageDO> {
  seq += 1;
  return env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`scheduler-alarm-${seq}`));
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
  // Ported from the TracerDO-hosted journeys: the owner object's alarm calls the same Scheduler.dispatchDue.
  it('dispatches a deterministic due batch by kind priority, due time and schedule id, and leaves the rest due', async () => {
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const nowRef = { value: Date.parse('2026-01-01T09:00:00Z') };
      const scheduler = new Scheduler(state.storage.sql, state.storage, fixedDeps(nowRef));
      const now = nowRef.value;
      for (let i = 0; i < 8; i += 1) {
        const dueAt = now - (i === 7 ? 1_000 : 0);
        await scheduler.schedule({ id: `brief:order-${i}`, kind: 'brief', occurrenceAt: dueAt, dueAt, payloadRefs: { id: `brief:order-${i}` } });
      }
      await scheduler.schedule({ id: 'dreaming:order', kind: 'dreaming', occurrenceAt: now - 60_000, dueAt: now - 60_000, payloadRefs: { id: 'dreaming:order' } });
      await scheduler.schedule({ id: 'journal:order', kind: 'journal', occurrenceAt: now, dueAt: now, payloadRefs: { id: 'journal:order' } });
      const fired: string[] = [];
      const record = async (entry: { id: string }) => { fired.push(entry.id); };
      await scheduler.dispatchDue({ brief: record, dreaming: record, journal: record });
      expect(fired).toEqual(['journal:order', 'brief:order-7', ...[0, 1, 2, 3, 4, 5].map((i) => `brief:order-${i}`)]);
      const left = () => state.storage.sql.exec<{ id: string }>('SELECT id FROM schedule ORDER BY id').toArray().map((row) => row.id);
      expect(left()).toEqual(['brief:order-6', 'dreaming:order']);
      await scheduler.dispatchDue({ brief: record, dreaming: record, journal: record });
      expect(fired.slice(8)).toEqual(['brief:order-6', 'dreaming:order']);
      expect(left()).toEqual([]);
    });
  });

  it('quarantines a repeatedly failing product schedule instead of wedging the alarm slot', async () => {
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const nowRef = { value: Date.parse('2026-01-01T09:00:00Z') };
      const scheduler = new Scheduler(state.storage.sql, state.storage, fixedDeps(nowRef));
      await scheduler.schedule({ id: 'brief:poison', kind: 'brief', occurrenceAt: nowRef.value, dueAt: nowRef.value, payloadRefs: { id: 'brief:poison' } });
      const fired: string[] = [];
      const executors = {
        brief: async (entry: { id: string }) => {
          fired.push(entry.id);
          if (entry.id === 'brief:poison') throw new Error('poison');
        },
      };
      const row = () => state.storage.sql
        .exec<{ id: string; status: string; attempts: number; quarantined_until: number | null }>("SELECT id, status, attempts, quarantined_until FROM schedule WHERE id = 'brief:poison'")
        .one();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await scheduler.dispatchDue(executors);
        expect(row().attempts).toBe(attempt);
        nowRef.value += 10 * 60_000;
      }
      expect(row()).toMatchObject({ status: 'quarantined', attempts: 3 });
      expect(row().quarantined_until).not.toBeNull();

      await scheduler.schedule({ id: 'brief:healthy-after-poison', kind: 'brief', occurrenceAt: nowRef.value, dueAt: nowRef.value, payloadRefs: { id: 'brief:healthy-after-poison' } });
      await scheduler.dispatchDue(executors);
      expect(fired).toEqual(['brief:poison', 'brief:poison', 'brief:poison', 'brief:healthy-after-poison']);
      expect(state.storage.sql.exec<{ id: string; status: string }>('SELECT id, status FROM schedule').toArray()).toEqual([{ id: 'brief:poison', status: 'quarantined' }]);
    });
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

describe('cron recurrence create-time validation (Codex #229)', () => {
  it('an invalid cron expression is rejected at schedule() - no armed row, no first fire', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const nowRef = { value: Date.parse('2026-09-26T12:00:00Z') };
      const scheduler = new Scheduler(state.storage.sql, state.storage, fixedDeps(nowRef));
      await expect(
        scheduler.schedule({
          id: 'bad-cron',
          kind: 'brief',
          occurrenceAt: nowRef.value,
          dueAt: nowRef.value,
          payloadRefs: { id: 'bad-cron', user_id: 'bad-cron:user' },
          recurrence: { type: 'cron', expression: '99 * * * *', timezone: 'Asia/Kolkata' },
        }),
      ).rejects.toThrow('invalid cron recurrence');
      const rows = state.storage.sql.exec('SELECT id FROM schedule').toArray();
      expect(rows).toEqual([]);
    });
  });
});

it('shared alarm keeps earlier retained common browser expiry alongside scheduled work',async()=>{
 const stub=freshStub();
 await runInDurableObject(stub,async(_instance,state)=>{
  const now=Date.now(),browserDue=now+60000;
  await state.storage.put('common_browser_due_v1',browserDue);
  await rearmSharedAlarm(state.storage,now+120000,now);
  expect(await state.storage.getAlarm()).toBe(browserDue);
  await state.storage.put('common_browser_due_v1',null);
  await rearmSharedAlarm(state.storage,now+120000,now);
  expect(await state.storage.getAlarm()).toBe(now+120000);
  await state.storage.deleteAlarm();
 });
});

