import { afterEach, describe, expect, it, vi } from 'vitest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';
import * as curveModule from '../src/health/scores/form-curve';

// Today's measured Form curve on the derived row, behind the producer's formCurve switch. Every value is synthetic.
const NOW = Date.parse('2026-03-20T14:30:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T14:30:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
// Asleep 23:00 to 07:00, then an hourly window of heart rate, movement and daylight for each hour that has ended.
const dayOfReadings = (day: string, i: number, hours: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 180, method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + wobble(i, 2) }),
  ...Array.from({ length: hours }, (_, hour) => [
    sample('heart_rate_window', day, { start_at: at(day, hour), end_at: at(day, hour + 1), value: 70 + wobble(hour + i, 2) }),
    sample('movement_duration', day, { start_at: at(day, hour), end_at: at(day, hour + 1), value: 12 + wobble(hour + i, 2) }),
    sample('daylight_duration', day, { start_at: at(day, hour), end_at: at(day, hour + 1), value: 20 + wobble(hour + i, 2) }),
  ]).flat(),
];
// Today read at 14:30 holds the hours 0 to 14; the days before it are whole.
const series = (nights = 20) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, i === 0 ? 15 : 24)).flat() }],
});
type Row = Record<string, any>;
const written = async (formCurve: boolean | undefined, samples = series(), flag: string | undefined = '1', readCurves?: () => Promise<unknown>): Promise<Row[]> => {
  const rows: Row[] = [];
  await produceHealthScores({
    readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
    compute: dailyScoresFor(flag),
    ...(formCurve === undefined ? {} : { formCurve }),
    ...(readCurves ? { readCurves } : {}),
  }, { now: NOW, timezone: 'UTC' });
  return rows;
};
afterEach(() => { vi.restoreAllMocks(); });

describe('the derived row: today\'s measured Form curve', () => {
  it('writes the curve on today\'s row only, in the row Form\'s own version, ending on the row\'s Form score', async () => {
    const rows = await written(true);
    const today = rows.find(r => r.day === TODAY)!, yesterday = rows.find(r => r.day === addDays(TODAY, -1))!;
    expect(today.form.score).toEqual(expect.any(Number));
    expect(Object.keys(today.form_curve).sort()).toEqual(['points', 'version']);
    expect(today.form_curve.version).toBe(today.form.algorithm_version);
    expect(today.form_curve.points.at(-1)).toEqual({ at: at(TODAY, 14), score: today.form.score, kind: 'measured' });
    expect('form_curve' in yesterday).toBe(false);
  });
  // Form needs eight hours of the day behind it, so the curve starts an hour after this owner's 07:00 wake.
  it('writes measured points only, a quarter of an hour apart from the first hour Form could be read, at most ninety-six', async () => {
    const { points } = (await written(true)).find(r => r.day === TODAY)!.form_curve as { points: { at: string; score: number; kind: string }[] };
    expect(points[0]!.at).toBe(at(TODAY, 8));
    expect(points.length).toBe(25);
    expect(points.length).toBeLessThanOrEqual(96);
    points.slice(1).forEach((point, k) => expect(Date.parse(point.at) - Date.parse(points[k]!.at)).toBe(900_000));
    for (const point of points) {
      expect(Object.keys(point).sort()).toEqual(['at', 'kind', 'score']);
      expect(point.kind).toBe('measured');
      expect(point.score).toBeGreaterThanOrEqual(0);
      expect(point.score).toBeLessThanOrEqual(100);
    }
  });
  it('writes the curve with the earlier engine too, in that engine\'s version', async () => {
    const today = (await written(true, series(), '0')).find(r => r.day === TODAY)!;
    expect(today.form_curve.version).toBe('form.candidate.v8');
    expect(today.form_curve.points.at(-1).score).toBe(today.form.score);
  });
  it('writes no curve with the switch off or absent, and the rest of the row is the same row', async () => {
    const on = await written(true);
    for (const off of [await written(false), await written(undefined)]) {
      for (const row of off) expect('form_curve' in row).toBe(false);
      expect(off).toEqual(on.map(({ form_curve: _curve, ...row }) => row));
    }
  });
  it('writes no curve when today\'s Form is unavailable', async () => {
    const today = (await written(true, series(1))).find(r => r.day === TODAY);
    expect(today === undefined || !('form_curve' in today)).toBe(true);
  });
  it('still writes the row, without a curve, when the curve cannot be computed, and logs no value', async () => {
    vi.spyOn(curveModule, 'formCurve').mockImplementation(() => { throw new Error('synthetic curve failure 71.5'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const today = (await written(true)).find(r => r.day === TODAY)!;
    expect(today.form.score).toEqual(expect.any(Number));
    expect('form_curve' in today).toBe(false);
    expect(errors.mock.calls).toEqual([['health form curve failed']]);
  });
  it('fits the writer\'s payload limit with a full day\'s curve', async () => {
    const late = Date.parse('2026-03-20T23:30:00Z');
    const samples = { ...series(), read_at: '2026-03-20T23:30:00.000123Z', sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 20 }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, i === 0 ? 23 : 24)).flat() }] };
    const payloads: string[] = [];
    await produceHealthScores({
      readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => { payloads.push(payload); return { written: true }; },
      compute: dailyScoresFor('1'), formCurve: true, trainingLoad: true,
    }, { now: late, timezone: 'UTC' });
    const today = payloads.find(payload => (JSON.parse(payload) as Row).day === TODAY)!;
    expect((JSON.parse(today) as Row).form_curve.points.length).toBeGreaterThan(60);
    expect(new TextEncoder().encode(today).length).toBeLessThan(16_384);
  });
});

