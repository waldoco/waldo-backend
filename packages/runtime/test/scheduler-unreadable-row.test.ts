import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SCHEDULE_KINDS } from '@waldo/contracts';
import { applyDayPlan, armDayCards, dayPlanBook, defaultPlan } from '../src/channels/day-cards';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { heartbeatTick, HEARTBEAT_ID } from '../src/channels/heartbeat';
import { loopBook } from '../src/channels/loops';
import { reminderBook, reminderHandlers, unreadableRemindersLine } from '../src/channels/reminders';
import { applySchedulePreferences, reconcileSchedulePreferences } from '../src/channels/schedule-preferences';
import { standingOrderBook, standingOrderHandlers, standingOrdersPrompt } from '../src/channels/standing-orders';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { Scheduler, UnreadableScheduleRowError } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';

let seq = 0;
const freshStub = (): Parameters<typeof runInDurableObject>[0] => {
  seq += 1;
  const ns = (env as never as { TRACER_DO: { idFromName(n: string): unknown; get(i: unknown): never } }).TRACER_DO;
  return ns.get(ns.idFromName(`unreadable-row-${seq}`));
};
const MINUTE = 60_000;

// A row as an older Worker meets it after a rollback: written by a newer Worker, with a kind this build does not know.
const plantUnknownKind = (sql: SqlStorage, id: string, dueAt: number, kind = 'kind_from_a_newer_worker', recurrence: unknown = null) => sql.exec(
  `INSERT INTO schedule (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts, last_fired_at, quarantined_until, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 'armed', 0, NULL, NULL, ?, ?)`, id, kind, dueAt, dueAt, recurrence === null ? null : JSON.stringify(recurrence), JSON.stringify({ id }), dueAt, dueAt);
// A known kind with a recurrence only a newer Worker writes.
const RESHAPED = { type: 'every_other_tuesday', every_ms: 600_000 };
const rowsLike = (sql: SqlStorage, prefix: string) => sql.exec("SELECT * FROM schedule WHERE id >= ? AND id < ? ORDER BY id", prefix, `${prefix}~`).toArray();
const invalidLogs = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.flatMap(([line]) => {
  try { const parsed = JSON.parse(String(line)); return parsed.hop === 'schedule_row_invalid' ? [parsed] : []; } catch { return []; }
});
const at = (now: number): Deps => ({ now: () => now, newRunId: () => crypto.randomUUID(), newOutboxId: () => crypto.randomUUID(), sha256Hex: async () => '0'.repeat(64) });

afterEach(() => vi.restoreAllMocks());

