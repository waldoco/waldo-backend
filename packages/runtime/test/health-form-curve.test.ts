import { describe, expect, it } from 'vitest';
import { formCurveRow } from '../src/health/scores/form-curve';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScoresInput, DayRecord, FormResult, HourlyBucket } from '../src/health/scores/types';

// Today's measured Form curve and the stress trend word. Every value is synthetic.
const TARGET = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
const at = (day: string, hour: number, minute = 0) => new Date(Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000).toISOString();

type Shape = (hour: number) => Partial<HourlyBucket>;
const bucket = (day: string, hour: number, i: number, shape: Shape = () => ({})): HourlyBucket => ({
  startAt: at(day, hour), heartRate: 70 + wobble(hour + i, 2), hrv: 50 + wobble(hour + i, 3), hrvMethod: 'rmssd',
  daylightMinutes: 20 + wobble(hour + i, 2), movementMinutes: 12 + wobble(hour + i, 2), activeEnergyKcal: null, ...shape(hour),
});
// Asleep from 22:00 the evening before to 08:00, so a day holds eight night hours before its wake. `through` is the first
// hour with no bucket: a day read at 14:30 holds buckets for hours 0 to 14.
const day = (i: number, through = 24, shape: Shape = () => ({}), zone = 'UTC'): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: zone,
    sleep: { startAt: at(addDays(d, -1), 22), endAt: at(d, 8), asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: [{ value: 55 + wobble(i, 6), method: 'rmssd' }], restingHeartRate: [{ value: 56 + wobble(i, 2), method: 'overnight_resting' }],
    hourly: Array.from({ length: through }, (_, hour) => bucket(d, hour, i, shape)), workouts: [], demand: null,
  };
};
const week = (today: DayRecord, nights = 20): DayRecord[] => [today, ...Array.from({ length: nights }, (_, k) => day(k + 1))];
const inputOf = (days: DayRecord[], asOf: string, over: Partial<DailyScoresInput> = {}): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: null, asOf, provisional: true, ...over });
const rowFormOf = (input: DailyScoresInput): FormResult => computeDailyScores(input).form;
const curveOf = (input: DailyScoresInput) => formCurveRow(input, rowFormOf(input));
const score = (form: FormResult): number => { if (form.state !== 'available') throw new Error('form unavailable'); return form.score; };

describe('the measured Form curve', () => {
  const input = inputOf(week(day(0, 15)), at(TARGET, 14, 30));

  it('has its latest point equal to the Form score of the row, at the last whole hour', () => {
    const curve = curveOf(input)!;
    const last = curve.form_curve.points.at(-1)!;
    expect(last).toEqual({ at: at(TARGET, 14), score: score(rowFormOf(input)), kind: 'measured' });
  });
  it('starts at the wake and steps every fifteen minutes to the last whole hour', () => {
    const { points } = curveOf(input)!.form_curve;
    expect(points[0]!.at).toBe(at(TARGET, 8));
    expect(points.length).toBe(25);
    points.slice(1).forEach((point, k) => expect(Date.parse(point.at) - Date.parse(points[k]!.at)).toBe(900_000));
    expect(points.every(point => point.kind === 'measured')).toBe(true);
  });
  it('repeats the last value between hours, never interpolates, and moves only when an hour has ended', () => {
    const { points } = curveOf(input)!.form_curve;
    for (let hourStart = 0; hourStart + 3 < points.length; hourStart += 4) {
      const [a, b, c, d] = points.slice(hourStart, hourStart + 4).map(point => point.score);
      expect([b, c, d]).toEqual([a, a, a]);
    }
    expect(new Set(points.map(point => point.score)).size).toBeGreaterThan(1);
  });
  it('is the score of Form on the hours that had ended, as the row would have read them then', () => {
    const { points } = curveOf(input)!.form_curve;
    const at1100 = score(rowFormOf(inputOf(week(day(0, 11)), at(TARGET, 11, 0))));
    expect(points.find(point => point.at === at(TARGET, 11))!.score).toBe(at1100);
  });
  it('leaves out the hour still filling when the read falls inside it', () => {
    const { points } = curveOf(input)!.form_curve;
    expect(points.some(point => Date.parse(point.at) > Date.parse(at(TARGET, 14)))).toBe(false);
  });
  it('names the version of the Form on the row, for either engine', () => {
    expect(curveOf(input)!.form_curve.version).toBe('form.v9');
    const earlier = inputOf(week(day(0, 15)), at(TARGET, 14, 30), { provisional: false });
    expect(curveOf(earlier)!.form_curve.version).toBe('form.candidate.v8');
    expect(curveOf(earlier)!.form_curve.points.at(-1)!.score).toBe(score(rowFormOf(earlier)));
  });
  it('is the whole day when the read comes after it ended, at most ninety-six points', () => {
    const full = inputOf(week(day(0, 24)), at(addDays(TARGET, 1), 0, 30));
    const { points } = curveOf(full)!.form_curve;
    expect(points.at(-1)!).toEqual({ at: at(addDays(TARGET, 1), 0), score: score(rowFormOf(full)), kind: 'measured' });
    expect(points.length).toBeLessThanOrEqual(96);
  });
  it('starts later than the wake when Form was not yet available at it, and leaves those fifteen minutes out', () => {
    const late = inputOf(week({ ...day(0, 15), hourly: day(0, 15).hourly.filter(b => Date.parse(b.startAt) >= Date.parse(at(TARGET, 4))) }), at(TARGET, 14, 30));
    const { points } = curveOf(late)!.form_curve;
    expect(Date.parse(points[0]!.at)).toBeGreaterThan(Date.parse(at(TARGET, 8)));
    expect(points[0]!.at).toBe(at(TARGET, 12));
  });
  it('lands on quarter-hours of the owner\'s own clock in a zone off the hour', () => {
    const zone = 'Asia/Kolkata';
    const shifted = (i: number, through: number): DayRecord => {
      const d = day(i, through, () => ({}), zone);
      const local = Date.parse(`${d.day}T00:00:00Z`) - 330 * 60_000;
      return { ...d, sleep: { ...d.sleep!, startAt: new Date(local - 2 * 3_600_000).toISOString(), endAt: new Date(local + 8 * 3_600_000).toISOString() },
        hourly: d.hourly.map((b, hour) => ({ ...b, startAt: new Date(local + hour * 3_600_000).toISOString() })) };
    };
    const asOf = new Date(Date.parse(`${TARGET}T00:00:00Z`) - 330 * 60_000 + (14 * 60 + 30) * 60_000).toISOString();
    const zoned = inputOf([shifted(0, 15), ...Array.from({ length: 20 }, (_, k) => shifted(k + 1, 24))], asOf);
    const { points } = curveOf(zoned)!.form_curve;
    expect(points.every(point => Date.parse(point.at) % 900_000 === 0)).toBe(true);
    expect(points.at(-1)!.score).toBe(score(rowFormOf(zoned)));
    expect(points.at(-1)!.at).toBe(new Date(Date.parse(`${TARGET}T00:00:00Z`) - 330 * 60_000 + 14 * 3_600_000).toISOString());
  });
  it('is no curve when the row has no Form, or the row names a method this engine would not have run, or the last point disagrees', () => {
    expect(formCurveRow(input, { state: 'unavailable', reason: 'stale_inputs' })).toBeNull();
    const form = rowFormOf(input);
    if (form.state !== 'available') throw new Error('form unavailable');
    expect(formCurveRow(input, { ...form, algorithm_version: 'form.v10' })).toBeNull();
    expect(formCurveRow(input, { ...form, score: form.score + 1 })).toBeNull();
  });
  it('is no curve with no wake to start from', () => {
    const noWake = inputOf(week({ ...day(0, 15), sleep: null }), at(TARGET, 14, 30));
    expect(formCurveRow(noWake, rowFormOf(input))).toBeNull();
  });
  it('is no curve for a day other than the one asked for, or with no access', () => {
    expect(formCurveRow({ ...input, targetDay: addDays(TARGET, -1) }, rowFormOf(input))).toBeNull();
    expect(formCurveRow({ ...input, access: 'consent_withdrawn' }, rowFormOf(input))).toBeNull();
  });
});

