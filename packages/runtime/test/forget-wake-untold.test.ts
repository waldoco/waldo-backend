import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetWakeUntold, wakeUntoldBook } from '../src/channels/wake';
import type { ForgetStore } from '../src/memory/forget-purge';

const { OwnerDO } = await import('../src/channels/owner-do');

// wake_untold: changes a wake made with no card whose message was held or failed, kept until the next delivery carries them. A
// line names what was changed (a reminder's note, a follow-up's title), so a forget removes any line carrying the forgotten text.
const LINES = ['Reminder set for 2026-11-29 09:00: "call Priya Marsh about the lease" (you can cancel it)', 'Opened a follow-up "deck review" (you can close it)'];
describe('a forget reaches the changes not yet told', () => {
  it('a forget removes the line that carries the forgotten text and keeps the rest, leaving nothing to retry', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-untold-book')), async (_instance, state) => {
      const book = wakeUntoldBook(state.storage.sql);
      expect(book.read()).toEqual([]);
      book.keep(LINES);
      expect(book.read()).toEqual(LINES);
      expect(forgetWakeUntold(state.storage.sql, ['priya marsh'])).toBe(0);
      expect(book.read()).toEqual([LINES[1]]);
      book.clear();
      expect(book.read()).toEqual([]);
    });
  });

  it('the forget purge job reaches it: wake_untold is in the owner object\'s one list of stores a forget cleans', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('wake-untold-forget-stores')), async (_instance, state) => {
      wakeUntoldBook(state.storage.sql).keep(LINES);
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const stores = (owner as unknown as { forgetStores(): ForgetStore[] }).forgetStores();
      expect(stores.map(store => store.name)).toContain('wake_untold');
      for (const store of stores) await store.run(['Priya Marsh']);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM wake_untold').toArray())).not.toContain('Priya');
    });
  });
});
