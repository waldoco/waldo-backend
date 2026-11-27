import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setProactivityArgsSchema } from '@waldo/contracts';
import { drawingOn, interruptBook, interruptHold, interruptLimits, reopensAt, spendOf, withinBudget, type HoldInput, type InterruptLimits } from '../src/channels/interruptions';
import { isQuiet, loopBook, loopHandlers, proactivityLine } from '../src/channels/loops';
import { dayPlanBook } from '../src/channels/day-cards';
import { episodeIndex, ownerSpokeSince, OWNER_SAID } from '../src/channels/episodes';

// The owner's limits on unasked messages (ruling of 27 Nov: no notification cap; the model judges). Code holds consent, quiet
// hours, the owner's day and one question waiting, and a daily number only when the owner set one for themselves; there is no
// gap between two messages. Past the owner's own number the model's urgent goes from a small allowance, never past the rest.
const LIMITS: InterruptLimits = { perDay: 2, urgentPerDay: 1 };
const NOW = Date.parse('2026-11-05T10:00:00Z');
const base: HoldInput = { consent: true, quiet: false, asks: false, urgent: false, open: null, spent: { day: '2026-11-05', count: 0, urgent: 0, last: null }, limits: LIMITS, now: NOW };
let seq = 0;
const withKv = <T,>(work: (state: DurableObjectState) => T | Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`interruptions-${seq += 1}`)), async (_instance, state) => work(state));

describe('interruptHold', () => {
  it('golden: an unasked message goes when nothing holds it', () => {
    expect(interruptHold(base)).toBeNull();
  });

  it('holds in order: consent, quiet hours, the end of the owner\'s day, a waiting question, the owner\'s own number', () => {
    const open = { ref: 'update:1', at: NOW - 1, day: '2026-11-05' };
    const spent = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    expect(interruptHold({ ...base, consent: false, quiet: true })).toBe('consent');
    expect(interruptHold({ ...base, quiet: true, asks: true, open })).toBe('quiet');
    expect(interruptHold({ ...base, closed: true, asks: true, open, spent })).toBe('closed');
    expect(interruptHold({ ...base, asks: true, open, spent })).toBe('question');
    expect(interruptHold({ ...base, open, spent })).toBe('budget');
  });

  it('no gap: a message a minute after the last one goes', () => {
    expect(interruptHold({ ...base, spent: { day: '2026-11-05', count: 1, urgent: 0, last: NOW - 60_000 } })).toBeNull();
  });

  it('urgent goes past the owner\'s number while the allowance lasts, never past consent, quiet hours or a waiting question', () => {
    const spent = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    const open = { ref: 'update:1', at: NOW - 1, day: '2026-11-05' };
    expect(interruptHold({ ...base, urgent: true, spent })).toBeNull();
    expect(interruptHold({ ...base, urgent: true, spent: { ...spent, urgent: 1 } })).toBe('budget');
    expect(interruptHold({ ...base, urgent: true, quiet: true, spent })).toBe('quiet');
    expect(interruptHold({ ...base, urgent: true, closed: true })).toBe('closed');
    expect(interruptHold({ ...base, urgent: true, consent: false })).toBe('consent');
    expect(interruptHold({ ...base, urgent: true, asks: true, open })).toBe('question');
  });

  it('past the owner\'s number a charge draws on the urgent allowance while it lasts, then is counted over it', () => {
    const over = { day: '2026-11-05', count: 2, urgent: 0, last: NOW - 1 };
    expect(spendOf(base.spent, LIMITS)).toBe('counted');
    expect(spendOf({ ...over, count: 1 }, LIMITS)).toBe('counted');
    expect(spendOf(over, LIMITS)).toBe('urgent');
    expect(spendOf({ ...over, urgent: 1 }, LIMITS)).toBe('counted');
  });
});

