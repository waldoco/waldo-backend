import type { HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';

// Google Health API v4 data points mapped onto the same normalized samples HealthKit, Health Connect and WHOOP produce.
// Pure: no I/O, no clock. A field Google has not computed, or does not state, produces no sample, never a zero. A record
// Google Health took from Apple Health or Health Connect is refused, since Waldo reads those sources itself and must not
// store them again under this source.
const SOURCE = 'google_health';
const IMPORTED = new Set(['HEALTH_KIT', 'HEALTH_CONNECT']);

export type GoogleHealthSleep = Readonly<{ start: string; end: string; offset: number; updatedAt: string; main: boolean; asleep: number | null; inPeriod: number | null }>;
export type GoogleHealthDailyKind = 'overnight_hrv' | 'resting_heart_rate' | 'spo2' | 'respiratory_rate' | 'wrist_temperature';
export type GoogleHealthDaily = Readonly<{ kind: GoogleHealthDailyKind; date: string; value: number }>;
export type GoogleHealthExercise = Readonly<{ id: string | null; start: string; end: string; offset: number; updatedAt: string; activity: string; kcal: number | null }>;
export type GoogleHealthBody = Readonly<{ kind: 'body_mass' | 'body_fat_percentage'; at: string; offset: number; value: number }>;
export type GoogleHealthRollup = Readonly<{ start: string; end: string; value: number }>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// Google writes int64 values as strings.
const int64 = (value: unknown): number | null => (typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const imported = (point: Record<string, unknown>) => IMPORTED.has(String(record(point.dataSource)?.platform ?? ''));

// A UTC offset as Google writes it, a duration in seconds such as "19800s", in whole minutes within a real zone; null otherwise.
export const utcOffsetMinutes = (value: string): number | null => {
  const match = /^(-?\d{1,6})(?:\.0+)?s$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]);
  return seconds % 60 === 0 && Math.abs(seconds / 60) <= 840 ? seconds / 60 : null;
};
const offsetOf = (value: unknown): number | null => (typeof value === 'string' ? utcOffsetMinutes(value) : null);
const dateOf = (value: unknown): string | null => {
  const d = record(value);
  const year = num(d?.year), month = num(d?.month), day = num(d?.day);
  if (year === null || month === null || day === null || !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const at = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === iso ? iso : null;
};
// The data point's own id: the last segment of users/{user}/dataTypes/{type}/dataPoints/{id}.
const pointId = (name: unknown): string | null => {
  const match = typeof name === 'string' ? /\/dataPoints\/([a-z0-9-]{4,63})$/.exec(name) : null;
  return match ? match[1]! : null;
};

// The provider's answers are parsed here and nowhere else, field by field. One that does not fit is null, so a record
// the shape rules cannot place is never guessed at.
export const googleHealthSleep = (raw: unknown): GoogleHealthSleep | null => {
  const point = record(raw), sleep = record(point?.sleep), interval = record(sleep?.interval);
  if (!point || !sleep || !interval || imported(point)) return null;
  const start = instant(interval.startTime), end = instant(interval.endTime), offset = offsetOf(interval.endUtcOffset), updatedAt = instant(sleep.updateTime);
  if (!start || !end || offset === null || !updatedAt || offsetOf(interval.startUtcOffset) === null) return null;
  const meta = record(sleep.metadata), summary = record(sleep.summary);
  return { start, end, offset, updatedAt, main: meta?.mainSleep === true && meta?.nap !== true, asleep: int64(summary?.minutesAsleep), inPeriod: int64(summary?.minutesInSleepPeriod) };
};

const DAILY: Readonly<Record<string, Readonly<{ kind: GoogleHealthDailyKind; read(body: Record<string, unknown>): number | null }>>> = {
  dailyHeartRateVariability: { kind: 'overnight_hrv', read: body => num(body.averageHeartRateVariabilityMilliseconds) },
  dailyRestingHeartRate: { kind: 'resting_heart_rate', read: body => int64(body.beatsPerMinute) },
  dailyOxygenSaturation: { kind: 'spo2', read: body => num(body.averagePercentage) },
  dailyRespiratoryRate: { kind: 'respiratory_rate', read: body => num(body.breathsPerMinute) },
  dailySleepTemperatureDerivations: { kind: 'wrist_temperature', read: body => num(body.nightlyTemperatureCelsius) },
};
export const googleHealthDaily = (raw: unknown): GoogleHealthDaily | null => {
  const point = record(raw);
  if (!point || imported(point)) return null;
  for (const [field, { kind, read }] of Object.entries(DAILY)) {
    const body = record(point[field]);
    if (!body) continue;
    const date = dateOf(body.date), value = read(body);
    return date && value !== null ? { kind, date, value } : null;
  }
  return null;
};

export const googleHealthExercise = (raw: unknown): GoogleHealthExercise | null => {
  const point = record(raw), exercise = record(point?.exercise), interval = record(exercise?.interval);
  if (!point || !exercise || !interval || imported(point) || typeof exercise.exerciseType !== 'string' || !/^[A-Z_]{1,64}$/.test(exercise.exerciseType)) return null;
  const start = instant(interval.startTime), end = instant(interval.endTime), offset = offsetOf(interval.startUtcOffset), updatedAt = instant(exercise.updateTime);
  if (!start || !end || offset === null || !updatedAt) return null;
  // The type, never displayName: for OTHER that is the owner's own free text.
  return { id: pointId(point.name), start, end, offset, updatedAt, activity: exercise.exerciseType.toLowerCase().replaceAll('_', ' '), kcal: num(record(exercise.metricsSummary)?.caloriesKcal) };
};

export const googleHealthBody = (raw: unknown): GoogleHealthBody | null => {
  const point = record(raw);
  if (!point || imported(point)) return null;
  const weight = record(point.weight), fat = record(point.bodyFat), body = weight ?? fat, time = record(body?.sampleTime);
  const at = instant(time?.physicalTime), offset = offsetOf(time?.utcOffset);
  if (!body || !at || offset === null) return null;
  const grams = weight ? num(weight.weightGrams) : null, percent = fat ? num(fat.percentage) : null;
  if (weight) return grams === null ? null : { kind: 'body_mass', at, offset, value: grams / 1000 };
  return percent === null ? null : { kind: 'body_fat_percentage', at, offset, value: percent };
};

export const googleHealthRollup = (kind: 'steps' | 'active_energy', raw: unknown): GoogleHealthRollup | null => {
  const point = record(raw);
  const start = instant(point?.startTime), end = instant(point?.endTime);
  const value = kind === 'steps' ? int64(record(point?.steps)?.countSum) : num(record(point?.activeEnergyBurned)?.kcalSum);
  return start && end && value !== null && value >= 0 ? { start, end, value } : null;
};

const MIN = 60_000;
const DAY_MIN = 1_440;
const HOUR_MS = 3_600_000;
const localDayOf = (at: number, offset: number): string => new Date(at + offset * MIN).toISOString().slice(0, 10);
const epochSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

// A daily vital as Waldo stores it, or null when its value is outside what Waldo stores for that signal.
const vital = (daily: GoogleHealthDaily, base: Omit<HealthSampleV1, 'signal' | 'unit' | 'value'>): HealthSampleV1 | null => {
  const { kind, value } = daily;
  if (kind === 'overnight_hrv') return value > 0 && value <= 1000 ? { ...base, signal: kind, unit: 'milliseconds', method: 'rmssd', value: round(value, 3) } : null;
  if (kind === 'resting_heart_rate') return value > 0 && value <= 300 ? { ...base, signal: kind, unit: 'beats_per_minute', method: 'provider_resting_daily', value } : null;
  if (kind === 'spo2') return value >= 50 && value <= 100 ? { ...base, signal: kind, unit: 'percent', value: round(value) } : null;
  if (kind === 'respiratory_rate') return value >= 4 && value <= 80 ? { ...base, signal: kind, unit: 'breaths_per_minute', value: round(value) } : null;
  return value >= 20 && value <= 45 ? { ...base, signal: kind, unit: 'celsius', method: 'absolute', value: round(value) } : null;
};

// The main sleep on its waking day, in its own offset, and that date's daily vitals placed on the same night. Google gives
// a daily vital only a date, so it takes the night's window and offset, and the fetch time as its revision. A sleep reading
// takes its id from source, signal and waking day, so a later sync replaces the night instead of adding a second one.
export const googleHealthNightSamples = (night: Readonly<{ sleep: GoogleHealthSleep; daily: readonly GoogleHealthDaily[]; fetchedAtSeconds: number }>): HealthSampleV1[] => {
  const { sleep, daily, fetchedAtSeconds } = night;
  const start = Date.parse(sleep.start), end = Date.parse(sleep.end);
  if (!sleep.main || !(start < end)) return [];
  const day = localDayOf(end, sleep.offset);
  const base = { day, utc_offset_minutes: sleep.offset, start_at: sleep.start, end_at: sleep.end };
  const id = (signal: string) => `${SOURCE}:${signal}:${day}`;
  const out: HealthSampleV1[] = [];
  const { asleep, inPeriod } = sleep;
  if (asleep !== null && asleep > 0 && asleep <= DAY_MIN) {
    const revision = epochSeconds(sleep.updatedAt);
    const midpoint = (((start + end) / 2 + sleep.offset * MIN) % (DAY_MIN * MIN) + DAY_MIN * MIN) % (DAY_MIN * MIN) / MIN;
    out.push({ ...base, sample_id: id('sleep_duration'), revision, signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: asleep });
    out.push({ ...base, sample_id: id('sleep_midpoint'), revision, signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: Math.min(round(midpoint, 3), 1439.999) });
    if (inPeriod !== null && inPeriod >= asleep && inPeriod > 0) out.push({ ...base, sample_id: id('sleep_efficiency'), revision, signal: 'sleep_efficiency', unit: 'ratio', value: round(asleep / inPeriod, 4) });
  }
  for (const entry of daily) {
    if (entry.date !== day) continue;
    const sample = vital(entry, { ...base, sample_id: id(entry.kind), revision: fetchedAtSeconds });
    if (sample) out.push(sample);
  }
  return out;
};

// Workout minutes from the record's own span, on the day it started in its own offset. Energy only when Google gives it.
export const googleHealthWorkoutSamples = (exercise: GoogleHealthExercise): HealthSampleV1[] => {
  const start = Date.parse(exercise.start), minutes = (Date.parse(exercise.end) - start) / MIN;
  if (!(minutes > 0) || minutes > DAY_MIN) return [];
  const kcal = exercise.kcal !== null && exercise.kcal >= 0 && exercise.kcal <= 30_000 ? round(exercise.kcal, 1) : null;
  return [{
    day: localDayOf(start, exercise.offset), utc_offset_minutes: exercise.offset, start_at: exercise.start, end_at: exercise.end,
    sample_id: `${SOURCE}:${exercise.id ?? exercise.start}:workout`, revision: epochSeconds(exercise.updatedAt),
    signal: 'workout', unit: 'minutes', activity: exercise.activity, value: round(minutes), ...(kcal !== null ? { energy_kcal: kcal } : {}),
  }];
};

// A scale or a logged reading is a point record. Google gives it no update time, so the fetch time is its revision.
export const googleHealthBodySamples = (body: GoogleHealthBody, fetchedAtSeconds: number): HealthSampleV1[] => {
  const inRange = body.kind === 'body_mass' ? body.value >= 20 && body.value <= 400 : body.value >= 2 && body.value <= 75;
  if (!inRange) return [];
  const base = { day: localDayOf(Date.parse(body.at), body.offset), utc_offset_minutes: body.offset, start_at: body.at, end_at: body.at, sample_id: `${SOURCE}:${body.kind}:${body.at}`, revision: fetchedAtSeconds };
  return [body.kind === 'body_mass' ? { ...base, signal: 'body_mass', unit: 'kilograms', value: round(body.value) } : { ...base, signal: 'body_fat_percentage', unit: 'percent', value: round(body.value) }];
};

// Hourly rollups as local-hour windows in the owner's offset. A bucket that is not exactly one hour starting on a local hour
// (the last one of a range, or a range not aligned to the offset) is not a window and is dropped. Only the current hour
// grows, so the fetch time is the revision.
export const googleHealthWindowSamples = (kind: 'steps' | 'active_energy', rollups: readonly GoogleHealthRollup[], offset: number, fetchedAtSeconds: number): HealthSampleV1[] =>
  rollups.flatMap((bucket): HealthSampleV1[] => {
    const start = Date.parse(bucket.start);
    if (Date.parse(bucket.end) - start !== HOUR_MS || (start + offset * MIN) % HOUR_MS !== 0) return [];
    const base = { day: localDayOf(start, offset), utc_offset_minutes: offset, start_at: bucket.start, end_at: bucket.end, revision: fetchedAtSeconds };
    if (kind === 'steps') return bucket.value <= 300_000 ? [{ ...base, sample_id: `${SOURCE}:steps_window:${bucket.start}`, signal: 'steps_window', unit: 'count', value: bucket.value }] : [];
    return bucket.value <= 30_000 ? [{ ...base, sample_id: `${SOURCE}:active_energy_window:${bucket.start}`, signal: 'active_energy_window', unit: 'kilocalories', value: round(bucket.value, 1) }] : [];
  });
