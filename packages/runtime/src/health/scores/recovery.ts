import { PULSE_PRIOR, VARIABILITY_PRIOR, sleepNeed, standing, type Prior } from './baseline';
import { BASELINE_DAYS, higherIsBetter, logZScore, lowerIsBetter, zScore, clampScore, type Component } from './stats';
import type { DayRecord, HrvMethod, MethodReading, RestingMethod, UnavailableReason } from './types';

// Form v2 and Weight v2 leave out days holding an overlapping hour window (Form's hours, Weight's physical load). Form v3
// reads an hour or day with no daylight or movement reading as missing, not zero; Weight v3 counts every day the calendar
// reports, not only days with health readings. Form v4 compares a day still in progress with the same wall-clock hours of
// earlier days, and judges a finished day on the hours it has. Recovery v2 reads HRV and resting heart rate against a
// baseline of their own method only, with a fallback method; Form v5 is Form v4 on Recovery v2's inputs, and also clears a
// day whose active-energy windows overlap. Weight v4 reads physical load as the day's active energy, falling back to
// minutes. Recovery v4 also admits a night with no measured resting heart rate, through the producer's low from its
// asleep heart-rate hours, a method of its own; Form v8 is Form v5 on Recovery v4's inputs. A change in which inputs are
// admitted is a new version.
export const ALGORITHM = { recovery: 'recovery.candidate.v4', form: 'form.candidate.v8', weight: 'weight.candidate.v4', sleepDebt: 'sleep-debt.candidate.v1' } as const;
// Provisional scores (recovery.v5 and the versions on it) read every component against the shared baseline from the
// owner's first day; the versions above stay as they were for the switch that keeps them.
export const PROVISIONAL_ALGORITHM = { recovery: 'recovery.v5', form: 'form.v9', weight: 'weight.v5', sleepDebt: 'sleep-debt.v2' } as const;
// Shares of the Recovery score. Keys name the component's role, not a reading.
export const RECOVERY_SHARES = { sleep: 0.5, variability: 0.3, pulse: 0.2 } as const;
// RMSSD is the canonical HRV method and SDNN its labelled fallback. A nightly minimum is the closest resting measure, then a
// platform's daily estimate, then a spot measurement, and last the low the producer takes from a night's heart-rate hours.
const HRV_ORDER: readonly HrvMethod[] = ['rmssd', 'sdnn'];
const RESTING_ORDER: readonly RestingMethod[] = ['overnight_resting', 'provider_resting_daily', 'resting_measurement', 'unknown', 'asleep_hours_low'];

export interface RecoveryBasis {
  readonly components: readonly Component[];
  readonly signals: readonly string[];
  readonly days: readonly string[];
  readonly hrvMethod: HrvMethod | null;
  // Provisional only: the own-day count of each used component that stands on the owner's history, and whether a prior took part.
  readonly own?: readonly number[];
  readonly usedPrior?: boolean;
}
export type RecoveryOutcome = RecoveryBasis | Readonly<{ reason: UnavailableReason }>;

const baselineOf = (prior: readonly DayRecord[], pick: (day: DayRecord) => number | null) => {
  const used = prior.flatMap(day => { const value = pick(day); return value === null ? [] : [{ day: day.day, value }]; });
  return used.length >= BASELINE_DAYS ? used : null;
};

// The first method, in order, that the day has a reading of and that has a mature baseline of its own. RMSSD and SDNN, or a
// nightly minimum and a daytime estimate, are different measures: a reading is never compared with another method's days.
const matched = <Method extends string>(order: readonly Method[], today: readonly MethodReading<Method>[], prior: readonly DayRecord[], read: (day: DayRecord) => readonly MethodReading<Method>[]) => {
  for (const method of order) {
    const reading = today.find(entry => entry.method === method);
    if (!reading) continue;
    const baseline = baselineOf(prior, day => read(day).find(entry => entry.method === method)?.value ?? null);
    if (baseline) return { reading, baseline };
  }
  return null;
};

// The owner's usual nightly sleep, used when no sleep need is confirmed.
export const usualSleepMinutes = (prior: readonly DayRecord[]): number | null => {
  const baseline = baselineOf(prior, day => day.sleep?.asleepMinutes ?? null);
  return baseline ? baseline.reduce((sum, entry) => sum + entry.value, 0) / baseline.length : null;
};

