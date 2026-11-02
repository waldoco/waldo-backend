import { OUTSIDE, SUBJECT_SIGNALS, type OwnRange } from './drivers';
import { BASELINE_DAYS, BASELINE_WINDOW_DAYS } from './stats';
import type { Standing } from './baseline';
import type { UsualRow } from './types';

// The owner's usual for one reading: a centre and the band one spread either side of it. A component of a score reads against
// the estimate that scored it (centre and predictive spread, which a population prior may still carry); every other signal
// against the plain mean and spread of the owner's own days, which is what the driver phrases use. The band edges sit at the
// cut a driver and a part's direction begin at, so a value inside a band has no phrase and no direction away from usual.
export const USUAL_SIGNALS = [
  'overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight', 'movement', 'stress_heart_rate',
  'breathing_rate', 'spo2', 'wrist_temperature', 'awake_time', 'walking_heart_rate', 'steps', 'active_energy', 'vo2_max',
] as const;
export const USUAL_OF_SUBJECT = SUBJECT_SIGNALS;
// A reading that cannot be below nothing has a band that stops at nothing.
const NON_NEGATIVE = new Set(['daylight', 'movement', 'awake_time', 'active_energy']);
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const clock = (minute: number) => round4(((minute % 1440) + 1440) % 1440) % 1440;
const stateOf = (days: number) => (days >= BASELINE_DAYS ? 'personal' as const : 'provisional' as const);

// A band from the estimate that scored the reading. A natural-log estimate is back-transformed, so its band is not symmetric.
// A circular one is minutes on the clock and may cross midnight; a spread of half a day or more leaves no band to show.
export const usualOfStanding = (signal: string, method: string | null, at: Standing): UsualRow | null => {
  const floor = (value: number) => (NON_NEGATIVE.has(signal) ? Math.max(0, value) : value);
  let low: number, centre: number, high: number;
  if (at.scale === 'circular') {
    if (at.spread * OUTSIDE >= 720) return null;
    [low, centre, high] = [clock(at.centre - at.spread * OUTSIDE), clock(at.centre), clock(at.centre + at.spread * OUTSIDE)];
  } else if (at.scale === 'ln') {
    [low, centre, high] = [round4(Math.exp(at.centre - at.spread * OUTSIDE)), round4(Math.exp(at.centre)), round4(Math.exp(at.centre + at.spread * OUTSIDE))];
  } else {
    [low, centre, high] = [round4(floor(at.centre - at.spread * OUTSIDE)), round4(at.centre), round4(at.centre + at.spread * OUTSIDE)];
  }
  if (![low, centre, high].every(Number.isFinite)) return null;
  return {
    signal, method, state: stateOf(at.own), low, centre, high, own_days: Math.min(at.own, BASELINE_WINDOW_DAYS),
    own_share: Math.round(at.ownShare * 1e6) / 1e6, window_days: BASELINE_WINDOW_DAYS, estimator: 'shrunk_predictive',
  };
};

// A band from the owner's own days alone: the mean and one population spread either side, from at least fourteen of them.
export const usualOfRange = (signal: string, method: string | null, range: OwnRange): UsualRow => ({
  signal, method, state: 'personal',
  low: round4(NON_NEGATIVE.has(signal) ? Math.max(0, range.mean - range.sd * OUTSIDE) : range.mean - range.sd * OUTSIDE),
  centre: round4(range.mean), high: round4(range.mean + range.sd * OUTSIDE),
  own_days: Math.min(range.days, BASELINE_WINDOW_DAYS), own_share: 1, window_days: BASELINE_WINDOW_DAYS, estimator: 'own_mean_sd',
});

// The bands in the contract's order, one per signal.
export const inUsualOrder = (rows: readonly UsualRow[]): UsualRow[] =>
  USUAL_SIGNALS.flatMap(signal => rows.filter(row => row.signal === signal).slice(0, 1));
