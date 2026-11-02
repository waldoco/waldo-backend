import { describe, expect, it } from 'vitest';
import { healthDayLoadV1Schema, healthFormCurveV1Schema, healthStressCurveV1Schema } from '../../contracts/src/app/health-ingest';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// What the producer writes of the day load, the Form curve and the stress curve: each behind its own switch, beside the scores,
// computed from the same readings and changing none of them. Synthetic owners only; the clock is 14:30 UTC on 20 March 2026.
const TODAY = '2026-03-20';
const NOW = Date.parse(`${TODAY}T14:30:00Z`);
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hour: number) => `${d}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, d: string, over: Sample): Sample => ({ signal, day: d, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const ZONES = { hr_zones: { seconds: [0, 1800, 1800, 0, 0] } };
const workout = (d: string, from: number, workoutDetail: Record<string, unknown> = ZONES, over: Sample = {}): Sample =>
  sample('workout', d, { start_at: at(d, from), end_at: at(d, from + 1), value: 60, activity: 'run', workout: workoutDetail, ...over });
type Shape = Readonly<{ nights: number; worn?: boolean; workouts?: (i: number) => Sample[]; hours?: number }>;
const dayOfReadings = (i: number, spec: Shape): Sample[] => {
  const d = day(i), through = i === 0 ? (spec.hours ?? 14) : 20;
  const worn = spec.worn !== false || i > 0;
  return [
    sample('sleep_duration', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
    sample('sleep_midpoint', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 180 + wobble(i, 15), method: 'sleep_midpoint' }),
    ...(worn ? [
      sample('overnight_hrv', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 55 + wobble(i, 6), method: 'rmssd' }),
      sample('resting_heart_rate', d, { start_at: at(d, 3), end_at: at(d, 4), value: 56 + wobble(i, 2) }),
    ] : []),
    ...Array.from({ length: Math.max(0, through - 4) }, (_, k) => 4 + k).flatMap(h => [
      ...(worn ? [sample('heart_rate_window', d, { start_at: at(d, h), end_at: at(d, h + 1), value: i % 2 === 0 ? 58 + (h % 2) : 62 - (h % 2) })] : []),
      sample('movement_duration', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 2 }),
      sample('daylight_duration', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 20 + wobble(h + i, 2) }),
    ]),
    ...(spec.workouts?.(i) ?? []),
  ];
};
const seriesOf = (spec: Shape) => ({
  access: 'granted', read_at: `${TODAY}T14:30:00.000123Z`,
  sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: spec.nights }, (_, i) => dayOfReadings(i, spec)).flat() }],
});
type Row = Record<string, any> & { day: string };
const rowsOf = async (spec: Shape, extra: Partial<ProducerDeps> = {}, series: unknown = seriesOf(spec), now = NOW): Promise<{ rows: Row[]; outcome: string }> => {
  const rows: Row[] = [];
  const typed = series as { sources: { samples: Sample[] }[] };
  const outcome = await produceHealthScores({
    readSeries: async range => (!Array.isArray(typed.sources) ? series : { ...typed, sources: typed.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
    compute: dailyScoresFor('1'), ...extra,
  }, { now, timezone: 'UTC' });
  return { rows, outcome };
};
const todayOf = (rows: Row[]) => rows.find(row => row.day === TODAY)!;
const yesterdayOf = (rows: Row[]) => rows.find(row => row.day === day(1))!;
// A workout on every even day, today included, 17:00 to 18:00 and so after the 14:30 read on today.
const evenDays: Shape = { nights: 25, workouts: i => (i % 2 === 0 ? [workout(day(i), 12)] : []) };
const without = ({ day_load: _l, form_curve: _f, stress_curve: _s, ...rest }: Row) => rest;

describe('producer: day load, Form curve and stress curve behind their switches', () => {
  it('writes exactly the rows it wrote before with all three switches off, and with them absent', async () => {
    const plain = (await rowsOf(evenDays)).rows;
    expect((await rowsOf(evenDays, { dayLoad: false, formCurve: false, stressCurve: false })).rows).toEqual(plain);
    expect(JSON.stringify(plain)).not.toMatch(/day_load|form_curve|stress_curve/);
    expect(plain).toHaveLength(2);
  });
  it('writes each key only for its own switch, and the rest of every row byte for byte as before', async () => {
    const plain = (await rowsOf(evenDays)).rows;
    for (const [extra, keys] of [
      [{ dayLoad: true }, ['day_load']], [{ formCurve: true }, ['form_curve']], [{ stressCurve: true }, ['stress_curve']],
      [{ dayLoad: true, formCurve: true, stressCurve: true }, ['day_load', 'form_curve', 'stress_curve']],
    ] as const) {
      const { rows } = await rowsOf(evenDays, extra);
      expect(rows.map(without)).toEqual(plain);
      expect(Object.keys(todayOf(rows)).filter(key => ['day_load', 'form_curve', 'stress_curve'].includes(key))).toEqual(keys);
    }
  });
  it('writes the curves for today only and the day load for today and yesterday', async () => {
    const { rows } = await rowsOf(evenDays, { dayLoad: true, formCurve: true, stressCurve: true });
    expect(Object.keys(yesterdayOf(rows)).filter(key => ['day_load', 'form_curve', 'stress_curve'].includes(key))).toEqual(['day_load']);
    expect(rows.map(row => row.day).sort()).toEqual([day(1), TODAY]);
  });
  it('never changes a pillar: each is the object it was', async () => {
    const plain = (await rowsOf(evenDays)).rows, all = (await rowsOf(evenDays, { dayLoad: true, formCurve: true, stressCurve: true })).rows;
    for (const [i, row] of all.entries()) for (const pillar of ['recovery', 'form', 'weight', 'sleep_debt', 'drivers', 'windows']) expect(row[pillar], `${row.day} ${pillar}`).toEqual(plain[i]![pillar]);
  });

  describe('day load', () => {
    it('is the load of today\'s workout, with the band of the owner\'s own days', async () => {
      const { rows } = await rowsOf(evenDays, { dayLoad: true });
      const load = todayOf(rows).day_load;
      expect(healthDayLoadV1Schema.safeParse(load).success).toBe(true);
      // 30 minutes in zone 2 and in zone 3 is 150, so ln(151) / ln(601) is 78.4. Of the 24 earlier observed days, the 12 even ones
      // score 78.4 and the 12 odd ones are rest days at 0: mean 39.2, spread 39.2.
      expect(load).toEqual({
        state: 'available', version: 'day-load.candidate.v1', activation: 'candidate_unaccepted', score: 78.4, method: 'hr_zones', approximate: false, window_days: 28,
        band: { state: 'personal', low: 0, centre: 39.2, high: 78.4, own_days: 24, days_until_personal: 0 }, direction: 'usual',
      });
    });
    it('reads yesterday\'s rest day as 0 against its own earlier days', async () => {
      const load = yesterdayOf((await rowsOf(evenDays, { dayLoad: true })).rows).day_load;
      expect(healthDayLoadV1Schema.safeParse(load).success).toBe(true);
      // 23 earlier observed days: 12 even ones at 78.4 and 11 odd ones at 0, so the mean is 12 x 78.4 / 23 = 40.9 and the spread is
      // 78.4 x sqrt(12/23 x 11/23) = 39.2, which puts the band's low edge at 1.7, above a rest day's 0.
      expect(load).toMatchObject({ score: 0, band: { state: 'personal', low: 1.7, centre: 40.9, high: 80.1, own_days: 23 }, direction: 'below_usual' });
    });
    it('counts a session once when two apps hold a copy of it', async () => {
      const copy = (d: string) => [workout(d, 12), workout(d, 12, { hr_zones: { seconds: [0, 1800, 1800, 0, 0] } }, { start_at: at(d, 12), end_at: at(d, 13) })];
      const { rows } = await rowsOf({ nights: 25, workouts: i => (i === 0 ? copy(day(0)) : []) }, { dayLoad: true });
      expect(todayOf(rows).day_load.score).toBe(78.4);
    });
    it('labels zones set from an observed peak as approximate, and falls to minutes when a workout has no zones', async () => {
      const peak = (d: string) => workout(d, 12, { hr_zones: { seconds: [0, 1800, 1800, 0, 0], basis: 'observed_workout_peak' } });
      expect(todayOf((await rowsOf({ nights: 25, workouts: i => (i === 0 ? [peak(day(0))] : []) }, { dayLoad: true })).rows).day_load).toMatchObject({ method: 'hr_zones_observed_peak', approximate: true, score: 78.4 });
      const plain = (await rowsOf({ nights: 25, workouts: i => (i === 0 ? [workout(day(0), 12)] : i === 3 ? [workout(day(3), 12, {})] : []) }, { dayLoad: true })).rows;
      expect(todayOf(plain).day_load).toMatchObject({ method: 'minutes', approximate: false });
    });
    it('scores a worn day with no workout as 0, and has no band until fourteen observed days', async () => {
      const { rows } = await rowsOf({ nights: 6 }, { dayLoad: true });
      expect(todayOf(rows).day_load).toMatchObject({ score: 0, band: { state: 'provisional', own_days: 5, days_until_personal: 9 }, direction: null });
    });
    it('has no load for a day no worn sensor saw, and is never a low score', async () => {
      const { rows } = await rowsOf({ nights: 25, worn: false }, { dayLoad: true });
      expect(todayOf(rows).day_load).toEqual({ state: 'unavailable', reason: 'no_readings' });
      expect(healthDayLoadV1Schema.safeParse(todayOf(rows).day_load).success).toBe(true);
    });
  });

  describe('Form curve', () => {
    it('ends on the row\'s Form, under the Form version, and is what the contract reads', async () => {
      const { rows } = await rowsOf(evenDays, { formCurve: true });
      const today = todayOf(rows);
      expect(healthFormCurveV1Schema.safeParse(today.form_curve).success).toBe(true);
      expect(today.form_curve.version).toBe(today.form.algorithm_version);
      expect(today.form_curve.points.at(-1)).toEqual({ at: at(TODAY, 14), score: today.form.score, kind: 'measured' });
    });
    it('writes no curve when Form is unavailable', async () => {
      const { rows } = await rowsOf({ nights: 25, hours: 8 }, { formCurve: true });
      expect(todayOf(rows).form).toHaveProperty('reason');
      expect(todayOf(rows)).not.toHaveProperty('form_curve');
    });
  });

  describe('stress curve', () => {
    it('is the hours of today against the same hours of the earlier days, and what the contract reads', async () => {
      const { rows } = await rowsOf(evenDays, { stressCurve: true });
      const curve = todayOf(rows).stress_curve;
      expect(healthStressCurveV1Schema.safeParse(curve).success).toBe(true);
      expect(curve.hours.map((hour: { at: string }) => hour.at)).toEqual(Array.from({ length: 7 }, (_, k) => at(TODAY, 7 + k)));
      expect(curve.hours.some((hour: { value: number | null }) => hour.value !== null)).toBe(true);
    });
    it('writes none for an owner without seven earlier days of those hours, so nothing is a zero', async () => {
      const { rows } = await rowsOf({ nights: 6 }, { stressCurve: true });
      expect(todayOf(rows)).not.toHaveProperty('stress_curve');
    });
  });

  describe('when the owner has no health to read', () => {
    it('writes nothing for a revoked or unlinked owner, switches on or off', async () => {
      for (const series of [{ access: 'consent_withdrawn', read_at: `${TODAY}T14:30:00.000123Z`, sources: [] }, { error: 'not_linked' }]) {
        const { rows, outcome } = await rowsOf({ nights: 25 }, { dayLoad: true, formCurve: true, stressCurve: true }, series as never);
        expect(rows).toEqual([]);
        expect(outcome).toBe('no_consent');
      }
    });
    it('writes no day load, no curve and no row for an owner with no readings at all', async () => {
      const { rows, outcome } = await rowsOf({ nights: 0 }, { dayLoad: true, formCurve: true, stressCurve: true }, { access: 'granted', read_at: `${TODAY}T14:30:00.000123Z`, sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: [] }] });
      expect(rows).toEqual([]);
      expect(outcome).toBe('no_readings');
    });
  });

  it('writes a full day\'s row with every switch on well within the writer\'s limit of 32 KiB', async () => {
    const spec: Shape = { ...evenDays, hours: 24 };
    const full = { ...seriesOf(spec), read_at: `${TODAY}T23:30:00.000123Z` };
    const { rows } = await rowsOf(spec, { dayLoad: true, formCurve: true, stressCurve: true, scoreParts: true, usual: true, trainingLoad: true }, full, Date.parse(`${TODAY}T23:30:00Z`));
    expect(todayOf(rows).form_curve.points.length).toBeGreaterThan(40);
    expect(new TextEncoder().encode(JSON.stringify(todayOf(rows))).length).toBeLessThan(20_000);
  });
  it('writes no row larger than the writer takes, with every switch and every other column on', async () => {
    const { rows } = await rowsOf(evenDays, { dayLoad: true, formCurve: true, stressCurve: true, scoreParts: true, usual: true, trainingLoad: true });
    for (const row of rows) expect(new TextEncoder().encode(JSON.stringify(row)).length, row.day).toBeLessThan(20_000);
  });
});
