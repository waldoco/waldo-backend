import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PULSE_PRIOR, VARIABILITY_PRIOR, estimate, zOf } from '../src/health/scores/baseline';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScores, DailyScoresInput, DayRecord, HourlyBucket } from '../src/health/scores/types';

// Provisional scores under random synthetic owners: bounds, monotonicity, method isolation and the shrinkage limits.
const TARGET = '2026-05-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const finite = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const optional = (min: number, max: number) => fc.option(finite(min, max), { nil: null });

const bucket = (day: string, hour: number, hr: number | null, hrv: number | null, method: 'rmssd' | 'sdnn'): HourlyBucket => ({
  startAt: new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000).toISOString(), heartRate: hr, hrv, hrvMethod: hrv === null ? null : method, daylightMinutes: 10, movementMinutes: 10, activeEnergyKcal: null,
});
const dayArb = (age: number): fc.Arbitrary<DayRecord> => {
  const day = addDays(TARGET, -age);
  return fc.record({
    sleep: fc.option(fc.record({ asleepMinutes: finite(0, 1440), midpointMinute: finite(0, 1439.99) }), { nil: null }),
    hrv: optional(1, 300), sdnn: optional(1, 300), rhr: optional(30, 120), unlabelled: optional(30, 120),
    hr: fc.array(fc.option(finite(40, 200), { nil: null }), { minLength: 0, maxLength: 24 }), method: fc.constantFrom('rmssd' as const, 'sdnn' as const),
    meetings: optional(0, 1000), load: optional(0, 5000),
  }).map(r => ({
    day, timezone: 'Europe/London',
    sleep: r.sleep && { ...r.sleep, startAt: `${addDays(day, -1)}T23:00:00.000Z`, endAt: `${day}T07:00:00.000Z` },
    overnightHrv: [...(r.hrv === null ? [] : [{ value: r.hrv, method: 'rmssd' as const }]), ...(r.sdnn === null ? [] : [{ value: r.sdnn, method: 'sdnn' as const }])],
    restingHeartRate: [...(r.rhr === null ? [] : [{ value: r.rhr, method: 'overnight_resting' as const }]), ...(r.unlabelled === null ? [] : [{ value: r.unlabelled, method: 'unknown' as const }])],
    hourly: r.hr.map((hr, hour) => bucket(day, hour, hr, hr === null ? null : hr / 2, r.method)), workouts: [],
    demand: { meetingMinutes: r.meetings, messageCount: 10, openTaskMinutes: 60, physicalLoad: r.load },
  }));
};
const daysArb = fc.integer({ min: 0, max: 40 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => dayArb(i))));
const input = (days: readonly DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: null, asOf: `${TARGET}T20:00:00.000Z`, provisional: true, ...over });
const numbers = (value: unknown): number[] => (typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(numbers) : []);

// A fixed owner for the one-factor properties: eight earlier nights, so every component is in the window.
const steady = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i), wobble = ((i * 7919) % 13 - 6) / 6;
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble * 20, midpointMinute: 180 },
    overnightHrv: [{ value: 40 + wobble * 4, method: 'rmssd' }, { value: 55 + wobble * 4, method: 'sdnn' }],
    restingHeartRate: [{ value: 60 + wobble * 2, method: 'overnight_resting' }],
    hourly: [], workouts: [], demand: null, ...over,
  };
};
const owner = (n: number, target: Partial<DayRecord> = {}): DayRecord[] => [steady(0, target), ...Array.from({ length: n }, (_, i) => steady(i + 1))];
const score = (result: DailyScores) => { const r = result.recovery; if (r.state !== 'available') throw new Error('expected available'); return r.score; };

