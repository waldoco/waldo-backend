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

  it('a retried tool call returns the same reminder instead of a second one', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('reminder-book-retry'));
    await runInDurableObject(stub, async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const now = Date.parse('2036-09-23T08:00:00Z');
      let n = 0;
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'Asia/Kolkata', now: () => new Date(now) }, () => String(++n));
      const args = { note: 'call mom', at: '2036-09-23T18:30', repeat: 'none' as const };
      const first = await book.set(args, 'turn-1-call-1');
      const retry = await book.set(args, 'turn-1-call-1');
      const other = await book.set(args, 'turn-1-call-2');
      expect(retry.id).toBe(first.id);
      expect(other.id).not.toBe(first.id);
      expect(book.list().length).toBe(2);
      await scheduler.cancel(first.id);
      await scheduler.cancel(other.id);
    });
  });
});
