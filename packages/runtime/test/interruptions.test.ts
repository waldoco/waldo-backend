import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setProactivityArgsSchema } from '@waldo/contracts';
import { drawingOn, interruptBook, interruptHold, interruptLimits, spendOf, type HoldInput, type InterruptLimits } from '../src/channels/interruptions';
import { loopBook, loopHandlers, proactivityLine } from '../src/channels/loops';
import { dayPlanBook } from '../src/channels/day-cards';
import { episodeIndex, ownerSpokeSince, OWNER_SAID } from '../src/channels/episodes';

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

  it('holds in order: consent, quiet hours, the end of the owner\'s day, a waiting question, the budget, the gap', () => {
    const open = { ref: 'update:1', at: NOW - 1, day: '2026-11-05' };
    const spent = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    expect(interruptHold({ ...base, consent: false, quiet: true })).toBe('consent');
    expect(interruptHold({ ...base, quiet: true, asks: true, open })).toBe('quiet');
    expect(interruptHold({ ...base, closed: true, asks: true, open, spent })).toBe('closed');
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
    expect(interruptHold({ ...base, urgent: true, closed: true })).toBe('closed');
    expect(interruptHold({ ...base, urgent: true, consent: false })).toBe('consent');
    expect(interruptHold({ ...base, urgent: true, asks: true, open })).toBe('question');
  });

  it('past the budget a charge is urgent only when the model said so and the allowance lasts; otherwise it is counted', () => {
    const over = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    expect(spendOf(base.spent, LIMITS, NOW, true)).toBe('counted');
    expect(spendOf(over, LIMITS, NOW, true)).toBe('urgent');
    expect(spendOf(over, LIMITS, NOW, false)).toBe('counted');
    expect(spendOf({ ...over, urgent: 1 }, LIMITS, NOW, true)).toBe('counted');
  });
});

