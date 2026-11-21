import { produceHealthScores } from '../../src/health/producer';
import { dailyScoresFor } from '../../src/health/scores';

// A synthetic owner whose phone sends every kind of body data Waldo stores, for 25 days, run through the real producer with every
// derived switch on. The written rows are what the database would hold, so a test can follow a kind from the phone to the model.
// Values are synthetic and wobble around fixed levels named by role.
export const EVERY_KIND_TODAY = '2026-03-20';
export const EVERY_KIND_NOW = Date.parse('2026-03-20T20:00:00Z');
const READ_AT = '2026-03-20T20:00:00.000123Z';
const NIGHTS = 25;
const LEVEL = {
  night: 450, midpoint: 180, overnight: 60, resting: 56, pulse: 72, variability: 50, daylight: 20, movement: 12, steps: 600, energy: 30,
  breathing: 14, oxygen: 96, temperature: 34, walking: 100, cardio: 42, recovery: 25, efficiency: 0.9, mindful: 10, mass: 70, fat: 20, lean: 55,
  food: 600, workout: 40,
};
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
// Today stands apart from the owner's usual on every reading, so a direction has something to say.
const today = (i: number, amp: number) => (i === 0 ? 3 * amp : 0);
type Sample = Record<string, unknown>;
const at = (d: string, hour: number) => `${d}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const sample = (signal: string, d: string, startHour: number, endHour: number, value: number, over: Sample = {}): Sample =>
  ({ signal, day: d, start_at: at(d, startHour), end_at: at(d, endHour), utc_offset_minutes: 0, timezone: 'UTC', value, ...over });

const dayOf = (d: string, i: number): Sample[] => {
  const night = { start_at: `${addDays(d, -1)}T23:00:00.000Z`, end_at: `${d}T07:00:00.000Z` };
  const asleep = LEVEL.night + wobble(i, 20) - today(i, 20);
  return [
    { ...sample('sleep_duration', d, 0, 7, asleep, { method: 'asleep_duration', stages: { light: asleep * 0.5, deep: asleep * 0.2, rem: asleep * 0.3, unspecified: 0, awake: 25 + wobble(i, 8) + today(i, 8) } }), ...night },
    { ...sample('sleep_midpoint', d, 0, 7, LEVEL.midpoint + wobble(i, 15) + today(i, 15), { method: 'sleep_midpoint' }), ...night },
    { ...sample('overnight_hrv', d, 0, 7, LEVEL.overnight + wobble(i, 6) - today(i, 6), { method: 'rmssd' }), ...night },
    { ...sample('sleep_efficiency', d, 0, 7, LEVEL.efficiency + wobble(i, 0.03)), ...night },
    sample('resting_heart_rate', d, 3, 4, LEVEL.resting + wobble(i, 2) + today(i, 2)),
    sample('respiratory_rate', d, 3, 4, LEVEL.breathing + wobble(i, 0.6) + today(i, 0.6)),
    sample('spo2', d, 3, 4, LEVEL.oxygen + wobble(i, 1) - today(i, 1)),
    sample('wrist_temperature', d, 3, 4, LEVEL.temperature + wobble(i, 0.3) + today(i, 0.3), { method: 'absolute' }),
    sample('walking_heart_rate_average', d, 18, 19, LEVEL.walking + wobble(i, 3) + today(i, 3)),
    sample('vo2_max', d, 18, 19, LEVEL.cardio + wobble(i, 1)),
    sample('heart_rate_recovery', d, 18, 19, LEVEL.recovery + wobble(i, 2)),
    sample('mindful_duration', d, 20, 21, LEVEL.mindful + wobble(i, 3)),
    sample('body_mass', d, 7, 8, LEVEL.mass + wobble(i, 0.5)),
    sample('body_fat_percentage', d, 7, 8, LEVEL.fat + wobble(i, 0.5)),
    sample('lean_body_mass', d, 7, 8, LEVEL.lean + wobble(i, 0.5)),
    sample('nutrition', d, 12, 13, LEVEL.food + wobble(i, 50), { nutrition: { protein_g: 30, carbohydrate_g: 60, fat_g: 20 } }),
    sample('workout', d, 17, 18, LEVEL.workout + wobble(i, 10), { activity: 'running', workout: { hr_zones: { seconds: [600, 900, 600, 300, 0], basis: 'observed_workout_peak' } } }),
    ...[8, 9, 10, 11, 12, 13, 14, 15].flatMap(h => [
      sample('heart_rate_window', d, h, h + 1, LEVEL.pulse + wobble(h + i, 2) + today(i, 4)),
      sample('hrv_window', d, h, h + 1, LEVEL.variability + wobble(h + i, 4), { method: 'rmssd' }),
      sample('daylight_duration', d, h, h + 1, LEVEL.daylight + wobble(h + i, 2) - today(i, 4)),
      sample('movement_duration', d, h, h + 1, LEVEL.movement + wobble(h + i, 2) - today(i, 4)),
      sample('steps_window', d, h, h + 1, LEVEL.steps + wobble(h + i, 100) - today(i, 150)),
      sample('active_energy_window', d, h, h + 1, LEVEL.energy + wobble(h + i, 5) - today(i, 8)),
      sample('stand_hour', d, h, h + 1, 1),
      sample('heart_rate_bins_window', d, h, h + 1, 3600, { bins: { from_bpm: 60, outside_workouts: [1200, 1800, 600], in_workouts: [0, 0, 0] } }),
    ]),
  ];
};

const seriesOf = (without: readonly string[]) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: NIGHTS }, (_, i) => dayOf(addDays(EVERY_KIND_TODAY, -i), i)).flat().filter(entry => !without.includes(String(entry.signal))) }],
});
export const EVERY_KIND_SIGNALS: readonly string[] = [...new Set(seriesOf([]).sources[0]!.samples.map(entry => String(entry.signal)))];

// The stored history the producer reads for its significance: the rows of the earlier days, as the database would answer.
const historyOf = (rows: readonly Record<string, unknown>[], today = EVERY_KIND_TODAY) => ({
  history: { from: addDays(today, -89), to: today, days: rows.filter(row => String(row.day) < today) },
});

// Every row the producer writes for this owner, with every derived switch on, oldest first; today's row last. without: kinds this
// owner's phone does not send.
export const everyKindRows = async (without: readonly string[] = []): Promise<Record<string, unknown>[]> => {
  const series = seriesOf(without);
  const run = async (history: readonly Record<string, unknown>[]) => {
    const written: Record<string, unknown>[] = [];
    await produceHealthScores({
      readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => { written.push(JSON.parse(payload) as Record<string, unknown>); return { written: true }; },
      compute: dailyScoresFor('1'),
      readHistory: async () => historyOf(history),
      scoreParts: true, usual: true, trainingLoad: true, changes: true, dayLoad: true, stressCurve: true, passiveLoad: ['apple'],
    } as Parameters<typeof produceHealthScores>[0], { now: EVERY_KIND_NOW, timezone: 'UTC' });
    return written;
  };
  // The first run backfills the earlier days; the second reads them as stored history, as the next run would.
  const backfilled = await run([]);
  const rows = await run(backfilled);
  return [...backfilled.filter(row => !rows.some(next => next.day === row.day)), ...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
};

// The rows of an owner whose phone synced every evening: one producer run a day, each reading only what had arrived by then, so each
// day's row was written while it was today, with its parts and bands, as an owner who syncs daily has them. Oldest first.
export const everyKindDailyRows = async (): Promise<Record<string, unknown>[]> => {
  const full = seriesOf([]);
  const stored = new Map<string, Record<string, unknown>>();
  for (let back = NIGHTS - 1; back >= 0; back--) {
    const today = addDays(EVERY_KIND_TODAY, -back);
    const readAt = `${today}T20:00:00.000123Z`;
    const series = { ...full, read_at: readAt, sources: full.sources.map(s => ({ ...s, samples: s.samples.filter(e => String(e.day) <= today) })) };
    await produceHealthScores({
      readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => {
        const row = JSON.parse(payload) as Record<string, unknown>;
        const held = stored.get(String(row.day));
        if (!(row.backfilled === true && held && held.backfilled !== true)) stored.set(String(row.day), row);
        return { written: true };
      },
      compute: dailyScoresFor('1'),
      readHistory: async () => historyOf([...stored.values()], today),
      scoreParts: true, usual: true, trainingLoad: true, changes: true, dayLoad: true, stressCurve: true, passiveLoad: ['apple'],
    } as Parameters<typeof produceHealthScores>[0], { now: Date.parse(readAt), timezone: 'UTC' });
  }
  return [...stored.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
};
