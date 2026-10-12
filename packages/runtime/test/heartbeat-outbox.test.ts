import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { heartbeatTick, HEARTBEAT_ID, heartbeatEligible, settleHeartbeat } from '../src/channels/heartbeat';
import { TelegramFinalOutbox, FINAL_OUTBOX_KEY, FINAL_OUTBOX_DUE_KEY } from '../src/channels/telegram-final-outbox';
import { loopBook } from '../src/channels/loops';
import { dayPlanBook } from '../src/channels/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import { TelegramRejection } from '../src/channels/telegram-api';


it('persists heartbeat intent without claiming delivery or starting cooldown', async () => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('heartbeat-outbox-tracer'));
  await runInDurableObject(stub, async (_instance, state) => {
    ensureSchema(state.storage);
    const now = Date.parse('2026-09-26T10:30:00Z');
    const scheduler = new Scheduler(state.storage.sql, manualAlarmStorage(state.storage), { now: () => now, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
    const loops = loopBook(state.storage.sql, { now: () => now, newId: () => 'loop-synthetic' });
    const loop = loops.open({ title: 'Synthetic errand', due: '2026-09-26T14:00' });
    const outbox = new TelegramFinalOutbox(state.storage.kv, () => now);
    await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now, dueAt: now, payloadRefs: {} });
    await scheduler.dispatchDue({ heartbeat: heartbeatTick({ scheduler, sql: state.storage.sql, loops, plans: dayPlanBook(state.storage.sql), timezone: 'Asia/Kolkata', now: () => now,
      enqueue: async (text, heartbeat) => outbox.enqueue({ id: `heartbeat:${heartbeat.id}:${heartbeat.occurrence}`, trace: 'beat', payload: { chat_id: 7, text }, ownerSubject: '7', doName: 'owner-7', heartbeat }),
    }) });
    expect(outbox.records()).toHaveLength(1);
    expect(outbox.records()[0]?.heartbeat?.loops).toEqual([{ id: loop.id, due: '2026-09-26T14:00' }]);
    expect(state.storage.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
    expect(state.storage.sql.exec('SELECT outcome, delivery FROM schedule_runs').toArray()).toEqual([{ outcome: 'running', delivery: 'pending' }]);
    await state.storage.deleteAlarm();
  });
});

let sequence = 0;
const withTransport = async (work: (f: {
  sql: SqlStorage; storage: DurableObjectStorage; scheduler: Scheduler;
  loops: ReturnType<typeof loopBook>; outbox: TelegramFinalOutbox;
  tick: () => Promise<unknown>; advance: (ms?: number) => void; now: () => number;
  drain: (send: (p: { chat_id: number; text: string }) => Promise<unknown>, allowed?: boolean) => Promise<void>;
}) => Promise<void>) => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`heartbeat-transport-${sequence++}`));
  await runInDurableObject(stub, async (_instance, state) => {
    ensureSchema(state.storage);
    let now = Date.parse('2026-09-26T10:30:00Z');
    const sql = state.storage.sql;
    const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), { now: () => now, newRunId: () => 'r', newOutboxId: () => 'o', sha256Hex: async () => 's' });
    const loops = loopBook(sql, { now: () => now, newId: () => 'synthetic' });
    loops.open({ title: 'Synthetic errand', due: '2026-09-26T14:00' });
    const outbox = new TelegramFinalOutbox(state.storage.kv, () => now);
    const occurrence = now;
    await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: occurrence, dueAt: occurrence, payloadRefs: {}, recurrence: { type: 'interval', every_ms: 1800000, phase_ms: 0 } });
    const tick = () => scheduler.dispatchDue({ heartbeat: heartbeatTick({ scheduler, sql, loops, plans: dayPlanBook(sql), timezone: 'Asia/Kolkata', now: () => now,
      enqueue: async (text, heartbeat) => outbox.enqueue({ id: `heartbeat:${heartbeat.id}:${heartbeat.occurrence}`, trace: 'beat', payload: { chat_id: 7, text }, ownerSubject: '7', doName: 'owner-7', heartbeat }),
    }) });
    const drain = (send: (p: { chat_id: number; text: string }) => Promise<unknown>, allowed = true) => outbox.drain({
      allowed: async record => allowed && heartbeatEligible(record, sql, loops, 'Asia/Kolkata', now), send,
      settled: async record => { settleHeartbeat(record, sql, scheduler); },
    });
    try { await work({ sql, storage: state.storage, scheduler, loops, outbox, tick, advance: (ms = 1000) => { now += ms; }, now: () => now, drain }); }
    finally { await state.storage.deleteAlarm(); }
  });
};

