import { describe, expect, it } from 'vitest';
import { healthDayLoadV1Schema } from '../../contracts/src/app/health-ingest';
import { passiveLoadSources, produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// What the producer writes of the passive day load: v2 for a listed phone source beside HEALTH_DAY_LOAD, v1 otherwise, the rest of
// every row unchanged. Synthetic owners only; the clock is 14:30 UTC on 20 March 2026. Each day: asleep 23:00-07:00 at 55 bpm,
// awake hours sitting at 70-80 with a stand-up minute at 95 and 100 steps; hourly maxima 160, and 190, 188, 186 on days 1-3.
const TODAY = '2026-03-20';
const NOW = Date.parse(`${TODAY}T14:30:00Z`);
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hour: number) => `${d}T${String(hour).padStart(2, '0')}:00:00.000Z`;
type Sample = Record<string, unknown>;
const sample = (signal: string, d: string, over: Sample): Sample => ({ signal, day: d, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const PEAK: Readonly<Record<number, number>> = { 1: 190, 2: 188, 3: 186 };
type Shape = Readonly<{ resting?: boolean; movement?: boolean; bins?: boolean }>;
const dayOf = (i: number, shape: Shape): Sample[] => {
  const d = day(i), through = i === 0 ? 15 : 24;
  const hours = Array.from({ length: through }, (_, h) => h);
  return [
    sample('sleep_duration', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 480, method: 'asleep_duration' }),
    sample('sleep_midpoint', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 180, method: 'sleep_midpoint' }),
    sample('overnight_hrv', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 55, method: 'rmssd' }),
    ...(shape.resting === false ? [] : [sample('resting_heart_rate', d, { start_at: at(d, 3), end_at: at(d, 4), value: 56 })]),
    ...hours.flatMap(h => [
      sample('heart_rate_window', d, { start_at: at(d, h), end_at: at(d, h + 1), value: h < 7 ? 55 : 74, max: h === 12 && PEAK[i] ? PEAK[i] : h < 7 ? 60 : 160 }),
      ...(shape.movement === false ? [] : [sample('movement_duration', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 2 })]),
      sample('steps_window', d, { start_at: at(d, h), end_at: at(d, h + 1), value: h < 7 ? 0 : 100 }),
      ...(shape.bins === false ? [] : [sample('heart_rate_bins_window', d, {
        start_at: at(d, h), end_at: at(d, h + 1), value: 3600,
        bins: h < 7 ? { from_bpm: 55, outside_workouts: [3600], in_workouts: [0] } : { from_bpm: 70, outside_workouts: [1140, 1800, 600, 0, 0, 60], in_workouts: [0, 0, 0, 0, 0, 0] },
      })]),
    ]),
  ];
};
const seriesOf = (source: string, shape: Shape = {}) => ({
  access: 'granted', read_at: `${TODAY}T14:30:00.000123Z`,
  sources: [{ source, consent_epoch: 3, truncated: false, samples: Array.from({ length: 26 }, (_, i) => dayOf(i, shape)).flat() }],
});
type Row = Record<string, any> & { day: string };
const rowsOf = async (extra: Partial<ProducerDeps>, series: ReturnType<typeof seriesOf> = seriesOf('apple'), failBins = false) => {
  const rows: Row[] = [], asked: string[][] = [];
  await produceHealthScores({
    readSeries: async range => {
      asked.push([...range.signals]);
      if (failBins && range.signals.includes('heart_rate_bins_window')) throw new Error('read failed');
      return { ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) };
    },
    writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
    compute: dailyScoresFor('1'), ...extra,
  }, { now: NOW, timezone: 'UTC' });
  return { rows, asked, today: rows.find(row => row.day === TODAY)! };
};
const without = ({ day_load: _l, ...rest }: Row) => rest;

describe('the HEALTH_PASSIVE_LOAD switch value', () => {
  it('is off for "0", empty or unset, and lists only phone transports', () => {
    expect(passiveLoadSources('0')).toEqual([]);
    expect(passiveLoadSources('')).toEqual([]);
    expect(passiveLoadSources(undefined)).toEqual([]);
    expect(passiveLoadSources('apple')).toEqual(['apple']);
    expect(passiveLoadSources(' apple , health_connect,samsung ')).toEqual(['apple', 'health_connect', 'samsung']);
    expect(passiveLoadSources('whoop,1,apple')).toEqual(['apple']);
  });
});

describe('producer: the passive day load', () => {
  it('writes a v2 load for a listed source, with its parts and that day\'s v1 load beside it, and every other key as before', async () => {
    const v1 = await rowsOf({ dayLoad: true }), v2 = await rowsOf({ dayLoad: true, passiveLoad: ['apple'] });
    const { v1: stored, ...served } = v2.today.day_load;
    expect(served).toMatchObject({ version: 'day-load.candidate.v2', method: 'hr_zones_observed_peak', approximate: true, parts: { passive: { state: 'available', observed_hours: 15 } } });
    expect(healthDayLoadV1Schema.safeParse(served).success).toBe(true);
    expect(stored).toEqual(v1.today.day_load);
    expect(v2.rows.map(without)).toEqual(v1.rows.map(without));
    expect(v2.asked).toContainEqual(['heart_rate_bins_window', 'steps_window']);
  });
  it('writes exactly v1 for a source that is not listed, and reads no bins with HEALTH_DAY_LOAD off', async () => {
    const v1 = await rowsOf({ dayLoad: true });
    expect((await rowsOf({ dayLoad: true, passiveLoad: ['samsung'] })).rows).toEqual(v1.rows);
    const off = await rowsOf({ passiveLoad: ['apple'] });
    expect(off.today.day_load).toBeUndefined();
    expect(off.asked.flat()).not.toContain('heart_rate_bins_window');
  });
  it('writes v1 when the bins cannot be read, claiming nothing about a passive part', async () => {
    const v1 = await rowsOf({ dayLoad: true });
    expect((await rowsOf({ dayLoad: true, passiveLoad: ['apple'] }, seriesOf('apple'), true)).rows).toEqual(v1.rows);
  });
  it('writes v1 with the reason when the source sent no bins', async () => {
    const { today } = await rowsOf({ dayLoad: true, passiveLoad: ['apple'] }, seriesOf('apple', { bins: false }));
    expect(today.day_load).toMatchObject({ version: 'day-load.candidate.v1', parts: { passive: { state: 'unavailable', reason: 'no_bins' } } });
  });
  it('reads Samsung\'s day with no resting heart rate and no movement minutes the same way', async () => {
    const { today } = await rowsOf({ dayLoad: true, passiveLoad: ['samsung'] }, seriesOf('samsung', { resting: false, movement: false }));
    expect(today.day_load).toMatchObject({ version: 'day-load.candidate.v2', parts: { passive: { state: 'available' } } });
  });
});
