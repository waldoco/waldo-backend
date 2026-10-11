import { ALGORITHM, recoveryBasis } from './recovery';
import { BASELINE_DAYS, circularZScore, combine, higherIsBetter, lowerIsBetter, mean, nearUsual, zScore, logZScore, type Component } from './stats';
import { formZone } from './zones';
import type { DayRecord, FormResult, HourlyBucket } from './types';

const FORM_WEIGHTS = { recovery: 0.4, midpoint: 0.1, daylight: 0.1, motion: 0.2, stress: 0.2 } as const;
const HOUR_MS = 3_600_000;
const MIN_DAY_BUCKETS = 8;
const MIN_STRESS_BUCKETS = 8;
const MIN_HRV_BUCKETS = 4;
const FRESH_HOURS = 6;

const overlaps = (startMs: number, span: Readonly<{ startAt: string; endAt: string }>): boolean => {
  const from = Date.parse(span.startAt);
  const to = Date.parse(span.endAt);
  return !Number.isNaN(from) && !Number.isNaN(to) && startMs < to && startMs + HOUR_MS > from;
};
// Hours the owner was awake and not working out: the only hours that say anything about stress.
const awakeRestingBuckets = (day: DayRecord): readonly HourlyBucket[] =>
  day.hourly.filter(bucket => {
    const start = Date.parse(bucket.startAt);
    return !(day.sleep && overlaps(start, day.sleep)) && !day.workouts.some(workout => overlaps(start, workout));
  });
const sum = (values: readonly (number | null)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);
const dayTotal = (day: DayRecord, pick: (bucket: HourlyBucket) => number | null): number | null => (day.hourly.length >= MIN_DAY_BUCKETS ? sum(day.hourly.map(pick)) : null);
const stressReading = (day: DayRecord): Readonly<{ heartRate: number; hrv: number | null }> | null => {
  const buckets = awakeRestingBuckets(day);
  const heartRates = buckets.flatMap(bucket => (bucket.heartRate === null ? [] : [bucket.heartRate]));
  if (heartRates.length < MIN_STRESS_BUCKETS) return null;
  const hrvs = buckets.flatMap(bucket => (bucket.hrv === null || bucket.hrvMethod !== 'rmssd' ? [] : [bucket.hrv]));
  return { heartRate: mean(heartRates), hrv: hrvs.length >= MIN_HRV_BUCKETS ? mean(hrvs) : null };
};
const history = <T,>(prior: readonly DayRecord[], read: (day: DayRecord) => T | null) =>
  prior.flatMap(day => { const value = read(day); return value === null ? [] : [{ day: day.day, value }]; });

export const formScore = (target: DayRecord, prior: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null): FormResult => {
  const recovery = recoveryBasis(target, prior, sleepNeedMinutes);
  if ('reason' in recovery) return { state: 'unavailable', reason: recovery.reason };
  if (target.hourly.length === 0) return { state: 'unavailable', reason: 'intraday_inputs_unavailable' };
  if (asOf !== null) {
    const newest = Math.max(...target.hourly.map(bucket => Date.parse(bucket.startAt))) + HOUR_MS;
    if (Date.parse(asOf) - newest > FRESH_HOURS * HOUR_MS) return { state: 'unavailable', reason: 'stale_inputs' };
  }

  const scale = FORM_WEIGHTS.recovery;
  const components: Component[] = recovery.components.map(component => ({ ...component, name: `recovery.${component.name}`, weight: component.weight * scale }));
  const signals = [...recovery.signals];
  const days = new Set<string>(recovery.days);
  const add = (name: string, score: number, weight: number, used: readonly string[]) => { components.push({ name, score, weight }); signals.push(name); used.forEach(day => days.add(day)); };

  const midpoints = target.sleep ? history(prior, day => day.sleep?.midpointMinute ?? null) : [];
  if (target.sleep && midpoints.length >= BASELINE_DAYS) {
    const z = circularZScore(target.sleep.midpointMinute, midpoints.map(entry => entry.value));
    if (z !== null) add('sleep_midpoint', nearUsual(z), FORM_WEIGHTS.midpoint, midpoints.map(entry => entry.day));
  }
  const daylight = dayTotal(target, bucket => bucket.daylightMinutes);
  const daylightHistory = history(prior, day => dayTotal(day, bucket => bucket.daylightMinutes));
  if (daylight !== null && daylightHistory.length >= BASELINE_DAYS) add('daylight', nearUsual(zScore(daylight, daylightHistory.map(entry => entry.value))), FORM_WEIGHTS.daylight, daylightHistory.map(entry => entry.day));
  const movement = dayTotal(target, bucket => bucket.movementMinutes);
  const movementHistory = history(prior, day => dayTotal(day, bucket => bucket.movementMinutes));
  if (movement !== null && movementHistory.length >= BASELINE_DAYS) add('movement', nearUsual(zScore(movement, movementHistory.map(entry => entry.value))), FORM_WEIGHTS.motion, movementHistory.map(entry => entry.day));
  const stress = stressReading(target);
  const stressHistory = history(prior, stressReading);
  if (stress && stressHistory.length >= BASELINE_DAYS) {
    const parts = [lowerIsBetter(zScore(stress.heartRate, stressHistory.map(entry => entry.value.heartRate)))];
    const hrvHistory = stressHistory.flatMap(entry => (entry.value.hrv === null ? [] : [entry.value.hrv]));
    if (stress.hrv !== null && hrvHistory.length >= BASELINE_DAYS) parts.push(higherIsBetter(logZScore(stress.hrv, hrvHistory)));
    add('stress', mean(parts), FORM_WEIGHTS.stress, stressHistory.map(entry => entry.day));
  }
  if (!signals.some(name => name === 'daylight' || name === 'movement' || name === 'stress')) return { state: 'unavailable', reason: 'baseline_immature' };

  const { score, coverage } = combine(components);
  return { state: 'available', score, zone: formZone(score), algorithm_version: ALGORITHM.form, activation: 'candidate_unaccepted', coverage, hrv_method: recovery.hrvMethod, used: { signals, days: [...days].sort() } };
};
