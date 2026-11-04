import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyDayPlan, armDayCards, dayPlanBook, pullBriefForWake } from '../src/channels/day-cards';
import { sleepJustEnded, WAKE_FRESH_MS } from '../src/health/wake-notice';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const tz = 'Asia/Kolkata';
// 2026-11-04 00:00 UTC = 05:30 in Kolkata.
const midnightUtc = Date.parse('2026-11-04T00:00:00Z');
const kolkata = (hhmm: string) => Date.parse(`2026-11-04T${hhmm}:00+05:30`);

const night = (endMs: number, extra: Record<string, unknown> = {}) => ({
  sample_id: `sleep-${endMs}`, revision: 1, signal: 'sleep_duration', unit: 'minutes', value: 420,
  start_at: new Date(endMs - 8 * 3_600_000).toISOString(), end_at: new Date(endMs).toISOString(), day: '2026-11-04', utc_offset_minutes: 330, ...extra,
});

describe('sleepJustEnded', () => {
  const now = Date.parse('2026-11-04T01:30:00Z');
  it('is true for a night whose last asleep interval ended within the fresh window', () => {
    expect(sleepJustEnded([night(now - 10 * 60_000)], now)).toBe(true);
    expect(sleepJustEnded([night(now - WAKE_FRESH_MS + 60_000)], now)).toBe(true);
    expect(sleepJustEnded([night(now + 2 * 60_000)], now)).toBe(true);
  });

  it('reads the last asleep interval over the sample end, so in-bed time after waking does not count as sleep', () => {
    const asleepEnd = now - 4 * 3_600_000;
    const withContext = night(now - 5 * 60_000, { sleep_context: {
      source_ref: 'watch', session_ref: 's1', waking_day: '2026-11-04', reducer_version: 'asleep-interval-union.v1', contributor_ids: ['a', 'b'],
      intervals: [
        { contributor_id: 'a', start_at: new Date(asleepEnd - 6 * 3_600_000).toISOString(), end_at: new Date(asleepEnd).toISOString(), kind: 'asleep' },
        { contributor_id: 'b', start_at: new Date(asleepEnd).toISOString(), end_at: new Date(now - 5 * 60_000).toISOString(), kind: 'in_bed' },
      ] } });
    expect(sleepJustEnded([withContext], now)).toBe(false);
  });

  it('is false for old nights, future nights, other signals and malformed samples', () => {
    expect(sleepJustEnded([night(now - WAKE_FRESH_MS - 60_000)], now)).toBe(false);
    expect(sleepJustEnded([night(now + 30 * 60_000)], now)).toBe(false);
    expect(sleepJustEnded([{ ...night(now - 60_000), signal: 'steps_window', unit: 'count' }], now)).toBe(false);
    expect(sleepJustEnded([0, null, { signal: 'sleep_duration' }], now)).toBe(false);
    expect(sleepJustEnded([], now)).toBe(false);
  });
});

describe('pullBriefForWake', () => {
  const fresh = async (name: string, run: (scheduler: Scheduler, book: ReturnType<typeof dayPlanBook>) => Promise<void>) => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const book = dayPlanBook(state.storage.sql);
      await armDayCards(scheduler, book, tz, midnightUtc);
      await run(scheduler, book);
    });
  };

  it('moves a pending Brief to now when the owner wakes within three hours of its planned time', async () => {
    await fresh('wake-brief-moves', async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnightUtc, [{ card: 'card:brief', time: '08:30', reason: 'usually up at 8' }]);
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('06:40'))).toBe('pulled_forward');
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('06:40'));
      expect(scheduler.read('card:midday')?.due_at).toBe(kolkata('14:00'));
    });
  });

  it('keeps the planned time for a wake long before it, a Brief already sent, skipped or held, and an entry already due', async () => {
    await fresh('wake-brief-early', async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnightUtc, [{ card: 'card:brief', time: '08:30', reason: 'usually up at 8' }]);
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('05:00'))).toBe('too_early');
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('08:30'));
    });
    await fresh('wake-brief-sent', async (scheduler, book) => {
      book.sent('2026-11-04', 'card:brief');
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('07:00'))).toBe('not_pending');
    });
    await fresh('wake-brief-held', async (scheduler, book) => {
      book.held('2026-11-04', 'card:brief');
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('07:00'))).toBe('not_pending');
    });
    await fresh('wake-brief-skipped', async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnightUtc, [{ card: 'card:brief', time: null, reason: 'day off' }]);
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('07:00'))).toBe('not_planned');
    });
    await fresh('wake-brief-due', async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnightUtc, [{ card: 'card:brief', time: '06:00', reason: 'early' }]);
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('06:10'))).toBe('not_armed');
    });
  });

  it('follows a night-shift worker whose Brief is planned for the evening', async () => {
    await fresh('wake-brief-night-shift', async (scheduler, book) => {
      await applyDayPlan(scheduler, book, tz, midnightUtc, [{ card: 'card:brief', time: '19:00', reason: 'night shift, wakes about 18:30' }]);
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('12:00'))).toBe('too_early');
      expect(await pullBriefForWake(scheduler, book, tz, kolkata('18:25'))).toBe('pulled_forward');
      expect(scheduler.read('card:brief')?.due_at).toBe(kolkata('18:25'));
    });
  });
});
