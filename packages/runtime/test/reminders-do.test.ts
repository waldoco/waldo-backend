import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { reminderBook } from '../src/channels/reminders';
import { ensureSchema } from '../src/tracer/schema';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

describe('reminder book on the Telegram owner object', () => {
  it('schedules, lists, fires and cancels reminders beside chat memory', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('reminder-book'));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const now = Date.parse('2036-09-23T08:00:00Z');
      let n = 0;
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'Asia/Kolkata', now: () => new Date(now) }, () => String(++n));
      const once = await book.set({ note: 'call mom', at: '2036-09-23T18:30', repeat: 'none' });
      const daily = await book.set({ note: 'drink water', at: '2036-09-23T09:00', repeat: 'daily' });
      await expect(book.set({ note: 'late', at: '2036-09-23T10:00', repeat: 'none' })).rejects.toThrow('already past');
      expect(daily.at).toBe('2036-09-24T09:00');
      expect(book.list().map((r) => [r.note, r.at, r.repeat])).toEqual([['call mom', '2036-09-23T18:30', 'none'], ['drink water', '2036-09-24T09:00', 'daily']]);
      expect(scheduler.read(once.id)?.due_at).toBe(Date.parse('2036-09-23T13:00:00Z'));
      expect(await state.storage.getAlarm()).toBe(Date.parse('2036-09-23T13:00:00Z'));
      book.fired(scheduler.read(once.id)!);
      expect(book.note(once.id)).toBeNull();
      expect(await book.cancel(daily.id)).toBe(true);
      expect(book.list()).toEqual([]);
      await scheduler.cancel(once.id);
    });
  });
});

describe('owner-scoped bulk reminder cancellation', () => {
  it('removes all reminder rows and notes, preserving other schedule kinds', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('reminder-bulk-cancel'));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const now = Date.parse('2036-09-23T08:00:00Z');
      let n = 0;
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'Asia/Kolkata', now: () => new Date(now) }, () => String(++n));
      const a = await book.set({ note: 'a', at: '2036-09-23T18:30', repeat: 'none' });
      const b = await book.set({ note: 'b', at: '2036-09-23T19:30', repeat: 'daily' });
      await scheduler.schedule({ id: 'other', kind: 'standing_order', occurrenceAt: now + 86400000, dueAt: now + 86400000, payloadRefs: { order_id: 'other' } });
      expect(await book.cancelAll()).toBe(2);
      expect(book.list()).toEqual([]);
      expect(book.note(a.id)).toBeNull();
      expect(book.note(b.id)).toBeNull();
      expect(scheduler.read('other')).not.toBeNull();
      expect(await book.cancelAll()).toBe(0);
      await scheduler.cancel('other');
    });
  });
});

describe('owner-local reminder recurrence', () => {
  it.each([
    ['daily', '2026-03-07T09:00', '2026-03-07T15:00:00Z', '2026-03-08T13:00:00Z', undefined],
    ['weekdays', '2026-10-09T09:00', '2026-10-09T15:00:00Z', '2026-10-12T13:00:00Z', undefined],
    ['weekly', '2026-03-01T09:00', '2026-03-01T15:00:00Z', '2026-03-08T13:00:00Z', undefined],
    ['cron', '2026-10-09T09:00', '2026-10-09T15:00:00Z', '2026-10-12T13:00:00Z', '0 9 * * 1-5'],
  ] as const)('sets and round-trips %s with owner timezone, including DST', async (repeat, at, nowText, expected, cron) => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`reminder-recurrence-${repeat}`));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      let now = Date.parse(nowText);
      const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'America/New_York', now: () => new Date(now) }, () => repeat);
      const reminder = await book.set({ note: 'routine', at, repeat, ...(cron ? { cron } : {}) } as never);
      expect(scheduler.read(reminder.id)?.due_at).toBe(Date.parse(expected));
      expect(book.list()[0]).toMatchObject({ repeat, ...(cron ? { cron } : {}) });
      now = Date.parse(expected);
      expect(await scheduler.dispatchDue({ reminder: async () => {} })).toHaveLength(1);
      expect(book.list()[0]?.repeat).toBe(repeat);
      expect(scheduler.read(reminder.id)!.due_at).toBeGreaterThan(now);
      expect(book.list()[0]!.at.slice(11)).toBe('09:00');
      await book.cancelAll();
    });
  });
});

describe('first recurrence in a DST gap', () => {
  it('uses the first valid minute on the requested local date, not the following day', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('reminder-first-dst-gap'));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage);
      const now = Date.parse('2026-03-07T15:00:00Z');
      const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'America/New_York', now: () => new Date(now) }, () => 'gap');
      const reminder = await book.set({ note: 'gap', at: '2026-03-08T02:30', repeat: 'daily' });
      expect(scheduler.read(reminder.id)?.due_at).toBe(Date.parse('2026-03-08T07:00:00Z'));
      await book.cancelAll();
    });
  });
});

describe('future cron start boundary', () => {
  it('does not fire before the requested at time on a future date', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('reminder-cron-start'));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql); ensureSchema(state.storage);
      const now = Date.parse('2026-10-08T08:00:00Z');
      const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'America/New_York', now: () => new Date(now) }, () => 'boundary');
      const reminder = await book.set({ note: 'cron', at: '2026-10-09T12:00', repeat: 'cron', cron: '0 9 * * *' });
      expect(scheduler.read(reminder.id)?.due_at).toBe(Date.parse('2026-10-10T13:00:00Z'));
      await book.cancelAll();
    });
  });
});
