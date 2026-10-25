import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { armHeartbeat, heartbeatTick, HEARTBEAT_EVERY_MS, HEARTBEAT_ID, settleHeartbeat } from '../src/channels/heartbeat';
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import type { Deps } from '../src/seams/deps';
import { TelegramFinalOutbox, type HeartbeatReceipt } from '../src/channels/telegram-final-outbox';
import type { OwnerDO } from '../src/channels/owner-do';
import { heartbeatJobs } from './helpers/heartbeat-job';
// The check-back is a reader job the tick writes; heartbeatJobs stands in for its worker and the jobs lane, and its apply
// turn reports which loops it was given.

let sequence = 0;
const stub = () => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`heartbeat-${sequence++}`)) as DurableObjectStub<OwnerDO>;
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
    const jobs = heartbeatJobs(state.storage, { loops: book, timezone: TZ, now: () => now, deliver: deliverSend(sql, state.storage, scheduler, now, async (text) => { sent.push(text); }) });
    const beat = async (occurrenceAt: number) => {
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt, dueAt: occurrenceAt, payloadRefs: { id: HEARTBEAT_ID } }).catch(() => undefined);
      const dispatched = await scheduler.dispatchDue({
        heartbeat: heartbeatTick({ scheduler, sql, loops: book, plans, timezone: TZ, now: () => now, ...jobs.tickDeps }),
      } as ScheduleExecutors);
      await jobs.runJobs();
      return dispatched;
    };
    const runs = () => sql.exec<RunRow>('SELECT schedule_id, outcome, heartbeat_result, delivery, attempt FROM schedule_runs ORDER BY id').toArray();
    return work({ scheduler, sql, runs, beat, sent, plans });
  });

// The apply's delivery: queued with the job's settle, then drained at once through a transport that always ACKs.
const deliverSend = (sql: SqlStorage, storage: DurableObjectStorage, scheduler: Scheduler, now: number, send: (text: string) => Promise<void>) =>
  async (id: string, _trace: string, text: string, heartbeat: HeartbeatReceipt, commit: () => void) => {
    let transportNow = now;
    const outbox = new TelegramFinalOutbox(storage.kv, () => transportNow);
    await outbox.enqueueFenced({ id, trace: 'synthetic', payload: { chat_id: 7, text }, ownerSubject: '7', doName: 'owner-7', heartbeat }, work => storage.transactionSync(() => { work(); commit(); }));
    transportNow += 1000;
    await outbox.drain({ allowed: async () => true, send: async payload => { await send(payload.text); return { message_id: 1, chat: { id: 7 } }; }, settled: async record => { settleHeartbeat(record, sql, scheduler); } });
    await storage.deleteAlarm();
  };

describe('a due entry the alarm has no time for', () => {
  it('is not started and stays armed and due for the next wake', async () => {
    const now = at('2026-09-26T10:00:00Z');
    await withBeat(now, async ({ scheduler }) => {
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now, dueAt: now, payloadRefs: { id: HEARTBEAT_ID } });
      let started = 0;
      const executors = { heartbeat: async () => { started += 1; } } as unknown as ScheduleExecutors;
      expect(await scheduler.dispatchDue(executors, () => false)).toEqual([]);
      expect(started).toBe(0);
      expect(scheduler.read(HEARTBEAT_ID)).toMatchObject({ status: 'armed', due_at: now });
      await scheduler.dispatchDue(executors, () => true);
      expect(started).toBe(1);
    });
  });
});

