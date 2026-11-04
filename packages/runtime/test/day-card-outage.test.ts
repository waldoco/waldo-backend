import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, cardFreshUntil, cardFor, dayPlanBook, resumeWaitingCards, runDayCard, type DayPlanBook } from '../src/channels/day-cards';
import { ModelUnavailableError } from '../src/llm/provider';
import { Scheduler, type ScheduleExecutors } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';

// A provider outage that spans the Brief slot: every model call fails as it did on 26 Oct (a dead key, auth_failed).
const tz = 'Asia/Kolkata';
const day = '2026-10-27';
const local = (time: string) => Date.parse(`${day}T${time}:00+05:30`);
const MINUTE = 60_000;

let seq = 0;
type Outage = { modelUp: boolean; generated: number[]; quarantined: boolean };

const withOutage = (work: (o: {
  scheduler: Scheduler; book: DayPlanBook; outage: Outage; executors: ScheduleExecutors;
  clock: { now: number }; tick(until: number, step?: number): Promise<void>;
}) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`day-card-outage-${seq++}`)), async (_instance, state) => {
    const clock = { now: local('03:00') };
    const deps: Deps = { now: () => clock.now, newRunId: () => 'run', newOutboxId: () => 'outbox', sha256Hex: async () => '0'.repeat(64) };
    const scheduler = new Scheduler(state.storage.sql, state.storage, deps);
    const book = dayPlanBook(state.storage.sql);
    const outage: Outage = { modelUp: false, generated: [], quarantined: false };
    const executors: ScheduleExecutors = {
      brief: (entry) => runDayCard({
        entry, book, timezone: tz, now: clock.now, freshness: { closeDue: null, quietStart: null },
        generate: async (card, cardDay) => {
          if (!outage.modelUp) throw new ModelUnavailableError('auth_failed');
          outage.generated.push(clock.now);
          book.sent(cardDay, card.id);
        },
      }),
    };
    const tick = async (until: number, step = MINUTE) => {
      while (clock.now < until) {
        clock.now = Math.min(clock.now + step, until);
        await scheduler.dispatchDue(executors);
        if (scheduler.read('card:brief')?.status === 'quarantined') outage.quarantined = true;
      }
    };
    await applyDayPlan(scheduler, book, tz, clock.now, [{ card: 'card:brief', time: '04:30', reason: 'early start' }]);
    await work({ scheduler, book, outage, executors, clock, tick });
  });

const brief = (book: DayPlanBook) => book.read(day).find((row) => row.card === 'card:brief');

describe('a model outage over a day-card slot', () => {
  it('parks the Brief as waiting on the model, and re-runs it once when the model recovers at 05:00 local', async () => {
    await withOutage(async ({ scheduler, book, outage, executors, clock, tick }) => {
      await tick(local('05:00'));
      expect(outage.generated).toEqual([]);
      // Each provider-down run is a wait, not a failure: more than QUARANTINE_AFTER_ATTEMPTS of them never quarantine the card.
      expect(outage.quarantined).toBe(false);
      expect(scheduler.read('card:brief')?.status).toBe('armed');
      expect(brief(book)?.state).toBe('waiting_on_model');

      outage.modelUp = true;
      expect(await resumeWaitingCards(scheduler, book, tz, clock.now)).toEqual(['card:brief']);
      await scheduler.dispatchDue(executors);
      // A second recovery signal and the rest of the morning add nothing.
      expect(await resumeWaitingCards(scheduler, book, tz, clock.now)).toEqual([]);
      await tick(local('07:00'));

      expect(outage.generated).toEqual([local('05:00')]);
      expect(scheduler.read('card:brief')).toBeNull();
      expect(brief(book)?.state).toBe('sent');
    });
  });

  it('skips the Brief with an honest reason when the model is still down past local midday, and sends nothing stale at 14:00', async () => {
    await withOutage(async ({ scheduler, book, outage, executors, clock, tick }) => {
      await tick(local('14:00'), 5 * MINUTE);
      expect(outage.quarantined).toBe(false);

      outage.modelUp = true;
      expect(await resumeWaitingCards(scheduler, book, tz, clock.now)).toEqual([]);
      await scheduler.dispatchDue(executors);
      await tick(local('15:00'), 5 * MINUTE);

      expect(outage.generated).toEqual([]);
      expect(scheduler.read('card:brief')).toBeNull();
      expect(brief(book)).toMatchObject({ state: 'skipped', reason: "Waldo couldn't reach its model this morning" });
    });
  });
});

