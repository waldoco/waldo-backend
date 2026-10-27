import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, dayPlanBook, resumeWaitingCards, runDayCard, type DayPlanBook } from '../src/channels/day-cards';
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
      expect(await resumeWaitingCards(scheduler, book, clock.now)).toEqual(['card:brief']);
      await scheduler.dispatchDue(executors);
      // A second recovery signal and the rest of the morning add nothing.
      expect(await resumeWaitingCards(scheduler, book, clock.now)).toEqual([]);
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
      expect(await resumeWaitingCards(scheduler, book, clock.now)).toEqual([]);
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
