import type { healthSeriesSignalV1Schema } from '../../../contracts/src/app/health-ingest';
import { asleepOf, daysOf, newest, parseSeries, sourcePicker, untruncated, type Reading } from './producer';
import { dayTotal } from './scores/form';
import { HRV_ORDER, RESTING_ORDER } from './scores/recovery';
import type { DayRecord, HourlyBucket } from './scores/types';
import { activeEnergy } from './scores/weight';

// One reading's daily values for the app's chart. Each is read off the same DayRecord the scores consumed, built by the producer's
// own pipeline from the same readings and the source it takes for the day, so a chart and the score beside it are one set of numbers
// and no value is derived twice. The stored signals a chart needs are the ones its reduction reads, plus sleep_duration, which the
// producer's choice of a day's source looks at.
type Signal = typeof healthSeriesSignalV1Schema.options[number];
type Value = Readonly<{ value: number; method: string | null }>;
type Reduce = (day: DayRecord, readings: readonly Reading[]) => Value | null;

const plain = (value: number | null | undefined): Value | null => (typeof value === 'number' ? { value, method: null } : null);
const firstMethod = <Method extends string>(order: readonly Method[], entries: readonly Readonly<{ value: number; method: Method }>[]): Value | null => {
  for (const method of order) { const entry = entries.find(candidate => candidate.method === method); if (entry) return { value: entry.value, method }; }
  return null;
};
const stage = (name: 'light' | 'deep' | 'rem'): Reduce => (_day, readings) => plain(asleepOf(readings)?.stages?.[name]);
const hourly = (pick: (bucket: HourlyBucket) => number | null): Reduce => day => plain(dayTotal(day, pick));
export const hourlyPick: Readonly<Partial<Record<Signal, (bucket: HourlyBucket) => number | null>>> = {
  daylight: bucket => bucket.daylightMinutes,
  movement: bucket => bucket.movementMinutes,
  active_energy: bucket => bucket.activeEnergyKcal,
};
const TEMPERATURE_ORDER = ['absolute', 'baseline_delta'] as const;
// A day's windows are read together, because the producer drops every window of a day that holds an overlapping pair.
const WINDOWS = ['sleep_duration', 'heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'active_energy_window'];

export const SERIES_READS: Readonly<Record<Signal, Readonly<{ stored: readonly string[]; reduce: Reduce }>>> = {
  sleep_asleep: { stored: ['sleep_duration'], reduce: (_day, readings) => plain(asleepOf(readings)?.value) },
  sleep_light: { stored: ['sleep_duration'], reduce: stage('light') },
  sleep_deep: { stored: ['sleep_duration'], reduce: stage('deep') },
  sleep_rem: { stored: ['sleep_duration'], reduce: stage('rem') },
  awake_time: { stored: ['sleep_duration'], reduce: day => plain(day.vitals?.awakeMinutes) },
  sleep_efficiency: { stored: ['sleep_duration', 'sleep_efficiency'], reduce: (_day, readings) => plain(newest(readings.filter(r => r.signal === 'sleep_efficiency'))?.value) },
  sleep_midpoint: { stored: ['sleep_duration', 'sleep_midpoint'], reduce: day => plain(day.sleep?.midpointMinute) },
  overnight_hrv: { stored: ['sleep_duration', 'overnight_hrv'], reduce: day => firstMethod(HRV_ORDER, day.overnightHrv) },
  resting_heart_rate: { stored: ['sleep_duration', 'sleep_midpoint', 'resting_heart_rate', 'heart_rate_window'], reduce: day => firstMethod(RESTING_ORDER, day.restingHeartRate) },
  breathing_rate: { stored: ['sleep_duration', 'sleep_midpoint', 'respiratory_rate'], reduce: day => plain(day.vitals?.breathingRate) },
  spo2: { stored: ['sleep_duration', 'sleep_midpoint', 'spo2'], reduce: day => plain(day.vitals?.bloodOxygen) },
  wrist_temperature: { stored: ['sleep_duration', 'sleep_midpoint', 'wrist_temperature'], reduce: day => firstMethod(TEMPERATURE_ORDER, day.vitals?.wristTemperature ?? []) },
  walking_heart_rate: { stored: ['sleep_duration', 'walking_heart_rate_average'], reduce: day => plain(day.vitals?.walkingHeartRate) },
  daylight: { stored: WINDOWS, reduce: hourly(hourlyPick.daylight!) },
  movement: { stored: WINDOWS, reduce: hourly(hourlyPick.movement!) },
  active_energy: { stored: WINDOWS, reduce: day => plain(activeEnergy(day)) },
};

export type SeriesDay = Readonly<{ day: string; value: number; method: string | null; source: string }>;
export type SeriesHour = Readonly<{ at: string; value: number }>;
export type SeriesOf =
  | Readonly<{ kind: 'series'; from: string; to: string; days: readonly SeriesDay[]; hours: readonly SeriesHour[] }>
  | Readonly<{ kind: 'unavailable'; reason: 'not_linked' | 'consent_required' | 'consent_withdrawn' | 'no_readings' }>
  | Readonly<{ kind: 'failed' }>;

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// What the database's answer holds of one signal: each day's value by the producer's own reduction, from the source it picks for
// the day, and today's hours for a signal made of them. A read that reached its row cap loses its oldest, partial day.
export const seriesOf = (answer: unknown, signal: Signal): SeriesOf => {
  const body = asRecord(answer);
  if (body?.error === 'not_linked') return { kind: 'unavailable', reason: 'not_linked' };
  if (body?.access === 'consent_required' || body?.access === 'consent_withdrawn') return { kind: 'unavailable', reason: body.access };
  const parsed = parseSeries(answer);
  if (parsed.kind !== 'series' || typeof body?.from !== 'string' || typeof body.to !== 'string' || !DAY.test(body.from) || !DAY.test(body.to)) return { kind: 'failed' };
  const { present, chooseFor } = sourcePicker(untruncated(parsed.series, 'signal_series_truncated'));
  if (!present.length) return { kind: 'unavailable', reason: 'no_readings' };
  const reduce = SERIES_READS[signal].reduce;
  const records = new Map<string, ReadonlyMap<string, DayRecord>>();
  const recordOf = (source: (typeof present)[number], day: string): DayRecord | undefined => {
    if (!records.has(source.source)) records.set(source.source, new Map(daysOf(source.readings, 'UTC').days.map(record => [record.day, record])));
    return records.get(source.source)!.get(day);
  };
  const days: SeriesDay[] = [];
  const dates = [...new Set(present.flatMap(source => source.readings.map(r => r.day)))].filter(day => day >= body.from! && day <= body.to!).sort();
  for (const day of dates) {
    const source = chooseFor(day), record = recordOf(source, day);
    const value = record && reduce(record, source.readings.filter(r => r.day === day));
    if (value) days.push({ day, value: value.value, method: value.method, source: source.source });
  }
  const pick = hourlyPick[signal];
  const todaySource = chooseFor(body.to);
  const today = pick && recordOf(todaySource, body.to);
  const hours = today && pick ? today.hourly.flatMap((bucket): SeriesHour[] => { const value = pick(bucket); return value === null ? [] : [{ at: bucket.startAt, value }]; }) : [];
  return { kind: 'series', from: body.from, to: body.to, days, hours };
};
