import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { forgetWaldoNotes, waldoNotesBook } from '../src/channels/waldo-notes';
import type { ForgetStore } from '../src/memory/forget-purge';

const { OwnerDO } = await import('../src/channels/owner-do');

// waldo_notes: Waldo's own page of what it is watching, in its own words, which may name a person or a thread. A forget that
// the page carries clears the whole page (cutting a phrase out of prose could leave a sentence that still says it); the next
// wake writes it again from what remains. A forget the page does not carry leaves it alone.
const AT = '2026-11-28T10:00';
const PAGE = 'Watching: Priya Marsh has not replied about the lease. Expect: a reply by Friday.';
describe('a forget reaches Waldo\'s own notes', () => {
  it('a forget the page carries clears it, marked as a forget; one it does not carry leaves it', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('waldo-notes-forget')), async (_instance, state) => {
      const book = waldoNotesBook(state.storage.sql);
      book.write({ text: PAGE, revision: 0, by: 'waldo', outside: true, at: AT });
      expect(forgetWaldoNotes(state.storage.sql, ['the gym'], AT)).toBe(0);
      expect(book.read().text).toBe(PAGE);
      // The page is cleared, so nothing is left for the purge to retry.
      expect(forgetWaldoNotes(state.storage.sql, ['priya marsh'], AT)).toBe(0);
      expect(book.read()).toMatchObject({ text: '', revision: 2, written_by: 'forget' });
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM waldo_notes').toArray())).not.toContain('Priya');
    });
  });

  it('the forget purge job reaches it: waldo_notes is in the owner object\'s one list of stores a forget cleans', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('waldo-notes-forget-stores')), async (_instance, state) => {
      waldoNotesBook(state.storage.sql).write({ text: PAGE, revision: 0, by: 'waldo', outside: true, at: AT });
      const owner = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
      const stores = (owner as unknown as { forgetStores(): ForgetStore[] }).forgetStores();
      expect(stores.map(store => store.name)).toContain('waldo_notes');
      for (const store of stores) await store.run(['Priya Marsh']);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM waldo_notes').toArray())).not.toContain('Priya');
    });
  });
});