describe('a schedule row this Worker cannot read', () => {
  it('does not stop the owner\'s other due work, is logged once per pass by count only, and is left exactly as it was', async () => {
    for (const bad of [1, 8]) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const now = Date.now();
      const fired = await runInDurableObject(freshStub(), async (_instance, state) => {
        const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
        // As many unreadable rows as one alarm may dispatch, stored first and due earlier than the valid one, so a
        // dispatch that cut its batch before leaving them out would never reach the valid row.
        for (let i = 0; i < bad; i += 1) plantUnknownKind(state.storage.sql, `unreadable-${i}`, now - 2 * MINUTE);
        await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now - MINUTE, dueAt: now - MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
        const before = rowsLike(state.storage.sql, 'unreadable-');
        expect(scheduler.hasDue()).toBe(true);
        expect(invalidLogs(log)).toEqual([]);
        const ran: string[] = [];
        await scheduler.dispatchDue({ brief: async entry => { ran.push(entry.id); } });
        expect(rowsLike(state.storage.sql, 'unreadable-')).toEqual(before);
        expect(before.every(row => row.status === 'armed')).toBe(true);
        return ran;
      });
      expect([bad, fired]).toEqual([bad, ['valid']]);
      expect([bad, invalidLogs(log)]).toEqual([bad, [{ hop: 'schedule_row_invalid', ok: false, count: bad }]]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('unreadable-');
      log.mockRestore();
    }
  });

  it('leaves the alarm on the next readable row, and never wakes for the unreadable one', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
      plantUnknownKind(state.storage.sql, 'unreadable-soon', now + 10 * MINUTE);
      await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
      await scheduler.rearm();
      expect(await state.storage.getAlarm()).toBe(now + 60 * MINUTE);
      // With only an unreadable row due, nothing is due and no alarm keeps waking for it.
      await scheduler.cancel('valid');
      plantUnknownKind(state.storage.sql, 'unreadable-due', now - MINUTE);
      expect(scheduler.hasDue()).toBe(false);
      await scheduler.rearm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(rowsLike(state.storage.sql, 'unreadable-').map(row => row.status)).toEqual(['armed', 'armed']);
    });
  });

  it('counts a pause that has ended as due work only on a row this Worker can read', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
      const pauseEnded = (id: string) => state.storage.sql.exec("UPDATE schedule SET status = 'quarantined', quarantined_until = ? WHERE id = ?", now - MINUTE, id);
      plantUnknownKind(state.storage.sql, 'unreadable-paused', now + 60 * MINUTE);
      pauseEnded('unreadable-paused');
      await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
      expect(scheduler.hasDue()).toBe(false);
      pauseEnded('valid');
      expect(scheduler.hasDue()).toBe(true);
    });
  });

  it('counts a pause still running as no due work, and a dispatch leaves it paused until its end', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = (clock: number) => new Scheduler(state.storage.sql, state.storage, at(clock));
      await scheduler(now).schedule({ id: 'valid', kind: 'brief', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
      state.storage.sql.exec("UPDATE schedule SET status = 'quarantined', quarantined_until = ? WHERE id = ?", now + MINUTE, 'valid');
      expect(scheduler(now).hasDue()).toBe(false);
      expect(await scheduler(now).dispatchDue({})).toEqual([]);
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM schedule WHERE id = ?', 'valid').one().status).toBe('quarantined');
      expect(scheduler(now + MINUTE).hasDue()).toBe(true);
    });
  });
});

