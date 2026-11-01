import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, applyWake, dayPlanBook, parseWakeReply, SET_FOR_TODAY, takeWakeTurn, wakeTarget, WAKE_TURNS_PER_MORNING, type DayPlanBook } from '../src/channels/day-cards';
import { dayPlanInput, DAY_CARDS } from '../src/prompt/day-cards';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

// The wake turn: the owner's night is in, and a Brief still to come may go now, at an earlier time, or at its "latest by". It
// never goes later, never comes back once sent, and is never woken past local midday. Owner-local times throughout.
let seq = 0;
const withPlan = (timezone: string, now: number, work: (h: Readonly<{ book: DayPlanBook; scheduler: Scheduler; kv: DurableObjectStorage['kv']; plan(card: string, time: string | null, reason?: string): Promise<void> }>) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`day-wake-${seq += 1}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => now });
    const book = dayPlanBook(state.storage.sql);
    const plan = async (card: string, time: string | null, reason = 'model plan') => {
      await applyDayPlan(scheduler, book, timezone, now, [{ card: card as never, time, reason }], false);
    };
    await work({ book, scheduler, kv: state.storage.kv, plan });
    for (const card of DAY_CARDS) await scheduler.cancel(card.id);
  });
const reply = (time: string, reason = 'up for the day') => JSON.stringify({ cards: [{ id: 'card:brief', time, reason }] });

describe('reading the wake turn\'s reply', () => {
  it('now, or a time still to come before the latest-by; anything else keeps the Brief where it is', () => {
    expect(parseWakeReply(reply('now'), '08:00', '07:05')).toEqual({ time: 'now', reason: 'up for the day' });
    expect(parseWakeReply(reply('07:30'), '08:00', '07:05')).toEqual({ time: '07:30', reason: 'up for the day' });
    for (const keep of ['08:00', '08:30', '07:05', '06:00', 'skip', 'soon']) expect(parseWakeReply(reply(keep), '08:00', '07:05')).toBeNull();
    expect(parseWakeReply('not json', '08:00', '07:05')).toBeNull();
    expect(parseWakeReply(JSON.stringify({ cards: [{ id: 'card:close', time: 'now', reason: 'x' }] }), '08:00', '07:05')).toBeNull();
  });
});

describe('what a wake may move', () => {
  const now = Date.parse('2026-10-20T07:05:00Z');

  it('golden: send now puts the Brief on the schedule at this moment, and the book at this minute', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '08:00');
      expect(wakeTarget(book, 'UTC', now)).toEqual(expect.objectContaining({ card: expect.objectContaining({ id: 'card:brief' }), time: '08:00' }));
      expect(await applyWake(scheduler, book, 'UTC', now, { time: 'now', reason: 'up for the day' })).toEqual([{ card: 'card:brief', time: '07:05', reason: 'up for the day' }]);
      expect(scheduler.read('card:brief')?.due_at).toBe(now);
      expect(book.read('2026-10-20')[0]).toMatchObject({ time: '07:05', reason: 'up for the day', state: 'pending' });
      // Sent now, it is no longer the wake's to move: a second wake finds nothing.
      expect(wakeTarget(book, 'UTC', now + 60_000)).toBe('nothing_to_move');
    });
  });

  it('an earlier time still to come moves the Brief there', async () => {
    await withPlan('UTC', now, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '08:00');
      await applyWake(scheduler, book, 'UTC', now, { time: '07:30', reason: 'after the school run' });
      expect(scheduler.read('card:brief')?.due_at).toBe(Date.parse('2026-10-20T07:30:00Z'));
    });
  });

  it('keeps the owner\'s own times, a skipped, held, waiting or sent Brief, and wakes none past local midday', async () => {
    for (const setup of [
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { await h.plan('card:brief', '09:15', SET_FOR_TODAY); },
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { h.book.pin('card:brief', '09:00'); await h.plan('card:brief', '09:00'); },
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { await h.plan('card:brief', null); },
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { await h.plan('card:brief', '08:00'); h.book.held('2026-10-20', 'card:brief'); },
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { await h.plan('card:brief', '08:00'); h.book.waitingOnModel('2026-10-20', 'card:brief'); },
      async (h: Parameters<Parameters<typeof withPlan>[2]>[0]) => { h.book.sent('2026-10-20', 'card:brief'); },
    ]) {
      await withPlan('UTC', now, async h => {
        await setup(h);
        expect(wakeTarget(h.book, 'UTC', now)).toBe('nothing_to_move');
        expect(await applyWake(h.scheduler, h.book, 'UTC', now, { time: 'now', reason: 'x' })).toEqual([]);
      });
    }
    const afternoon = Date.parse('2026-10-20T12:00:00Z');
    await withPlan('UTC', afternoon, async ({ book, plan }) => {
      await plan('card:brief', '12:30');
      expect(wakeTarget(book, 'UTC', afternoon)).toBe('past_fresh');
    });
  });

  it('reads today, now and midday on the owner\'s clock, across a DST end and a zone change', async () => {
    // London leaves summer time at 01:00 UTC on 25 October 2026: 07:05 UTC is 07:05 there that morning.
    const sunday = Date.parse('2026-10-25T07:05:00Z');
    await withPlan('Europe/London', sunday, async ({ book, scheduler, plan }) => {
      await plan('card:brief', '08:00');
      await applyWake(scheduler, book, 'Europe/London', sunday, { time: 'now', reason: 'x' });
      expect(book.read('2026-10-25')[0]).toMatchObject({ time: '07:05' });
    });
    // 06:35 UTC is 12:05 in Kolkata: past that owner's midday, though morning in UTC.
    const morning = Date.parse('2026-10-20T06:35:00Z');
    await withPlan('Asia/Kolkata', morning, async ({ book, plan }) => {
      await plan('card:brief', '12:30');
      expect(wakeTarget(book, 'Asia/Kolkata', morning)).toBe('past_fresh');
      expect(wakeTarget(book, 'UTC', morning)).toEqual(expect.objectContaining({ time: '12:30' }));
    });
  });

  it('three wake turns a morning at most, counted per local day', async () => {
    await withPlan('UTC', now, async ({ kv }) => {
      const taken = Array.from({ length: WAKE_TURNS_PER_MORNING + 2 }, () => takeWakeTurn(kv, '2026-10-20'));
      expect(taken).toEqual([true, true, true, false, false]);
      expect(takeWakeTurn(kv, '2026-10-21')).toBe(true);
    });
  });
});

describe('the wake prompts', () => {
  const brief = DAY_CARDS.slice(0, 1);
  it('the wake turn says the night is in, names the latest-by and the weekday, and asks for now, earlier or keep', () => {
    const text = dayPlanInput({ localNow: '2026-10-24T10:30', calendar: '', cards: brief, proactivity: 'Proactivity: volume normal; quiet hours 22:00-07:00',
      wake: { latestBy: '11:00', weekday: 'Saturday' } });
    expect(text).toContain('Saturday');
    expect(text).toContain('wearable shows their night is in');
    expect(text).toContain('quiet hours 22:00-07:00');
    expect(text).toContain('- card:brief (The Brief), default 08:00, latest 11:00');
    expect(text).toContain('"now"');
    expect(text).toContain('Never later');
  });

  it('in wake mode the nightly plan times the Brief as the latest it should go; otherwise it reads as before', () => {
    const wake = dayPlanInput({ localNow: '2026-10-20T03:00', calendar: '', cards: brief, proactivity: 'Proactivity: normal', wakeMode: true });
    expect(wake).toContain('the latest it should go');
    const plain = dayPlanInput({ localNow: '2026-10-20T03:00', calendar: '', cards: brief, proactivity: 'Proactivity: normal' });
    expect(plain).toContain('Plan these cards for today:\n\n- card:brief (The Brief), default 08:00\n\n<calendar>');
    expect(plain).not.toMatch(/latest|night is in/);
  });
});
