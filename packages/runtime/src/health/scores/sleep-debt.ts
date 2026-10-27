import { sleepNeed } from './baseline';
import { ALGORITHM, PROVISIONAL_ALGORITHM } from './recovery';
import { usualSleepMinutes } from './recovery';
import { shiftDay } from './time';
import type { DayRecord, SleepDebtResult, Unavailable } from './types';

const NIGHTS = 14;
// Recent nights count more: age 0 weighs 1, age 13 weighs 0.5.
const recency = Array.from({ length: NIGHTS }, (_, age) => 1 - age / 26);
const totalRecency = recency.reduce((sum, share) => sum + share, 0);
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// A figure needs this many of the fourteen nights, last night among them. Fewer give the share observed and no figure.
const MIN_OBSERVED_NIGHTS = 10;
// A night above need pays back this share of the surplus.
const REPAYMENT_RATE = 0.5;

// Sleep debt on the shared need: the owner's confirmed figure, or one taken from the nights before the target day. Nights are
// walked oldest to newest, so a long night repays only the debt before it, never below nothing, and banks no credit against
// a later short one. Both a short night and the repayment carry the recency weight of the night. The figure scales the
// shortfall to the weight of the nights observed.
const provisionalSleepDebt = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>, prior: readonly DayRecord[], sleepNeedMinutes: number | null): SleepDebtResult | Unavailable => {
  const nights = recency.map((share, age) => ({ share, day: shiftDay(targetDay, -age), minutes: byDay.get(shiftDay(targetDay, -age))?.sleep?.asleepMinutes ?? null }));
  if (nights.every(night => night.minutes === null)) return { state: 'unavailable', reason: 'missing_sleep' };
  const need = sleepNeedMinutes ?? sleepNeed(prior.flatMap(day => (day.sleep ? [day.sleep.asleepMinutes] : [])));
  if (need <= 0) return { state: 'unavailable', reason: 'baseline_immature' };

  let observedShare = 0;
  let shortfall = 0;
  const missing: string[] = [];
  for (const night of [...nights].reverse()) {
    if (night.minutes === null) { missing.push(night.day); continue; }
    observedShare += night.share;
    const gap = need - night.minutes;
    shortfall = gap > 0 ? shortfall + gap * night.share : Math.max(0, shortfall + gap * night.share * REPAYMENT_RATE);
  }
  missing.reverse();
  const observed = NIGHTS - missing.length;
  const figure = observed >= MIN_OBSERVED_NIGHTS && nights[0]!.minutes !== null;
  return {
    state: figure ? 'available' : 'partial', algorithm_version: PROVISIONAL_ALGORITHM.sleepDebt, activation: 'accepted',
    debt_minutes: figure ? round3(shortfall * totalRecency / observedShare) : null, observed_weighted_shortfall_minutes: round3(shortfall),
    observed_nights: observed, coverage: round3(observedShare / totalRecency), missing_nights: missing,
    sleep_need_minutes: round3(need), need_basis: sleepNeedMinutes === null ? 'own_average' : 'owner_confirmed',
  };
};

export const sleepDebt = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>, prior: readonly DayRecord[], sleepNeedMinutes: number | null, provisional = false): SleepDebtResult | Unavailable => {
  if (provisional) return provisionalSleepDebt(targetDay, byDay, prior, sleepNeedMinutes);
  const nights = recency.map((share, age) => ({ share, day: shiftDay(targetDay, -age), minutes: byDay.get(shiftDay(targetDay, -age))?.sleep?.asleepMinutes ?? null }));
  if (nights.every(night => night.minutes === null)) return { state: 'unavailable', reason: 'missing_sleep' };
  const usual = sleepNeedMinutes === null ? usualSleepMinutes(prior) : null;
  const need = sleepNeedMinutes ?? usual;
  if (need === null || need <= 0) return { state: 'unavailable', reason: 'baseline_immature' };

  let observedShare = 0;
  let shortfall = 0;
  const missing: string[] = [];
  for (const night of nights) {
    if (night.minutes === null) { missing.push(night.day); continue; }
    observedShare += night.share;
    shortfall += Math.max(0, need - night.minutes) * night.share;
  }
  return {
    state: missing.length ? 'partial' : 'available', algorithm_version: ALGORITHM.sleepDebt, activation: 'candidate_unaccepted',
    debt_minutes: missing.length ? null : round3(shortfall), observed_weighted_shortfall_minutes: round3(shortfall),
    observed_nights: NIGHTS - missing.length, coverage: round3(observedShare / totalRecency), missing_nights: missing,
    sleep_need_minutes: round3(need), need_basis: sleepNeedMinutes === null ? 'own_average' : 'owner_confirmed',
  };
};