describe('interruptLimits: no count of Waldo\'s own; the owner\'s own number holds', () => {
  const at = (volume: 'low' | 'normal' | 'high', interruptions_per_day?: number) => ({ quiet_start: null, quiet_end: null, volume, ...(interruptions_per_day === undefined ? {} : { interruptions_per_day }) });
  // What staging still sets; none of it is a count Waldo holds any more.
  const deployed = { PROACTIVE_INTERRUPTS_PER_DAY: '2', PROACTIVE_URGENT_PER_DAY: '1', PROACTIVE_GAP_MIN: '60' };

  it('at every volume, without a number of the owner\'s, there is no daily count and no gap', () => {
    for (const volume of ['low', 'normal', 'high'] as const) {
      const limits = interruptLimits(deployed, at(volume));
      expect(limits).toEqual({ perDay: Number.POSITIVE_INFINITY, urgentPerDay: 0 });
      const spent = { day: '2026-11-05', count: 40, urgent: 0, last: NOW - 60_000 };
      expect(interruptHold({ ...base, spent, limits })).toBeNull();
      expect(withinBudget(spent, limits)).toBe(true);
      expect(interruptHold({ ...base, quiet: true, spent, limits })).toBe('quiet');
    }
  });

  it('the owner\'s own number holds at every volume, with the deployment\'s urgent allowance past it', () => {
    for (const volume of ['low', 'normal', 'high'] as const) expect(interruptLimits(deployed, at(volume, 3))).toEqual({ perDay: 3, urgentPerDay: 1 });
  });

  it('the owner\'s zero means none at all: no urgent allowance either', () => {
    const none = interruptLimits({ PROACTIVE_URGENT_PER_DAY: '3' }, at('high', 0));
    expect(none).toEqual({ perDay: 0, urgentPerDay: 0 });
    expect(interruptHold({ ...base, urgent: true, limits: none })).toBe('budget');
  });

  it('an unreadable urgent allowance falls back rather than opening the gate', () => {
    expect(interruptLimits({ PROACTIVE_URGENT_PER_DAY: 'lots' }, at('normal', 4))).toEqual({ perDay: 4, urgentPerDay: 1 });
  });

  it('the turn is told there is no count to spend, and to judge from what already went today; the owner\'s own number is read back', () => {
    const kv = new Map<string, unknown>();
    const book = interruptBook({ get: <T,>(key: string) => kv.get(key) as T | undefined, put: (key, value) => { kv.set(key, value); }, delete: key => kv.delete(key) },
      { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
    const free = book.line(interruptLimits(deployed, at('normal')));
    expect(free).toContain('There is no daily count of unasked messages and no gap between them');
    expect(free).toContain('what Waldo already sent today and what became of each');
    expect(free).not.toMatch(/Infinity|urgent|budget|more times/);
    expect(book.line(interruptLimits(deployed, at('normal', 3)))).toContain('The owner set 3 unasked messages a day for themselves: 3 more today.');
  });
});

// The sleep window and the owner's day change on a mocked clock, in Kolkata (UTC+05:30), with quiet hours 22:00-07:00.
describe('with no count, the sleep window and the owner\'s own number still hold across the night and the day change', () => {
  const settings = (interruptions_per_day?: number) => ({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' as const, ...(interruptions_per_day === undefined ? {} : { interruptions_per_day }) });
  const ZONE = 'Asia/Kolkata';
  it('a message at 22:15 waits for the morning, urgent or not; at 07:01 it goes, however many went the day before', async () => {
    await withKv((state) => {
      const clock = { at: Date.parse('2026-11-05T16:30:00Z') }; // 22:00 IST
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => ZONE, ownerSpokeSince: () => false });
      const limits = interruptLimits({ PROACTIVE_URGENT_PER_DAY: '1' }, settings());
      clock.at = Date.parse('2026-11-05T16:00:00Z'); // 21:30 IST
      for (let n = 0; n < 12; n += 1) { expect(book.hold({ consent: true, quiet: isQuiet(settings(), clock.at, ZONE), asks: false, urgent: false, limits })).toBeNull(); book.spend(limits, false, `m${n}`); clock.at += 60_000; }
      clock.at = Date.parse('2026-11-05T16:45:00Z'); // 22:15 IST
      for (const urgent of [false, true]) expect(book.hold({ consent: true, quiet: isQuiet(settings(), clock.at, ZONE), asks: false, urgent, limits })).toBe('quiet');
      clock.at = Date.parse('2026-11-06T01:31:00Z'); // 07:01 IST on the 6th
      expect(book.spent()).toMatchObject({ day: '2026-11-06', count: 0 });
      expect(book.hold({ consent: true, quiet: isQuiet(settings(), clock.at, ZONE), asks: false, urgent: false, limits })).toBeNull();
    });
  });

  it('the owner\'s own number is spent by their midnight, not UTC\'s, and starts again after it', async () => {
    await withKv((state) => {
      const clock = { at: Date.parse('2026-11-05T12:00:00Z') }; // 17:30 IST
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => ZONE, ownerSpokeSince: () => false });
      const limits = interruptLimits({ PROACTIVE_URGENT_PER_DAY: '1' }, { ...settings(3), quiet_start: null, quiet_end: null });
      for (const ref of ['a', 'b', 'c']) book.spend(limits, false, ref);
      clock.at = Date.parse('2026-11-05T18:29:00Z'); // 23:59 IST
      expect(book.hold({ consent: true, quiet: false, asks: false, urgent: false, limits })).toBe('budget');
      clock.at = Date.parse('2026-11-05T18:31:00Z'); // 00:01 IST on the 6th, still the 5th in UTC
      expect(book.hold({ consent: true, quiet: false, asks: false, urgent: false, limits })).toBeNull();
    });
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
      expect(book.spend(LIMITS, false, 'a')).toBe('counted');
      clock.at += 60_000;
      expect(book.spend(LIMITS, false, 'b')).toBe('counted');
      clock.at += 1;
      expect(book.spend(LIMITS, false, 'c')).toBe('urgent');
      expect(book.spend(LIMITS, false, 'd')).toBe('counted');
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
      book.spend(LIMITS, false, 'note');
      expect(book.question()).toMatchObject({ ref: 'q' });
      expect(book.hold({ consent: true, quiet: false, asks: true, urgent: true, limits: LIMITS })).toBe('question');
      spoke.at = NOW + 1;
      expect(book.question()).toBeNull();
    });
  });
});