it.each([undefined, { message_id: 9, chat: { id: 8 } }])('unconfirmed heartbeat ACK %s never starts cooldown', async ack => {
  await withTransport(async f => {
    await f.tick(); f.advance();
    await f.drain(async () => ack);
    expect(f.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
    expect(f.sql.exec('SELECT outcome, delivery FROM schedule_runs').toArray()).toEqual([{ outcome: 'quarantined', delivery: 'failed' }]);
    expect(f.outbox.records()[0]?.status).toBe(ack === undefined ? 'blocked' : 'quarantined');
  });
});

it('validated ACK settles frozen occurrence cooldown at ACK time', async () => {
  await withTransport(async f => {
    await f.tick(); f.advance(); await f.drain(async () => ({ message_id: 9, chat: { id: 7 } }));
    expect(f.sql.exec('SELECT loop_id, due, notified_at FROM heartbeat_notified').toArray()).toEqual([{ loop_id: 'osynthetic', due: '2026-09-26T14:00', notified_at: f.now() }]);
    expect(f.sql.exec('SELECT outcome, delivery FROM schedule_runs').toArray()).toEqual([{ outcome: 'ok', delivery: 'sent' }]);
    expect(f.scheduler.read(HEARTBEAT_ID)?.occurrence_at).toBeGreaterThan(f.now());
  });
});

it.each(['closed', 'edited', 'quiet', 'unlinked', 'cooldown'])('fresh %s eligibility blocks already frozen heartbeat before transport', async mode => {
  await withTransport(async f => {
    await f.tick(); f.advance();
    if (mode === 'closed') f.sql.exec("UPDATE loops SET status = 'closed'");
    if (mode === 'edited') f.sql.exec("UPDATE loops SET due = '2026-09-27T14:00'");
    if (mode === 'quiet') f.loops.setProactivity({ quiet_start: '15:00', quiet_end: '17:00', volume: 'normal' });
    if (mode === 'cooldown') f.sql.exec('INSERT INTO heartbeat_notified(loop_id, due, notified_at) VALUES (?, ?, ?)', 'osynthetic', '2026-09-26T14:00', f.now());
    let sends = 0; await f.drain(async () => { sends++; return { message_id: 9, chat: { id: 7 } }; }, mode !== 'unlinked');
    expect(sends).toBe(0); expect(f.outbox.records()[0]?.status).toBe('blocked');
    expect(f.sql.exec('SELECT delivery FROM schedule_runs').toArray()).toEqual([{ delivery: 'failed' }]);
  });
});

it('definite429 retries same frozen bytes after title changes without rerunning producer', async () => {
  await withTransport(async f => {
    await f.tick(); f.advance(); const sent: string[] = [];
    await f.drain(async payload => { sent.push(payload.text); throw new TelegramRejection(429, 'rate', 30); });
    f.sql.exec("UPDATE loops SET title = 'Changed synthetic title'");
    expect(f.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
    f.advance(31000); await f.drain(async payload => { sent.push(payload.text); return { message_id: 9, chat: { id: 7 } }; });
    expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]); expect(sent[1]).toContain('Synthetic errand');
    expect(f.outbox.records()[0]?.attempts).toBe(2);
  });
});

it('crash after persisted ACK replays bookkeeping without resend or moving cooldown time', async () => {
  await withTransport(async f => {
    await f.tick(); f.advance(); const ackAt = f.now(); let sends = 0;
    const send = async () => { sends++; return { message_id: 9, chat: { id: 7 } }; };
    await expect(f.outbox.drain({ allowed: async () => true, send, settled: async () => { throw new Error('crash bookkeeping'); } })).rejects.toThrow('crash bookkeeping');
    f.advance(60000); await f.drain(send);
    expect(sends).toBe(1); expect(f.sql.exec('SELECT notified_at FROM heartbeat_notified').toArray()).toEqual([{ notified_at: ackAt }]);
  });
});

