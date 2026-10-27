import { describe, expect, it } from 'vitest';
import { MIN_OWN_DAYS, PULSE_PRIOR, VARIABILITY_PRIOR, estimate, sleepNeed, zOf, type Prior } from '../src/health/scores/baseline';

// The estimator's formula is written out again here, from the conjugate normal model, so the test does not share code with it.
const reference = (values: readonly number[], prior: Prior) => {
  const n = values.length;
  const y = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const s2 = n > 1 ? values.reduce((a, b) => a + (b - y) ** 2, 0) / (n - 1) : 0;
  const sigma2 = n <= 1 ? prior.sigma0 ** 2 : (prior.nu0 * prior.sigma0 ** 2 + (n - 1) * s2) / (prior.nu0 + n - 1);
  const k = sigma2 / prior.tau ** 2;
  const centre = (k * prior.mu0 + n * y) / (k + n);
  const varC = 1 / (1 / prior.tau ** 2 + n / sigma2);
  return { centre, spread: Math.sqrt(sigma2 + varC), ownShare: n / (k + n) };
};
const lowSpread = (centre: number, n: number) => Array.from({ length: n }, (_, i) => centre + (i % 2 === 0 ? 0.4 : -0.4));

describe('shared baseline: priors', () => {
  it('holds the published resting-rate prior', () => {
    expect(PULSE_PRIOR).toEqual({ mu0: 65.5, tau: 7.7, sigma0: 3.03, nu0: 7 });
  });
  it('holds an all-adult variability prior on the natural-log scale, from the pooled age bands', () => {
    expect(VARIABILITY_PRIOR.sigma0).toBe(0.2);
    expect(VARIABILITY_PRIOR.nu0).toBe(7);
    // exp(mu0) is a typical early-morning RMSSD for adults, between the oldest and youngest band medians.
    expect(Math.exp(VARIABILITY_PRIOR.mu0)).toBeGreaterThan(27);
    expect(Math.exp(VARIABILITY_PRIOR.mu0)).toBeLessThan(66);
    // Wider than any single band's own spread, because it also carries the spread of the band medians.
    expect(VARIABILITY_PRIOR.tau).toBeGreaterThan(0.5);
    expect(VARIABILITY_PRIOR.tau).toBeLessThan(0.7);
  });
});

describe('shared baseline: estimate with a prior', () => {
  it('puts the centre on the prior with no own values, with the spread of the whole population', () => {
    for (const prior of [PULSE_PRIOR, VARIABILITY_PRIOR]) {
      const e = estimate([], prior)!;
      expect(e.centre).toBe(prior.mu0);
      expect(e.own).toBe(0);
      expect(e.ownShare).toBe(0);
      expect(e.spread).toBeCloseTo(Math.sqrt(prior.sigma0 ** 2 + prior.tau ** 2), 10);
    }
  });
  it('matches the conjugate formula for every count from 1 to 30', () => {
    for (let n = 1; n <= 30; n++) {
      const values = Array.from({ length: n }, (_, i) => 58 + Math.sin(i * 1.7) * 3);
      const got = estimate(values, PULSE_PRIOR)!, want = reference(values, PULSE_PRIOR);
      expect(got.centre).toBeCloseTo(want.centre, 9);
      expect(got.spread).toBeCloseTo(want.spread, 9);
      expect(got.ownShare).toBeCloseTo(want.ownShare, 9);
      expect(got.own).toBe(n);
    }
  });
  it('puts at least 95 percent of the weight on the owner after three typical nights', () => {
    const values = lowSpread(58, 3), own = values.reduce((a, b) => a + b, 0) / values.length;
    const e = estimate(values, PULSE_PRIOR)!;
    expect(e.ownShare).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(e.centre - own)).toBeLessThanOrEqual(0.05 * Math.abs(PULSE_PRIOR.mu0 - own));
  });
  it('lets the owner win as the history grows, and never lets the prior weigh exactly nothing', () => {
    const e = estimate(Array.from({ length: 30 }, () => 58), PULSE_PRIOR)!;
    expect(e.ownShare).toBeGreaterThan(0.99);
    expect(e.ownShare).toBeLessThan(1);
    expect(e.centre).toBeGreaterThan(58);
  });
  it('is never more certain than the prior spread allows for a flat history', () => {
    const e = estimate(Array.from({ length: 30 }, () => 58), PULSE_PRIOR)!;
    expect(e.spread).toBeGreaterThan(0);
  });
  it('reads a log-scale prior against log values only', () => {
    const e = estimate([], VARIABILITY_PRIOR)!;
    expect(zOf(Math.log(Math.exp(VARIABILITY_PRIOR.mu0)), e)).toBeCloseTo(0, 10);
  });
});

describe('shared baseline: estimate without a prior', () => {
  it(`needs ${MIN_OWN_DAYS} own values`, () => {
    expect(MIN_OWN_DAYS).toBe(7);
    for (let n = 0; n < 7; n++) expect(estimate(lowSpread(50, n), null)).toBeNull();
    expect(estimate(lowSpread(50, 7), null)).not.toBeNull();
  });
  it('centres on the mean and widens the sample spread for the next reading', () => {
    const values = [48, 52, 50, 47, 53, 51, 49, 55];
    const n = values.length, mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const e = estimate(values, null)!;
    expect(e.centre).toBeCloseTo(mean, 10);
    expect(e.spread).toBeCloseTo(sd * Math.sqrt(1 + 1 / n), 10);
    expect(e.ownShare).toBe(1);
    expect(e.own).toBe(n);
  });
  it('keeps the flat-history rule: the same value is no deviation, any other value takes the limit', () => {
    const flat = estimate(Array.from({ length: 8 }, () => 40), null)!;
    expect(zOf(40, flat)).toBe(0);
    expect(zOf(41, flat)).toBe(2.5);
    expect(zOf(39, flat)).toBe(-2.5);
  });
});

describe('shared baseline: z', () => {
  it('limits one outlier to 2.5 spreads either way', () => {
    const e = estimate(lowSpread(58, 10), PULSE_PRIOR)!;
    expect(zOf(500, e)).toBe(2.5);
    expect(zOf(-500, e)).toBe(-2.5);
  });
  it('is the distance from the centre in predictive spreads', () => {
    const e = estimate([], PULSE_PRIOR)!;
    expect(zOf(e.centre + e.spread, e)).toBeCloseTo(1, 10);
    expect(zOf(e.centre - e.spread / 2, e)).toBeCloseTo(-0.5, 10);
  });
});

describe('shared baseline: sleep need', () => {
  const NIGHT = 60;
  it('is eight hours with no nights of the owner\'s own', () => {
    expect(sleepNeed([])).toBe(8 * NIGHT);
  });
  it('moves from eight hours toward the owner\'s own mean, with fourteen nights of weight on the eight hours', () => {
    expect(sleepNeed(Array.from({ length: 14 }, () => 7 * NIGHT))).toBe(7.5 * NIGHT);
    expect(sleepNeed(Array.from({ length: 7 }, () => 7 * NIGHT))).toBeCloseTo((14 * 480 + 7 * 420) / 21, 10);
  });
  it('is clipped to between six and ten hours', () => {
    expect(sleepNeed(Array.from({ length: 400 }, () => 3 * NIGHT))).toBe(6 * NIGHT);
    expect(sleepNeed(Array.from({ length: 400 }, () => 14 * NIGHT))).toBe(10 * NIGHT);
  });
});
