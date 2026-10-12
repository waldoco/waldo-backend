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

type Normalised = Readonly<{ byDay: Map<string, DayRecord>; target: DayRecord; prior: DayRecord[] }>;

// Null when a zone is invalid or one day arrives twice with different readings.
const normalise = (days: readonly DayRecord[], targetDay: string): Normalised | null => {
  if (days.some(record => !isTimeZone(record.timezone))) return null;
  const byDay = new Map<string, DayRecord>();
  for (const raw of days) {
    const record = withinLocalDay(raw);
    const existing = byDay.get(record.day);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) return null;
    byDay.set(record.day, record);
  }
  const target: DayRecord = byDay.get(targetDay)
    ?? { day: targetDay, timezone: days[0]?.timezone ?? 'UTC', sleep: null, overnightHrv: null, restingHeartRate: null, hourly: [], workouts: [], demand: null };
  const prior = [...byDay.values()].filter(record => {
    const age = daysBetween(record.day, targetDay);
    return age >= 1 && age <= BASELINE_WINDOW_DAYS;
  });
  return { byDay, target, prior };
};

// One owner, one target day. Pure: no clock, no I/O, same input gives the same output.
export const computeDailyScores = (input: DailyScoresInput): DailyScores => {
  if (input.access !== 'granted') return everywhere(input.access);
  if (input.days.length === 0) return everywhere('no_readings');
  const primary = normalise(input.days, input.targetDay);
  if (!primary) return everywhere('conflicting_inputs');
  const { byDay, target, prior } = primary;

  const basis = recoveryBasis(target, prior, input.sleepNeedMinutes);
  let recovery: RecoveryResult;
  if ('reason' in basis) recovery = { state: 'unavailable', reason: basis.reason };
  else {
    const { score, coverage } = combine(basis.components);
    recovery = { state: 'available', score, zone: recoveryZone(score), algorithm_version: ALGORITHM.recovery, activation: 'candidate_unaccepted', coverage, hrv_method: basis.hrvMethod, used: { signals: basis.signals, days: basis.days } };
  }
  // A source whose own days conflict is left out of Form rather than voiding the other sources.
  const formSources = (input.formSources ?? (input.source ? [{ source: input.source, days: input.days }] : []))
    .flatMap(({ source, days }) => {
      const normalised = normalise(days, input.targetDay);
      return normalised ? [{ source, target: normalised.target, prior: normalised.prior }] : [];
    });
  return {
    recovery,
    sleep_debt: sleepDebt(input.targetDay, byDay, prior, input.sleepNeedMinutes),
    form: formScore(formSources, input.sleepNeedMinutes, input.asOf),
    weight: weightScore(target, prior),
  };
};