describe('drawingOn: a health card under the owner\'s limits', () => {
  it('stops at the owner\'s own number with no gap before it, and charges both budgets once it goes', async () => {
    await withKv((state) => {
      const clock = { at: NOW }, charged: string[] = [];
      const book = interruptBook(state.storage.kv, { now: () => clock.at, timezone: () => 'UTC', ownerSpokeSince: () => false });
      const budget = drawingOn({ admit: () => ({ verdict: 'send' }), charge: id => { charged.push(id); } }, book, () => LIMITS, () => null);
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'send' });
      budget.charge('health:2026-11-05');
      expect([charged, book.spent().count]).toEqual([['health:2026-11-05'], 1]);
      clock.at += 60_000;
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'send' });
      budget.charge('health:2026-11-05');
      expect(budget.admit('health:2026-11-05')).toEqual({ verdict: 'spent' });
    });
  });

  it('the delivery gate\'s own answer still holds when the owner has budget left', async () => {
    await withKv((state) => {
      const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
      expect(drawingOn({ admit: () => ({ verdict: 'spent' }), charge: () => undefined }, book, () => LIMITS, () => null).admit('x')).toEqual({ verdict: 'spent' });
    });
  });

  it('outside the owner\'s day a health card waits for their next Brief, before either budget is asked', async () => {
    await withKv((state) => {
      const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
      let asked = 0;
      const budget = drawingOn({ admit: () => { asked += 1; return { verdict: 'send' }; }, charge: () => undefined }, book, () => LIMITS, () => NOW + 3_600_000);
      expect([budget.admit('health:2026-11-05'), asked]).toEqual([{ verdict: 'wait', until: NOW + 3_600_000 }, 0]);
    });
  });
});

// The owner's day is two-sided: nothing unasked before their Brief or from their Close on, on their own calendar day.
describe('reopensAt: the owner\'s day, from the Brief to the Close', () => {
  const open = (now: string, zone: string) => withKv((state) => {
    const plans = dayPlanBook(state.storage.sql);
    const at = reopensAt(Date.parse(now), zone, day => plans.window(day, zone));
    return at === null ? null : new Date(at).toISOString();
  });
  it('inside the day it is open; before the Brief it opens at the Brief; from the Close it opens at the next Brief', async () => {
    expect(await open('2026-11-05T12:00:00Z', 'UTC')).toBeNull();
    expect(await open('2026-11-05T02:00:00Z', 'UTC')).toBe('2026-11-05T08:00:00.000Z');
    expect(await open('2026-11-05T21:30:00Z', 'UTC')).toBe('2026-11-06T08:00:00.000Z');
  });

  it('follows the owner\'s own calendar day: 02:00 in Kolkata is before that day\'s Brief, not after the evening\'s Close', async () => {
    // 20:30Z on 5 Nov is 02:00 on 6 Nov in Kolkata; that day's Brief is 08:00 IST, 02:30Z.
    expect(await open('2026-11-05T20:30:00Z', 'Asia/Kolkata')).toBe('2026-11-06T02:30:00.000Z');
    expect(await open('2026-11-05T10:00:00Z', 'Asia/Kolkata')).toBeNull();
  });

  it('across the end of daylight saving in New York the next Brief keeps its local time', async () => {
    // 22:00 EDT on 31 Oct (02:00Z on 1 Nov) is after the Close; the next Brief is 08:00 EST on 1 Nov, 13:00Z.
    expect(await open('2026-11-01T02:00:00Z', 'America/New_York')).toBe('2026-11-01T13:00:00.000Z');
    // 07:30 EST on 1 Nov (12:30Z) is still before it; 21:00 EST (02:00Z on 2 Nov) is inside the day.
    expect(await open('2026-11-01T12:30:00Z', 'America/New_York')).toBe('2026-11-01T13:00:00.000Z');
    expect(await open('2026-11-02T02:00:00Z', 'America/New_York')).toBeNull();
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