export const recoveryBasis = (target: DayRecord, prior: readonly DayRecord[], sleepNeedMinutes: number | null): RecoveryOutcome => {
  if (!target.sleep) return { reason: 'missing_sleep' };
  const need = sleepNeedMinutes ?? usualSleepMinutes(prior);
  if (need === null || need <= 0) return { reason: 'baseline_immature' };
  if (!target.overnightHrv.length && !target.restingHeartRate.length) return { reason: 'missing_resting_signal' };

  const components: Component[] = [{ name: 'sleep', score: clampScore(target.sleep.asleepMinutes / need * 100), weight: RECOVERY_SHARES.sleep }];
  const signals = ['sleep'];
  const days = new Set<string>([target.day]);
  let hrvMethod: HrvMethod | null = null;

  const hrv = matched(HRV_ORDER, target.overnightHrv, prior, day => day.overnightHrv);
  if (hrv) {
    components.push({ name: 'hrv', score: higherIsBetter(logZScore(hrv.reading.value, hrv.baseline.map(entry => entry.value))), weight: RECOVERY_SHARES.variability });
    signals.push('hrv');
    hrvMethod = hrv.reading.method;
    hrv.baseline.forEach(entry => days.add(entry.day));
  }
  const resting = matched(RESTING_ORDER, target.restingHeartRate, prior, day => day.restingHeartRate);
  if (resting) {
    components.push({ name: 'resting_heart_rate', score: lowerIsBetter(zScore(resting.reading.value, resting.baseline.map(entry => entry.value))), weight: RECOVERY_SHARES.pulse });
    signals.push('resting_heart_rate');
    resting.baseline.forEach(entry => days.add(entry.day));
  }
  if (!hrv && !resting) return { reason: 'baseline_immature' };
  return { components, signals, days: [...days].sort(), hrvMethod };
};

// Only RMSSD and the resting rates measured or taken from the night's low have a population prior. SDNN and an unlabelled
// resting rate do not: no conversion or published figure exists for them, so each stands on its own days alone.
const HRV_PRIORS: Readonly<Partial<Record<HrvMethod, Prior>>> = { rmssd: VARIABILITY_PRIOR };
const RESTING_PRIORS: Readonly<Partial<Record<RestingMethod, Prior>>> = {
  overnight_resting: PULSE_PRIOR, provider_resting_daily: PULSE_PRIOR, resting_measurement: PULSE_PRIOR, asleep_hours_low: PULSE_PRIOR,
};

// The first method, in order, that the day has a reading of and that has a baseline: a prior, or enough own days. Methods
// are still never compared with each other's days.
const matchedStanding = <Method extends string>(
  order: readonly Method[], today: readonly MethodReading<Method>[], prior: readonly DayRecord[], read: (day: DayRecord) => readonly MethodReading<Method>[],
  priors: Readonly<Partial<Record<Method, Prior>>>, scale: 'linear' | 'ln',
) => {
  for (const method of order) {
    const reading = today.find(entry => entry.method === method);
    if (!reading) continue;
    const earlier = prior.flatMap(day => { const value = read(day).find(entry => entry.method === method)?.value; return value === undefined ? [] : [{ day: day.day, value }]; });
    const at = standing(reading.value, earlier.map(entry => entry.value), priors[method] ?? null, scale);
    if (at) return { reading, at, days: earlier.map(entry => entry.day) };
  }
  return null;
};

export const provisionalRecoveryBasis = (target: DayRecord, prior: readonly DayRecord[], sleepNeedMinutes: number | null): RecoveryOutcome => {
  if (!target.sleep) return { reason: 'missing_sleep' };
  const nights = prior.flatMap(day => (day.sleep ? [day.sleep.asleepMinutes] : []));
  const need = sleepNeedMinutes ?? sleepNeed(nights);
  if (need <= 0) return { reason: 'baseline_immature' };
  if (!target.overnightHrv.length && !target.restingHeartRate.length) return { reason: 'missing_resting_signal' };

  const components: Component[] = [{ name: 'sleep', score: clampScore(target.sleep.asleepMinutes / need * 100), weight: RECOVERY_SHARES.sleep }];
  const signals = ['sleep'];
  const days = new Set<string>([target.day]);
  // A need the owner confirmed stands on no history. One taken from the owner's nights is shrunk toward a prior of eight hours.
  const own: number[] = sleepNeedMinutes === null ? [nights.length] : [];
  let usedPrior = sleepNeedMinutes === null;
  let hrvMethod: HrvMethod | null = null;

  const hrv = matchedStanding(HRV_ORDER, target.overnightHrv, prior, day => day.overnightHrv, HRV_PRIORS, 'ln');
  if (hrv) {
    components.push({ name: 'hrv', score: higherIsBetter(hrv.at.z), weight: RECOVERY_SHARES.variability });
    signals.push('hrv');
    hrvMethod = hrv.reading.method;
    hrv.days.forEach(day => days.add(day));
    own.push(hrv.at.own);
    usedPrior ||= hrv.at.prior;
  }
  const resting = matchedStanding(RESTING_ORDER, target.restingHeartRate, prior, day => day.restingHeartRate, RESTING_PRIORS, 'linear');
  if (resting) {
    components.push({ name: 'resting_heart_rate', score: lowerIsBetter(resting.at.z), weight: RECOVERY_SHARES.pulse });
    signals.push('resting_heart_rate');
    resting.days.forEach(day => days.add(day));
    own.push(resting.at.own);
    usedPrior ||= resting.at.prior;
  }
  if (!hrv && !resting) return { reason: 'baseline_immature' };
  return { components, signals, days: [...days].sort(), hrvMethod, own, usedPrior };
};
