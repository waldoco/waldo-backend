import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetWakeUntold, wakeUntoldBook, WITHHELD_CHANGE } from '../src/channels/wake';
import type { ForgetStore } from '../src/memory/forget-purge';

const { OwnerDO } = await import('../src/channels/owner-do');

// wake_untold: changes a wake made with no card whose message was held or failed, kept until the next delivery carries them. A
// line names what was changed (a reminder's note, a follow-up's title), so a forget removes any line carrying the forgotten text.
const LINES = ['Reminder set for 2026-11-29 09:00: "call Priya Marsh about the lease" (you can cancel it)', 'Opened a follow-up "deck review" (you can close it)'];
describe('a forget reaches the changes not yet told', () => {
  it('a forget removes the line that carries the forgotten text and keeps the rest, leaving nothing to retry', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-untold-book')), async (_instance, state) => {
      const book = wakeUntoldBook(state.storage.sql), lines = () => book.read().map(entry => entry.line);
      expect(book.read()).toEqual([]);
      book.add(LINES);
      expect(lines()).toEqual(LINES);
      expect(forgetWakeUntold(state.storage.sql, ['priya marsh'])).toBe(0);
      expect(lines()).toEqual([LINES[1]]);
      // A line written after a message read the table stays when that message settles what it carried.
      const through = book.read().at(-1)!.seq;
      book.add(['Reminder set for 2026-11-30 08:00: "later" (you can cancel it)']);
      book.settle(through);
      expect(lines()).toEqual(['Reminder set for 2026-11-30 08:00: "later" (you can cancel it)']);
      // A line holding a health reading is kept as a fixed line, never the reading.
      book.add(['Reminder set for 2026-11-30 07:00: "HRV was 31 ms, rest" (you can cancel it)']);
      expect(lines().at(-1)).toBe(WITHHELD_CHANGE);
    });
  });

  it('the forget purge job reaches it: wake_untold is in the owner object\'s one list of stores a forget cleans', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('wake-untold-forget-stores')), async (_instance, state) => {
      wakeUntoldBook(state.storage.sql).add(LINES);
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const stores = (owner as unknown as { forgetStores(): ForgetStore[] }).forgetStores();
      expect(stores.map(store => store.name)).toContain('wake_untold');
      for (const store of stores) await store.run(['Priya Marsh']);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM wake_untold').toArray())).not.toContain('Priya');
    });
  });
});