describe('provisional scores: properties', () => {
  it('every available pillar is an integer 0 to 100, the label is coherent, and every number is finite', () => {
    fc.assert(fc.property(daysArb, days => {
      const out = computeDailyScores(input(days));
      for (const pillar of [out.recovery, out.form, out.weight]) {
        if (pillar.state !== 'available') { expect(pillar.reason.length).toBeGreaterThan(0); continue; }
        expect(Number.isInteger(pillar.score) && pillar.score >= 0 && pillar.score <= 100).toBe(true);
        expect(pillar.coverage > 0 && pillar.coverage <= 1).toBe(true);
        expect(pillar.activation).toBe('accepted');
        expect(pillar.baseline!.needed).toBe(14);
        expect(pillar.baseline!.state).toBe(pillar.baseline!.personal_days >= 14 ? 'personal' : 'provisional');
        expect(pillar.baseline!.personal_days).toBeGreaterThanOrEqual(0);
        expect(pillar.baseline!.personal_days).toBeLessThanOrEqual(30);
        expect(['adults', 'none']).toContain(pillar.baseline!.prior);
      }
      const debt = out.sleep_debt;
      if (debt.state === 'available') expect(debt.debt_minutes! >= 0 && debt.debt_minutes! <= 20_160).toBe(true);
      expect(numbers(out).every(Number.isFinite)).toBe(true);
    }), { numRuns: 200 });
  });
  it('is deterministic', () => {
    fc.assert(fc.property(daysArb, days => { expect(JSON.stringify(computeDailyScores(input(days)))).toBe(JSON.stringify(computeDailyScores(input(days)))); }), { numRuns: 60 });
  });
  it('more sleep never lowers Recovery, all else equal, with or without a confirmed need', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), finite(0, 900), finite(0, 400), fc.constantFrom(null, 480), (n, base, extra, need) => {
      const slept = (minutes: number) => ({ sleep: { startAt: `${addDays(TARGET, -1)}T23:00:00.000Z`, endAt: `${TARGET}T07:00:00.000Z`, asleepMinutes: minutes, midpointMinute: 180 } });
      const less = score(computeDailyScores(input(owner(n, slept(base)), { sleepNeedMinutes: need })));
      const more = score(computeDailyScores(input(owner(n, slept(base + extra)), { sleepNeedMinutes: need })));
      expect(more).toBeGreaterThanOrEqual(less);
    }), { numRuns: 200 });
  });
  it('a higher resting rate never raises Recovery, all else equal', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), finite(30, 110), finite(0, 40), (n, base, extra) => {
      const resting = (value: number) => ({ restingHeartRate: [{ value, method: 'overnight_resting' as const }] });
      const lower = score(computeDailyScores(input(owner(n, resting(base)))));
      const higher = score(computeDailyScores(input(owner(n, resting(base + extra)))));
      expect(higher).toBeLessThanOrEqual(lower);
    }), { numRuns: 200 });
  });
  it('a higher overnight variability never lowers Recovery, all else equal', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), finite(5, 120), finite(0, 80), (n, base, extra) => {
      const variability = (value: number) => ({ overnightHrv: [{ value, method: 'rmssd' as const }] });
      const lower = score(computeDailyScores(input(owner(n, variability(base)))));
      const higher = score(computeDailyScores(input(owner(n, variability(base + extra)))));
      expect(higher).toBeGreaterThanOrEqual(lower);
    }), { numRuns: 200 });
  });
  it('an SDNN history never changes an RMSSD night, and an RMSSD history never changes an SDNN night', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 20 }), finite(1, 300), finite(1, 300), (n, a, b) => {
      const withSdnn = (value: number) => (record: DayRecord): DayRecord => ({ ...record, overnightHrv: [...record.overnightHrv.filter(r => r.method === 'rmssd'), { value, method: 'sdnn' }] });
      const withRmssd = (value: number) => (record: DayRecord): DayRecord => ({ ...record, overnightHrv: [...record.overnightHrv.filter(r => r.method === 'sdnn'), { value, method: 'rmssd' }] });
      const rmssdNight = { overnightHrv: [{ value: 41, method: 'rmssd' as const }] };
      const earlier = (change: (record: DayRecord) => DayRecord) => (n === 0 ? [] : owner(n).slice(1)).map(change);
      const rmssdA = computeDailyScores(input([steady(0, rmssdNight), ...earlier(withSdnn(a))])), rmssdB = computeDailyScores(input([steady(0, rmssdNight), ...earlier(withSdnn(b))]));
      expect(JSON.stringify(rmssdA.recovery)).toBe(JSON.stringify(rmssdB.recovery));
      const sdnnNight = { overnightHrv: [{ value: 52, method: 'sdnn' as const }] };
      const sdnnA = computeDailyScores(input([steady(0, sdnnNight), ...earlier(withRmssd(a))])), sdnnB = computeDailyScores(input([steady(0, sdnnNight), ...earlier(withRmssd(b))]));
      expect(JSON.stringify(sdnnA.recovery)).toBe(JSON.stringify(sdnnB.recovery));
    }), { numRuns: 120 });
  });
  it('sleep debt is never negative and never changes when a night above need is replaced by one at need and none is owed', () => {
    fc.assert(fc.property(fc.array(finite(0, 1000), { minLength: 10, maxLength: 14 }), nights => {
      const records = nights.map((minutes, i) => steady(i, { sleep: { startAt: `${addDays(TARGET, -i - 1)}T23:00:00.000Z`, endAt: `${addDays(TARGET, -i)}T07:00:00.000Z`, asleepMinutes: minutes, midpointMinute: 180 } }));
      const debt = computeDailyScores(input(records, { sleepNeedMinutes: 480 })).sleep_debt;
      if (debt.state === 'available') expect(debt.debt_minutes).toBeGreaterThanOrEqual(0);
      const rested = computeDailyScores(input(records.map(r => ({ ...r, sleep: r.sleep && { ...r.sleep, asleepMinutes: 1000 } })), { sleepNeedMinutes: 480 })).sleep_debt;
      expect(rested.state === 'available' && rested.debt_minutes).toBe(0);
    }), { numRuns: 100 });
  });
});

describe('shrinkage limits', () => {
  it('gives the prior centre with no days, and the owner\'s own mean as the days grow without bound', () => {
    for (const prior of [PULSE_PRIOR, VARIABILITY_PRIOR]) expect(estimate([], prior)!.centre).toBe(prior.mu0);
    fc.assert(fc.property(finite(40, 90), fc.integer({ min: 200, max: 2000 }), (mean, n) => {
      const e = estimate(Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? 1 : -1)), PULSE_PRIOR)!;
      expect(Math.abs(e.centre - mean)).toBeLessThan(0.1);
    }), { numRuns: 60 });
  });
  it('gives the owner more of the centre at thirty days than at three, and keeps the z inside the limit', () => {
    fc.assert(fc.property(finite(40, 90), finite(0, 10), finite(-100, 300), (mean, spread, today) => {
      const series = (n: number) => Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? spread : -spread));
      const early = estimate(series(3), PULSE_PRIOR)!, late = estimate(series(30), PULSE_PRIOR)!;
      expect(late.ownShare).toBeGreaterThan(early.ownShare);
      expect(late.ownShare).toBeLessThan(1);
      for (const e of [early, late]) expect(Math.abs(zOf(today, e))).toBeLessThanOrEqual(2.5);
    }), { numRuns: 60 });
  });
});