describe('reading one id whose row this Worker cannot read', () => {
  it('tells absent, readable and unreadable apart, and cancels only a readable row', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, at(now));
      plantUnknownKind(state.storage.sql, 'unreadable-row', now + MINUTE, 'heartbeat', RESHAPED);
      await scheduler.schedule({ id: 'valid', kind: 'brief', occurrenceAt: now + MINUTE, dueAt: now + MINUTE, payloadRefs: { id: 'valid' }, recurrence: null });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect([scheduler.lookup('nothing').state, scheduler.lookup('valid').state, scheduler.lookup('unreadable-row').state]).toEqual(['absent', 'entry', 'unreadable']);
      // Each lookup that meets an unreadable row says so, by count only.
      expect(invalidLogs(log)).toEqual([{ hop: 'schedule_row_invalid', ok: false, code: 'lookup', count: 1 }]);
      const before = rowsLike(state.storage.sql, 'unreadable-');
      await scheduler.cancelReadable('unreadable-row');
      await scheduler.cancelReadable('valid');
      expect(rowsLike(state.storage.sql, 'unreadable-')).toEqual(before);
      expect(scheduler.lookup('valid').state).toBe('absent');
      expect(JSON.stringify(log.mock.calls)).not.toContain('unreadable-row');
      // read(id) still refuses, with an error a caller can tell apart from a passing fault.
      expect(() => scheduler.read('unreadable-row')).toThrow(UnreadableScheduleRowError);
    });
  });

  it('turning every kind off cancels the readable fixed jobs and leaves the unreadable ones exactly as they were', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const { sql } = state.storage;
      const scheduler = new Scheduler(sql, state.storage, at(now));
      const unreadable = [[HEARTBEAT_ID, 'heartbeat'], [NIGHTLY_ID, 'dreaming'], [BRIEF_SWEEP_ID, 'pre_activity_spot'], [DAY_CARDS[0]!.id, 'brief']] as const;
      for (const [id, kind] of unreadable) plantUnknownKind(sql, id, now + 60 * MINUTE, kind, RESHAPED);
      const readableCard = DAY_CARDS[1]!.id;
      await scheduler.schedule({ id: readableCard, kind: 'brief', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { id: readableCard }, recurrence: null });
      const rows = () => sql.exec('SELECT * FROM schedule WHERE id IN (?, ?, ?, ?) ORDER BY id', ...unreadable.map(([id]) => id)).toArray();
      const before = rows();
      const off = Object.fromEntries(SCHEDULE_KINDS.map(kind => [kind, false])) as Record<(typeof SCHEDULE_KINDS)[number], boolean>;
      const ctx = { scheduler, plans: dayPlanBook(sql), timezone: 'UTC', now };
      await applySchedulePreferences(off, ctx);
      await reconcileSchedulePreferences(off, ctx);
      expect(rows()).toEqual(before);
      expect(scheduler.lookup(readableCard).state).toBe('absent');
    });
  });

  it('plans no day card whose row cannot be read, and cancels only readable cards when the day plan is off', async () => {
    // Midnight UTC, so every card's default time is still ahead today.
    const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const { sql } = state.storage;
      const scheduler = new Scheduler(sql, state.storage, at(now));
      const [unreadableCard, readableCard] = [DAY_CARDS[0]!.id, DAY_CARDS[1]!.id];
      plantUnknownKind(sql, unreadableCard, now + 60 * MINUTE, 'brief', RESHAPED);
      const before = rowsLike(sql, unreadableCard);
      const plans = dayPlanBook(sql);
      const applied = await applyDayPlan(scheduler, plans, 'UTC', now, defaultPlan(DAY_CARDS));
      expect(applied.map(entry => entry.card)).not.toContain(unreadableCard);
      expect(applied.map(entry => entry.card)).toContain(readableCard);
      expect(plans.read(new Date(now).toISOString().slice(0, 10)).map(entry => entry.card)).not.toContain(unreadableCard);
      expect(scheduler.lookup(readableCard).state).toBe('entry');
      await applyDayPlan(scheduler, plans, 'UTC', now, defaultPlan(DAY_CARDS), true, false);
      expect(rowsLike(sql, unreadableCard)).toEqual(before);
      expect(scheduler.lookup(readableCard).state).toBe('absent');
    });
  });

  it('seeds no day plan, and so asks for no plan, when every card row is unreadable', async () => {
    const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const { sql } = state.storage;
      const scheduler = new Scheduler(sql, state.storage, at(now));
      for (const card of DAY_CARDS) plantUnknownKind(sql, card.id, now + 60 * MINUTE, 'brief', RESHAPED);
      const plans = dayPlanBook(sql);
      expect(await armDayCards(scheduler, plans, 'UTC', now)).toBe(false);
      expect(await armDayCards(scheduler, plans, 'UTC', now)).toBe(false);
      sql.exec('DELETE FROM schedule WHERE id = ?', DAY_CARDS[0]!.id);
      expect(await armDayCards(scheduler, plans, 'UTC', now)).toBe(true);
    });
  });

  it('releasing a quiet-hours-held card leaves an unreadable card row exactly as it was', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const { sql } = state.storage;
      const scheduler = new Scheduler(sql, state.storage, at(now));
      const [unreadableCard, readableCard] = [DAY_CARDS[0]!.id, DAY_CARDS[1]!.id];
      plantUnknownKind(sql, unreadableCard, now + 60 * MINUTE, 'brief', RESHAPED);
      const before = rowsLike(sql, unreadableCard);
      const loops = loopBook(sql, { newId: () => 'loop-1', now: () => now });
      await scheduler.schedule({ id: HEARTBEAT_ID, kind: 'heartbeat', occurrenceAt: now - MINUTE, dueAt: now - MINUTE, payloadRefs: { id: HEARTBEAT_ID } });
      await scheduler.dispatchDue({ heartbeat: heartbeatTick({ scheduler, sql, loops, plans: { heldToday: () => [unreadableCard, readableCard] }, timezone: 'UTC', now: () => now, enqueue: async () => undefined }) });
      expect(rowsLike(sql, unreadableCard)).toEqual(before);
      expect(scheduler.lookup(readableCard)).toMatchObject({ state: 'entry', entry: { due_at: now } });
    });
  });

  it('lists a standing order without its schedule, and leaves out a reminder, when the row behind it cannot be read', async () => {
    const now = Date.now();
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const { sql } = state.storage;
      const scheduler = new Scheduler(sql, state.storage, at(now));
      const clock = { timezone: 'UTC', now: () => new Date(now) };
      const orders = standingOrderBook(sql, scheduler, clock, () => 'order-1');
      sql.exec("INSERT INTO standing_orders (id, scope, trigger, at, gate, escalation, created_at) VALUES ('order-1', 'tidy the inbox', 'daily', '09:00', 'confirm_first', 'none', ?)", now);
      plantUnknownKind(sql, 'order-1', now + 60 * MINUTE, 'standing_order', RESHAPED);
      expect(orders.list().map(order => [order.id, order.cron, order.schedule_unreadable])).toEqual([['order-1', undefined, true]]);
      sql.exec("INSERT INTO standing_orders (id, scope, trigger, at, gate, escalation, created_at) VALUES ('order-cron', 'weekly review', 'cron', NULL, 'confirm_first', 'none', ?)", now + 1);
      plantUnknownKind(sql, 'order-cron', now + 60 * MINUTE, 'standing_order', RESHAPED);
      const prompt = standingOrdersPrompt(orders);
      expect(prompt).toContain("runs cron on a schedule stored in a form this version can't read");
      expect(prompt).not.toContain('at null');
      // Cancelling one can never succeed here, so it is refused as final, not as a passing fault, and nothing changes.
      const orderRows = () => sql.exec("SELECT * FROM standing_orders WHERE id = 'order-1'").toArray();
      const ordersBefore = [orderRows(), rowsLike(sql, 'order-1')];
      const cancelOrder = standingOrderHandlers(orders).find(handler => handler.name === 'cancel_standing_order')!;
      expect(await (cancelOrder as unknown as { handle: (args: { id: string }) => Promise<unknown> }).handle({ id: 'order-1' })).toMatchObject({ ok: false, code: 'rejected' });
      expect([orderRows(), rowsLike(sql, 'order-1')]).toEqual(ordersBefore);
      const reminders = reminderBook(sql, scheduler, clock, () => 'unused');
      for (const id of ['reminder-unreadable', 'reminder-readable']) sql.exec('INSERT INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', id, 'call Sam', now);
      plantUnknownKind(sql, 'reminder-unreadable', now + 30 * MINUTE, 'reminder', RESHAPED);
      await scheduler.schedule({ id: 'reminder-readable', kind: 'reminder', occurrenceAt: now + 60 * MINUTE, dueAt: now + 60 * MINUTE, payloadRefs: { reminder_id: 'reminder-readable' }, recurrence: null });
      expect(reminders.list().map(reminder => reminder.id)).toEqual(['reminder-readable']);
      // The ones left out are still counted, so the owner and the model know they exist.
      expect(reminders.unreadable()).toBe(1);
      const listTool = reminderHandlers(reminders).find(handler => handler.name === 'list_reminders')!;
      expect(await (listTool as unknown as { handle: () => Promise<unknown> }).handle()).toMatchObject({ ok: true, data: { reminders: [{ id: 'reminder-readable' }], unreadable: 1 } });
      const cancelReminder = reminderHandlers(reminders).find(handler => handler.name === 'cancel_reminder')!;
      const reminderRows = () => [sql.exec("SELECT * FROM reminder_notes WHERE id = 'reminder-unreadable'").toArray(), rowsLike(sql, 'reminder-unreadable')];
      const remindersBefore = reminderRows();
      expect(await (cancelReminder as unknown as { handle: (args: { id: string }) => Promise<unknown> }).handle({ id: 'reminder-unreadable' })).toMatchObject({ ok: false, code: 'rejected' });
      expect(reminderRows()).toEqual(remindersBefore);
      expect(unreadableRemindersLine(0)).toBe('');
      expect(unreadableRemindersLine(2)).toContain('2 more reminders');
    });
  });
});
