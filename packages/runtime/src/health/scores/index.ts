import { formScore } from './form';
import { ALGORITHM, recoveryBasis } from './recovery';
import { sleepDebt } from './sleep-debt';
import { BASELINE_WINDOW_DAYS, combine } from './stats';
import { daysBetween, isTimeZone, localDayWindow } from './time';
import { recoveryZone } from './zones';
import { weightScore } from './weight';
import type { DailyScores, DailyScoresInput, DayRecord, RecoveryResult, Unavailable, UnavailableReason } from './types';

export type { DailyScores, DailyScoresInput, DayRecord, HourlyBucket, UnavailableReason } from './types';

const everywhere = (reason: UnavailableReason): DailyScores => {
  const unavailable: Unavailable = { state: 'unavailable', reason };
  return { recovery: unavailable, sleep_debt: unavailable, form: unavailable, weight: unavailable };
};

// A day owns only the hourly readings inside its own local day, in the zone it was read in. That
// is 23 or 25 hours across a clock change, and a day read while travelling keeps its own zone.
const withinLocalDay = (record: DayRecord): DayRecord => {
  const { start, end } = localDayWindow(record.day, record.timezone);
  return { ...record, hourly: record.hourly.filter(bucket => { const at = Date.parse(bucket.startAt); return at >= start && at < end; }) };
};

// One owner, one target day. Pure: no clock, no I/O, same input gives the same output.
export const computeDailyScores = (input: DailyScoresInput): DailyScores => {
  if (input.access !== 'granted') return everywhere(input.access);
  if (input.days.length === 0) return everywhere('no_readings');

  if (input.days.some(record => !isTimeZone(record.timezone))) return everywhere('conflicting_inputs');
  const byDay = new Map<string, DayRecord>();
  for (const raw of input.days) {
    const record = withinLocalDay(raw);
    const existing = byDay.get(record.day);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) return everywhere('conflicting_inputs');
    byDay.set(record.day, record);
  }
  const target: DayRecord = byDay.get(input.targetDay)
    ?? { day: input.targetDay, timezone: input.days[0]?.timezone ?? 'UTC', sleep: null, overnightHrv: null, restingHeartRate: null, hourly: [], workouts: [], demand: null };
  const prior = [...byDay.values()].filter(record => {
    const age = daysBetween(record.day, input.targetDay);
    return age >= 1 && age <= BASELINE_WINDOW_DAYS;
  });

  const basis = recoveryBasis(target, prior, input.sleepNeedMinutes);
  let recovery: RecoveryResult;
  if ('reason' in basis) recovery = { state: 'unavailable', reason: basis.reason };
  else {
    const { score, coverage } = combine(basis.components);
    recovery = { state: 'available', score, zone: recoveryZone(score), algorithm_version: ALGORITHM.recovery, activation: 'candidate_unaccepted', coverage, hrv_method: basis.hrvMethod, used: { signals: basis.signals, days: basis.days } };
  }
  return {
    recovery,
    sleep_debt: sleepDebt(input.targetDay, byDay, prior, input.sleepNeedMinutes),
    form: formScore(target, prior, input.sleepNeedMinutes, input.asOf, input.source ?? null),
    weight: weightScore(target, prior),
  };
};
