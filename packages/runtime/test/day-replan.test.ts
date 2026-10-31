import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, applyReplan, dayPlanBook, movableCards, parseDayPlan, SET_FOR_TODAY, type DayPlanBook } from '../src/channels/day-cards';
import { dayPlanInput, DAY_CARDS } from '../src/prompt/day-cards';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

// When today's calendar changes, the cards still planned and not yet due are planned again. The owner's own times, a card held
// for quiet hours or waiting on the model, and one already sent or due keep theirs; a re-planned time already past keeps the
// card where it was. Owner-local times throughout.
let seq = 0;
const withPlan = (timezone: string, now: number, work: (h: Readonly<{ book: DayPlanBook; scheduler: Scheduler; plan(card: string, time: string | null, reason?: string): Promise<void> }>) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`day-replan-${seq += 1}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
    const book = dayPlanBook(state.storage.sql);
    const plan = async (card: string, time: string | null, reason = 'model plan') => {
      await applyDayPlan(scheduler, book, timezone, now, [{ card: card as never, time, reason }], false);
    };
    await work({ book, scheduler, plan });
    for (const card of DAY_CARDS) await scheduler.cancel(card.id);
  });
const ids = (movable: ReturnType<typeof movableCards>) => movable.map(entry => entry.card.id);

describe('what a re-plan may move', () => {
  const now = Date.parse('2026-10-20T07:00:00Z');

  it('golden: a planned card not yet due moves to its new time, with the reason given', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '08:00');
      const movable = movableCards(book, 'UTC', now);
      expect(movable).toEqual([expect.objectContaining({ card: expect.objectContaining({ id: 'card:brief' }), time: '08:00' })]);
      await applyReplan(scheduler, book, 'UTC', now, [{ card: 'card:brief', time: '07:20', reason: 'before the 07:30 call' }], movable);
      expect(book.read('2026-10-20')).toEqual([expect.objectContaining({ card: 'card:brief', time: '07:20', reason: 'before the 07:30 call' })]);
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-20T07:20:00Z'));
    });
  });

  it('a re-planned time already past keeps the card where it was', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '08:00');
      await applyReplan(scheduler, book, 'UTC', now, [{ card: 'card:brief', time: '06:50', reason: 'should have gone earlier' }], movableCards(book, 'UTC', now));
      expect(book.read('2026-10-20')[0]).toMatchObject({ time: '08:00', reason: 'model plan' });
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-20T08:00:00Z'));
    });
  });

  it('the model may still skip a card the change made unnecessary', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:midday', '14:00');
      await applyReplan(scheduler, book, 'UTC', now, [{ card: 'card:midday', time: null, reason: 'the afternoon cleared' }], movableCards(book, 'UTC', now));
      expect(book.read('2026-10-20')[0]).toMatchObject({ time: null, reason: 'the afternoon cleared' });
      expect(scheduler.read('card:midday')).toBeNull();
    });
  });

  it('keeps the owner\'s own times, held, waiting, sent and due cards, and a card never planned', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '09:15', SET_FOR_TODAY);
      book.pin('card:close', '22:00');
      await applyDayPlan(scheduler, book, 'UTC', now, [{ card: 'card:close', time: '21:30', reason: 'model plan' }]);
      await plan('card:midday', '14:00');
      expect(ids(movableCards(book, 'UTC', now))).toEqual(['card:midday']);
      book.held('2026-10-20', 'card:midday');
      expect(ids(movableCards(book, 'UTC', now))).toEqual([]);
      await applyReplan(scheduler, book, 'UTC', now, [{ card: 'card:brief', time: '07:20', reason: 'x' }, { card: 'card:close', time: '20:00', reason: 'x' },
        { card: 'card:midday', time: '13:00', reason: 'x' }], movableCards(book, 'UTC', now));
      expect(book.read('2026-10-20').map(row => [row.card, row.time])).toEqual([['card:brief', '09:15'], ['card:close', '22:00'], ['card:midday', '14:00']]);
    });
    await withPlan('UTC', now, async ({ book, plan }) => {
      await plan('card:brief', '08:00');
      book.waitingOnModel('2026-10-20', 'card:brief');
      await plan('card:midday', '06:30');
      book.sent('2026-10-20', 'card:close');
      expect(ids(movableCards(book, 'UTC', now))).toEqual([]);
    });
  });

  it('reads due and new times on the owner\'s clock, across a DST end and a zone change', async () => {
    // London leaves summer time at 01:00 UTC on 25 October 2026.
    const sunday = Date.parse('2026-10-25T07:00:00Z');
    await withPlan('Europe/London', sunday, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '09:00');
      await applyReplan(scheduler, book, 'Europe/London', sunday, [{ card: 'card:brief', time: '08:30', reason: 'x' }], movableCards(book, 'Europe/London', sunday));
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-25T08:30:00Z'));
    });
    // 03:00 UTC is 08:30 in Kolkata: a Brief planned for 08:00 there is already due, so it is not moved.
    const morning = Date.parse('2026-10-20T03:00:00Z');
    await withPlan('UTC', morning, async ({ book, plan }) => {
      await plan('card:brief', '08:00');
      expect(ids(movableCards(book, 'UTC', morning))).toEqual(['card:brief']);
      expect(ids(movableCards(book, 'Asia/Kolkata', morning))).toEqual([]);
    });
  });
});

describe('the re-plan prompt', () => {
  it('names each card\'s current time and asks for times after now, or to keep them', () => {
    const text = dayPlanInput({ localNow: '2026-10-20T07:00', calendar: '- 07:30 Call with Asha', cards: DAY_CARDS.slice(0, 1), proactivity: 'Proactivity: normal',
      replan: { 'card:brief': '08:00' } });
    expect(text).toContain('Today\'s calendar just changed.');
    expect(text).toContain('- card:brief (The Brief), default 08:00, planned 08:00');
    expect(text).toContain('a time after now');
  });

  it('the nightly plan reads as before', () => {
    const text = dayPlanInput({ localNow: '2026-10-20T03:00', calendar: '', cards: DAY_CARDS.slice(0, 1), proactivity: 'Proactivity: normal' });
    expect(text).toContain('Plan these cards for today:\n\n- card:brief (The Brief), default 08:00\n\n<calendar>');
    expect(text).not.toContain('just changed');
  });
});

describe('reading a re-plan reply', () => {
  it('a card the reply leaves out or times badly keeps its time, where the nightly plan falls back to the default', () => {
    const reply = JSON.stringify({ cards: [{ id: 'card:brief', time: 'soon', reason: 'x' }, { id: 'card:midday', time: '13:00', reason: 'lunch moved' }] });
    expect(parseDayPlan(reply, DAY_CARDS, true)).toEqual([{ card: 'card:midday', time: '13:00', reason: 'lunch moved' }]);
    expect(parseDayPlan(reply, DAY_CARDS).map(entry => entry.time)).toEqual(['08:00', '13:00', '21:30']);
  });
});
