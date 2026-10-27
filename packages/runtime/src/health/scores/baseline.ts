import { BASELINE_DAYS, bounded, circularDelta, mean } from './stats';
import type { BaselineLabel } from './types';

// The shared baseline of provisional scores: one centre and one predictive spread per component, from the owner's own
// values in the window and, where a defensible population figure exists, a prior. It is the conjugate normal model with a
// scaled inverse chi-squared prior on the variance (Gelman et al., Bayesian Data Analysis, 3rd ed., sections 2.5 and 2.6).
//
// Not every component has a prior. Where none exists the owner's own values must carry it alone, from MIN_OWN_DAYS days,
// and a reading is never placed against another method's prior or another method's days.

// A prior on the component's natural scale: mu0 and tau are the centre and spread of people's usual values, sigma0 and nu0
// the typical night-to-night spread and the number of nights that spread is worth.
export interface Prior { readonly mu0: number; readonly tau: number; readonly sigma0: number; readonly nu0: number }

// Quer et al., PLoS One 2020 (doi 10.1371/journal.pone.0227709): adults, all ages and both sexes pooled. Age and sex explain
// little of the between-person spread there, so one prior serves everyone. Beats per minute.
export const PULSE_PRIOR: Prior = { mu0: 65.5, tau: 7.7, sigma0: 3.03, nu0: 7 };

// Pinned for recovery.v5 and the versions on it: any change to these constants, or to the prior's source, is a new version,
// and rows written under the old one are never reinterpreted.
// Natarajan et al., bioRxiv 10.1101/772285 (v1), Table S2, 6 to 7 am window, ages 20 to 60, female and male rows: 18 bands,
// each given as a median with its quartiles. On the natural-log scale, mu0 is the mean over the bands of ln(median), taking
// the bands as equal because the table gives no counts, which puts the centre near 39 ms. tau is the root of the mean
// within-band variance, each band's ln(P75/P25)/1.349 squared, plus the variance of the bands' ln medians (population
// form), so it carries the spread of the age bands as well as each band's own. sigma0 and nu0 are the conservative
// candidates of the amendment, not read from the paper. The window is the paper's, a five-minute median early in the
// morning, and a whole-night average is not that quantity.
export const VARIABILITY_PRIOR: Prior = { mu0: 3.653, tau: 0.58, sigma0: 0.2, nu0: 7 };

// A component with no prior joins at this many own days, the common minimum of the wearables' own baselines.
export const MIN_OWN_DAYS = 7;

export interface Estimate {
  readonly centre: number;
  // The spread a new reading is judged against: the owner's own and the uncertainty of the centre together.
  readonly spread: number;
  readonly own: number;
  // The share of the centre that comes from the owner's values rather than the prior.
  readonly ownShare: number;
  readonly prior: boolean;
}

const sampleDeviation = (values: readonly number[], centre: number): number =>
  Math.sqrt(values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (values.length - 1));

export const estimate = (values: readonly number[], prior: Prior | null): Estimate | null => {
  const n = values.length;
  if (prior === null) {
    if (n < MIN_OWN_DAYS) return null;
    const centre = mean(values);
    return { centre, spread: sampleDeviation(values, centre) * Math.sqrt(1 + 1 / n), own: n, ownShare: 1, prior: false };
  }
  const centreOwn = n === 0 ? 0 : mean(values);
  const variance = n <= 1 ? prior.sigma0 ** 2 : (prior.nu0 * prior.sigma0 ** 2 + (n - 1) * sampleDeviation(values, centreOwn) ** 2) / (prior.nu0 + n - 1);
  const k = variance / prior.tau ** 2;
  const centreVariance = 1 / (1 / prior.tau ** 2 + n / variance);
  return { centre: n === 0 ? prior.mu0 : (k * prior.mu0 + n * centreOwn) / (k + n), spread: Math.sqrt(variance + centreVariance), own: n, ownShare: n / (k + n), prior: true };
};

// Distance from the centre in predictive spreads, limited to 2.5 either way. A flat history with no prior has no spread: the
// same value is no deviation, any other takes the limit.
export const zOf = (value: number, e: Estimate): number => bounded(value - e.centre, e.spread);

export interface Standing { readonly z: number; readonly own: number; readonly prior: boolean }
// Where today's value stands against the owner's earlier values, or null when the component has no baseline yet. A natural-log
// component is compared on that scale and only where every value is positive.
export const standing = (value: number, earlier: readonly number[], prior: Prior | null, scale: 'linear' | 'ln' = 'linear'): Standing | null => {
  if (scale === 'ln' && !(value > 0)) return null;
  const e = estimate(scale === 'ln' ? earlier.filter(v => v > 0).map(Math.log) : earlier, prior);
  return e === null ? null : { z: zOf(scale === 'ln' ? Math.log(value) : value, e), own: e.own, prior: e.prior };
};

// The same for a time on a 1440-minute clock, where 23:50 and 00:10 are twenty minutes apart. Personal-only.
export const circularStanding = (value: number, earlier: readonly number[]): Standing | null => {
  if (earlier.length < MIN_OWN_DAYS) return null;
  const sine = mean(earlier.map(entry => Math.sin(entry * Math.PI / 720)));
  const cosine = mean(earlier.map(entry => Math.cos(entry * Math.PI / 720)));
  if (Math.hypot(sine, cosine) < 1e-8) return null;
  const centre = ((Math.atan2(sine, cosine) * 720 / Math.PI) + 1440) % 1440;
  const n = earlier.length;
  const spread = Math.sqrt(earlier.reduce((sum, entry) => sum + circularDelta(entry, centre) ** 2, 0) / (n - 1)) * Math.sqrt(1 + 1 / n);
  return { z: bounded(circularDelta(value, centre), spread), own: n, prior: false };
};

// Sleep need when the owner has confirmed none: eight hours of prior worth fourteen nights, moved toward the owner's own
// nights, and kept within six to ten hours. With no nights it is the prior itself.
const NEED_CENTRE = 480;
const NEED_NIGHTS = 14;
const NEED_FLOOR = 360;
const NEED_CEILING = 600;
export const sleepNeed = (nights: readonly number[]): number =>
  Math.max(NEED_FLOOR, Math.min(NEED_CEILING, (NEED_NIGHTS * NEED_CENTRE + nights.reduce((sum, minutes) => sum + minutes, 0)) / (NEED_NIGHTS + nights.length)));

// The label a pillar carries: personal once every component it used holds fourteen own days.
export const labelOf = (own: readonly number[], usedPrior: boolean): BaselineLabel => {
  const personalDays = own.length ? Math.min(...own) : 0;
  return { state: personalDays >= BASELINE_DAYS ? 'personal' : 'provisional', personal_days: personalDays, needed: BASELINE_DAYS, prior: usedPrior ? 'adults' : 'none' };
};
