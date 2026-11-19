import { circularStanding, labelOf, standing } from './baseline';
import { ALGORITHM, PROVISIONAL_ALGORITHM, provisionalRecoveryBasis, recoveryBasis } from './recovery';
import { BASELINE_DAYS, circularZScore, combine, higherIsBetter, lowerIsBetter, mean, nearUsual, readingsOf, SCORE_OF, zScore, logZScore, type Component, type Sense } from './stats';
import { localDayWindow, wallMinute } from './time';
import { formZone } from './zones';
import { fromTheNight, partRows, PART_ORDER } from './parts';
import { usualOfStanding } from './usual';
import type { Absent, DayRecord, FormResult, HourlyBucket, HrvMethod, UsedSignal } from './types';

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
const hrvOf = (bucket: HourlyBucket, method: HrvMethod): number | null => bucket.hrvReadings.find(reading => reading.method === method)?.value ?? null;
const stressReading = (day: DayRecord): Readonly<{ heartRate: number; hrv: number | null }> | null => {
  const buckets = awakeRestingBuckets(day);
  const heartRates = buckets.flatMap(bucket => (bucket.heartRate === null ? [] : [bucket.heartRate]));
  if (heartRates.length < MIN_STRESS_BUCKETS) return null;
  const hrvs = buckets.flatMap(bucket => { const value = hrvOf(bucket, 'rmssd'); return value === null ? [] : [value]; });
  return { heartRate: mean(heartRates), hrv: hrvs.length >= MIN_HRV_BUCKETS ? mean(hrvs) : null };
};
// The provisional stress part keeps hourly HRV of each method apart: a day is read against its own method's days only.
const HRV_METHODS = ['rmssd', 'sdnn'] as const;
const stressReadingByMethod = (day: DayRecord): Readonly<{ heartRate: number; hrv: Readonly<Record<(typeof HRV_METHODS)[number], number | null>> }> | null => {
  const buckets = awakeRestingBuckets(day);
  const heartRates = buckets.flatMap(bucket => (bucket.heartRate === null ? [] : [bucket.heartRate]));
  if (heartRates.length < MIN_STRESS_BUCKETS) return null;
  const meanOf = (method: (typeof HRV_METHODS)[number]) => {
    const values = buckets.flatMap(bucket => { const value = hrvOf(bucket, method); return value === null ? [] : [value]; });
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
// toward Form's hours, its data horizon or the hour still filling. Steps are a signal of the provisional Form only; the earlier
// engine reads the hours it always read.
const formHours = (day: DayRecord, provisional: boolean): DayRecord =>
  ({ ...day, hourly: day.hourly.filter(bucket => bucket.heartRate !== null || bucket.hrvReadings.length > 0 || bucket.daylightMinutes !== null || bucket.movementMinutes !== null || (provisional && (bucket.steps ?? null) !== null)) });

// What Form reads of a day read at `asOf`, or null when the day holds no hour of its own. The day's data horizon is the end of its
// newest hour. A day still running needs that horizon recent; a finished day is judged on the hours it has, so a recompute the
// next morning does not turn it stale. Only the current hour grows, so the newest hour, while the read falls inside it, is left
// out on both sides until it ends: `settled` is the instant the day's hours are taken through.
export const formReading = (record: DayRecord, asOf: string | null, provisional: boolean): Readonly<{ stale: boolean; settled: number }> | null => {
  const target = formHours(record, provisional);
  if (target.hourly.length === 0) return null;
  const { end } = localDayWindow(target.day, target.timezone);
  const horizon = Math.max(...target.hourly.map(bucket => Date.parse(bucket.startAt))) + HOUR_MS;
  const stale = asOf !== null && Date.parse(asOf) < end && Date.parse(asOf) - horizon > FRESH_HOURS * HOUR_MS;
  const filling = asOf !== null && Date.parse(asOf) >= horizon - HOUR_MS && Date.parse(asOf) < horizon;
  return { stale, settled: filling ? horizon - HOUR_MS : horizon };
};

export const formScore = (record: DayRecord, earlier: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null, provisional = false, detail = false): FormResult => {
  const target = formHours(record, provisional), prior = earlier.map(day => formHours(day, provisional));
  const recovery = provisional ? provisionalRecoveryBasis(target, prior, sleepNeedMinutes) : recoveryBasis(target, prior, sleepNeedMinutes);
  if ('reason' in recovery) return { state: 'unavailable', reason: recovery.reason };
  const reading = formReading(target, asOf, provisional);
  if (reading === null) return { state: 'unavailable', reason: 'intraday_inputs_unavailable' };
  if (reading.stale) return { state: 'unavailable', reason: 'stale_inputs' };
  const { settled } = reading;
  const { end } = localDayWindow(target.day, target.timezone);
  const cutoff = settled >= end ? null : wallMinute(settled, target.timezone);
  const sameHours = (day: DayRecord) => throughMinute(day, cutoff);
  const today = sameHours(target);

  const scale = FORM_WEIGHTS.recovery;
  const components: Component[] = recovery.components.map(component => ({ ...component, name: `recovery.${component.name}`, weight: component.weight * scale }));
  const signals: UsedSignal[] = [...recovery.signals];
  const days = new Set<string>(recovery.days);
  const add = (name: UsedSignal, score: number, weight: number, used: readonly string[], extra: Pick<Component, 'basis' | 'usual' | 'today'> = {}) => { components.push({ name, score, weight, ...extra }); signals.push(name); used.forEach(day => days.add(day)); };
  const absent = new Map<string, Absent>('absent' in recovery ? recovery.absent ?? [] : []);

  const own: number[] = [...('own' in recovery ? recovery.own ?? [] : [])];
  const usedPrior = 'usedPrior' in recovery && recovery.usedPrior === true;
  // A component with no prior joins at seven own days and is judged against its own days alone.
  // A component with no usual band of its own kind (steps standing in for movement: the contract reads a steps band as the plain
  // mean of the owner's own days, not this estimate) keeps its direction and links to no band, as physical_load does.
  const addOwn = (name: UsedSignal, signal: string | null, value: number, at: ReturnType<typeof standing>, entries: readonly { day: string }[], weight: number, sense: Sense) => {
    if (at === null) { absent.set(name, 'baseline_immature'); return; }
    add(name, SCORE_OF[sense](at.z), weight, entries.map(entry => entry.day), { basis: { z: at.z, own: at.own, ownShare: at.ownShare, signals: signal ? [signal] : [] }, usual: signal === null ? undefined : usualOfStanding(signal, null, at) ?? undefined, today: { value, sense } });
    own.push(at.own);
  };
  if (provisional) {
    const midpoints = target.sleep ? history(prior, day => day.sleep?.midpointMinute ?? null) : [];
    if (target.sleep) addOwn('sleep_midpoint', 'sleep_midpoint', target.sleep.midpointMinute, circularStanding(target.sleep.midpointMinute, midpoints.map(entry => entry.value)), midpoints, FORM_WEIGHTS.midpoint, 'near');
    const daylight = dayTotal(today, bucket => bucket.daylightMinutes);
    const daylightHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.daylightMinutes));
    if (daylight === null) absent.set('daylight', 'no_reading');
    else addOwn('daylight', 'daylight', daylight, standing(daylight, daylightHistory.map(entry => entry.value), null), daylightHistory, FORM_WEIGHTS.daylight, 'near');
    const movement = dayTotal(today, bucket => bucket.movementMinutes);
    const movementHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.movementMinutes));
    if (movement !== null) addOwn('movement', 'movement', movement, standing(movement, movementHistory.map(entry => entry.value), null), movementHistory, FORM_WEIGHTS.motion, 'near');
    // A day with no movement minutes (Health Connect has none, nor an iPhone without a Watch) is read on its steps instead, against
    // its own days' steps through the same hours. Steps are walking volume, not effort, so they stand in for movement, never add to it.
    else {
      const steps = dayTotal(today, bucket => bucket.steps ?? null);
      const stepsHistory = history(prior, day => dayTotal(sameHours(day), bucket => bucket.steps ?? null));
      if (steps === null) absent.set('movement', 'no_reading');
      else addOwn('steps', null, steps, standing(steps, stepsHistory.map(entry => entry.value), null), stepsHistory, FORM_WEIGHTS.motion, 'near');
    }
    const stress = stressReadingByMethod(today);
    const stressHistory = history(prior, day => stressReadingByMethod(sameHours(day)));
    const heartRate = stress && standing(stress.heartRate, stressHistory.map(entry => entry.value.heartRate), null);
    if (!stress) absent.set('stress', 'no_reading');
    else if (!heartRate) absent.set('stress', 'baseline_immature');
    if (stress && heartRate) {
      const parts = [SCORE_OF.lower(heartRate.z)], counts = [heartRate.own];
      // The day's own HRV method, against that method's own days only; the first method with a baseline of its own.
      for (const method of HRV_METHODS) {
        const value = stress.hrv[method];
        const ownValues = stressHistory.flatMap(entry => (entry.value.hrv[method] === null ? [] : [entry.value.hrv[method]!]));
        const at = value === null ? null : standing(value, ownValues, null, 'ln');
        if (at) { parts.push(higherIsBetter(at.z)); counts.push(at.own); break; }
      }
      add('stress', mean(parts), FORM_WEIGHTS.stress, stressHistory.map(entry => entry.day), {
        today: { value: stress.heartRate, sense: 'lower' },
        basis: { z: heartRate.z, own: Math.min(...counts), ownShare: heartRate.ownShare, signals: ['stress_heart_rate'] }, usual: usualOfStanding('stress_heart_rate', null, heartRate) ?? undefined,
      });
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
  if (!signals.some(name => name === 'daylight' || name === 'movement' || name === 'steps' || name === 'stress')) return { state: 'unavailable', reason: 'baseline_immature' };

  const { score, coverage } = combine(components);
  const used = { signals, days: [...days].sort() };
  if (provisional) {
    const asked = detail ? (() => {
      const scaled = components.filter(component => component.name.startsWith('recovery.'));
      // Steps fill movement's part when they stand in for it, so the shares still make the whole score.
      const asPart = (name: string) => (name === 'steps' ? 'movement' : name);
      const ownParts = components.filter(component => !component.name.startsWith('recovery.')).map(component => ({ ...component, name: asPart(component.name) }));
      const rows = partRows(PART_ORDER.form, [fromTheNight(scaled), ...ownParts], new Map([...absent].map(([name, reason]) => [asPart(name), reason])));
      return { parts: rows, usual: components.flatMap(component => (component.usual ? [component.usual] : [])), readings: readingsOf(components) };
    })() : {};
    return { state: 'available', score, zone: formZone(score), algorithm_version: PROVISIONAL_ALGORITHM.form, activation: 'accepted', coverage, hrv_method: recovery.hrvMethod, used, baseline: labelOf(own, usedPrior), ...asked };
  }
  return { state: 'available', score, zone: formZone(score), algorithm_version: ALGORITHM.form, activation: 'candidate_unaccepted', coverage, hrv_method: recovery.hrvMethod, used };
};