describe('interruptLimits', () => {
  it('reads the deployment defaults, and the owner\'s own number wins', () => {
    const proactivity = { quiet_start: null, quiet_end: null, volume: 'normal' as const };
    expect(interruptLimits({ PROACTIVE_INTERRUPTS_PER_DAY: '3', PROACTIVE_URGENT_PER_DAY: '0', PROACTIVE_GAP_MIN: '30' }, proactivity)).toEqual({ perDay: 3, urgentPerDay: 0, gapMs: 30 * 60_000 });
    expect(interruptLimits({ PROACTIVE_INTERRUPTS_PER_DAY: '3' }, { ...proactivity, interruptions_per_day: 1 })).toEqual({ perDay: 1, urgentPerDay: 1, gapMs: 60 * 60_000 });
  });

  it('the owner\'s zero means none at all: no budget and no urgent allowance, whatever the deployment allows', () => {
    const none = interruptLimits({ PROACTIVE_URGENT_PER_DAY: '3' }, { quiet_start: null, quiet_end: null, volume: 'normal', interruptions_per_day: 0 });
    expect(none).toMatchObject({ perDay: 0, urgentPerDay: 0 });
    expect(interruptHold({ ...base, urgent: true, limits: none })).toBe('budget');
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

// With PROACTIVE_GATE off (production) nothing holds the owner's number, so set_proactivity neither offers nor takes it and
// the ledger line never shows one: the tool and the line are what they were before the gate.
describe('set_proactivity with the gate off', () => {
  const SETTINGS = { quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' as const };
  it('offers and takes no daily number, and a stored one is neither shown nor returned', async () => {
    await withKv(async (state) => {
      const loops = loopBook(state.storage.sql, { newId: () => 'l', now: () => NOW });
      const tool = (limits: boolean) => loopHandlers(loops, undefined, limits).find(handler => handler.name === 'set_proactivity')!;
      expect(tool(false).schema.safeParse({ ...SETTINGS, interruptions_per_day: 1 }).success).toBe(false);
      expect(tool(true).schema.safeParse({ ...SETTINGS, interruptions_per_day: 1 }).success).toBe(true);
      loops.setProactivity({ ...SETTINGS, interruptions_per_day: 1 });
      const off = await tool(false).handle(tool(false).schema.parse(SETTINGS) as never);
      expect(off.ok && 'interruptions_per_day' in (off.data as object)).toBe(false);
      expect(proactivityLine(loops.proactivity())).toBe('Proactivity: volume normal; quiet hours 22:00-07:00');
      expect(proactivityLine(loops.proactivity(), true)).toBe('Proactivity: volume normal; quiet hours 22:00-07:00; 1 unasked messages a day');
    });
  });
});

// The owner's day for unasked messages: from the Brief to the Close, as they went, else as planned or pinned, else by default.
describe('the day window', () => {
  it('reads the defaults, a pinned Close, and the time the Close actually went', async () => {
    await withKv((state) => {
      const plans = dayPlanBook(state.storage.sql);
      expect(plans.window('2026-11-05', 'UTC')).toEqual({ opens: Date.parse('2026-11-05T08:00:00Z'), closes: Date.parse('2026-11-05T21:30:00Z') });
      plans.pin('card:close', '20:00');
      expect(plans.window('2026-11-05', 'UTC').closes).toBe(Date.parse('2026-11-05T20:00:00Z'));
      plans.delivered('2026-11-05', 'card:close', 'm-1', Date.parse('2026-11-05T19:45:00Z'));
      expect(plans.window('2026-11-05', 'UTC').closes).toBe(Date.parse('2026-11-05T19:45:00Z'));
      expect(plans.window('2026-11-05', 'Asia/Kolkata').opens).toBe(Date.parse('2026-11-05T02:30:00Z'));
    });
  });
});

describe('interruptBook', () => {
  it('golden: spends the budget, then the urgent allowance, and starts again on the owner\'s next day', async () => {
    await withKv((state) => {
      const clock = { at: NOW };
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'UTC', ownerSpokeSince: () => false });
      expect(book.spend(LIMITS, false, 'a', false)).toBe('counted');
      clock.at += LIMITS.gapMs;
      expect(book.spend(LIMITS, false, 'b', false)).toBe('counted');
      clock.at += 1;
      expect(book.spend(LIMITS, false, 'c', true)).toBe('urgent');
      expect(book.spend(LIMITS, false, 'd', false)).toBe('counted');
      expect(book.spent()).toMatchObject({ count: 3, urgent: 1 });
      clock.at = Date.parse('2026-11-06T00:00:01Z');
      expect(book.spent()).toMatchObject({ day: '2026-11-06', count: 0, urgent: 0 });
    });
  });

  it('the owner\'s day follows their clock across the end of daylight saving', async () => {
    await withKv((state) => {
      // New York leaves daylight saving at 06:00Z on 1 Nov 2026: 03:30Z is still 31 Oct there, 05:30Z on 2 Nov is 1 Nov.
      const clock = { at: Date.parse('2026-11-01T03:30:00Z') };
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'America/New_York', ownerSpokeSince: () => false });
      book.spend(LIMITS, true, 'q', false);
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
      book.spend(LIMITS, true, 'q', false);
      book.spend({ ...LIMITS, gapMs: 0 }, false, 'note', false);
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

describe('ownerSpokeSince, on the real episode index', () => {
  it('golden: an owner row after the question counts; Waldo\'s and the system\'s rows, and earlier owner rows, do not', async () => {
    await withKv((state) => {
      const index = episodeIndex(state.storage.sql);
      index.add('tg-1', 'owner', 'earlier words', NOW - 10);
      index.add('r-1-reply', 'waldo', 'Waldo asks something', NOW);
      index.add('sys-1', 'system', 'a job ran', NOW + 5);
      expect(ownerSpokeSince(state.storage.sql, NOW)).toBe(false);
      index.add('tg-2', OWNER_SAID as never, 'yes, do it', NOW + 10);
      expect(ownerSpokeSince(state.storage.sql, NOW)).toBe(true);
      expect(ownerSpokeSince(state.storage.sql, NOW + 10)).toBe(false);
    });
  });

  it('a message that is only a quote the owner pasted still counts as them speaking', async () => {
    await withKv((state) => {
      episodeIndex(state.storage.sql).add('tg-3', 'quoted', '> the line they pasted', NOW + 1);
      expect(ownerSpokeSince(state.storage.sql, NOW)).toBe(true);
    });
  });
});
