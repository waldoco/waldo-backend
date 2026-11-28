import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetHomeCard, homeCardBook } from '../src/channels/home-card';
import type { ForgetStore } from '../src/memory/forget-purge';

const { OwnerDO } = await import('../src/channels/owner-do');

// home_card: the one card on the owner's Home, in Waldo's words, which may name a person or a thread. A forget the card carries
// removes it; the next wake writes a new one from what remains. A forget it does not carry leaves it.
const CARD = { card_id: 'home:1', text: 'Priya Marsh still has not replied about the lease; the viewing is at 5.', written_at: 1, day: '2026-11-28', outside: true };
describe('a forget reaches the Home card', () => {
  it('a forget the card carries removes it; one it does not carry leaves it, and nothing is left to retry', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('home-card-forget')), async (_instance, state) => {
      const book = homeCardBook(state.storage.sql);
      book.write(CARD);
      expect(forgetHomeCard(state.storage.sql, ['the gym'])).toBe(0);
      expect(book.read()?.text).toBe(CARD.text);
      expect(forgetHomeCard(state.storage.sql, ['priya marsh'])).toBe(0);
      expect(book.read()).toBeNull();
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM home_card').toArray())).not.toContain('Priya');
    });
  });

  it('the forget purge job reaches it: home_card is in the owner object\'s one list of stores a forget cleans', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('home-card-forget-stores')), async (_instance, state) => {
      homeCardBook(state.storage.sql).write(CARD);
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const stores = (owner as unknown as { forgetStores(): ForgetStore[] }).forgetStores();
      expect(stores.map(store => store.name)).toContain('home_card');
      for (const store of stores) await store.run(['Priya Marsh']);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM home_card').toArray())).not.toContain('Priya');
    });
  });
});
