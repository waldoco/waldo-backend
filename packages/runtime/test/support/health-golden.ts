import { produceHealthScores, type ProducerDeps } from '../../src/health/producer';
import type { DailyScoresInput, DayRecord, HourlyBucket } from '../../src/health/scores/types';

// Synthetic owners for the flag-off identity guard: the same builders feed the generator that wrote the stored golden
// and the test that compares against it, so a drift in either shows as a diff, never as a silently regenerated file.
const TARGET = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;

const hourly = (day: string, offset: number, hrvMethod: 'rmssd' | 'sdnn' = 'rmssd'): HourlyBucket[] =>
  [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(h => ({
    startAt: new Date(Date.parse(`${day}T00:00:00Z`) + h * 3_600_000).toISOString(),
    heartRate: 72 + wobble(h + offset, 2), hrv: 55 + wobble(h + offset, 3), hrvMethod,
    daylightMinutes: 20 + wobble(h + offset, 2), movementMinutes: 12 + wobble(h + offset, 2), activeEnergyKcal: 30 + wobble(h + offset, 5),
  }));
const day = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: [{ value: 60 + wobble(i, 6), method: 'rmssd' }],
    restingHeartRate: [{ value: 55 + wobble(i, 2), method: 'provider_resting_daily' }],
    hourly: hourly(d, i), workouts: [],
    demand: { meetingMinutes: 240 + wobble(i, 40), messageCount: 30 + wobble(i, 5), openTaskMinutes: 120 + wobble(i, 20), physicalLoad: 100 + wobble(i, 10) },
    vitals: { breathingRate: 14 + wobble(i, 0.6), bloodOxygen: 96 + wobble(i, 1), awakeMinutes: 25 + wobble(i, 8), walkingHeartRate: 100 + wobble(i, 3), wristTemperature: [{ value: 34 + wobble(i, 0.3), method: 'absolute' }] },
    ...over,
  };
};
const run = (n: number, over: (i: number) => Partial<DayRecord> = () => ({})): DayRecord[] => Array.from({ length: n }, (_, i) => day(i, over(i)));
const input = (days: DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z`, ...over });

export const goldenScoreInputs = (): Readonly<Record<string, DailyScoresInput>> => ({
  mature_confirmed_need: input(run(21)),
  mature_own_average_need: input(run(30), { sleepNeedMinutes: null }),
  immature_ten_days: input(run(10), { sleepNeedMinutes: null }),
  first_day_only: input(run(1), { sleepNeedMinutes: null }),
  missing_target_sleep: input(run(21, i => (i === 0 ? { sleep: null } : {}))),
  sdnn_only: input(run(20, i => ({ overnightHrv: [{ value: 40 + wobble(i, 5), method: 'sdnn' }], hourly: hourly(addDays(TARGET, -i), i, 'sdnn') }))),
  no_calendar: input(run(20, () => ({ demand: { meetingMinutes: null, messageCount: null, openTaskMinutes: null, physicalLoad: null } }))),
  two_nights_missing: input(run(21).filter((_, i) => i !== 3 && i !== 8)),
  short_sleeper: input(run(30, i => ({ sleep: { startAt: `${addDays(addDays(TARGET, -i), -1)}T23:00:00.000Z`, endAt: `${addDays(TARGET, -i)}T05:00:00.000Z`, asleepMinutes: 360 + wobble(i, 10), midpointMinute: 120 } })), { sleepNeedMinutes: null }),
  no_access: input(run(21), { access: 'consent_required' }),
});

type Sample = Record<string, unknown>;
const sample = (signal: string, d: string, over: Sample = {}): Sample =>
  ({ signal, day: d, start_at: `${d}T08:00:00.000Z`, end_at: `${d}T09:00:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const dayOfReadings = (d: string, i: number): Sample[] => [
  sample('sleep_duration', d, { start_at: `${addDays(d, -1)}T23:00:00.000Z`, end_at: `${d}T07:00:00.000Z`, value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', d, { start_at: `${addDays(d, -1)}T23:00:00.000Z`, end_at: `${d}T07:00:00.000Z`, value: 180 + wobble(i, 15), method: 'sleep_midpoint' }),
  sample('overnight_hrv', d, { start_at: `${addDays(d, -1)}T23:00:00.000Z`, end_at: `${d}T07:00:00.000Z`, value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', d, { start_at: `${d}T03:00:00.000Z`, end_at: `${d}T04:00:00.000Z`, value: 56 + wobble(i, 2) }),
  ...[8, 9, 10, 11, 12, 13, 14, 15].flatMap(h => {
    const start_at = `${d}T${String(h).padStart(2, '0')}:00:00.000Z`, end_at = `${d}T${String(h + 1).padStart(2, '0')}:00:00.000Z`;
    return [
      sample('heart_rate_window', d, { start_at, end_at, value: 72 + wobble(h + i, 2) }),
      sample('hrv_window', d, { start_at, end_at, value: 50 + wobble(h + i, 4), method: 'rmssd' }),
      sample('daylight_duration', d, { start_at, end_at, value: 20 }),
      sample('movement_duration', d, { start_at, end_at, value: 12 }),
    ];
  }),
];
export const PRODUCER_NOW = Date.parse('2026-03-20T12:00:00Z');
const READ_AT = '2026-03-20T12:00:00.000123Z';
const seriesOf = (nights: number, source: string) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source, consent_epoch: 3, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TARGET, -i), i)).flat() }],
});
const busy = Array.from({ length: 31 }, (_, i) => ({ day: addDays(TARGET, -i), busy_minutes: Math.round(240 + wobble(i, 40)), partial: false }));

export type GoldenProducerCase = Readonly<{ nights: number; source: string; calendar: boolean }>;
export const goldenProducerCases: Readonly<Record<string, GoldenProducerCase>> = {
  apple_mature_with_calendar: { nights: 25, source: 'apple', calendar: true },
  oura_mature_no_calendar: { nights: 25, source: 'oura', calendar: false },
  apple_ten_nights: { nights: 10, source: 'apple', calendar: false },
  whoop_first_night: { nights: 1, source: 'whoop', calendar: false },
};

// The exact payloads written to the derived-row writer, as the strings the signed call carries.
export const producerPayloads = async (compute: ProducerDeps['compute'], spec: GoldenProducerCase): Promise<string[]> => {
  const written: string[] = [];
  const series = seriesOf(spec.nights, spec.source);
  await produceHealthScores({
    readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async payload => { written.push(payload); return { written: true }; },
    compute,
    ...(spec.calendar ? { readDemand: async () => ({ state: 'available', days: busy }) } : {}),
  }, { now: PRODUCER_NOW, timezone: 'UTC' });
  return written;
};
