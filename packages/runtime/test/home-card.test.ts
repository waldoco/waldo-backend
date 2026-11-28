import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { homeCardAnswer, homeCardBook, homeCardHandler } from '../src/channels/home-card';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

// GENERAL_WAKE: the one card the owner sees first on Home. The wake writes it whole; the app reads it for today, or none.
const NOW = Date.parse('2026-11-28T10:00:00Z');
const TODAY = '2026-11-28';
const LINE = 'Board prep moved to 4. Your deep work block this morning is safe; the gym is still at 6.';
let seq = 0;
const inStore = <T,>(work: (sql: SqlStorage) => T | Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`home-card-${seq += 1}`)), async (_instance, state) => work(state.storage.sql));
const ctx = (extra: Partial<ToolDispatcherContext> = {}) => extra as ToolDispatcherContext;

describe('the Home card', () => {
  it('golden: the wake writes the card whole, and the app reads it for today with no model call', async () => {
    await inStore(async sql => {
      const book = homeCardBook(sql);
      expect(homeCardAnswer(book.read(), TODAY)).toEqual({ state: 'none' });
      const handler = homeCardHandler(book, { now: () => NOW, today: () => TODAY });
      expect(await handler.handle({ text: LINE }, ctx({ toolArgSourceTaint: 'external' }))).toMatchObject({ ok: true, data: { card_id: `home:${NOW}`, written: true } });
      expect(book.read()).toEqual({ card_id: `home:${NOW}`, text: LINE, written_at: NOW, day: TODAY, outside: true });
      expect(homeCardAnswer(book.read(), TODAY)).toEqual({ state: 'written', card_id: `home:${NOW}`, text: LINE, written_at: NOW, day: TODAY });
      await homeCardHandler(book, { now: () => NOW + 1, today: () => TODAY }).handle({ text: 'Rewritten.' }, ctx());
      expect(homeCardAnswer(book.read(), TODAY)).toMatchObject({ card_id: `home:${NOW + 1}`, text: 'Rewritten.' });
    });
  });

  it('a card for an earlier day reads as none', async () => {
    await inStore(async sql => {
      homeCardBook(sql).write({ card_id: 'home:1', text: LINE, written_at: NOW, day: '2026-11-27', outside: false });
      expect(homeCardAnswer(homeCardBook(sql).read(), TODAY)).toEqual({ state: 'none' });
    });
  });

  it('a card that holds a health reading is never kept, and the card before stays', async () => {
    await inStore(async sql => {
      const book = homeCardBook(sql);
      const handler = homeCardHandler(book, { now: () => NOW, today: () => TODAY });
      await handler.handle({ text: LINE }, ctx());
      expect(await handler.handle({ text: 'Your HRV is 31 ms today, so take it easy.' }, ctx())).toMatchObject({ ok: false, code: 'rejected' });
      expect(book.read()?.text).toBe(LINE);
    });
  });
});
