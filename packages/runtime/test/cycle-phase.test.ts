import { describe, expect, it } from 'vitest';
import { cycleEngineOn, cyclePhaseOn, cycleRoutesOpen, type PeriodDates } from '../src/health/cycle/phase';

// Synthetic dates.
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const regular = (first: string, lengths: readonly number[], bleed = 5): PeriodDates[] => {
  const out: PeriodDates[] = [];
  let start = first;
  for (const length of [...lengths, 0]) {
    out.push({ start, end: addDays(start, bleed - 1) });
    start = addDays(start, length);
  }
  return out;
};
const ON = '1';

describe('cycle phase engine', () => {
  // Starts 2026-07-01, -07-31, -08-30, -09-29: three complete cycles of 30 days. Ovulation is the next start less 14: day 16.
  const periods = regular('2026-07-01', [30, 30, 30]);
  const last = '2026-09-29';

  it('places a regular history: menstrual, follicular, luteal, then unknown once the period is late', () => {
    expect(cyclePhaseOn(last, periods, ON)).toEqual({ phase: 'menstrual', cycleStart: last });
    expect(cyclePhaseOn(addDays(last, 4), periods, ON).phase).toBe('menstrual');
    expect(cyclePhaseOn(addDays(last, 5), periods, ON).phase).toBe('follicular');
    expect(cyclePhaseOn(addDays(last, 15), periods, ON).phase).toBe('follicular');
    expect(cyclePhaseOn(addDays(last, 16), periods, ON).phase).toBe('luteal');
    expect(cyclePhaseOn(addDays(last, 29), periods, ON).phase).toBe('luteal');
    expect(cyclePhaseOn(addDays(last, 30), periods, ON)).toEqual({ phase: 'unknown', cycleStart: null });
  });

  it('uses the median of the owner\'s own cycles once two are complete', () => {
    const own = regular('2026-07-01', [33, 34, 33]);
    const start = own[own.length - 1]!.start;
    // Median 33: ovulation on day 19.
    expect(cyclePhaseOn(addDays(start, 18), own, ON).phase).toBe('follicular');
    expect(cyclePhaseOn(addDays(start, 19), own, ON).phase).toBe('luteal');
  });

  it('falls back to 28 days for boundaries with fewer than two complete cycles', () => {
    const one = regular('2026-09-01', [33]);
    const start = one[1]!.start;
    expect(cyclePhaseOn(addDays(start, 13), one, ON).phase).toBe('follicular');
    expect(cyclePhaseOn(addDays(start, 14), one, ON).phase).toBe('luteal');
    expect(cyclePhaseOn(addDays('2026-09-01', 14), [{ start: '2026-09-01', end: null }], ON).phase).toBe('luteal');
  });

  it('is unknown with no period in the last 60 days, before any period, or with none at all', () => {
    expect(cyclePhaseOn(addDays(last, 60), periods, ON).phase).toBe('unknown');
    expect(cyclePhaseOn('2026-06-20', periods, ON).phase).toBe('unknown');
    expect(cyclePhaseOn('2026-10-10', [], ON).phase).toBe('unknown');
  });

  it('is unknown when a recent cycle is outside 21 to 45 days or the cycles vary by more than 9 days', () => {
    const short = regular('2026-07-01', [30, 19, 30]);
    expect(cyclePhaseOn(addDays(short[3]!.start, 2), short, ON).phase).toBe('unknown');
    const long = regular('2026-05-01', [30, 47, 30]);
    expect(cyclePhaseOn(addDays(long[3]!.start, 2), long, ON).phase).toBe('unknown');
    const varied = regular('2026-07-01', [24, 34, 28]);
    expect(cyclePhaseOn(addDays(varied[3]!.start, 2), varied, ON).phase).toBe('unknown');
    const withinNine = regular('2026-07-01', [25, 34, 28]);
    expect(cyclePhaseOn(addDays(withinNine[3]!.start, 2), withinNine, ON).phase).toBe('menstrual');
  });

  it('merges the same period recorded by two apps, and takes an open period as five days', () => {
    const twice = [...periods, { start: addDays(last, 1), end: addDays(last, 3) }];
    expect(cyclePhaseOn(addDays(last, 16), twice, ON).phase).toBe('luteal');
    const open = [...periods.slice(0, -1), { start: last, end: null }];
    expect(cyclePhaseOn(addDays(last, 4), open, ON).phase).toBe('menstrual');
    expect(cyclePhaseOn(addDays(last, 5), open, ON).phase).toBe('follicular');
  });

  it('places a past day on the actual next start, not the expected one', () => {
    const own = regular('2026-07-01', [26, 34, 30]);
    const second = own[1]!.start;
    // That cycle ran 34 days, so ovulation was day 20: day 19 was follicular and day 33 still luteal.
    expect(cyclePhaseOn(addDays(second, 19), own, ON).phase).toBe('follicular');
    expect(cyclePhaseOn(addDays(second, 20), own, ON).phase).toBe('luteal');
    expect(cyclePhaseOn(addDays(second, 33), own, ON).phase).toBe('luteal');
    // A day in a cycle that ended outside 21 to 45 days is unknown.
    const gap = regular('2026-05-01', [50, 30]);
    expect(cyclePhaseOn(addDays(gap[0]!.start, 10), gap, ON).phase).toBe('unknown');
  });

  it('the kill switch makes every day unknown; only "1" runs the engine', () => {
    for (const flag of [undefined, '0', 'paused', 'true', 'on', ' 1']) {
      expect(cyclePhaseOn(addDays(last, 16), periods, flag)).toEqual({ phase: 'unknown', cycleStart: null });
      expect(cycleEngineOn(flag)).toBe(false);
    }
    expect(cycleRoutesOpen('paused')).toBe(true);
    expect(cycleRoutesOpen('1')).toBe(true);
    expect(cycleRoutesOpen('0')).toBe(false);
    expect(cycleRoutesOpen(undefined)).toBe(false);
  });
});
