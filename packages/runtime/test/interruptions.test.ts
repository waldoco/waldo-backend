import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setProactivityArgsSchema } from '@waldo/contracts';
import { drawingOn, interruptBook, interruptHold, interruptLimits, spendOf, type HoldInput, type InterruptLimits } from '../src/channels/interruptions';
import { loopBook } from '../src/channels/loops';

// The owner's limits on unasked messages. Code holds consent, quiet hours, one question waiting, the day's budget and the gap;
// the model's urgent goes past the budget and the gap from a small allowance, and never past the rest.
const LIMITS: InterruptLimits = { perDay: 2, urgentPerDay: 1, gapMs: 60 * 60_000 };
const NOW = Date.parse('2026-11-05T10:00:00Z');
const base: HoldInput = { consent: true, quiet: false, asks: false, urgent: false, open: null, spent: { day: '2026-11-05', count: 0, urgent: 0, last: null }, limits: LIMITS, now: NOW };
let seq = 0;
const withKv = <T,>(work: (state: DurableObjectState) => T | Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`interruptions-${seq += 1}`)), async (_instance, state) => work(state));

describe('interruptHold', () => {
  it('golden: an unasked message goes when nothing holds it', () => {
    expect(interruptHold(base)).toBeNull();
  });

  it('holds in order: consent, quiet hours, a waiting question, the budget, the gap', () => {
    const open = { ref: 'update:1', at: NOW - 1, day: '2026-11-05' };
    const spent = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    expect(interruptHold({ ...base, consent: false, quiet: true })).toBe('consent');
    expect(interruptHold({ ...base, quiet: true, asks: true, open })).toBe('quiet');
    expect(interruptHold({ ...base, asks: true, open, spent })).toBe('question');
    expect(interruptHold({ ...base, open, spent })).toBe('budget');
    expect(interruptHold({ ...base, spent: { ...spent, count: 1 } })).toBe('cooldown');
  });

  it('urgent goes past the budget and the gap while the allowance lasts, never past consent, quiet hours or a waiting question', () => {
    const spent = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    const open = { ref: 'update:1', at: NOW - 1, day: '2026-11-05' };
    expect(interruptHold({ ...base, urgent: true, spent })).toBeNull();
    expect(interruptHold({ ...base, urgent: true, spent: { ...spent, urgent: 1 } })).toBe('budget');
    expect(interruptHold({ ...base, urgent: true, quiet: true, spent })).toBe('quiet');
    expect(interruptHold({ ...base, urgent: true, consent: false })).toBe('consent');
    expect(interruptHold({ ...base, urgent: true, asks: true, open })).toBe('question');
  });

  it('an owner budget of zero holds everything that is not urgent', () => {
    expect(interruptHold({ ...base, limits: { ...LIMITS, perDay: 0 } })).toBe('budget');
    expect(spendOf(base.spent, { ...LIMITS, perDay: 0 }, NOW)).toBe('urgent');
  });
});

describe('interruptLimits', () => {
  it('reads the deployment defaults, and the owner\'s own number wins', () => {
    const proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' as const };
    expect(interruptLimits({ PROACTIVE_INTERRUPTS_PER_DAY: '3', PROACTIVE_URGENT_PER_DAY: '0', PROACTIVE_GAP_MIN: '30' }, proactivity)).toEqual({ perDay: 3, urgentPerDay: 0, gapMs: 30 * 60_000 });
    expect(interruptLimits({ PROACTIVE_INTERRUPTS_PER_DAY: '3' }, { ...proactivity, interruptions_per_day: 0 }).perDay).toBe(0);
  });

  it('an unset or unreadable default falls back rather than opening the gate', () => {
    const proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' as const };
    expect(interruptLimits({}, proactivity)).toEqual({ perDay: 2, urgentPerDay: 1, gapMs: 60 * 60_000 });
    expect(interruptLimits({ PROACTIVE_INTERRUPTS_PER_DAY: '-1', PROACTIVE_URGENT_PER_DAY: 'lots', PROACTIVE_GAP_MIN: '1.5' }, proactivity)).toEqual({ perDay: 2, urgentPerDay: 1, gapMs: 60 * 60_000 });
  });
});

