import { labelOf } from './baseline';
import { driversOf } from './drivers';
import { formScore } from './form';
import { ALGORITHM, PROVISIONAL_ALGORITHM, provisionalRecoveryBasis, recoveryBasis } from './recovery';
import { energyWindows } from './energy-windows';
import { priorDays, sleepDebt } from './sleep-debt';
import { combine } from './stats';
import { isTimeZone, localDayWindow } from './time';
import { recoveryZone } from './zones';
import { weightScore } from './weight';
import type { DailyScores, DailyScoresInput, DayRecord, RecoveryResult, Unavailable, UnavailableReason } from './types';

export type { DailyScores, DailyScoresInput, DayRecord, DayVitals, HourlyBucket, UnavailableReason } from './types';

const everywhere = (reason: UnavailableReason): DailyScores => {
  const unavailable: Unavailable = { state: 'unavailable', reason };
  return { recovery: unavailable, drivers: [], sleep_debt: unavailable, form: unavailable, weight: unavailable };
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
    ?? { day: input.targetDay, timezone: input.days[0]?.timezone ?? 'UTC', sleep: null, overnightHrv: [], restingHeartRate: [], hourly: [], workouts: [], demand: null };
  const prior = priorDays(input.targetDay, byDay);

  const provisional = input.provisional === true;
  const basis = provisional ? provisionalRecoveryBasis(target, prior, input.sleepNeedMinutes) : recoveryBasis(target, prior, input.sleepNeedMinutes);
  let recovery: RecoveryResult;
  if ('reason' in basis) recovery = { state: 'unavailable', reason: basis.reason };
  else {
    const { score, coverage } = combine(basis.components);
    const used = { signals: basis.signals, days: basis.days };
    recovery = provisional
      ? { state: 'available', score, zone: recoveryZone(score), algorithm_version: PROVISIONAL_ALGORITHM.recovery, activation: 'accepted', coverage, hrv_method: basis.hrvMethod, used, baseline: labelOf(basis.own ?? [], basis.usedPrior === true) }
      : { state: 'available', score, zone: recoveryZone(score), algorithm_version: ALGORITHM.recovery, activation: 'candidate_unaccepted', coverage, hrv_method: basis.hrvMethod, used };
  }
  const debt = sleepDebt(input.targetDay, byDay, prior, input.sleepNeedMinutes, provisional);
  return {
    recovery,
    drivers: driversOf(target, prior),
    sleep_debt: debt,
    form: formScore(target, prior, input.sleepNeedMinutes, input.asOf, provisional),
    weight: weightScore(target, prior, provisional),
    ...(provisional ? { windows: energyWindows({ targetDay: input.targetDay, days: [...byDay.values()], recoveryZone: recovery.state === 'available' ? recovery.zone : null, sleepTrend: debt.state === 'unavailable' ? 'steady' : debt.trend ?? 'steady' }) } : {}),
  };
};

// The engine the owner's recompute runs, chosen by the HEALTH_PROVISIONAL_SCORES variable: only the exact value "1" turns
// provisional scores on, and anything else is the earlier engine itself.
export const dailyScoresFor = (flag: string | undefined): ((input: DailyScoresInput) => DailyScores) =>
  (flag === '1' ? input => computeDailyScores({ ...input, provisional: true }) : computeDailyScores);