it.each(['attempting', 'delivered'])('crash while persisting %s cannot resend ambiguous provider effects', async failStatus => {
  await withTransport(async f => {
    await f.tick(); f.advance(); let sends = 0;
    const broken = new TelegramFinalOutbox(f.storage.kv, f.now, async (rows, due) => {
      if (rows.some(row => row.status === failStatus)) throw new Error('crash persist');
      f.storage.kv.put(FINAL_OUTBOX_KEY, rows); f.storage.kv.put(FINAL_OUTBOX_DUE_KEY, due);
    });
    await expect(broken.drain({ allowed: async () => true, send: async () => { sends++; return { message_id: 9, chat: { id: 7 } }; }, settled: async record => { settleHeartbeat(record, f.sql, f.scheduler); } })).rejects.toThrow('crash persist');
    // Failure before attempting commit never issued I/O; after ACK loss the durable attempting evidence quarantines.
    await f.drain(async () => { sends++; return { message_id: 10, chat: { id: 7 } }; });
    expect(sends).toBe(1);
    expect(f.outbox.records()[0]?.status).toBe(failStatus === 'attempting' ? 'delivered' : 'quarantined');
  });
});

it('partial ACK bookkeeping replays every frozen cooldown without resending or shifting time', async () => {
  await withTransport(async f => {
    f.sql.exec("INSERT INTO loops(id, title, due, status, created_at) VALUES (?, ?, ?, 'open', ?)", 'synthetic-second', 'Synthetic second errand', '2026-09-26T14:00', f.now());
    await f.tick(); f.advance(); const ackAt = f.now(); let writes = 0, sends = 0;
    const interruptedSql = { exec: (...args: Parameters<SqlStorage['exec']>) => {
      if (args[0].startsWith('INSERT INTO heartbeat_notified') && ++writes === 2) throw new Error('crash partial cooldown');
      return f.sql.exec(...args);
    } } as Pick<SqlStorage, 'exec'>;
    await expect(f.outbox.drain({ allowed: async () => true, send: async () => { sends++; return { message_id: 9, chat: { id: 7 } }; },
      settled: async record => { settleHeartbeat(record, interruptedSql, f.scheduler); },
    })).rejects.toThrow('crash partial cooldown');
    expect(f.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toHaveLength(1);
    f.advance(60000); await f.drain(async () => { sends++; return { message_id: 10, chat: { id: 7 } }; });
    expect(sends).toBe(1);
    expect(f.sql.exec('SELECT notified_at FROM heartbeat_notified ORDER BY loop_id').toArray()).toEqual([{ notified_at: ackAt }, { notified_at: ackAt }]);
    expect(f.sql.exec('SELECT outcome, delivery FROM schedule_runs').toArray()).toEqual([{ outcome: 'ok', delivery: 'sent' }]);
  });
});

it('failure before enqueue leaves no intent or cooldown and a later producer retry can commit', async () => {
  await withTransport(async f => {
    await f.scheduler.dispatchDue({ heartbeat: heartbeatTick({ scheduler: f.scheduler, sql: f.sql, loops: f.loops, plans: dayPlanBook(f.sql), timezone: 'Asia/Kolkata', now: f.now,
      enqueue: async () => { throw new Error('storage failed before enqueue'); },
    }) });
    expect(f.outbox.records()).toEqual([]); expect(f.sql.exec('SELECT * FROM heartbeat_notified').toArray()).toEqual([]);
    f.advance(31000); await f.tick();
    expect(f.outbox.records()).toHaveLength(1);
    expect(f.sql.exec('SELECT outcome, delivery FROM schedule_runs ORDER BY attempt').toArray()).toEqual([{ outcome: 'failed', delivery: 'pending' }, { outcome: 'running', delivery: 'pending' }]);
  });
});
