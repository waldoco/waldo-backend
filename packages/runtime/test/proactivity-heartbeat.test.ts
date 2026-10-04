import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { heartbeatTick, HEARTBEAT_ID, settleHeartbeat } from "../src/channels/heartbeat";
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import type { Deps } from '../src/seams/deps';
import { TelegramFinalOutbox, type HeartbeatReceipt } from '../src/channels/telegram-final-outbox';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

let sequence = 0;
const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`proactivity-${sequence++}`)) as DurableObjectStub<TelegramOwnerDO>;
const at = (iso: string) => Date.parse(iso);
const TZ = 'Asia/Kolkata';
const deps = (now: number): Deps => ({ now: () => now, newRunId: () => 'run-fixed', newOutboxId: () => 'out-fixed', sha256Hex: async () => 'sha-fixed' });

type RunRow = { schedule_id: string; outcome: string; heartbeat_result: string | null; delivery: string | null; attempt: number };

const withBeat = async <T>(now: number, work: (ctx: {
  scheduler: Scheduler;
  sql: SqlStorage;
  runs: () => RunRow[];
  beat: (occurrenceAt: number) => Promise<unknown>;
  sent: string[];
  plans: ReturnType<typeof dayPlanBook>;
}) => Promise<T> | T) =>
  runInDurableObject(stub(), async (_instance, state) => {
    ensureSchema(state.storage);
    const sql = state.storage.sql;
    const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), deps(now));
    const sent: string[] = [];
    const book = loopBook(sql, { newId: (() => { let n = 0; return () => `l${++n}`; })(), now: () => now });
    const plans = dayPlanBook(sql);
    const beat = async (occurrenceAt: number) => {
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt, dueAt: occurrenceAt, payloadRefs: { id: HEARTBEAT_ID } }).catch(() => undefined);
      return scheduler.dispatchDue({
        heartbeat: heartbeatTick({ scheduler, sql, loops: book, plans, timezone: TZ, now: () => now, enqueue: enqueueSend(sql, state.storage, scheduler, now, async (text) => { sent.push(text); }) }),
      } as ScheduleExecutors);
    };
    const runs = () => sql.exec<RunRow>('SELECT schedule_id, outcome, heartbeat_result, delivery, attempt FROM schedule_runs ORDER BY id').toArray();
    return work({ scheduler, sql, runs, beat, sent, plans });
  });

const enqueueSend = (sql: SqlStorage, storage: DurableObjectStorage, scheduler: Scheduler, now: number, send: (text: string) => Promise<void>) =>
  async (text: string, heartbeat: HeartbeatReceipt) => {
    let transportNow = now;
    const outbox = new TelegramFinalOutbox(storage.kv, () => transportNow);
    await outbox.enqueue({ id: `heartbeat:${heartbeat.id}:${heartbeat.occurrence}`, trace: 'synthetic', payload: { chat_id: 7, text }, ownerSubject: '7', doName: 'owner-7', heartbeat });
    transportNow += 1000;
    await outbox.drain({ allowed: async () => true, send: async payload => { await send(payload.text); return { message_id: 1, chat: { id: 7 } }; }, settled: async record => { settleHeartbeat(record, sql, scheduler); } });
    await storage.deleteAlarm();
  };


// RED/characterization for the proactivity lane (first-cohort behaviors). Source layer only.
describe('proactivity: follow-through nudges', () => {
  it('a loop the owner closed before the tick is never nudged', async () => {
    await withBeat(at('2026-09-26T10:30:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      const opened = book.open({ title: 'Send the deck', due: '2026-09-26T14:00' });
      expect(book.close(typeof opened === 'string' ? opened : (opened as { id: string }).id, 'done')).toBe(true);
      await beat(at('2026-09-26T10:30:00Z'));
      expect(sent).toEqual([]);
      expect(runs()[0]).toMatchObject({ heartbeat_result: 'quiet' });
    });
  });
  it('volume low means no unrequested loop nudges (owner-set reminders still fire elsewhere)', async () => {
    await withBeat(at('2026-09-26T10:30:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Send the deck', due: '2026-09-26T14:00' });
      book.setProactivity({ quiet_start: null, quiet_end: null, volume: 'low' });
      await beat(at('2026-09-26T10:30:00Z'));
      expect(sent).toEqual([]);
      expect(runs()[0]).toMatchObject({ heartbeat_result: 'quiet' });
    });
  });
});