describe('set_proactivity: interruptions_per_day', () => {
  it('valid: a whole number in range, or left out', () => {
    expect(setProactivityArgsSchema.safeParse({ quiet_start: null, quiet_end: null, volume: 'normal', interruptions_per_day: 0 }).success).toBe(true);
    expect(setProactivityArgsSchema.safeParse({ quiet_start: null, quiet_end: null, volume: 'normal' }).success).toBe(true);
  });

  it('invalid: negative, fractional or past the cap', () => {
    for (const value of [-1, 1.5, 13, '2']) expect(setProactivityArgsSchema.safeParse({ quiet_start: null, quiet_end: null, volume: 'normal', interruptions_per_day: value }).success).toBe(false);
  });

  it('a later change that leaves it out keeps the owner\'s number', async () => {
    await withKv((state) => {
      const loops = loopBook(state.storage.sql, { newId: () => 'l', now: () => NOW });
      loops.setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal', interruptions_per_day: 4 });
      loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'high' });
      expect(loops.proactivity()).toMatchObject({ volume: 'high', interruptions_per_day: 4 });
    });
  });
});

describe('interruptBook', () => {
  it('golden: spends the budget, then the urgent allowance, and starts again on the owner\'s next day', async () => {
    await withKv((state) => {
      const clock = { at: NOW };
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'UTC', ownerSpokeSince: () => false });
      expect(book.spend(LIMITS, false, 'a')).toBe('counted');
      clock.at += LIMITS.gapMs;
      expect(book.spend(LIMITS, false, 'b')).toBe('counted');
      clock.at += 1;
      expect(book.spend(LIMITS, false, 'c')).toBe('urgent');
      expect(book.spent()).toMatchObject({ count: 2, urgent: 1 });
      clock.at = Date.parse('2026-11-06T00:00:01Z');
      expect(book.spent()).toMatchObject({ day: '2026-11-06', count: 0, urgent: 0 });
    });
  });

  it('the owner\'s day follows their clock across the end of daylight saving', async () => {
    await withKv((state) => {
      // New York leaves daylight saving at 06:00Z on 1 Nov 2026: 03:30Z is still 31 Oct there, 05:30Z on 2 Nov is 1 Nov.
      const clock = { at: Date.parse('2026-11-01T03:30:00Z') };
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'America/New_York', ownerSpokeSince: () => false });
      book.spend(LIMITS, true, 'q');
      expect(book.spent().day).toBe('2026-10-31');
      expect(book.question()).not.toBeNull();
      clock.at = Date.parse('2026-11-01T04:30:00Z');
      expect([book.spent().day, book.spent().count, book.question()]).toEqual(['2026-11-01', 0, null]);
      clock.at = Date.parse('2026-11-02T04:30:00Z');
      expect(book.spent().day).toBe('2026-11-01');
      clock.at = Date.parse('2026-11-02T05:30:00Z');
      expect(book.spent().day).toBe('2026-11-02');
    });
  });

  it('a waiting question ends when the owner speaks, and a message that asks nothing leaves it open', async () => {
    await withKv((state) => {
      const spoke = { at: null as number | null };
      const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: at => spoke.at !== null && spoke.at > at });
      book.spend(LIMITS, true, 'q');
      book.spend({ ...LIMITS, gapMs: 0 }, false, 'note');
      expect(book.question()).toMatchObject({ ref: 'q' });
      expect(book.hold({ consent: true, quiet: false, asks: true, urgent: true, limits: LIMITS })).toBe('question');
      spoke.at = NOW + 1;
      expect(book.question()).toBeNull();
    });
  });
});

describe('drawingOn: a health card under the owner\'s limits', () => {
  it('stops at the day\'s budget, waits out the gap, and charges both budgets once it goes', async () => {
    await withKv((state) => {
      const clock = { at: NOW }, charged: string[] = [];
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'UTC', ownerSpokeSince: () => false });
      const budget = drawingOn({ admit: () => ({ verdict: 'send' }), charge: id => { charged.push(id); } }, book, () => LIMITS);
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'send' });
      budget.charge('health:2026-11-05');
      expect([charged, book.spent().count]).toEqual([['health:2026-11-05'], 1]);
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'wait', until: NOW + LIMITS.gapMs });
      clock.at += LIMITS.gapMs;
      budget.charge('health:2026-11-05');
      clock.at += LIMITS.gapMs;
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'spent' });
    });
  });

  it('the delivery gate\'s own answer still holds when the owner has budget left', async () => {
    await withKv((state) => {
      const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
      expect(drawingOn({ admit: () => ({ verdict: 'spent' }), charge: () => undefined }, book, () => LIMITS).admit('x')).toEqual({ verdict: 'spent' });
    });
  });
});
