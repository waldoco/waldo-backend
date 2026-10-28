import { circularStanding, labelOf, standing } from './baseline';
import { ALGORITHM, PROVISIONAL_ALGORITHM, provisionalRecoveryBasis, recoveryBasis } from './recovery';
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
// The provisional stress part keeps hourly HRV of each method apart: a day is read against its own method's days only.
const HRV_METHODS = ['rmssd', 'sdnn'] as const;
const stressReadingByMethod = (day: DayRecord): Readonly<{ heartRate: number; hrv: Readonly<Record<(typeof HRV_METHODS)[number], number | null>> }> | null => {
  const buckets = awakeRestingBuckets(day);
  const heartRates = buckets.flatMap(bucket => (bucket.heartRate === null ? [] : [bucket.heartRate]));
  if (heartRates.length < MIN_STRESS_BUCKETS) return null;
  const meanOf = (method: (typeof HRV_METHODS)[number]) => {
    const values = buckets.flatMap(bucket => (bucket.hrv === null || bucket.hrvMethod !== method ? [] : [bucket.hrv]));
    return values.length >= MIN_HRV_BUCKETS ? mean(values) : null;
  };
  return { heartRate: mean(heartRates), hrv: { rmssd: meanOf('rmssd'), sdnn: meanOf('sdnn') } };
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
export const formHours = (day: DayRecord): DayRecord =>
  ({ ...day, hourly: day.hourly.filter(bucket => bucket.heartRate !== null || bucket.hrv !== null || bucket.daylightMinutes !== null || bucket.movementMinutes !== null) });

// What Form reads of a day read at `asOf`, or null when the day holds no hour of its own. The day's data horizon is the end of its
// newest hour. A day still running needs that horizon recent; a finished day is judged on the hours it has, so a recompute the
// next morning does not turn it stale. Only the current hour grows, so the newest hour, while the read falls inside it, is left
// out on both sides until it ends: `settled` is the instant the day's hours are taken through.
export const formReading = (record: DayRecord, asOf: string | null): Readonly<{ stale: boolean; settled: number }> | null => {
  const target = formHours(record);
  if (target.hourly.length === 0) return null;
  const { end } = localDayWindow(target.day, target.timezone);
  const horizon = Math.max(...target.hourly.map(bucket => Date.parse(bucket.startAt))) + HOUR_MS;
  const stale = asOf !== null && Date.parse(asOf) < end && Date.parse(asOf) - horizon > FRESH_HOURS * HOUR_MS;
  const filling = asOf !== null && Date.parse(asOf) >= horizon - HOUR_MS && Date.parse(asOf) < horizon;
  return { stale, settled: filling ? horizon - HOUR_MS : horizon };
};

// What one evaluation of Form leaves besides its result: the stress part's own score where the day had a stress reading (higher
// is calmer, as Form weighs it), null when Form is unavailable.
export type FormEvaluation = Readonly<{ result: FormResult; stress: number | null }>;
const none = (reason: Extract<FormResult, { state: 'unavailable' }>['reason']): FormEvaluation => ({ result: { state: 'unavailable', reason }, stress: null });

export const formScore = (record: DayRecord, earlier: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null, provisional = false): FormResult =>
  evaluateForm(record, earlier, sleepNeedMinutes, asOf, provisional).result;

export const evaluateForm = (record: DayRecord, earlier: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null, provisional = false): FormEvaluation => {
  const target = formHours(record), prior = earlier.map(formHours);
  const recovery = provisional ? provisionalRecoveryBasis(target, prior, sleepNeedMinutes) : recoveryBasis(target, prior, sleepNeedMinutes);
  if ('reason' in recovery) return none(recovery.reason);
  const reading = formReading(target, asOf);
  if (reading === null) return none('intraday_inputs_unavailable');
  if (reading.stale) return none('stale_inputs');
  const { settled } = reading;
  const { end } = localDayWindow(target.day, target.timezone);
  const cutoff = settled >= end ? null : wallMinute(settled, target.timezone);
  const sameHours = (day: DayRecord) => throughMinute(day, cutoff);
  const today = sameHours(target);

  const scale = FORM_WEIGHTS.recovery;
  const components: Component[] = recovery.components.map(component => ({ ...component, name: `recovery.${component.name}`, weight: component.weight * scale }));
  const signals = [...recovery.signals];
  const days = new Set<string>(recovery.days);
  const add = (name: string, score: number, weight: number, used: readonly string[]) => { components.push({ name, score, weight }); signals.push(name); used.forEach(day => days.add(day)); };

  const own: number[] = [...('own' in recovery ? recovery.own ?? [] : [])];
  const usedPrior = 'usedPrior' in recovery && recovery.usedPrior === true;
  // A component with no prior joins at seven own days and is judged against its own days alone.
  const addOwn = (name: string, at: ReturnType<typeof standing>, entries: readonly { day: string }[], weight: number, score: (z: number) => number) => {
    if (at === null) return;
    add(name, score(at.z), weight, entries.map(entry => entry.day));
    own.push(at.own);
  };
  if (provisional) {
    const midpoints = target.sleep ? history(prior, day => day.sleep?.midpointMinute ?? null) : [];
    if (target.sleep) addOwn('sleep_midpoint', circularStanding(target.sleep.midpointMinute, midpoints.map(entry => entry.value)), midpoints, FORM_WEIGHTS.midpoint, nearUsual);
    const daylight = dayTotal(today, bucket => bucket.daylightMinutes);
    const daylightHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.daylightMinutes));
    if (daylight !== null) addOwn('daylight', standing(daylight, daylightHistory.map(entry => entry.value), null), daylightHistory, FORM_WEIGHTS.daylight, nearUsual);
    const movement = dayTotal(today, bucket => bucket.movementMinutes);
    const movementHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.movementMinutes));
    if (movement !== null) addOwn('movement', standing(movement, movementHistory.map(entry => entry.value), null), movementHistory, FORM_WEIGHTS.motion, nearUsual);
    const stress = stressReadingByMethod(today);
    const stressHistory = history(prior, day => stressReadingByMethod(sameHours(day)));
    const heartRate = stress && standing(stress.heartRate, stressHistory.map(entry => entry.value.heartRate), null);
    if (stress && heartRate) {
      const parts = [lowerIsBetter(heartRate.z)], counts = [heartRate.own];
      // The day's own HRV method, against that method's own days only; the first method with a baseline of its own.
      for (const method of HRV_METHODS) {
        const value = stress.hrv[method];
        const ownValues = stressHistory.flatMap(entry => (entry.value.hrv[method] === null ? [] : [entry.value.hrv[method]!]));
        const at = value === null ? null : standing(value, ownValues, null, 'ln');
        if (at) { parts.push(higherIsBetter(at.z)); counts.push(at.own); break; }
      }
      add('stress', mean(parts), FORM_WEIGHTS.stress, stressHistory.map(entry => entry.day));
      own.push(...counts);
    }
  } else {
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
  }
  if (!signals.some(name => name === 'daylight' || name === 'movement' || name === 'stress')) return none('baseline_immature');

  const { score, coverage } = combine(components);
  const used = { signals, days: [...days].sort() };
  const stress = components.find(component => component.name === 'stress')?.score ?? null;
  const result: FormResult = provisional
    ? { state: 'available', score, zone: formZone(score), algorithm_version: PROVISIONAL_ALGORITHM.form, activation: 'accepted', coverage, hrv_method: recovery.hrvMethod, used, baseline: labelOf(own, usedPrior) }
    : { state: 'available', score, zone: formZone(score), algorithm_version: ALGORITHM.form, activation: 'candidate_unaccepted', coverage, hrv_method: recovery.hrvMethod, used };
  return { result, stress };
};
