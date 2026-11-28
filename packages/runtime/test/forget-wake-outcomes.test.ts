import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetWakeReasons, WAKE_ROWS_KEPT, wakeOutcomeBook } from '../src/channels/wake';
import type { ForgetStore } from '../src/memory/forget-purge';

const { OwnerDO } = await import('../src/channels/owner-do');

// wake_outcomes: each general wake's outcome row keeps the reason the run gave, which is Waldo's own wording and may name a
// person or quote a mail. A forget (the owner DO's forget_memory redaction) clears a reason that carries the forgotten text;
// the row stays for its outcome and tools. The table keeps only the newest rows.
const NOW = Date.parse('2026-11-28T10:00:00Z');
describe('a forget reaches the wake outcome rows', () => {
  it('the outcome table keeps the newest rows only, and a forget clears a reason that carries the forgotten text', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-outcomes-book')), async (_instance, state) => {
      const book = wakeOutcomeBook(state.storage.sql);
      for (let index = 0; index < WAKE_ROWS_KEPT + 5; index += 1) book.record({ id: `w${index}`, at: NOW + index, kind: 'look', ref: 'cadence', outcome: 'nothing', reason: index === WAKE_ROWS_KEPT + 4 ? 'Waiting on Priya Marsh to reply about the lease.' : 'Nothing new.', tools: [], outside: true, spend: null });
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM wake_outcomes').one().n).toBe(WAKE_ROWS_KEPT);
      expect(forgetWakeReasons(state.storage.sql, ['priya marsh'])).toBe(0);
      expect(book.recent(1)[0]).toMatchObject({ id: `w${WAKE_ROWS_KEPT + 4}`, reason: null });
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM wake_outcomes').toArray())).not.toContain('Priya');
    });
  });

  it('the forget purge job reaches it: wake_outcomes is in the owner object\'s one list of stores a forget cleans', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('wake-outcomes-forget-stores')), async (_instance, state) => {
      wakeOutcomeBook(state.storage.sql).record({ id: 'w1', at: NOW, kind: 'look', ref: 'cadence', outcome: 'nothing', reason: 'Waiting on Priya Marsh to reply about the lease.', tools: [], outside: true, spend: null });
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const stores = (owner as unknown as { forgetStores(): ForgetStore[] }).forgetStores();
      expect(stores.map(store => store.name)).toContain('wake_reasons');
      for (const store of stores) await store.run(['Priya Marsh']);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM wake_outcomes').toArray())).not.toContain('Priya');
    });
  });
});
