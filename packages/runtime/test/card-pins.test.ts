import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, dayPlanBook } from '../src/channels/day-cards';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

describe('card pins', () => {
  it('pinned times override the planner until cleared; a today-only time ignores the pin', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('card-pins'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const now = Date.parse('2036-09-23T01:00:00Z');
      const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
      const book = dayPlanBook(state.storage.sql);
      book.pin('card:close', '22:15');
      await applyDayPlan(scheduler, book, 'Asia/Kolkata', now, [{ card: 'card:close', time: '21:30', reason: 'model plan' }]);
      expect(book.read('2036-09-23')).toEqual([{ card: 'card:close', time: '22:15', reason: 'pinned by you', sent: false }]);
      expect(scheduler.read('card:close')?.due_at).toBe(Date.parse('2036-09-23T16:45:00Z'));
      await applyDayPlan(scheduler, book, 'Asia/Kolkata', now, [{ card: 'card:close', time: '20:00', reason: 'set by you for today' }], false);
      expect(book.read('2036-09-23')[0]?.time).toBe('20:00');
      book.pin('card:close', null);
      expect(book.pins()).toEqual({});
      await scheduler.cancel('card:close');
    });
  });
});
