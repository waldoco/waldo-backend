import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetWakeReasons, WAKE_ROWS_KEPT, wakeOutcomeBook } from '../src/channels/wake';

// wake_outcomes: each general wake's outcome row keeps the reason the run gave, which is Waldo's own wording and may name a
// person or quote a mail. A forget (the owner DO's forget_memory redaction) clears a reason that carries the forgotten text;
// the row stays for its outcome and tools. The table keeps only the newest rows.
const NOW = Date.parse('2026-11-28T10:00:00Z');
describe('a forget reaches the wake outcome rows', () => {
  it('the outcome table keeps the newest rows only, and a forget clears a reason that carries the forgotten text', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-outcomes-book')), async (_instance, state) => {
      const book = wakeOutcomeBook(state.storage.sql);
      for (let index = 0; index < WAKE_ROWS_KEPT + 5; index += 1) book.record({ id: `w${index}`, at: NOW + index, kind: 'look', ref: 'cadence', outcome: 'nothing', reason: index === WAKE_ROWS_KEPT + 4 ? 'Waiting on Priya Marsh to reply about the lease.' : 'Nothing new.', tools: [], outside: true });
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM wake_outcomes').one().n).toBe(WAKE_ROWS_KEPT);
      expect(forgetWakeReasons(state.storage.sql, ['priya marsh'])).toBe(0);
      expect(book.recent(1)[0]).toMatchObject({ id: `w${WAKE_ROWS_KEPT + 4}`, reason: null });
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM wake_outcomes').toArray())).not.toContain('Priya');
    });
  });
});
