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

// A reading only a phone makes: it shows the phone was about, not that a body-worn sensor was.
const phoneOnly = (day: string): Sample => ({ signal: 'movement_duration', day, start_at: at(day, 9), end_at: at(day, 10), utc_offset_minutes: 0, timezone: 'UTC', value: 30 });
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
      workout(TODAY, 30, zones([600, -60, 600, 600, 0])),
      worn(TODAY),
    ]));
    if (parsed.kind !== 'series') throw new Error(parsed.kind);
    expect(parsed.series.sources[0]!.readings.map(r => r.workout && { zoneSeconds: r.workout.zoneSeconds, effort: r.workout.effort, activity: r.workout.activity })).toEqual([
      { zoneSeconds: [600, 600, 600, 600, 0], effort: { score: 6, method: 'rated' }, activity: 'running' },
      { zoneSeconds: null, effort: null, activity: 'running' },
      { zoneSeconds: null, effort: null, activity: 'running' },
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

  it('writes zones set from an observed workout peak as their own method, from one such workout in the window', async () => {
    const peak = (seconds: number[]) => ({ hr_zones: { basis: 'observed_workout_peak', lower_bounds_bpm: [110, 124, 138, 152], seconds } });
    const writes = await run(seriesOf(month((day, thisWeek) => (day === addDays(TODAY, -10) ? peak : zones)(thisWeek ? [0, 600, 600, 600, 600] : [600, 1200, 600, 0, 0]))), { trainingLoad: true });
    expect(writes.at(-1)?.training_load).toMatchObject({ method: 'hr_zones_observed_peak', phrase: 'much heavier than usual' });
    const parsed = parseSeries(seriesOf([workout(TODAY, 40, peak([600, 600, 600, 600, 0])), workout(TODAY, 40, zones([600, 600, 600, 600, 0]))]));
    if (parsed.kind !== 'series') throw new Error(parsed.kind);
    expect(parsed.series.sources[0]!.readings.map(r => r.workout?.zonesFromObservedPeak)).toEqual([true, false]);
  });

  it('reads a steady six-day routine as about usual on a training morning, before today\'s session and after it', async () => {
    // Four weeks of the same routine, a rest day every seventh day; today is a training day. Today is not over, so the
    // week is the seven whole days ending yesterday on both rows.
    const routine = (sessionDone: boolean) => Array.from({ length: 31 }, (_, i) => addDays(TODAY, -i)).flatMap((day, i) => [
      worn(day), ...(i % 7 === 3 || (i === 0 && !sessionDone) ? [] : [workout(day, 60)]),
    ]);
    for (const sessionDone of [false, true]) {
      const writes = await run(seriesOf(routine(sessionDone)), { trainingLoad: true });
      expect(writes.map(row => row.day)).toEqual([addDays(TODAY, -1), TODAY]);
      for (const row of writes) expect(row.training_load, `${String(row.day)}, session done: ${sessionDone}`).toMatchObject({ state: 'available', phrase: 'about usual' });
    }
  });

  it('never reads a day only the phone saw as rest', async () => {
    // Usual: a session every day. This week: four sessions on worn days, and three days the watch sat in a drawer while
    // the phone still counted movement. Those three are unobserved, not rest, so the week is about usual.
    const yesterday = addDays(TODAY, -1);
    const samples = Array.from({ length: 29 }, (_, i) => addDays(yesterday, -i)).flatMap((day, i) =>
      i >= 4 && i <= 6 ? [phoneOnly(day)] : [worn(day), workout(day, 60)]);
    const writes = await run(seriesOf([...samples, worn(TODAY)]), { trainingLoad: true });
    for (const row of writes) expect(row.training_load, String(row.day)).toMatchObject({ state: 'available', phrase: 'about usual' });
  });

  it('counts a session two apps wrote to the store once', async () => {
    // The same 60-minute run each day, recorded by the watch with zones and mirrored by another app a minute later without
    // them. This week the mirror is on; before it, off. One run a day throughout, so the week is about usual, in zones.
    const mirrored = (day: string): Sample => ({ ...workout(day, 60), start_at: `${day}T06:01:00.000Z`, end_at: `${day}T07:01:00.000Z` });
    const samples = Array.from({ length: 31 }, (_, i) => addDays(TODAY, -i)).flatMap((day, i) => [
      worn(day), workout(day, 60, zones([600, 1200, 1200, 600, 0])), ...(i < 8 ? [mirrored(day)] : []),
    ]);
    const writes = await run(seriesOf(samples), { trainingLoad: true });
    expect(writes.map(row => row.day)).toEqual([addDays(TODAY, -1), TODAY]);
    for (const row of writes) expect(row.training_load, String(row.day)).toMatchObject({ state: 'available', phrase: 'about usual', method: 'hr_zones' });
  });

  it('keeps sessions that only touch or barely overlap apart, and folds a short copy inside a long one', async () => {
    const zoned = zones([600, 1200, 1200, 600, 0]);
    const session = (day: string, from: string, to: string, detail?: Sample): Sample => ({ ...workout(day, (Date.parse(`${day}T${to}Z`) - Date.parse(`${day}T${from}Z`)) / 60_000, detail), start_at: `${day}T${from}Z`, end_at: `${day}T${to}Z` });
    // One zoned hour a day; this week each day also carries `extra`.
    const loadWith = async (extra: (day: string) => Sample) => (await run(seriesOf(Array.from({ length: 31 }, (_, i) => addDays(TODAY, -i)).flatMap((day, i) => [
      worn(day), session(day, '06:00:00.000', '07:00:00.000', zoned), ...(i < 8 ? [extra(day)] : []),
    ])), { trainingLoad: true })).at(-1)?.training_load;
    expect(await loadWith(day => session(day, '18:00:00.000', '19:00:00.000', zoned)), 'an evening session').toMatchObject({ phrase: 'much heavier than usual', method: 'hr_zones' });
    expect(await loadWith(day => session(day, '07:00:00.000', '08:00:00.000', zoned)), 'back to back').toMatchObject({ phrase: 'much heavier than usual', method: 'hr_zones' });
    expect(await loadWith(day => session(day, '06:45:00.000', '07:45:00.000', zoned)), 'a quarter shared').toMatchObject({ phrase: 'much heavier than usual', method: 'hr_zones' });
    expect(await loadWith(day => session(day, '06:20:00.000', '06:40:00.000')), 'a copy inside').toMatchObject({ phrase: 'about usual', method: 'hr_zones' });
  });

  it('says why when the window cannot carry a load', async () => {
    const fewDays = await run(seriesOf(month(() => undefined).filter(s => String(s.day) >= addDays(TODAY, -9))), { trainingLoad: true });
    expect(fewDays.at(-1)?.training_load).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    const noWorkouts = await run(seriesOf(month(() => undefined).filter(s => s.signal !== 'workout')), { trainingLoad: true });
    for (const row of noWorkouts) expect(row.training_load).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
});
