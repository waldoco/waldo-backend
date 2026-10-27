import { sleepNeed } from './baseline';
import { ALGORITHM, PROVISIONAL_ALGORITHM } from './recovery';
import { usualSleepMinutes } from './recovery';
import { BASELINE_WINDOW_DAYS } from './stats';
import { daysBetween, shiftDay } from './time';
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
    sleep_need_minutes: round3(need), need_basis: sleepNeedMinutes === null ? 'blended_average' : 'owner_confirmed',
  };
};

// The days a target day's own baseline is drawn from: the thirty before it.
export const priorDays = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>): DayRecord[] =>
  [...byDay.values()].filter(record => { const age = daysBetween(record.day, targetDay); return age >= 1 && age <= BASELINE_WINDOW_DAYS; });

// Which way the debt is going: building when it rose on both of the last two steps, easing when it fell on both, steady
// otherwise and whenever a figure cannot be computed for any of the three days. The three figures use the target day's need, so
// a need that drifts as nights accrue is never read as the debt moving.
export const sleepDebtTrend = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>, sleepNeedMinutes: number | null): NonNullable<SleepDebtResult['trend']> => {
  const need = sleepNeedMinutes ?? sleepNeed(priorDays(targetDay, byDay).flatMap(day => (day.sleep ? [day.sleep.asleepMinutes] : [])));
  const figure = (back: number): number | null => {
    const day = shiftDay(targetDay, -back);
    const debt = provisionalSleepDebt(day, byDay, priorDays(day, byDay), need);
    return debt.state === 'available' ? debt.debt_minutes : null;
  };
  const [now, before, earlier] = [figure(0), figure(1), figure(2)];
  if (now === null || before === null || earlier === null) return 'steady';
  return now > before && before > earlier ? 'building' : now < before && before < earlier ? 'easing' : 'steady';
};

export const sleepDebt = (targetDay: string, byDay: ReadonlyMap<string, DayRecord>, prior: readonly DayRecord[], sleepNeedMinutes: number | null, provisional = false): SleepDebtResult | Unavailable => {
  if (provisional) {
    const debt = provisionalSleepDebt(targetDay, byDay, prior, sleepNeedMinutes);
    return debt.state === 'unavailable' ? debt : { ...debt, trend: sleepDebtTrend(targetDay, byDay, sleepNeedMinutes) };
  }
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
