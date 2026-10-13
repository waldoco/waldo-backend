import { BASELINE_DAYS, higherIsBetter, logZScore, lowerIsBetter, zScore, clampScore, type Component } from './stats';
import type { DayRecord, HrvMethod, UnavailableReason } from './types';

// Form v2 and Weight v2 leave out days holding an overlapping hour window (Form's hours, Weight's physical load); a
// change in which inputs are admitted is a new version.
export const ALGORITHM = { recovery: 'recovery.candidate.v1', form: 'form.candidate.v3', weight: 'weight.candidate.v2', sleepDebt: 'sleep-debt.candidate.v1' } as const;
// Shares of the Recovery score. Keys name the component's role, not a reading.
export const RECOVERY_SHARES = { sleep: 0.5, variability: 0.3, pulse: 0.2 } as const;

export interface RecoveryBasis {
  readonly components: readonly Component[];
  readonly signals: readonly string[];
  readonly days: readonly string[];
  readonly hrvMethod: HrvMethod | null;
}
export type RecoveryOutcome = RecoveryBasis | Readonly<{ reason: UnavailableReason }>;

const baselineOf = (prior: readonly DayRecord[], pick: (day: DayRecord) => number | null) => {
  const used = prior.flatMap(day => { const value = pick(day); return value === null ? [] : [{ day: day.day, value }]; });
  return used.length >= BASELINE_DAYS ? used : null;
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
  if (!target.overnightHrv && target.restingHeartRate === null) return { reason: 'missing_resting_signal' };

  const components: Component[] = [{ name: 'sleep', score: clampScore(target.sleep.asleepMinutes / need * 100), weight: RECOVERY_SHARES.sleep }];
  const signals = ['sleep'];
  const days = new Set<string>([target.day]);
  let hrvMethod: HrvMethod | null = null;

  const hrv = target.overnightHrv;
  if (hrv) {
    // RMSSD and SDNN are different measures: a reading is only compared with its own method.
    const baseline = baselineOf(prior, day => (day.overnightHrv?.method === hrv.method ? day.overnightHrv.value : null));
    if (baseline) {
      components.push({ name: 'hrv', score: higherIsBetter(logZScore(hrv.value, baseline.map(entry => entry.value))), weight: RECOVERY_SHARES.variability });
      signals.push('hrv');
      hrvMethod = hrv.method;
      baseline.forEach(entry => days.add(entry.day));
    }
  }
  if (target.restingHeartRate !== null) {
    const baseline = baselineOf(prior, day => day.restingHeartRate);
    if (baseline) {
      components.push({ name: 'resting_heart_rate', score: lowerIsBetter(zScore(target.restingHeartRate, baseline.map(entry => entry.value))), weight: RECOVERY_SHARES.pulse });
      signals.push('resting_heart_rate');
      baseline.forEach(entry => days.add(entry.day));
    }
  }
  if (!signals.includes('hrv') && !signals.includes('resting_heart_rate')) return { reason: 'baseline_immature' };
  return { components, signals, days: [...days].sort(), hrvMethod };
};
