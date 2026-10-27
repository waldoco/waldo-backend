import { describe, expect, it } from 'vitest';
import { PULSE_PRIOR, VARIABILITY_PRIOR } from '../src/health/scores/baseline';
import { computeDailyScores } from '../src/health/scores';
import type { BaselineLabel, DailyScores, DailyScoresInput, DayRecord, HourlyBucket } from '../src/health/scores/types';

// Provisional day-1 scores (recovery.v5, form.v9, weight.v5, sleep-debt.v2). Every value is synthetic.
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TARGET = '2026-03-20';
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
const TYPICAL_VARIABILITY = Math.exp(VARIABILITY_PRIOR.mu0);

const hourly = (day: string, offset: number, hrv = 55, method: 'rmssd' | 'sdnn' = 'rmssd'): HourlyBucket[] =>
  [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(h => ({
    startAt: new Date(Date.parse(`${day}T00:00:00Z`) + h * 3_600_000).toISOString(),
    heartRate: 72 + wobble(h + offset, 2), hrv: hrv + wobble(h + offset, 3), hrvMethod: method,
    daylightMinutes: 20 + wobble(h + offset, 2), movementMinutes: 12 + wobble(h + offset, 2), activeEnergyKcal: null,
  }));
const day = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: [{ value: 40 + wobble(i, 4), method: 'rmssd' }],
    restingHeartRate: [{ value: 62 + wobble(i, 2), method: 'overnight_resting' }],
    hourly: hourly(d, i), workouts: [],
    demand: { meetingMinutes: 240 + wobble(i, 40), messageCount: null, openTaskMinutes: null, physicalLoad: 100 + wobble(i, 10) },
    ...over,
  };
};
const days = (n: number, over: (i: number) => Partial<DayRecord> = () => ({})): DayRecord[] => Array.from({ length: n }, (_, i) => day(i, over(i)));
const on = (records: DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScores =>
  computeDailyScores({ access: 'granted', targetDay: TARGET, days: records, sleepNeedMinutes: null, asOf: `${TARGET}T20:00:00.000Z`, provisional: true, ...over });
const off = (records: DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScores => on(records, { provisional: false, ...over });
const asleepAt = (minutes: (i: number) => number | null) => (i: number): Partial<DayRecord> => {
  const m = minutes(i), d = addDays(TARGET, -i);
  return { sleep: m === null ? null : { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: m, midpointMinute: 180 } };
};
// An available pillar. Where the label is wanted it is there only on a pillar computed provisionally, which the caller names.
const available = <P extends { state: string }>(pillar: P): Extract<P, { state: 'available' }> & { baseline: BaselineLabel } => {
  if (pillar.state !== 'available') throw new Error(`expected available, got ${JSON.stringify(pillar)}`);
  return pillar as Extract<P, { state: 'available' }> & { baseline: BaselineLabel };
};
// The first morning: no earlier day at all, sleep and the two resting signals only.
const firstMorning = (over: Partial<DayRecord> = {}) => [day(0, { overnightHrv: [{ value: TYPICAL_VARIABILITY, method: 'rmssd' }], restingHeartRate: [{ value: PULSE_PRIOR.mu0, method: 'overnight_resting' }], ...over })];
const sleeping = (minutes: number) => ({ sleep: { startAt: `${addDays(TARGET, -1)}T23:00:00.000Z`, endAt: `${TARGET}T07:00:00.000Z`, asleepMinutes: minutes, midpointMinute: 180 } });

describe('provisional Recovery: the first morning', () => {
  it('scores from one night of the owner, against the all-adult priors, with its own version and label', () => {
    const r = available(on(firstMorning(sleeping(480))).recovery);
    expect(r.algorithm_version).toBe('recovery.v5');
    expect(r.activation).toBe('accepted');
    expect(r.coverage).toBe(1);
    expect(r.hrv_method).toBe('rmssd');
    expect(r.used.signals).toEqual(['sleep', 'hrv', 'resting_heart_rate']);
    expect(r.used.days).toEqual([TARGET]);
    expect(r.baseline).toEqual({ state: 'provisional', personal_days: 0, needed: 14, prior: 'adults' });
    // Sleep at need is a full sleep part, and a night at the typical centre is the middle for the other two.
    expect(r.score).toBe(75);
  });
  it('reads sleep against eight hours when the owner has no nights and has confirmed nothing', () => {
    expect(available(on(firstMorning(sleeping(400))).recovery).score).toBe(67);
  });
  it('reads sleep against the owner-confirmed need when there is one', () => {
    const r = available(on(firstMorning(sleeping(400)), { sleepNeedMinutes: 400 }).recovery);
    expect(r.score).toBe(75);
  });
  it('is the older engine, unchanged, with the switch off', () => {
    expect(off(firstMorning(sleeping(480))).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('still names what is missing', () => {
    expect(on(firstMorning({ sleep: null })).recovery).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
    expect(on(firstMorning({ overnightHrv: [], restingHeartRate: [] })).recovery).toEqual({ state: 'unavailable', reason: 'missing_resting_signal' });
  });
  it('is baseline_immature when its only resting signal has no prior and too few own days', () => {
    const appleDay = firstMorning({ overnightHrv: [{ value: 40, method: 'sdnn' }], restingHeartRate: [] });
    expect(on(appleDay).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(on(firstMorning({ overnightHrv: [], restingHeartRate: [{ value: 60, method: 'unknown' }] })).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
});

describe('provisional Recovery: which methods have a baseline', () => {
  it('keeps an SDNN night out of the score until seven own SDNN nights exist, and never reads a population prior for it', () => {
    const sdnnNight = (value: number) => firstMorning({ overnightHrv: [{ value, method: 'sdnn' }] });
    const low = available(on(sdnnNight(8)).recovery), high = available(on(sdnnNight(250)).recovery);
    expect(low.used.signals).not.toContain('hrv');
    expect(low.hrv_method).toBeNull();
    expect(high.score).toBe(low.score);
    expect(low.coverage).toBe(0.7);
  });
  it('joins an SDNN night at seven own nights, against its own history', () => {
    const history = (n: number) => [day(0, { overnightHrv: [{ value: 55, method: 'sdnn' }] }), ...days(n + 1, i => ({ overnightHrv: [{ value: 40 + wobble(i, 3), method: 'sdnn' as const }] })).slice(1)];
    expect(available(on(history(6)).recovery).used.signals).not.toContain('hrv');
    const seven = available(on(history(7)).recovery);
    expect(seven.used.signals).toContain('hrv');
    expect(seven.hrv_method).toBe('sdnn');
    expect(seven.coverage).toBe(1);
  });
  it('never reads RMSSD days for an SDNN night, nor SDNN days for an RMSSD one', () => {
    const rmssdDays = days(20);
    const sdnnTarget = [day(0, { overnightHrv: [{ value: 55, method: 'sdnn' }] }), ...rmssdDays.slice(1)];
    expect(available(on(sdnnTarget).recovery).used.signals).not.toContain('hrv');
    const sdnnDays = days(20, () => ({ overnightHrv: [{ value: 55, method: 'sdnn' as const }] }));
    const rmssdTarget = [day(0, { overnightHrv: [{ value: 41, method: 'rmssd' }] }), ...sdnnDays.slice(1)];
    const r = available(on(rmssdTarget).recovery);
    expect(r.hrv_method).toBe('rmssd');
    // The RMSSD night stands on the prior alone, so what the SDNN days hold changes nothing in it.
    const louder = days(20, () => ({ overnightHrv: [{ value: 150, method: 'sdnn' as const }] }));
    expect(available(on([rmssdTarget[0]!, ...louder.slice(1)]).recovery).score).toBe(r.score);
  });
  it('prefers RMSSD when the night has both', () => {
    const both = firstMorning({ overnightHrv: [{ value: TYPICAL_VARIABILITY, method: 'rmssd' }, { value: 55, method: 'sdnn' }] });
    expect(available(on(both).recovery).hrv_method).toBe('rmssd');
  });
  it('gives the heart-rate prior to measured and asleep-low resting rates, and none to an unlabelled one', () => {
    const lowOnly = firstMorning({ overnightHrv: [], restingHeartRate: [{ value: 60, method: 'asleep_hours_low' }] });
    const low = available(on(lowOnly).recovery);
    expect(low.coverage).toBe(0.7);
    expect(low.used.signals).toEqual(['sleep', 'resting_heart_rate']);
    for (const method of ['overnight_resting', 'provider_resting_daily', 'resting_measurement'] as const) {
      expect(available(on(firstMorning({ restingHeartRate: [{ value: 60, method }] })).recovery).used.signals).toContain('resting_heart_rate');
    }
    const unknown = available(on(firstMorning({ restingHeartRate: [{ value: 60, method: 'unknown' }] })).recovery);
    expect(unknown.used.signals).not.toContain('resting_heart_rate');
    expect(unknown.coverage).toBe(0.8);
  });
});

describe('provisional Recovery: the baseline label', () => {
  it('is provisional until fourteen own days, whatever the account age', () => {
    expect(available(on(days(14)).recovery).baseline).toMatchObject({ state: 'provisional', personal_days: 13 });
    expect(available(on(days(15)).recovery).baseline).toEqual({ state: 'personal', personal_days: 14, needed: 14, prior: 'adults' });
  });
  it('is personal on the first morning for an owner whose backfill already holds fourteen days', () => {
    expect(available(on(days(15), { sleepNeedMinutes: 480 }).recovery).baseline.state).toBe('personal');
    expect(available(on(days(40)).recovery).baseline.personal_days).toBe(30);
  });
  it('counts the fewest own days among the components it used', () => {
    const sparse = days(30, i => (i % 2 === 1 ? { restingHeartRate: [] } : {}));
    const r = available(on(sparse).recovery);
    expect(r.baseline.personal_days).toBe(14);
    expect(r.baseline.state).toBe('personal');
    expect(available(on(days(30, i => (i % 3 === 1 ? { restingHeartRate: [] } : {}))).recovery).baseline).toMatchObject({ personal_days: 19 });
  });
  it('says no prior took part when only own-day components were used', () => {
    const sdnnDays = days(20, () => ({ overnightHrv: [{ value: 55, method: 'sdnn' as const }], restingHeartRate: [{ value: 60, method: 'unknown' as const }] }));
    const r = available(on(sdnnDays, { sleepNeedMinutes: 480 }).recovery);
    expect(r.baseline).toEqual({ state: 'personal', personal_days: 19, needed: 14, prior: 'none' });
  });
  it('is absent with the switch off', () => {
    expect(available(off(days(20)).recovery)).not.toHaveProperty('baseline');
    expect(available(off(days(20)).recovery).algorithm_version).toBe('recovery.candidate.v4');
  });
});

describe('provisional Form', () => {
  const full = (n: number) => days(n, i => ({ overnightHrv: [{ value: 40 + wobble(i, 4), method: 'rmssd' as const }] }));
  it('needs one component beyond Recovery, which joins at seven own days', () => {
    expect(on(full(1)).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(on(full(7)).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    const seven = available(on(full(8)).form);
    expect(seven.algorithm_version).toBe('form.v9');
    expect(seven.activation).toBe('accepted');
    expect(seven.coverage).toBe(1);
    expect(seven.used.signals).toEqual(expect.arrayContaining(['sleep', 'sleep_midpoint', 'daylight', 'movement', 'stress']));
    expect(seven.baseline).toMatchObject({ state: 'provisional', personal_days: 7, needed: 14, prior: 'adults' });
  });
  it('is personal once every component it used holds fourteen own days', () => {
    expect(available(on(full(15)).form).baseline).toEqual({ state: 'personal', personal_days: 14, needed: 14, prior: 'adults' });
  });
  it('reads the stress part of an SDNN day against SDNN days only', () => {
    const sdnnDays = (n: number, target: number) => Array.from({ length: n }, (_, i) =>
      day(i, { hourly: hourly(addDays(TARGET, -i), i, i === 0 ? target : 55, 'sdnn'), overnightHrv: [{ value: 40 + wobble(i, 4), method: 'rmssd' as const }] }));
    const calm = available(on(sdnnDays(10, 90)).form).score, usual = available(on(sdnnDays(10, 55)).form).score;
    expect(calm).toBeGreaterThan(usual);
  });
  it('does not read an SDNN day against RMSSD days, nor the reverse', () => {
    const mixed = (target: number) => Array.from({ length: 10 }, (_, i) =>
      day(i, { hourly: hourly(addDays(TARGET, -i), i, i === 0 ? target : 55, i === 0 ? 'sdnn' : 'rmssd'), overnightHrv: [{ value: 40 + wobble(i, 4), method: 'rmssd' as const }] }));
    expect(available(on(mixed(95)).form).score).toBe(available(on(mixed(15)).form).score);
    const reverse = (target: number) => Array.from({ length: 10 }, (_, i) =>
      day(i, { hourly: hourly(addDays(TARGET, -i), i, i === 0 ? target : 55, i === 0 ? 'rmssd' : 'sdnn'), overnightHrv: [{ value: 40 + wobble(i, 4), method: 'rmssd' as const }] }));
    expect(available(on(reverse(95)).form).score).toBe(available(on(reverse(15)).form).score);
  });
  it('is the earlier engine, unchanged, with the switch off', () => {
    expect(off(full(10)).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
});

describe('provisional Weight', () => {
  const loadOnly = (n: number) => days(n, i => ({ demand: { meetingMinutes: null, messageCount: null, openTaskMinutes: null, physicalLoad: 100 + wobble(i, 10) } }));
  it('is available from physical load alone at reduced coverage, with the calendar missing from what it used', () => {
    const w = available(on(loadOnly(8)).weight);
    expect(w.algorithm_version).toBe('weight.v5');
    expect(w.activation).toBe('accepted');
    expect(w.coverage).toBe(0.2);
    expect(w.used.signals).toEqual(['physical_load']);
    expect(w.baseline).toEqual({ state: 'provisional', personal_days: 7, needed: 14, prior: 'none' });
    expect(off(loadOnly(8)).weight).toEqual({ state: 'unavailable', reason: 'calendar_demand_unavailable' });
  });
  it('adds the calendar when it has a baseline of its own', () => {
    const w = available(on(days(8)).weight);
    expect(w.used.signals).toEqual(['calendar', 'physical_load']);
    expect(w.coverage).toBe(0.55);
  });
  it('says the calendar is unavailable only when there is no demand and no load reading at all', () => {
    const nothing = { meetingMinutes: null, messageCount: null, openTaskMinutes: null, physicalLoad: null };
    expect(on(days(10, () => ({ demand: nothing }))).weight).toEqual({ state: 'unavailable', reason: 'calendar_demand_unavailable' });
    expect(on(days(10, () => ({ demand: null }))).weight).toEqual({ state: 'unavailable', reason: 'calendar_demand_unavailable' });
  });
  it('says the baseline is immature when there is data but fewer than seven own days of it', () => {
    expect(on(days(7)).weight).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(on(loadOnly(3)).weight).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('is personal at fourteen own days of every component it used', () => {
    expect(available(on(days(16)).weight).baseline).toEqual({ state: 'personal', personal_days: 15, needed: 14, prior: 'none' });
  });
});

describe('provisional sleep debt', () => {
  const nightly = (minutes: number) => days(30, asleepAt(() => minutes));
  const debt = (result: DailyScores) => result.sleep_debt;
  it('shows a chronic short sleeper a non-zero debt, which the earlier version put at zero', () => {
    const now = debt(on(nightly(360)));
    expect(now.state).toBe('available');
    if (now.state !== 'available') return;
    expect(now.debt_minutes).toBeGreaterThan(300);
    expect(now.need_basis).toBe('blended_average');
    expect(now.algorithm_version).toBe('sleep-debt.v2');
    expect(now.activation).toBe('accepted');
    const before = debt(off(nightly(360)));
    expect(before.state === 'available' && before.debt_minutes).toBe(0);
  });
  it('uses the owner-confirmed need when there is one', () => {
    const now = debt(on(nightly(360), { sleepNeedMinutes: 480 }));
    expect(now.state === 'available' && [now.need_basis, now.sleep_need_minutes]).toEqual(['owner_confirmed', 480]);
  });
  it('takes the need from the owner\'s earlier nights, shrunk toward eight hours and kept within six to ten', () => {
    const now = debt(on(nightly(360)));
    expect(now.state === 'available' && now.sleep_need_minutes).toBeCloseTo((14 * 480 + 29 * 360) / 43, 2);
    const never = debt(on(days(30, asleepAt(i => (i === 0 ? 400 : 120)))));
    expect(never.state === 'available' && never.sleep_need_minutes).toBeGreaterThanOrEqual(360);
  });
  it('gives a figure from ten of fourteen nights that include last night, scaled to the weight observed', () => {
    const missing = (set: readonly number[]) => debt(on(days(14, asleepAt(i => (set.includes(i) ? null : 420))), { sleepNeedMinutes: 480 }));
    const four = missing([2, 5, 8, 11]);
    expect(four.state === 'available' && four.debt_minutes).toBeCloseTo(630, 3);
    expect(four.state === 'available' && four.observed_nights).toBe(10);
    const five = missing([2, 5, 8, 11, 12]);
    expect(five.state).toBe('partial');
    expect(five.state === 'partial' && five).toMatchObject({ debt_minutes: null, observed_nights: 9 });
    const noLastNight = missing([0]);
    expect(noLastNight.state).toBe('partial');
  });
  it('is missing_sleep with no night in the window', () => {
    expect(debt(on(days(20, asleepAt(() => null))))).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
  it('repays a night above need at half rate, with the debt kept in recency weights', () => {
    const nights = (older: number, last: number, middle = 480) => days(14, asleepAt(i => (i === 5 ? older : i === 0 ? last : middle)));
    const fromLastNight = debt(on(nights(360, 600), { sleepNeedMinutes: 480 }));
    expect(fromLastNight.state === 'available' && fromLastNight.debt_minutes).toBeCloseTo(120 * (1 - 5 / 26) - 60, 3);
    const withNone = debt(on(nights(360, 480), { sleepNeedMinutes: 480 }));
    expect(withNone.state === 'available' && withNone.debt_minutes).toBeCloseTo(120 * (1 - 5 / 26), 3);
    expect(fromLastNight.state === 'available' && withNone.state === 'available' && fromLastNight.debt_minutes! > 0).toBe(true);
  });
  it('never takes the debt below zero, however long the night, and banks no credit against a later short night', () => {
    const huge = debt(on(days(14, asleepAt(i => (i === 5 ? 360 : i === 0 ? 900 : 480))), { sleepNeedMinutes: 480 }));
    expect(huge.state === 'available' && huge.debt_minutes).toBe(0);
    const creditFirst = debt(on(days(14, asleepAt(i => (i === 9 ? 900 : i === 5 ? 360 : 480))), { sleepNeedMinutes: 480 }));
    expect(creditFirst.state === 'available' && creditFirst.debt_minutes).toBeCloseTo(120 * (1 - 5 / 26), 3);
  });
});

describe('provisional scores: what stays as it was', () => {
  it('keeps the drivers on their fourteen-day rule', () => {
    const vitals = (i: number, breathing: number) => ({ breathingRate: breathing + wobble(i, 0.4), bloodOxygen: null, wristTemperature: [], awakeMinutes: null, walkingHeartRate: null });
    const run = (n: number) => days(n, i => ({ vitals: vitals(i, i === 0 ? 22 : 14) }));
    for (const n of [8, 14, 16, 30]) expect(on(run(n)).drivers).toEqual(off(run(n)).drivers);
    expect(on(run(8)).drivers).toEqual([]);
    expect(on(run(16)).drivers).toEqual(['breathing rate far above usual']);
  });
  it('moves a mature owner by only a few points', () => {
    const mature = days(30, i => ({ overnightHrv: [{ value: 40 + wobble(i, 5), method: 'rmssd' as const }] }));
    const now = on(mature, { sleepNeedMinutes: 480 }), before = off(mature, { sleepNeedMinutes: 480 });
    for (const pillar of ['recovery', 'form', 'weight'] as const) expect(Math.abs(available(now[pillar]).score - available(before[pillar]).score)).toBeLessThanOrEqual(6);
  });
  it('is the same for the same input', () => {
    expect(JSON.stringify(on(days(12)))).toBe(JSON.stringify(on(days(12))));
  });
});
