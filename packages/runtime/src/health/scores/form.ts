import { ALGORITHM, recoveryBasis } from './recovery';
import { BASELINE_DAYS, circularZScore, combine, higherIsBetter, lowerIsBetter, mean, nearUsual, zScore, logZScore, type Component } from './stats';
import { localDayWindow, wallMinute } from './time';
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
// The phone sends a summed signal only for hours that hold some of it, so on a day that carries the signal an hour
// without it is none. A day with no reading for it is unknown, not zero: the source may not measure it at all.
const dayTotal = (day: DayRecord, pick: (bucket: HourlyBucket) => number | null): number | null => {
  const readings = day.hourly.flatMap(bucket => { const value = pick(bucket); return value === null ? [] : [value]; });
  return day.hourly.length >= MIN_DAY_BUCKETS && readings.length > 0 ? readings.reduce((total, value) => total + value, 0) : null;
};
const stressReading = (day: DayRecord): Readonly<{ heartRate: number; hrv: number | null }> | null => {
  const buckets = awakeRestingBuckets(day);
  const heartRates = buckets.flatMap(bucket => (bucket.heartRate === null ? [] : [bucket.heartRate]));
  if (heartRates.length < MIN_STRESS_BUCKETS) return null;
  const hrvs = buckets.flatMap(bucket => (bucket.hrv === null || bucket.hrvMethod !== 'rmssd' ? [] : [bucket.hrv]));
  return { heartRate: mean(heartRates), hrv: hrvs.length >= MIN_HRV_BUCKETS ? mean(hrvs) : null };
};
const history = <T,>(prior: readonly DayRecord[], read: (day: DayRecord) => T | null) =>
  prior.flatMap(day => { const value = read(day); return value === null ? [] : [{ day: day.day, value }]; });
// A day still in progress is compared with the same hours of the owner's earlier days, matched on each day's own wall
// clock: its 15:00 is 14 hours after midnight on a spring-forward day and it is still 15:00, and an earlier day spent in
// another zone is cut at 15:00 there. Null minutes is the whole day.
const throughMinute = (day: DayRecord, minute: number | null): DayRecord =>
  (minute === null ? day : { ...day, hourly: day.hourly.filter(bucket => wallMinute(Date.parse(bucket.startAt), day.timezone) < minute) });
// Form reads the hours that hold one of its own signals. An hour holding only active energy is Weight's, so it never counts
// toward Form's hours, its data horizon or the hour still filling.
const formHours = (day: DayRecord): DayRecord =>
  ({ ...day, hourly: day.hourly.filter(bucket => bucket.heartRate !== null || bucket.hrv !== null || bucket.daylightMinutes !== null || bucket.movementMinutes !== null) });

export const formScore = (record: DayRecord, earlier: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null): FormResult => {
  const target = formHours(record), prior = earlier.map(formHours);
  const recovery = recoveryBasis(target, prior, sleepNeedMinutes);
  if ('reason' in recovery) return { state: 'unavailable', reason: recovery.reason };
  if (target.hourly.length === 0) return { state: 'unavailable', reason: 'intraday_inputs_unavailable' };
  // The day's data horizon: the end of its newest hour. A day still running needs that horizon recent; a finished day is
  // judged on the hours it has, so a recompute the next morning does not turn it stale.
  const { end } = localDayWindow(target.day, target.timezone);
  const horizon = Math.max(...target.hourly.map(bucket => Date.parse(bucket.startAt))) + HOUR_MS;
  if (asOf !== null && Date.parse(asOf) < end && Date.parse(asOf) - horizon > FRESH_HOURS * HOUR_MS) return { state: 'unavailable', reason: 'stale_inputs' };
  // Only the current hour grows, so the newest hour, while the read falls inside it, is left out on both sides until it ends.
  const filling = asOf !== null && Date.parse(asOf) >= horizon - HOUR_MS && Date.parse(asOf) < horizon;
  const settled = filling ? horizon - HOUR_MS : horizon;
  const cutoff = settled >= end ? null : wallMinute(settled, target.timezone);
  const sameHours = (day: DayRecord) => throughMinute(day, cutoff);
  const today = sameHours(target);

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
  const daylight = dayTotal(today, bucket => bucket.daylightMinutes);
  const daylightHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.daylightMinutes));
  if (daylight !== null && daylightHistory.length >= BASELINE_DAYS) add('daylight', nearUsual(zScore(daylight, daylightHistory.map(entry => entry.value))), FORM_WEIGHTS.daylight, daylightHistory.map(entry => entry.day));
  const movement = dayTotal(today, bucket => bucket.movementMinutes);
  const movementHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.movementMinutes));
  if (movement !== null && movementHistory.length >= BASELINE_DAYS) add('movement', nearUsual(zScore(movement, movementHistory.map(entry => entry.value))), FORM_WEIGHTS.motion, movementHistory.map(entry => entry.day));
  const stress = stressReading(today);
  const stressHistory = history(prior, day => stressReading(sameHours(day)));
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