describe('a model outage over any other job', () => {
  it('still pauses it after QUARANTINE_AFTER_ATTEMPTS failures: only a day card waits for the model', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`day-card-outage-${seq++}`)), async (_instance, state) => {
      const clock = { now: local('03:00') };
      const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => clock.now, newRunId: () => 'run', newOutboxId: () => 'outbox', sha256Hex: async () => '0'.repeat(64) });
      await scheduler.schedule({ id: 'reminder:r', kind: 'reminder', payloadRefs: { reminder_id: 'reminder:r' }, occurrenceAt: clock.now, dueAt: clock.now, recurrence: null });
      const executors: ScheduleExecutors = { reminder: async () => { throw new ModelUnavailableError('auth_failed'); } };
      for (let step = 0; step < 10 && scheduler.read('reminder:r')?.status === 'armed'; step += 1) {
        clock.now += 5 * MINUTE;
        await scheduler.dispatchDue(executors);
      }
      expect(scheduler.read('reminder:r')?.status).toBe('quarantined');
    });
  });
});

describe('which cards come back when the model does', () => {
  it('pulls forward only today\'s waiting cards, never a row left waiting on an earlier day', async () => {
    await withOutage(async ({ scheduler, book, clock }) => {
      book.waitingOnModel('2026-10-26', 'card:close');
      await scheduler.schedule({ id: 'card:close', kind: 'brief', payloadRefs: { id: 'card:close' }, occurrenceAt: local('21:30'), dueAt: local('21:30'), recurrence: null });
      expect(await resumeWaitingCards(scheduler, book, tz, clock.now)).toEqual([]);
      expect(scheduler.read('card:close')?.due_at).toBe(local('21:30'));
    });
  });
});

describe('how late a card that waited may still go out', () => {
  const brief = cardFor('card:brief')!, checkIn = cardFor('card:midday')!, close = cardFor('card:close')!;
  const endOfDay = Date.parse('2026-10-28T00:00:00+05:30');
  it('the Brief until local midday', () => {
    expect(cardFreshUntil(brief, local('04:30'), tz, { closeDue: null, quietStart: null })).toBe(local('12:00'));
  });
  it('the Check-in until the Close is due, else the end of its day', () => {
    expect(cardFreshUntil(checkIn, local('14:00'), tz, { closeDue: local('21:30'), quietStart: null })).toBe(local('21:30'));
    expect(cardFreshUntil(checkIn, local('14:00'), tz, { closeDue: null, quietStart: null })).toBe(endOfDay);
    // A Close already behind the Check-in bounds nothing.
    expect(cardFreshUntil(checkIn, local('14:00'), tz, { closeDue: local('13:00'), quietStart: null })).toBe(endOfDay);
  });
  it('the Close until quiet hours start, and to the end of its day when quiet hours start after midnight or are unset', () => {
    expect(cardFreshUntil(close, local('21:30'), tz, { closeDue: null, quietStart: '23:00' })).toBe(local('23:00'));
    expect(cardFreshUntil(close, local('21:30'), tz, { closeDue: null, quietStart: '01:00' })).toBe(endOfDay);
    expect(cardFreshUntil(close, local('21:30'), tz, { closeDue: null, quietStart: null })).toBe(endOfDay);
  });
});
