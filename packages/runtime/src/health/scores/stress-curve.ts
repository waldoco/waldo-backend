import { stressBandOf } from '../../../../contracts/src/app/health-ingest';
import { MIN_DAYS_PER_HOUR, NOISE_FLOOR, RESTING_MOVEMENT_MINUTES } from './energy-windows';
import { byLocalDay } from './index';
import { priorDays } from './sleep-debt';
import { clampScore, mean } from './stats';
import { localDayWindow, wallMinute } from './time';
import type { DayRecord, HourlyBucket, HrvMethod } from './types';

// Strain on the body at rest, by hour of today (stress-curve.candidate.v1, ADR-0081 amendment of 2 Nov 2026, §6). Each settled
// awake hour outside a workout and with little movement is read against the same wall-clock hour on the owner's earlier days:
// its mean heart rate, and its HRV where the hour has it, each in spreads from that hour's own mean. 50 is the owner's usual
// hour and 20 points are one spread, the map every part of a score uses; higher is more strain. HRV is read on the natural-log
// scale and against its own method's days only. The band is read off the value, so the two cannot disagree. Pure: no clock,
// no I/O.
export const STRESS_CURVE_VERSION = 'stress-curve.candidate.v1';
export type StressHourReason = 'workout' | 'moving' | 'no_reading' | 'baseline_immature';
export type StressHour =
  | Readonly<{ at: string; value: number; band: 'low' | 'medium' | 'high' }>
  | Readonly<{ at: string; value: null; band: null; reason: StressHourReason }>;
export type StressCurve = Readonly<{ version: typeof STRESS_CURVE_VERSION; hours: readonly StressHour[] }>;

const HOUR_MS = 3_600_000;
// Below this a same-hour spread is measurement noise, so an hour's z cannot run away on a flat history (the heart-rate floor is the
// energy windows' noise floor, in beats; an ln-scale HRV spread is a fraction).
const HEART_RATE_SPREAD_FLOOR = NOISE_FLOOR;
const HRV_SPREAD_FLOOR = 0.02;
const HRV_ORDER: readonly HrvMethod[] = ['rmssd', 'sdnn'];
const POINTS_PER_SPREAD = 20;
const MAX_HOURS = 24;
const round1 = (value: number) => Math.round(value * 10) / 10;

const wallHour = (startMs: number, timeZone: string): number => Math.floor(wallMinute(startMs, timeZone) / 60);
const overlapsWorkout = (record: DayRecord, startMs: number): boolean =>
  record.workouts.some(workout => Date.parse(workout.startAt) < startMs + HOUR_MS && Date.parse(workout.endAt) > startMs);

// An hour that says something about strain: a heart rate, known movement under the resting limit and no workout in it.
const restingBucket = (record: DayRecord, bucket: HourlyBucket): boolean =>
  bucket.heartRate !== null && bucket.movementMinutes !== null && bucket.movementMinutes < RESTING_MOVEMENT_MINUTES && !overlapsWorkout(record, Date.parse(bucket.startAt));

type History = Readonly<{ heartRate: number[]; hrv: Readonly<Record<HrvMethod, number[]>> }>;
// The owner's earlier days' resting hours at each wall-clock hour, from the day's wake to the sleep that follows it.
const historyByHour = (earlier: readonly DayRecord[], byDay: ReadonlyMap<string, DayRecord>): ReadonlyMap<number, History> => {
  const byHour = new Map<number, { heartRate: number[]; hrv: Record<HrvMethod, number[]> }>();
  for (const record of earlier) {
    if (!record.sleep) continue;
    const wake = Date.parse(record.sleep.endAt);
    const nextDay = [...byDay.values()].find(other => Date.parse(`${other.day}T00:00:00Z`) - Date.parse(`${record.day}T00:00:00Z`) === 24 * HOUR_MS);
    const nextSleep = nextDay?.sleep ? Date.parse(nextDay.sleep.startAt) : null;
    for (const bucket of record.hourly) {
      const start = Date.parse(bucket.startAt);
      if (!restingBucket(record, bucket) || start < wake || (nextSleep !== null && start + HOUR_MS > nextSleep)) continue;
      const hour = wallHour(start, record.timezone);
      const entry = byHour.get(hour) ?? { heartRate: [], hrv: { rmssd: [], sdnn: [] } };
      entry.heartRate.push(bucket.heartRate!);
      for (const reading of bucket.hrvReadings) if (reading.value > 0) entry.hrv[reading.method].push(Math.log(reading.value));
      byHour.set(hour, entry);
    }
  }
  return byHour;
};

const spreadOf = (values: readonly number[], floor: number): number => {
  const centre = mean(values);
  return Math.max(floor, Math.sqrt(mean(values.map(value => (value - centre) ** 2))));
};

// Today's curve, or none when there is no wake to start from or no hour of it that has a value. A curve holds the last 24 hours at most.
export const stressCurve = (input: Readonly<{ targetDay: string; days: readonly DayRecord[]; asOf: string | null }>): StressCurve | null => {
  const byDay = byLocalDay(input.days);
  const target = byDay?.get(input.targetDay);
  if (!byDay || !target?.sleep) return null;
  const history = historyByHour(priorDays(input.targetDay, byDay), byDay);
  const buckets = new Map(target.hourly.map(bucket => [Date.parse(bucket.startAt), bucket] as const));
  const { start: dayStart, end: dayEnd } = localDayWindow(target.day, target.timezone);
  const wake = Math.max(Date.parse(target.sleep.endAt), dayStart);
  const settledBy = input.asOf === null ? dayEnd : Math.min(dayEnd, Date.parse(input.asOf));

  const hours: StressHour[] = [];
  for (let start = dayStart + Math.ceil((wake - dayStart) / HOUR_MS) * HOUR_MS; start + HOUR_MS <= settledBy; start += HOUR_MS) {
    const at = new Date(start).toISOString();
    const missing = (reason: StressHourReason): StressHour => ({ at, value: null, band: null, reason });
    const bucket = buckets.get(start);
    if (overlapsWorkout(target, start)) { hours.push(missing('workout')); continue; }
    if (!bucket || bucket.heartRate === null || bucket.movementMinutes === null) { hours.push(missing('no_reading')); continue; }
    if (bucket.movementMinutes >= RESTING_MOVEMENT_MINUTES) { hours.push(missing('moving')); continue; }
    const same = history.get(wallHour(start, target.timezone));
    if (!same || same.heartRate.length < MIN_DAYS_PER_HOUR) { hours.push(missing('baseline_immature')); continue; }
    const heartRate = clampScore(50 + POINTS_PER_SPREAD * (bucket.heartRate - mean(same.heartRate)) / spreadOf(same.heartRate, HEART_RATE_SPREAD_FLOOR));
    const parts = [heartRate];
    // The hour's HRV, in the first method that has enough same-hour days of its own: methods are never mixed.
    for (const method of HRV_ORDER) {
      const reading = bucket.hrvReadings.find(entry => entry.method === method);
      const own = same.hrv[method];
      if (reading && reading.value > 0 && own.length >= MIN_DAYS_PER_HOUR) {
        parts.push(clampScore(50 - POINTS_PER_SPREAD * (Math.log(reading.value) - mean(own)) / spreadOf(own, HRV_SPREAD_FLOOR)));
        break;
      }
    }
    const value = round1(mean(parts));
    hours.push({ at, value, band: stressBandOf(value) });
  }
  const shown = hours.slice(-MAX_HOURS);
  return shown.some(hour => hour.value !== null) ? { version: STRESS_CURVE_VERSION, hours: shown } : null;
};