describe('heartbeat tick (H1, scheduler-owned run history)', () => {
  it('arms one interval schedule entry and re-arming is a no-op', async () => {
    await withBeat(at('2026-09-26T10:00:00Z'), async ({ scheduler }) => {
      await armHeartbeat(scheduler, at('2026-09-26T10:00:00Z'));
      const entry = scheduler.read(HEARTBEAT_ID);
      expect(entry?.kind).toBe('heartbeat');
      expect(entry?.recurrence).toEqual({ type: 'interval', every_ms: HEARTBEAT_EVERY_MS, phase_ms: 0 });
      await armHeartbeat(scheduler, at('2026-09-26T10:30:00Z'));
      expect(scheduler.read(HEARTBEAT_ID)?.occurrence_at).toBe(entry?.occurrence_at);
    });
  });

  it('a quiet tick with nothing due sends nothing and records quiet on its run row', async () => {
    await withBeat(at('2026-09-26T10:00:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Someday maybe', due: null });
      await beat(at('2026-09-26T10:00:00Z'));
      expect(sent).toEqual([]);
      expect(runs()).toEqual([{ schedule_id: HEARTBEAT_ID, outcome: 'ok', heartbeat_result: 'quiet', delivery: null, attempt: 1 }]);
    });
  });

  it('a tick with one past-due loop sends the reply of the check-back turn; its run records acted, and the job owns the send', async () => {
    await withBeat(at('2026-09-26T10:30:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      await beat(at('2026-09-26T10:30:00Z'));
      // 16:00 IST - the 14:00 IST loop is past due.
      expect(sent).toEqual(['Checked Check how the late call went']);
      expect(runs()).toEqual([{ schedule_id: HEARTBEAT_ID, outcome: 'ok', heartbeat_result: 'acted', delivery: null, attempt: 1 }]);
    });
  });

  it('flood control: many past-due loops go to one check-back turn and produce exactly one message', async () => {
    await withBeat(at('2026-09-26T10:30:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: (() => { let n = 0; return () => `l${++n}`; })(), now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'A', due: '2026-09-26T13:00' });
      book.open({ title: 'B', due: '2026-09-26T14:00' });
      book.open({ title: 'C', due: '2026-09-26T15:00' });
      book.open({ title: 'D', due: '2026-09-26T15:30' });
      await beat(at('2026-09-26T10:30:00Z'));
      expect(sent.length).toBe(1);
      expect(sent).toEqual(['Checked A, B, C, D']);
      expect(runs()[0]).toMatchObject({ outcome: 'ok', heartbeat_result: 'acted', delivery: null });
    });
  });

  it('quiet hours suppress the send even when loops are past due', async () => {
    await withBeat(at('2026-09-26T01:00:00Z'), async ({ sql, beat, sent, runs }) => {
      // Date-only due, so the loop is past due at 06:30 local; 06:30 IST is inside 23:00-07:30 quiet.
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Morning thing', due: '2026-09-26' });
      book.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' });
      await beat(at('2026-09-26T01:00:00Z'));
      expect(sent).toEqual([]);
      expect(runs()[0]).toMatchObject({ outcome: 'ok', heartbeat_result: 'quiet', delivery: null });
    });
  });

  it('a loop due later today is not past due yet', async () => {
    await withBeat(at('2026-09-26T10:30:00Z'), async ({ sql, beat, sent, runs }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Later', due: '2026-09-26T22:00' });
      await beat(at('2026-09-26T10:30:00Z'));
      expect(sent).toEqual([]);
      expect(runs()[0]).toMatchObject({ heartbeat_result: 'quiet' });
    });
  });

  it('cross-tick flood control: two consecutive ticks with the same due work send once', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      ensureSchema(state.storage);
      const sql = state.storage.sql;
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      const sent: string[] = [];
      let now = at('2026-09-26T10:30:00Z');
      const beatAt = async (occurrence: number) => {
        now = occurrence;
        const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), deps(now));
        const jobs = heartbeatJobs(state.storage, { loops: book, timezone: TZ, now: () => now, deliver: deliverSend(sql, state.storage, scheduler, now, async (text) => { sent.push(text); }) });
        await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: occurrence, dueAt: occurrence, payloadRefs: {} });
        await scheduler.dispatchDue({
          heartbeat: heartbeatTick({ scheduler, sql, loops: book, plans: dayPlanBook(sql), timezone: TZ, now: () => now, ...jobs.tickDeps }),
        } as ScheduleExecutors);
        await jobs.runJobs();
      };
      await beatAt(at('2026-09-26T10:30:00Z'));
      await beatAt(at('2026-09-26T11:00:00Z'));
      expect(sent.length).toBe(1);
      const rows = sql.exec<RunRow>('SELECT schedule_id, outcome, heartbeat_result, delivery, attempt FROM schedule_runs ORDER BY id').toArray();
      expect(rows.map((row) => row.heartbeat_result)).toEqual(['acted', 'quiet']);
    });
  });

  it('a crash after acted+pending is recovered by the retry - the check-back runs again, never assumed delivered', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      ensureSchema(state.storage);
      const sql = state.storage.sql;
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      const occurrence = at('2026-09-26T10:30:00Z');
      const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), deps(occurrence));
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: occurrence, dueAt: occurrence, payloadRefs: {} });
      // Crash after marking acted+pending, before the send completes.
      await expect(
        scheduler.dispatchDue({
          heartbeat: async (entry) => {
            const runId = scheduler.runningRunId(entry.id, entry.occurrence_at)!;
            scheduler.markHeartbeatDecision(runId, 'acted');
            scheduler.markDelivery(runId, 'pending');
            throw new Error('crash-injection: power loss before send');
          },
        } as ScheduleExecutors),
      ).rejects.toThrow('crash-injection');
      const crashed = sql.exec<RunRow>('SELECT schedule_id, outcome, heartbeat_result, delivery, attempt FROM schedule_runs ORDER BY id').toArray();
      expect(crashed[0]).toMatchObject({ outcome: 'running', heartbeat_result: 'acted', delivery: 'pending' });
      // Retry of the same occurrence: no terminal delivery exists, so the check-back runs.
      const sent: string[] = [];
      const jobs = heartbeatJobs(state.storage, { loops: book, timezone: TZ, now: () => occurrence, deliver: deliverSend(sql, state.storage, scheduler, occurrence, async (text) => { sent.push(text); }) });
      await scheduler.dispatchDue({
        heartbeat: heartbeatTick({ scheduler, sql, loops: book, plans: dayPlanBook(sql), timezone: TZ, now: () => occurrence, ...jobs.tickDeps }),
      } as ScheduleExecutors);
      await jobs.runJobs();
      expect(sent.length).toBe(1);
      const rows = sql.exec<RunRow>('SELECT schedule_id, outcome, heartbeat_result, delivery, attempt FROM schedule_runs ORDER BY id').toArray();
      expect(rows[rows.length - 1]).toMatchObject({ outcome: 'ok', heartbeat_result: 'acted', delivery: null });
    });
  });

  it('a terminal delivery state (sent or failed) is never re-sent on occurrence retry', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      ensureSchema(state.storage);
      const sql = state.storage.sql;
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T10:00:00Z') });
      book.open({ title: 'Check how the late call went', due: '2026-09-26T14:00' });
      const occurrence = at('2026-09-26T10:30:00Z');
      const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), deps(occurrence));
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: occurrence, dueAt: occurrence, payloadRefs: {} });
      // An attempt from before check-backs became jobs, whose send failed: its row holds the terminal delivery.
      await scheduler.dispatchDue({
        heartbeat: async (entry) => {
          const runId = scheduler.runningRunId(entry.id, entry.occurrence_at)!;
          scheduler.markHeartbeatDecision(runId, 'acted');
          scheduler.markDelivery(runId, 'failed');
          throw new TypeError('network down');
        },
      } as ScheduleExecutors).catch(() => undefined);
      let calls = 0;
      const jobs = heartbeatJobs(state.storage, { loops: book, timezone: TZ, now: () => occurrence, deliver: deliverSend(sql, state.storage, scheduler, occurrence, async () => { calls += 1; }) });
      // Retry: the terminal 'failed' delivery is observed; no job is written and nothing is re-sent.
      await scheduler.dispatchDue({
        heartbeat: heartbeatTick({ scheduler, sql, loops: book, plans: dayPlanBook(sql), timezone: TZ, now: () => occurrence, ...jobs.tickDeps }),
      } as ScheduleExecutors).catch(() => undefined);
      await jobs.runJobs();
      expect(jobs.book.open()).toEqual([]);
      expect(calls).toBe(0);
    });
  });
});

