import { ALGORITHM } from './recovery';
import { usualSleepMinutes } from './recovery';
import { shiftDay } from './time';
import type { DayRecord, SleepDebtResult, Unavailable } from './types';

const NIGHTS = 14;
// Recent nights count more: age 0 weighs 1, age 13 weighs 0.5.
const weights = Array.from({ length: NIGHTS }, (_, age) => 1 - age / 26);
const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export const sleepDebt = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>, prior: readonly DayRecord[], sleepNeedMinutes: number | null): SleepDebtResult | Unavailable => {
  const nights = weights.map((weight, age) => ({ weight, day: shiftDay(targetDay, -age), minutes: byDay.get(shiftDay(targetDay, -age))?.sleep?.asleepMinutes ?? null }));
  if (nights.every(night => night.minutes === null)) return { state: 'unavailable', reason: 'missing_sleep' };
  const usual = sleepNeedMinutes === null ? usualSleepMinutes(prior) : null;
  const need = sleepNeedMinutes ?? usual;
  if (need === null || need <= 0) return { state: 'unavailable', reason: 'baseline_immature' };

  let observedWeight = 0;
  let shortfall = 0;
  const missing: string[] = [];
  for (const night of nights) {
    if (night.minutes === null) { missing.push(night.day); continue; }
    observedWeight += night.weight;
    shortfall += Math.max(0, need - night.minutes) * night.weight;
  }
  return {
    state: missing.length ? 'partial' : 'available', algorithm_version: ALGORITHM.sleepDebt, activation: 'candidate_unaccepted',
    debt_minutes: missing.length ? null : round3(shortfall), observed_weighted_shortfall_minutes: round3(shortfall),
    observed_nights: NIGHTS - missing.length, coverage: round3(observedWeight / totalWeight), missing_nights: missing,
    sleep_need_minutes: round3(need), need_basis: sleepNeedMinutes === null ? 'own_average' : 'owner_confirmed',
  };
};
