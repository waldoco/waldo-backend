// The owner's time for the Brief or the Close, through the real scheduler and day plan: the time every day's plan keeps,
// today's card moved to it at once, never sent twice and never dropped. Times are mocked per case: DST, a zone change,
// quiet hours and a time set just past now.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyWake, armDayCards, dayPlanBook, setCardTime, wakeTarget, MOVED_EARLIER, SET_FOR_TODAY, type DayPlanBook } from '../src/channels/day-cards';
import { localIso, localToEpoch } from '../src/channels/reminders';
import { replanDayCards } from '../src/channels/schedule-preferences';
import type { CardId } from '../src/prompt/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

type World = Readonly<{ scheduler: Scheduler; book: DayPlanBook; kv: DurableObjectStorage['kv'] }>;
let sequence = 0;
const owner = (tz: string, at: number, run: (world: World) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`schedule-card-time-${sequence++}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => at });
    const book = dayPlanBook(state.storage.sql);
    await armDayCards(scheduler, book, tz, at);
    await run({ scheduler, book, kv: state.storage.kv });
  });
const deps = (world: World, tz: string, now: number, extra: Partial<{ enabled: boolean; armable: boolean; quiet: (at: number) => boolean; queued: () => boolean }> = {}) =>
  ({ ...world, timezone: tz, now, enabled: true, quiet: () => false, queued: () => false, ...extra });
const due = (world: World, id: CardId) => { const found = world.scheduler.lookup(id); return found.state === 'entry' ? found.entry.due_at : null; };
const planned = (world: World, day: string, id: CardId) => world.book.read(day).find(row => row.card === id);

describe('a new Brief or Close time', () => {
  const tz = 'Asia/Kolkata', day = '2026-11-06', at = (clock: string) => localToEpoch(`${day}T${clock}`, tz);

  it('moves today\'s card to it at once and keeps it for every day after', async () => {
    await owner(tz, at('06:00'), async world => {
      expect(due(world, 'card:brief')).toBe(at('08:00'));
      expect(await setCardTime(deps(world, tz, at('06:00')), 'card:brief', '07:10', true)).toBe('planned');
      expect([due(world, 'card:brief'), world.book.pins()['card:brief'], planned(world, day, 'card:brief')?.time]).toEqual([at('07:10'), '07:10', '07:10']);
      // The next day's plan keeps it.
      const tomorrow = localToEpoch('2026-11-07T00:05', tz);
      await armDayCards(world.scheduler, world.book, tz, tomorrow);
      expect(due(world, 'card:brief')).toBe(localToEpoch('2026-11-07T07:10', tz));
    });
  });

  it('just past now sends today\'s card now, once, when it was still due later today', async () => {
    await owner(tz, at('07:30'), async world => {
      expect(await setCardTime(deps(world, tz, at('07:30')), 'card:brief', '07:10', true)).toBe('now');
      expect(due(world, 'card:brief')).toBe(at('07:30'));
      expect(world.book.pins()['card:brief']).toBe('07:10');
    });
  });

  it('past a card that is not due again today starts tomorrow and arms nothing today', async () => {
    await owner(tz, at('07:30'), async world => {
      await world.scheduler.cancel('card:brief');
      expect(await setCardTime(deps(world, tz, at('07:30')), 'card:brief', '07:10', true)).toBe('passed');
      expect(due(world, 'card:brief')).toBeNull();
      expect(world.book.pins()['card:brief']).toBe('07:10');
    });
  });

  it('after today\'s card went out, only tomorrow moves: nothing is sent twice', async () => {
    await owner(tz, at('09:00'), async world => {
      world.book.sent(day, 'card:brief');
      await world.scheduler.cancel('card:brief');
      expect(await setCardTime(deps(world, tz, at('09:00')), 'card:brief', '10:00', true)).toBe('sent');
      expect(due(world, 'card:brief')).toBeNull();
    });
  });

  it('leaves a card being made, held or waiting to reach the owner as it is: racing its alarm makes one card', async () => {
    await owner(tz, at('07:59'), async world => {
      world.book.held(day, 'card:close');
      expect(await setCardTime(deps(world, tz, at('07:59')), 'card:close', '22:00', true)).toBe('busy');
      expect(due(world, 'card:close')).toBe(at('21:30'));
      expect(await setCardTime(deps(world, tz, at('07:59'), { queued: () => true }), 'card:brief', '09:00', true)).toBe('busy');
      expect(due(world, 'card:brief')).toBe(at('08:00'));
      expect(world.book.pins()).toEqual({ 'card:close': '22:00', 'card:brief': '09:00' });
    });
  });

  it('with the day cards off, keeps the time and arms nothing', async () => {
    await owner(tz, at('06:00'), async world => {
      await world.scheduler.cancel('card:brief');
      expect(await setCardTime(deps(world, tz, at('06:00'), { enabled: false }), 'card:brief', '07:10', true)).toBe('off');
      expect([due(world, 'card:brief'), world.book.pins()['card:brief']]).toEqual([null, '07:10']);
    });
  });

  it('while the day cards may not be armed yet, keeps the time, arms nothing and says they wait for the zone', async () => {
    await owner(tz, at('06:00'), async world => {
      await world.scheduler.cancel('card:brief');
      expect(await setCardTime(deps(world, tz, at('06:00'), { armable: false }), 'card:brief', '07:10', true)).toBe('zone');
      expect([due(world, 'card:brief'), world.book.pins()['card:brief']]).toEqual([null, '07:10']);
    });
  });

  it('says when the time is already the one kept, and touches nothing', async () => {
    await owner(tz, at('06:00'), async world => {
      world.book.pin('card:close', '21:30');
      expect(await setCardTime(deps(world, tz, at('06:00')), 'card:close', '21:30', true)).toBe('unchanged');
      expect(due(world, 'card:close')).toBe(at('21:30'));
    });
  });

  it('says when the new time falls in quiet hours; the card is still armed, and its send holds until they end', async () => {
    await owner(tz, at('06:00'), async world => {
      const quiet = (instant: number) => localIso(instant, tz).slice(11, 16) >= '22:30';
      expect(await setCardTime(deps(world, tz, at('06:00'), { quiet }), 'card:close', '23:00', true)).toBe('quiet');
      expect(due(world, 'card:close')).toBe(at('23:00'));
    });
  });

  it('set for today only does not pin, and a wake keeps it', async () => {
    await owner(tz, at('06:00'), async world => {
      expect(await setCardTime(deps(world, tz, at('06:00')), 'card:brief', '09:15', false)).toBe('planned');
      expect([world.book.pins()['card:brief'], planned(world, day, 'card:brief')?.reason]).toEqual([undefined, SET_FOR_TODAY]);
      expect(wakeTarget(world.book, tz, at('06:30'))).toBe('nothing_to_move');
    });
  });

  it('refuses a card row this Worker cannot read', async () => {
    await owner(tz, at('06:00'), async world => {
      const before = due(world, 'card:brief');
      world.scheduler.lookup = () => ({ state: 'unreadable' });
      expect(await setCardTime(deps(world, tz, at('06:00')), 'card:brief', '07:10', true)).toBe('unreadable');
      expect(world.book.pins()['card:brief']).toBeUndefined();
      expect(before).toBe(at('08:00'));
    });
  });
});

describe('the Brief time, across clock changes', () => {
  it('on the night clocks go forward, a time in the missing hour fires once, the same morning', async () => {
    const tz = 'America/New_York';
    await owner(tz, Date.parse('2026-03-08T05:00:00Z'), async world => {
      expect(await setCardTime(deps(world, tz, Date.parse('2026-03-08T05:00:00Z')), 'card:brief', '02:30', true)).toBe('planned');
      const at = due(world, 'card:brief')!;
      expect(localIso(at, tz).slice(0, 10)).toBe('2026-03-08');
      expect(at).toBeGreaterThan(Date.parse('2026-03-08T05:00:00Z'));
      expect(at).toBeLessThanOrEqual(Date.parse('2026-03-08T08:00:00Z'));
      await armDayCards(world.scheduler, world.book, tz, Date.parse('2026-03-09T05:00:00Z'));
      expect(localIso(due(world, 'card:brief')!, tz)).toBe('2026-03-09T02:30');
    });
  });

  it('on the night clocks go back, a time in the repeated hour fires at its first occurrence', async () => {
    const tz = 'America/New_York';
    await owner(tz, Date.parse('2026-11-01T04:00:00Z'), async world => {
      expect(await setCardTime(deps(world, tz, Date.parse('2026-11-01T04:00:00Z')), 'card:brief', '01:30', true)).toBe('planned');
      expect(localIso(due(world, 'card:brief')!, tz)).toBe('2026-11-01T01:30');
    });
  });

  it('after a time-zone change, the Brief comes at the owner\'s time in the new zone, in place of the old one', async () => {
    const from = 'Asia/Kolkata', to = 'Europe/London', now = Date.parse('2026-11-06T00:30:00Z');
    await owner(from, now, async world => {
      expect(await setCardTime(deps(world, from, now), 'card:brief', '07:10', true)).toBe('planned');
      await replanDayCards(world.scheduler, world.book, to, now);
      expect(localIso(due(world, 'card:brief')!, to)).toBe('2026-11-06T07:10');
    });
  });
});

describe('with WAKE_BRIEF, a Brief time the owner set is the latest it comes', () => {
  const tz = 'Asia/Kolkata', day = '2026-11-06', at = (clock: string) => localToEpoch(`${day}T${clock}`, tz);
  it('a wake before it brings the Brief earlier, and nothing moves it later than the owner\'s time', async () => {
    await owner(tz, at('05:00'), async world => {
      await setCardTime(deps(world, tz, at('05:00')), 'card:brief', '07:10', true);
      expect(wakeTarget(world.book, tz, at('06:00'))).toEqual({ card: expect.objectContaining({ id: 'card:brief' }), time: '07:10' });
      expect(await applyWake(world.scheduler, world.book, tz, at('06:00'), '06:20')).toBe(true);
      expect([due(world, 'card:brief'), planned(world, day, 'card:brief')?.reason, world.book.pins()['card:brief']]).toEqual([at('06:20'), MOVED_EARLIER, '07:10']);
    });
  });
  it('a wake now sends it now', async () => {
    await owner(tz, at('05:00'), async world => {
      await setCardTime(deps(world, tz, at('05:00')), 'card:brief', '07:10', true);
      expect(await applyWake(world.scheduler, world.book, tz, at('06:00'), 'now')).toBe(true);
      expect(due(world, 'card:brief')).toBe(at('06:00'));
    });
  });
});
