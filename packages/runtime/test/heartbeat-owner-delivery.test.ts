import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { loopBook } from '../src/channels/loops';
import { Scheduler } from '../src/scheduler/multiplexer';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';
const effects = vi.hoisted(() => ({ sends: 0, ack: true, crashEnqueue: false, ordinaryEnqueue: false, sentText: '' }));
vi.mock('../src/channels/telegram-api', async load => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return { ...original, createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method === 'sendMessage') { effects.sends++; effects.sentText = payload.text ?? ''; return effects.ack ? { message_id: 91, chat: { id: payload.chat_id } } : undefined; }
    return true;
  } };
});
vi.mock('../src/scheduler/alarm-slot', async load => {
  const original = await load<typeof import('../src/scheduler/alarm-slot')>();
  return { ...original, persistTransportWake: async (storage: DurableObjectStorage, rows: unknown, due: number | null) => {
    await original.persistTransportWake(storage, rows, due);
    if (effects.crashEnqueue && (rows as FinalRecord[]).some(r => r.heartbeat && r.status === 'pending')) {
      effects.crashEnqueue = false; throw new Error(effects.ordinaryEnqueue ? 'post-commit storage notification failed' : 'crash-injection: after enqueue');
    }
  } };
});
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('heartbeat fixture forbids model calls'); } }; } }));
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');
let sequence = 0;
it.each(['ack', 'blocked', 'unlink', 'enqueueCrash', 'enqueueFailure'])('actual owner alarm keeps heartbeat background delivery truthful: %s', async mode => {
  const stub = env.TRACER_DO.get(env.TRACER_DO.idFromName(`heartbeat-owner-${sequence++}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const owner = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC' });
    state.storage.kv.put('do_name', 'synthetic-owner'); state.storage.kv.put('telegram_subject', '7');
    try {
      await owner.alarm();
      state.storage.sql.exec('DELETE FROM schedule');
      const now = Date.now();
      const loops = loopBook(state.storage.sql, { now: () => now, newId: () => 'synthetic' });
      loops.open({ title: 'Synthetic errand https://fixture.invalid/page?code=fixture-code', due: '2026-09-01' });
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => now, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now, dueAt: now, payloadRefs: {} });
      effects.sends = 0; effects.ack = mode === 'ack' || mode === 'enqueueCrash' || mode === 'enqueueFailure'; effects.crashEnqueue = mode === 'enqueueCrash' || mode === 'enqueueFailure'; effects.ordinaryEnqueue = mode === 'enqueueFailure';
      if (mode === 'enqueueCrash') await expect(owner.alarm()).rejects.toThrow('crash-injection');
      else await owner.alarm();
      const rows = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!;
      expect(rows).toHaveLength(1); expect(rows[0]?.heartbeat?.runId).toBeTruthy();
      expect(rows[0]?.payload.text).not.toContain('fixture-code');
      expect(rows[0]?.payload.text).toContain('[link removed]');
      expect(effects.sends).toBe(0);
      expect(state.storage.sql.exec("SELECT status FROM background_runs WHERE kind = 'heartbeat'").toArray()).toEqual([{ status: 'running' }]);
      expect(state.storage.sql.exec('SELECT outcome, delivery FROM schedule_runs WHERE kind = ?', 'heartbeat').toArray()).toEqual([{ outcome: 'running', delivery: 'pending' }]);
      rows[0]!.dueAt = Date.now() - 1; state.storage.kv.put(FINAL_OUTBOX_KEY, rows);
      if (mode === 'unlink') state.storage.kv.put('telegram_unlinked', true);
      await owner.alarm();
      expect(effects.sends).toBe(mode === 'unlink' ? 0 : 1);
      if (mode !== 'unlink') expect(effects.sentText).toBe(rows[0]!.payload.text);
      expect(state.storage.sql.exec("SELECT status FROM background_runs WHERE kind = 'heartbeat'").toArray()).toEqual([{ status: effects.ack ? 'completed' : 'failed' }]);
      expect(state.storage.sql.exec('SELECT delivery FROM schedule_runs WHERE kind = ?', 'heartbeat').toArray()).toEqual([{ delivery: effects.ack ? 'sent' : 'failed' }]);
      expect(state.storage.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toHaveLength(effects.ack ? 1 : 0);
      if (mode === 'ack') {
        const endedAt = state.storage.sql.exec<{ ended_at: number }>("SELECT ended_at FROM background_runs WHERE kind = 'heartbeat'").one().ended_at;
        const replay = state.storage.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!; replay[0]!.settled = false;
        state.storage.kv.put(FINAL_OUTBOX_KEY, replay);
        const originalNow = Date.now; Date.now = () => endedAt + 60000;
        try { await owner.alarm(); } finally { Date.now = originalNow; }
        expect(state.storage.sql.exec<{ ended_at: number }>("SELECT ended_at FROM background_runs WHERE kind = 'heartbeat'").one().ended_at).toBe(endedAt);
        expect(effects.sends).toBe(1);
      }
    } finally { await state.storage.deleteAlarm(); }
  });
});
