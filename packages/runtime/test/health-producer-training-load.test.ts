import { describe, expect, it } from 'vitest';
import { parseSeries, produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';

// The producer's candidate training load (ADR-0081 amendment of 31 Oct 2026, §2). Every value here is synthetic.
const NOW = Date.parse('2026-03-30T12:00:00Z');
const TODAY = '2026-03-30';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Sample = Record<string, unknown>;
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
// An hour of heart rate: the day was observed, whether or not it held a workout.
const worn = (day: string): Sample => ({ signal: 'heart_rate_window', day, start_at: at(day, 9), end_at: at(day, 10), utc_offset_minutes: 0, timezone: 'UTC', value: 70, min: 60, max: 90, n_samples: 20 });
const workout = (day: string, minutes: number, workoutDetail?: Sample): Sample =>
  ({ signal: 'workout', day, start_at: at(day, 6), end_at: at(day, 7), utc_offset_minutes: 0, timezone: 'UTC', value: minutes, activity: 'running', ...(workoutDetail ? { workout: workoutDetail } : {}) });
const zones = (seconds: number[]) => ({ hr_zones: { basis: 'heart_rate_reserve', lower_bounds_bpm: [120, 136, 151, 166], seconds } });

// 28 observed days: an easy session every day of the usual, a harder one every day this week, same minutes.
const month = (detail: (day: string, thisWeek: boolean) => Sample | undefined): Sample[] => Array.from({ length: 31 }, (_, i) => addDays(TODAY, -i)).flatMap((day, i) => [
  worn(day), workout(day, 40, detail(day, i < 7)),
]);
const seriesOf = (samples: Sample[], source = 'apple') => ({ access: 'granted', read_at: '2026-03-30T12:00:00.000000Z', sources: [{ source, consent_epoch: 3, truncated: false, samples }] });

const run = async (series: unknown, extra: Partial<ProducerDeps> = {}) => {
  const writes: Record<string, unknown>[] = [];
  const deps: ProducerDeps = {
    readSeries: async range => {
      const body = series as { sources: { samples: Sample[] }[] };
      return { ...body, sources: body.sources.map(s => ({ ...s, samples: s.samples.filter(entry => range.signals.includes(String(entry.signal))) })) };
    },
    writeContext: async payload => { writes.push(JSON.parse(payload)); return { written: true }; },
    compute: computeDailyScores,
    ...extra,
  };
  await produceHealthScores(deps, { now: NOW, timezone: 'UTC' });
  return writes;
};

describe('producer: candidate training load', () => {
  it('reads a workout\'s zones and effort from the series, and drops a part that is not the contract\'s shape', () => {
    const parsed = parseSeries(seriesOf([
      workout(TODAY, 40, { ...zones([600, 600, 600, 600, 0]), effort: { score: 6, method: 'rated' }, distance_m: 8000 }),
      workout(TODAY, 30, { hr_zones: { seconds: [1, 2, 3] }, effort: { score: 12, method: 'rated' } }),
      worn(TODAY),
    ]));
    if (parsed.kind !== 'series') throw new Error(parsed.kind);
    expect(parsed.series.sources[0]!.readings.map(r => r.workout)).toEqual([
      { zoneSeconds: [600, 600, 600, 600, 0], effort: { score: 6, method: 'rated' } },
      { zoneSeconds: null, effort: null },
      null,
    ]);
  });

  it('writes no training load while the switch is off', async () => {
    const writes = await run(seriesOf(month((_, thisWeek) => zones(thisWeek ? [0, 600, 600, 600, 600] : [600, 1200, 600, 0, 0]))));
    expect(writes.length).toBeGreaterThan(0);
    for (const row of writes) expect(row).not.toHaveProperty('training_load');
  });

  it('writes today\'s and yesterday\'s candidate load from the source\'s own workouts when on, in words only', async () => {
    const writes = await run(seriesOf(month((_, thisWeek) => zones(thisWeek ? [0, 600, 600, 600, 600] : [600, 1200, 600, 0, 0]))), { trainingLoad: true });
    expect(writes.map(row => row.day)).toEqual([addDays(TODAY, -1), TODAY]);
    for (const row of writes) {
      expect(row.training_load).toEqual({ state: 'available', phrase: 'much heavier than usual', method: 'hr_zones', algorithm_version: 'training-load.candidate.v1', activation: 'candidate_unaccepted' });
    }
    // The same minutes without zones are the same load.
    const plain = await run(seriesOf(month(() => undefined)), { trainingLoad: true });
    expect(plain.at(-1)?.training_load).toMatchObject({ method: 'minutes', phrase: 'about usual' });
  });

  it('says why when the window cannot carry a load', async () => {
    const fewDays = await run(seriesOf(month(() => undefined).filter(s => String(s.day) >= addDays(TODAY, -9))), { trainingLoad: true });
    expect(fewDays.at(-1)?.training_load).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    const noWorkouts = await run(seriesOf(month(() => undefined).filter(s => s.signal !== 'workout')), { trainingLoad: true });
    for (const row of noWorkouts) expect(row.training_load).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
});