// The projected points: the earlier days' stored curves come from the health store's own read, and the measured part is untouched.
describe('the derived row: today\'s projected Form curve', () => {
  // Each earlier day woke at 07:00 and holds a measured point every quarter hour to 22:00, climbing a point an hour.
  const heldCurves = (n: number) => ({ curves: Array.from({ length: n }, (_, k) => ({ day: addDays(TODAY, -(k + 1)),
    points: Array.from({ length: 61 }, (_, slot) => ({ at: new Date(Date.parse(at(addDays(TODAY, -(k + 1)), 7)) + slot * 900_000).toISOString(), score: 50 + Math.floor(slot / 4), kind: 'measured' })) })) });
  const todayOf = async (readCurves?: () => Promise<unknown>) => (await written(true, series(), '1', readCurves)).find(r => r.day === TODAY)!;

  it('follows the measured points with projected ones, in the projection\'s version, and leaves the measured part as it was', async () => {
    const plain = await todayOf(), projected = await todayOf(async () => heldCurves(10));
    expect(projected.form_curve.version).toBe('form-curve.v1');
    const points = projected.form_curve.points as { at: string; score: number; kind: string }[];
    const measured = points.filter(point => point.kind === 'measured');
    expect(measured).toEqual(plain.form_curve.points);
    expect(measured.at(-1)).toEqual({ at: at(TODAY, 14), score: projected.form.score, kind: 'measured' });
    const after = points.slice(measured.length);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every(point => point.kind === 'projected')).toBe(true);
    expect(after[0]!.at).toBe('2026-03-20T14:15:00.000Z');
    // Fifteen hours after a 07:00 wake is where every earlier day's curve ends, and before the usual 23:00 sleep start.
    expect(after.at(-1)!.at).toBe(at(TODAY, 22));
    // An hour on, the earlier days had each climbed a point.
    expect(after.find(point => point.at === at(TODAY, 15))!.score).toBe(projected.form.score + 1);
    points.slice(1).forEach((point, k) => expect(Date.parse(point.at) - Date.parse(points[k]!.at)).toBe(900_000));
    expect(points.length).toBeLessThanOrEqual(96);
    const { form_curve: _a, ...restProjected } = projected, { form_curve: _b, ...restPlain } = plain;
    expect(restProjected).toEqual(restPlain);
  });
  it('writes the measured curve alone, in the Form\'s own version, when fewer than seven earlier days hold a curve', async () => {
    const plain = await todayOf();
    for (const held of [heldCurves(6), { curves: [] }]) expect((await todayOf(async () => held)).form_curve).toEqual(plain.form_curve);
  });
  it('writes the measured curve alone when the stored curves cannot be read or do not read as curves', async () => {
    const plain = await todayOf();
    for (const answer of [null, { error: 'not_linked' }, { curves: 'synthetic' }, { curves: [{ day: 'yesterday', points: [] }, { day: addDays(TODAY, -1), points: 'none' }] }]) {
      expect((await todayOf(async () => answer)).form_curve, JSON.stringify(answer)).toEqual(plain.form_curve);
    }
    expect((await todayOf(async () => { throw new Error('synthetic read failure'); })).form_curve).toEqual(plain.form_curve);
  });
  it('keeps the measured curve when the projection cannot be computed, and logs no value', async () => {
    const plain = await todayOf();
    vi.spyOn(curveModule, 'formProjection').mockImplementation(() => { throw new Error('synthetic projection failure 71.5'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await todayOf(async () => heldCurves(10))).form_curve).toEqual(plain.form_curve);
    expect(errors.mock.calls).toEqual([['health form projection failed']]);
  });
  it('never asks for the stored curves with the switch off, or when today has no curve', async () => {
    let asked = 0;
    const read = async () => { asked += 1; return heldCurves(10); };
    await written(false, series(), '1', read);
    await written(true, series(1), '1', read);
    expect(asked).toBe(0);
  });
});
