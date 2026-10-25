import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { loopBook } from '../src/channels/loops';
import { Scheduler } from '../src/scheduler/multiplexer';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { FINAL_OUTBOX_KEY, TelegramFinalOutbox, type FinalRecord } from '../src/channels/telegram-final-outbox';
import { reportMachineJobs } from './helpers/heartbeat-job';
const effects = vi.hoisted(() => ({ sends: 0, ack: true, sentText: '', turns: 0 }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method === 'sendMessage') { effects.sends++; effects.sentText = payload.text ?? ''; return effects.ack ? { message_id: 91, chat: { id: payload.chat_id } } : undefined; }
    return true;
  } };
});
// Only the check-back turn may call the model; its reply carries a link the outbox must redact.
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { input: unknown }) => {
  if (!JSON.stringify(body.input).includes('[Check-back due now')) throw new Error('heartbeat fixture allows only the check-back turn');
  effects.turns += 1;
  return { status: 'completed', output_text: 'Still open: Synthetic errand https://fixture.invalid/page?code=fixture-code', output: [], usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');
let sequence = 0;
// The check-back is a reader job: the tick writes it, its worker reports (stood in for here), and the next pass's apply turn
// queues the message with the job's settle in one transaction.
it.each(['ack', 'blocked', 'unlink'])('actual owner alarm keeps heartbeat background delivery truthful: %s', async mode => {
  const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`heartbeat-owner-${sequence++}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
    state.storage.kv.put('do_name', 'synthetic-owner'); state.storage.kv.put('telegram_subject', '7');
    try {
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      const now = Date.now();
      const loops = loopBook(state.storage.sql, { now: () => now, newId: () => 'synthetic' });
      loops.open({ title: 'Synthetic errand https://fixture.invalid/page?code=fixture-code', due: '2026-09-01' });
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => now, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now, dueAt: now, payloadRefs: {} });
      effects.sends = 0; effects.ack = mode === 'ack';
      await owner.alarm();
      expect(reportMachineJobs(state.storage.sql)).toHaveLength(1);
      await owner.alarm();
      expect(state.storage.kv.get('owner_alarm_failures_v1')).toBeUndefined();
      const rows = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!;
      expect(rows).toHaveLength(1); expect(rows[0]?.heartbeat?.runId).toBeTruthy();
      expect(rows[0]?.payload.text).not.toContain('fixture-code');
      expect(rows[0]?.payload.text).toContain('[link removed]');
      expect(effects.sends).toBe(0);
      // The tick's run finished when it wrote the job; the send's own run waits for the ACK.
      const runs = () => state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'heartbeat' ORDER BY started_at").toArray();
      expect(runs()).toEqual([{ status: 'completed' }, { status: 'running' }]);
      expect(state.storage.sql.exec('SELECT outcome, delivery FROM schedule_runs WHERE kind = ?', 'heartbeat').toArray()).toEqual([{ outcome: 'ok', delivery: null }]);
      rows[0]!.dueAt = Date.now() - 1; state.storage.kv.put(FINAL_OUTBOX_KEY, rows);
      if (mode === 'unlink') state.storage.kv.put('telegram_unlinked', true);
      await owner.alarm();
      expect(state.storage.kv.get('owner_alarm_failures_v1')).toBeUndefined();
      expect(effects.sends).toBe(mode === 'unlink' ? 0 : 1);
      if (mode !== 'unlink') expect(effects.sentText).toBe(rows[0]!.payload.text);
      expect(runs()).toEqual([{ status: 'completed' }, { status: effects.ack ? 'completed' : 'failed' }]);
      // A send that failed no longer quarantines the heartbeat's schedule, so the failure is told on its own hop.
      expect(state.storage.sql.exec("SELECT ok FROM trace_log WHERE hop = 'heartbeat_delivery'").toArray()).toEqual([{ ok: effects.ack ? 1 : 0 }]);
      expect(state.storage.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toHaveLength(effects.ack ? 1 : 0);
      if (mode === 'ack') {
        const endedAt = state.storage.sql.exec<{ ended_at: number }>("SELECT ended_at FROM background_runs WHERE kind = 'heartbeat' ORDER BY started_at DESC LIMIT 1").one().ended_at;
        const replay = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!; replay[0]!.settled = false;
        state.storage.kv.put(FINAL_OUTBOX_KEY, replay);
        const originalNow = Date.now; Date.now = () => endedAt + 60000;
        try { await owner.alarm(); } finally { Date.now = originalNow; }
        expect(state.storage.sql.exec<{ ended_at: number }>("SELECT ended_at FROM background_runs WHERE kind = 'heartbeat' ORDER BY started_at DESC LIMIT 1").one().ended_at).toBe(endedAt);
        expect(effects.sends).toBe(1);
      }
    } finally { await state.storage.deleteAlarm(); }
  });
});

// The apply queues the message and settles the job in one transaction. A transaction that fails queues nothing, settles
// nothing and starts no cooldown; the job stays reported, and the next pass after its backoff delivers it once.
it('a settle transaction that fails queues nothing and settles nothing, and the next pass delivers the check-back once', async () => {
  const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`heartbeat-owner-${sequence++}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
    state.storage.kv.put('do_name', 'synthetic-owner'); state.storage.kv.put('telegram_subject', '7');
    const originalNow = Date.now;
    try {
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      const now = Date.now();
      loopBook(state.storage.sql, { now: () => now, newId: () => 'synthetic' }).open({ title: 'Synthetic errand', due: '2026-09-01' });
      await new Scheduler(state.storage.sql, state.storage, { now: () => now, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' })
        .schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now, dueAt: now, payloadRefs: {} });
      effects.sends = 0; effects.ack = true;
      await owner.alarm();
      const [job] = reportMachineJobs(state.storage.sql);
      const enqueueFenced = TelegramFinalOutbox.prototype.enqueueFenced;
      const failing = vi.spyOn(TelegramFinalOutbox.prototype, 'enqueueFenced').mockImplementationOnce(function (this: TelegramFinalOutbox, input, commit) {
        return enqueueFenced.call(this, input, work => commit(() => { work(); throw new Error('storage failed inside the settle transaction'); }));
      });
      await owner.alarm();
      expect(failing).toHaveBeenCalledTimes(1);
      const heartbeats = () => (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.heartbeat);
      expect(heartbeats()).toEqual([]);
      expect(state.storage.sql.exec('SELECT status FROM task_jobs WHERE id = ?', job).one()).toEqual({ status: 'reported' });
      expect(state.storage.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
      expect(effects.sends).toBe(0);
      // Past the apply's first backoff (two minutes): the apply runs again and its message is queued once, then sent once.
      Date.now = () => originalNow() + 3 * 60_000;
      await owner.alarm();
      expect(heartbeats()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT status FROM task_jobs WHERE id = ?', job).one()).toEqual({ status: 'applied' });
      const rows = heartbeats(); rows[0]!.dueAt = Date.now() - 1; state.storage.kv.put(FINAL_OUTBOX_KEY, [...(state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => !record.heartbeat), ...rows]);
      await owner.alarm();
      await owner.alarm();
      expect(effects.sends).toBe(1);
      expect(heartbeats()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM heartbeat_notified').one()).toEqual({ n: 1 });
    } finally { Date.now = originalNow; vi.restoreAllMocks(); await state.storage.deleteAlarm(); }
  });
});

// A check-back that could not be sent, or is still waiting to go, holds its loops: later ticks write no new job, ask no model
// and queue no second message for them. The failure stays told once, on the send's run and its hop.
describe('an undelivered check-back holds its loops', () => {
  const START = Date.parse('2026-10-22T12:00:00Z');
  const withOwner = async (work: (owner: InstanceType<typeof OwnerDO>, state: DurableObjectState, tick: (at: number) => Promise<void>) => Promise<void>) => {
    const stub = env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`heartbeat-owner-${sequence++}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
      state.storage.kv.put('do_name', 'synthetic-owner'); state.storage.kv.put('telegram_subject', '7');
      const originalNow = Date.now;
      try {
        Date.now = () => START;
        await owner.alarm();
        state.storage.sql.exec('DELETE FROM schedule');
        loopBook(state.storage.sql, { now: () => START, newId: () => 'synthetic' }).open({ title: 'Synthetic errand', due: '2026-09-01' });
        effects.sends = 0; effects.ack = false; effects.turns = 0;
        await work(owner, state, async at => {
          Date.now = () => at;
          await new Scheduler(state.storage.sql, state.storage, { now: () => at, newRunId: () => `r${at}`, newOutboxId: () => 'o', sha256Hex: async () => 's' })
            .schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: at, dueAt: at, payloadRefs: {} });
          await owner.alarm();
          reportMachineJobs(state.storage.sql);
        });
      } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
    });
  };
  const heartbeatJobs = (state: DurableObjectState) => state.storage.sql.exec("SELECT id FROM task_jobs WHERE origin = 'machine:heartbeat'").toArray();
  const heartbeats = (state: DurableObjectState) => (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(record => record.heartbeat);

  it('a failed send: four ticks over two hours make one job, one apply turn and one message', async () => {
    await withOwner(async (owner, state, tick) => {
      for (let n = 0; n < 4; n += 1) {
        const at = START + n * 30 * 60_000;
        await tick(at);
        Date.now = () => at + 60_000;
        await owner.alarm();
        const rows = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? [];
        state.storage.kv.put(FINAL_OUTBOX_KEY, rows.map(record => ({ ...record, dueAt: Math.min(record.dueAt, Date.now() - 1) })));
        await owner.alarm();
      }
      expect(heartbeatJobs(state)).toHaveLength(1);
      expect(effects.turns).toBe(1);
      expect(heartbeats(state)).toHaveLength(1);
      expect(effects.sends).toBe(1);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM background_runs WHERE kind = 'heartbeat' AND summary LIKE 'heartbeat%'").toArray()).toEqual([{ status: 'failed' }]);
      expect(state.storage.sql.exec("SELECT ok FROM trace_log WHERE hop = 'heartbeat_delivery'").toArray()).toEqual([{ ok: 0 }]);
      // Only a delivered message marks the loop told; the hold ends with the cooldown, and the loop is asked about once more.
      expect(state.storage.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
      await tick(START + 4 * 60 * 60_000 + 5 * 60_000);
      expect(heartbeatJobs(state)).toHaveLength(2);
    });
  });
  it('a failed send holds only that occurrence: a loop given a new due time is asked about at the next tick', async () => {
    await withOwner(async (owner, state, tick) => {
      await tick(START);
      Date.now = () => START + 60_000;
      await owner.alarm();
      state.storage.kv.put(FINAL_OUTBOX_KEY, (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).map(record => ({ ...record, dueAt: Date.now() - 1 })));
      await owner.alarm();
      expect(heartbeats(state)).toMatchObject([{ status: 'blocked' }]);
      state.storage.sql.exec("UPDATE loops SET due = '2026-09-02' WHERE title = 'Synthetic errand'");
      await tick(START + 30 * 60_000);
      expect(heartbeatJobs(state)).toHaveLength(2);
    });
  });
  it('a message still waiting to send: the next tick writes no job for its loops', async () => {
    await withOwner(async (owner, state, tick) => {
      await tick(START);
      Date.now = () => START + 60_000;
      await owner.alarm();
      expect(heartbeats(state)).toMatchObject([{ status: 'pending' }]);
      // Still waiting at the next tick, as a WhatsApp message held for a closed window would be.
      state.storage.kv.put(FINAL_OUTBOX_KEY, (state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).map(record => ({ ...record, dueAt: START + 9 * 60 * 60_000 })));
      // At the next tick, and still past the cooldown: a message waiting for days is not written again.
      for (const at of [START + 30 * 60_000, START + 5 * 60 * 60_000]) {
        await tick(at);
        Date.now = () => at + 60_000;
        await owner.alarm();
        expect(heartbeats(state)).toMatchObject([{ status: 'pending' }]);
        expect(heartbeatJobs(state)).toHaveLength(1);
      }
      expect(effects.turns).toBe(1);
    });
  });
});