describe('heartbeat H1b: quiet-held day card release', () => {
  it('a card held during quiet hours re-arms on the first non-quiet tick; the release-only tick records acted with no delivery of its own', async () => {
    await withBeat(at('2026-09-26T02:30:00Z'), async ({ scheduler, beat, sent, runs, plans }) => {
      // 08:00 IST - outside 23:00-07:30 quiet. The card was held at its 06:30 planned time.
      plans.held('2026-09-26', 'card:brief');
      await beat(at('2026-09-26T02:30:00Z'));
      const rearmed = scheduler.read('card:brief');
      expect(rearmed?.kind).toBe('brief');
      expect(rearmed?.occurrence_at).toBe(at('2026-09-26T02:30:00Z'));
      expect(rearmed?.status).toBe('armed');
      // the tick sent no message itself - the released card's own fire carries that send
      expect(sent).toEqual([]);
      expect(runs()).toEqual([{ schedule_id: HEARTBEAT_ID, outcome: 'ok', heartbeat_result: 'acted', delivery: null, attempt: 1 }]);
    });
  });

  it('quiet hours do NOT release held cards, and a stale held card from yesterday stays held', async () => {
    await withBeat(at('2026-09-26T01:00:00Z'), async ({ sql, scheduler, beat, runs, plans }) => {
      // 06:30 IST - inside 23:00-07:30 quiet.
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T01:00:00Z') });
      book.setProactivity({ quiet_start: '23:00', quiet_end: '07:30', volume: 'normal' });
      plans.held('2026-09-26', 'card:brief');
      plans.held('2026-09-25', 'card:close');
      await beat(at('2026-09-26T01:00:00Z'));
      expect(scheduler.read('card:brief')).toBeNull();
      expect(scheduler.read('card:close')).toBeNull();
      expect(runs()[0]).toMatchObject({ heartbeat_result: 'quiet', delivery: null });
    });
  });

  it('a tick releasing a held card AND nudging a past-due loop does both; the check-back job owns the message', async () => {
    await withBeat(at('2026-09-26T02:30:00Z'), async ({ sql, scheduler, beat, sent, runs, plans }) => {
      const book = loopBook(sql, { newId: () => 'x', now: () => at('2026-09-26T02:30:00Z') });
      // 08:00 IST: the 07:00 IST loop is past due and quiet (23:00-07:30) has ended.
      book.open({ title: 'Check how the late call went', due: '2026-09-26T07:00' });
      plans.held('2026-09-26', 'card:brief');
      await beat(at('2026-09-26T02:30:00Z'));
      expect(scheduler.read('card:brief')?.status).toBe('armed');
      expect(sent).toEqual(['Checked Check how the late call went']);
      expect(runs()[0]).toMatchObject({ heartbeat_result: 'acted', delivery: null });
    });
  });

  it('held() never regresses a card that genuinely sent', async () => {
    await withBeat(at('2026-09-26T02:30:00Z'), async ({ plans }) => {
      plans.sent('2026-09-26', 'card:brief');
      plans.held('2026-09-26', 'card:brief');
      expect(plans.read('2026-09-26').find((row) => row.card === 'card:brief')?.sent).toBe(true);
    });
  });
});
