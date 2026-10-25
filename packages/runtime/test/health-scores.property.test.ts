import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDailyScores } from '../src/health/scores';
import { DRIVER_SUBJECTS } from '../src/health/scores/drivers';
import type { DailyScoresInput, DayRecord, HourlyBucket } from '../src/health/scores/types';

const TARGET = '2026-05-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const finite = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const bucket = (day: string, hour: number, hr: number | null, hrv: number | null, move: number | null, energy: number | null): HourlyBucket => ({
  startAt: new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000).toISOString(), heartRate: hr, hrv, hrvMethod: hrv === null ? null : 'rmssd', daylightMinutes: move, movementMinutes: move, activeEnergyKcal: energy,
});
const optional = (min: number, max: number) => fc.option(finite(min, max), { nil: null });
const dayArb = (age: number): fc.Arbitrary<DayRecord> => {
  const day = addDays(TARGET, -age);
  return fc.record({
    sleep: fc.option(fc.record({ asleepMinutes: finite(0, 1440), midpointMinute: finite(0, 1439.99) }), { nil: null }),
    hrv: optional(1, 300), sdnn: optional(1, 300), rhr: optional(30, 120), nightly: optional(30, 120),
    hr: fc.array(fc.option(finite(40, 200), { nil: null }), { minLength: 0, maxLength: 24 }), energy: optional(0, 900),
    meetings: optional(0, 1000), load: optional(0, 5000),
    breathing: optional(4, 80), oxygen: optional(50, 100), temperature: optional(25, 42), awake: optional(0, 600), walking: optional(40, 200),
  }).map(r => ({
    day, timezone: 'Europe/London',
    sleep: r.sleep && { ...r.sleep, startAt: `${addDays(day, -1)}T23:00:00.000Z`, endAt: `${day}T07:00:00.000Z` },
    overnightHrv: [...(r.hrv === null ? [] : [{ value: r.hrv, method: 'rmssd' as const }]), ...(r.sdnn === null ? [] : [{ value: r.sdnn, method: 'sdnn' as const }])],
    restingHeartRate: [...(r.rhr === null ? [] : [{ value: r.rhr, method: 'provider_resting_daily' as const }]), ...(r.nightly === null ? [] : [{ value: r.nightly, method: 'overnight_resting' as const }])],
    hourly: r.hr.map((hr, hour) => bucket(day, hour, hr, hr === null ? null : hr / 2, hr === null ? null : 10, r.energy === null ? null : r.energy / 24)), workouts: [],
    vitals: { breathingRate: r.breathing, bloodOxygen: r.oxygen, awakeMinutes: r.awake, walkingHeartRate: r.walking, wristTemperature: r.temperature === null ? [] : [{ value: r.temperature, method: 'absolute' as const }] },
    demand: { meetingMinutes: r.meetings, messageCount: 10, openTaskMinutes: 60, physicalLoad: r.load },
  }));
};
const daysArb = fc.integer({ min: 0, max: 40 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => dayArb(i))));
const toInput = (days: DayRecord[]): DailyScoresInput => ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z` });
const numbers = (value: unknown): number[] => (typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(numbers) : []);

describe('health scores: properties', () => {
  it('every pillar is a valid shape with finite clamped integer scores', () => {
    fc.assert(fc.property(daysArb, days => {
      const out = computeDailyScores(toInput(days));
      for (const pillar of [out.recovery, out.form, out.weight]) {
        if (pillar.state === 'available') {
          expect(Number.isInteger(pillar.score)).toBe(true);
          expect(pillar.score >= 0 && pillar.score <= 100).toBe(true);
          expect(pillar.coverage > 0 && pillar.coverage <= 1).toBe(true);
        } else expect(pillar.reason.length).toBeGreaterThan(0);
      }
      expect(numbers(out).every(Number.isFinite)).toBe(true);
    }), { numRuns: 200 });
  });
  it('drivers are only closed phrases, and never move a score', () => {
    fc.assert(fc.property(daysArb, days => {
      const out = computeDailyScores(toInput(days));
      for (const driver of out.drivers) expect(driver).toMatch(new RegExp(`^(${DRIVER_SUBJECTS.join('|')})( far)? (above|below) usual$`));
      const without = computeDailyScores(toInput(days.map(({ vitals: _vitals, ...rest }) => rest)));
      expect(without.drivers).toEqual([]);
      expect([out.recovery, out.form, out.weight, out.sleep_debt]).toEqual([without.recovery, without.form, without.weight, without.sleep_debt]);
    }), { numRuns: 150 });
  });
  it('same input gives the same output', () => {
    fc.assert(fc.property(daysArb, days => { expect(computeDailyScores(toInput(days))).toEqual(computeDailyScores(toInput(days))); }), { numRuns: 100 });
  });
  it('dropping baseline days never raises coverage', () => {
    fc.assert(fc.property(daysArb, fc.integer({ min: 1, max: 40 }), (days, cut) => {
      const full = computeDailyScores(toInput(days));
      const fewer = computeDailyScores(toInput(days.filter((_, i) => i < Math.max(1, days.length - cut))));
      const cov = (p: { state: string; coverage?: number }) => (p.state === 'available' ? p.coverage ?? 0 : 0);
      expect(cov(fewer.recovery)).toBeLessThanOrEqual(cov(full.recovery) + 1e-9);
      expect(cov(fewer.form)).toBeLessThanOrEqual(cov(full.form) + 1e-9);
      expect(cov(fewer.weight)).toBeLessThanOrEqual(cov(full.weight) + 1e-9);
      expect(fewer.sleep_debt.state === 'unavailable' ? 0 : fewer.sleep_debt.coverage).toBeLessThanOrEqual((full.sleep_debt.state === 'unavailable' ? 0 : full.sleep_debt.coverage) + 1e-9);
    }), { numRuns: 100 });
  });
  it('better sleep never lowers Recovery, all else fixed', () => {
    fc.assert(fc.property(daysArb, finite(0, 1440), finite(0, 1440), (days, a, b) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      const withSleep = (minutes: number) => toInput(days.map((d, i) => (i === 0 ? { ...d, sleep: { startAt: 'x', endAt: 'y', asleepMinutes: minutes, midpointMinute: 180 } } : d)));
      const score = (r: ReturnType<typeof computeDailyScores>['recovery']) => (r.state === 'available' ? r.score : null);
      const lo = score(computeDailyScores(withSleep(low)).recovery);
      const hi = score(computeDailyScores(withSleep(high)).recovery);
      if (lo !== null && hi !== null) expect(hi).toBeGreaterThanOrEqual(lo);
    }), { numRuns: 150 });
  });
});