describe('the stress trend', () => {
  // Read at 22:30, so the last three whole hours end at 20:00, 21:00 and 22:00 with the owner awake for a dozen hours or more.
  // Heart rate and variability sit at the owner's usual level except where a case moves one of them, so each case moves
  // the stress reading one way only. The first of the three hours sets the level; the two steps are the hours after it.
  const READ = at(TARGET, 22, 30);
  const trendOf = (shape: Shape, over: Partial<DailyScoresInput> = {}) => curveOf(inputOf(week(day(0, 23, shape)), READ, over))?.stress_trend;
  const usual: Shape = () => ({ heartRate: 70, hrv: 50 });
  const pulse = (...above: readonly number[]): Shape => hour => ({ ...usual(hour), ...(hour >= 19 && hour <= 21 ? { heartRate: 70 + above[hour - 19]! } : {}) });
  const variability = (...above: readonly number[]): Shape => hour => ({ ...usual(hour), ...(hour >= 19 && hour <= 21 ? { hrv: 50 + above[hour - 19]! } : {}) });
  it('is rising when the stress reading is worse at both of the last two steps', () => {
    expect(trendOf(pulse(2, 4, 6))).toBe('rising');
  });
  it('is easing when it is better at both', () => {
    expect(trendOf(pulse(-2, -4, -6))).toBe('easing');
  });
  it('is steady when the two steps disagree', () => {
    expect(trendOf(pulse(0, 6, -6))).toBe('steady');
    expect(trendOf(pulse(0, -6, 6))).toBe('steady');
  });
  it('is steady when nothing moved', () => {
    expect(trendOf(usual)).toBe('steady');
  });
  it('reads a lower heart-rate variability as worse, as the method does', () => {
    expect(trendOf(variability(-3, -6, -9))).toBe('rising');
    expect(trendOf(variability(3, 6, 9))).toBe('easing');
  });
  it('is steady when the stress reading cannot be computed at one of the three hours', () => {
    const early = inputOf(week(day(0, 15)), at(TARGET, 14, 30));
    expect(curveOf(early)!.stress_trend).toBe('steady');
    expect(curveOf(early)!.form_curve.points.length).toBeGreaterThan(0);
    const dark: Shape = hour => ({ ...usual(hour), ...(hour >= 19 ? { heartRate: null, hrv: null } : {}) });
    expect(trendOf(dark)).toBe('steady');
  });
  it('is paired with the curve: no curve, no word', () => {
    expect(formCurveRow(inputOf(week(day(0, 23)), READ), { state: 'unavailable', reason: 'stale_inputs' })).toBeNull();
  });
});
