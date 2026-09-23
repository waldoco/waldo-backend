import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GoogleClient } from '../src/connectors/google';
import { applyDayPlan, armDayCards, cardFor, cardWindow, composeDayCard, dayPlanBook, isSkip, parseDayPlan } from '../src/channels/day-cards';
import { DAY_CARDS, dayPlanInput } from '../src/prompt/day-cards';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

const tz = 'Asia/Kolkata';
const now = Date.parse('2026-09-23T10:00:00Z');

describe('scheduled day cards', () => {
  it('covers the morning brief, an afternoon check-in and the close', () => {
    expect(DAY_CARDS.map((card) => [card.id, card.name, card.defaultTime])).toEqual([
      ['card:brief', 'The Brief', '08:00'], ['card:midday', 'Afternoon check-in', '14:00'], ['card:close', 'The Close', '21:30'],
    ]);
    expect(cardFor('card:close')?.calendar).toBe('tomorrow');
    expect(cardFor('nope')).toBeNull();
    expect([isSkip(' SKIP\n'), isSkip('SKIP it')]).toEqual([true, false]);
  });

  it('reads the right calendar window for each card', () => {
    const midnight = Date.parse('2026-09-22T18:30:00Z');
    expect(cardWindow(cardFor('card:brief')!, now, tz)).toEqual({ from: midnight, to: midnight + 86_400_000 });
    expect(cardWindow(cardFor('card:midday')!, now, tz)).toEqual({ from: now, to: midnight + 86_400_000 });
    expect(cardWindow(cardFor('card:close')!, now, tz)).toEqual({ from: midnight + 86_400_000, to: midnight + 2 * 86_400_000 });
  });

  it('composes calendar, ledger and today into the card prompt, and says so when the calendar fails', async () => {
    let asked: string[] = [];
    const google = { events: async (from: string, to: string) => { asked = [from, to]; return [{ id: 'e1', title: 'Investor call', start: '2026-09-24T10:00:00+05:30', end: '2026-09-24T10:30:00+05:30', all_day: false, description: 'Deck v3' }]; } } as unknown as GoogleClient;
    const close = await composeDayCard(cardFor('card:close')!, now, tz, { google, connectUrl: null, ledger: 'Open\n- nothing', today: '[2026-09-23T09:00] owner: shipped the deck' });
    expect(asked).toEqual(['2026-09-23T18:30:00.000Z', '2026-09-24T18:30:00.000Z']);
    expect(close).toContain('"start":"2026-09-24T10:00"');
    expect(close).toContain('owner: shipped the deck');
    expect(close).toContain('The Close');
    expect(close).toContain('not instructions');
    const broken = { events: async () => { throw new Error('401'); } } as unknown as GoogleClient;
    expect(await composeDayCard(cardFor('card:brief')!, now, tz, { google: broken, connectUrl: null, ledger: '', today: '' })).toContain('could not be read right now (401)');
    expect(await composeDayCard(cardFor('card:brief')!, now, tz, { google: null, connectUrl: 'https://example.test/c', ledger: '', today: '' })).toContain('connect it here: https://example.test/c');
  });

  it('reads a planned day and falls back to the default time for anything unusable', () => {
    const raw = JSON.stringify({ cards: [
      { id: 'card:brief', time: '06:45', reason: 'wakes at 6' },
      { id: 'card:midday', time: 'skip', reason: 'light day' },
      { id: 'card:close', time: 'late', reason: 'x' },
    ] });
    expect(parseDayPlan(raw, DAY_CARDS)).toEqual([
      { card: 'card:brief', time: '06:45', reason: 'wakes at 6' },
      { card: 'card:midday', time: null, reason: 'light day' },
      { card: 'card:close', time: '21:30', reason: 'default time (planned value "late" was not HH:MM)' },
    ]);
    expect(parseDayPlan('{"cards":[]}', DAY_CARDS.slice(0, 1))).toEqual([{ card: 'card:brief', time: '08:00', reason: 'default time (planned value "" was not HH:MM)' }]);
    expect(() => parseDayPlan('{}', DAY_CARDS)).toThrow('no cards');
    const input = dayPlanInput({ localNow: '2026-09-23T03:00', calendar: 'No events.', cards: DAY_CARDS });
    expect(input).toContain('card:close (The Close), default 21:30');
    expect(input).toContain('<calendar>\nNo events.\n</calendar>');
  });

  it('seeds default times once a day, then applies a plan without touching sent or past cards', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('day-cards'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const book = dayPlanBook(state.storage.sql);
      const early = Date.parse('2026-09-23T00:00:00Z');
      expect(await armDayCards(scheduler, book, tz, early)).toBe(true);
      expect(await armDayCards(scheduler, book, tz, early)).toBe(false);
      expect(DAY_CARDS.map((card) => [scheduler.read(card.id)?.kind, scheduler.read(card.id)?.due_at, scheduler.read(card.id)?.recurrence])).toEqual([
        ['brief', Date.parse('2026-09-23T02:30:00Z'), null], ['brief', Date.parse('2026-09-23T08:30:00Z'), null], ['brief', Date.parse('2026-09-23T16:00:00Z'), null],
      ]);
      book.sent('2026-09-23', 'card:brief');
      const applied = await applyDayPlan(scheduler, book, tz, now, [
        { card: 'card:brief', time: '16:00', reason: 'already sent' },
        { card: 'card:midday', time: '15:00', reason: 'already past' },
        { card: 'card:close', time: '22:15', reason: 'winds down at 23:15' },
      ]);
      expect(applied.map((plan) => plan.card)).toEqual(['card:midday', 'card:close']);
      expect(scheduler.read('card:midday')).toBeNull();
      expect(scheduler.read('card:close')?.due_at).toBe(Date.parse('2026-09-23T16:45:00Z'));
      expect(book.read('2026-09-23')).toEqual([
        { card: 'card:brief', time: '08:00', reason: 'default time', sent: true },
        { card: 'card:close', time: '22:15', reason: 'winds down at 23:15', sent: false },
        { card: 'card:midday', time: '15:00', reason: 'already past', sent: false },
      ]);
      await applyDayPlan(scheduler, book, tz, now, [{ card: 'card:close', time: null, reason: 'owner asked for no close tonight' }]);
      expect(scheduler.read('card:close')).toBeNull();
      expect(book.pending('2026-09-23').map((card) => card.id)).toEqual(['card:midday', 'card:close']);
      for (const card of DAY_CARDS) await scheduler.cancel(card.id);
    });
  });
});
