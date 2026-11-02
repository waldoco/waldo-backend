import { describe, expect, it } from 'vitest';
import { dayLoad, dayScoreOf, DAY_LOAD_VERSION } from '../src/health/scores/day-load';
import { shiftDay } from '../src/health/scores/time';
import type { WorkoutLoad } from '../src/health/scores/training-load';

// day-load.candidate.v1 (ADR-0081 amendment of 2 Nov 2026, §5). Every value is synthetic. Golden numbers are worked by hand:
// a day's load in Edwards units (minutes in zone n weigh n), then 100 x ln(1 + load) / ln(1 + 600) for zones, rounded to a tenth.
const TODAY = '2026-11-02';
const before = (n: number) => shiftDay(TODAY, -n);
const prior = (count: number) => Array.from({ length: count }, (_, i) => before(i + 1));
const run = (day: string, minutes: number, extra: Partial<WorkoutLoad> = {}): WorkoutLoad => ({ day, minutes, zoneSeconds: null, effort: null, ...extra });
// 30 minutes in zone 2 and 30 in zone 3: 2 x 30 + 3 x 30 = 150, so ln(151) / ln(601) = 0.7841, a score of 78.4.
const ZONES = [0, 1800, 1800, 0, 0];
const zoned = (day: string, extra: Partial<WorkoutLoad> = {}): WorkoutLoad => run(day, 60, { zoneSeconds: ZONES, ...extra });

describe('the score of a load', () => {
  it('is log-shaped, reaches 100 at the pinned load of its method and no further, and is 0 for none', () => {
    expect(dayScoreOf(150, 'hr_zones')).toBe(78.4);
    expect(dayScoreOf(30, 'minutes')).toBe(62.6);
    expect(dayScoreOf(0, 'hr_zones')).toBe(0);
    expect(dayScoreOf(600, 'hr_zones')).toBe(100);
    expect(dayScoreOf(240, 'minutes')).toBe(100);
    expect(dayScoreOf(10_000, 'effort')).toBe(100);
    expect(dayScoreOf(300, 'hr_zones')).toBeGreaterThan(dayScoreOf(150, 'hr_zones'));
    expect(dayScoreOf(300, 'hr_zones') - dayScoreOf(150, 'hr_zones')).toBeLessThan(dayScoreOf(150, 'hr_zones') - dayScoreOf(0, 'hr_zones'));
  });
});

describe('the day\'s load', () => {
  it('scores the day\'s workouts by their zones and names the method, the version and the candidate activation', () => {
    const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(TODAY)] });
    expect(load).toMatchObject({ state: 'available', version: DAY_LOAD_VERSION, activation: 'candidate_unaccepted', score: 78.4, method: 'hr_zones', approximate: false, window_days: 28 });
    expect(DAY_LOAD_VERSION).toBe('day-load.candidate.v1');
  });
  it('adds the sessions of one day: two zone workouts are the sum of their loads', () => {
    const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(TODAY), zoned(TODAY, { zoneSeconds: [0, 0, 0, 1800, 0] })] });
    // 150 + 4 x 30 = 270, so ln(271) / ln(601).
    expect(load).toMatchObject({ score: Math.round(100 * Math.log(271) / Math.log(601) * 10) / 10 });
  });
  it('scores an observed day with no workout as 0, never as missing', () => {
    expect(dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [] })).toMatchObject({ state: 'available', score: 0, method: 'minutes', approximate: false });
  });
  it('has no load for a day nothing worn saw, and a day with a workout is observed whatever the caller says', () => {
    expect(dayLoad({ targetDay: TODAY, observedDays: [before(1)], workouts: [zoned(before(1))] })).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(dayLoad({ targetDay: TODAY, observedDays: [], workouts: [] })).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(dayLoad({ targetDay: TODAY, observedDays: [], workouts: [zoned(TODAY)] })).toMatchObject({ state: 'available', score: 78.4 });
  });
  it('reads a day still running as the load so far, and ignores a workout of a day after it', () => {
    expect(dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(shiftDay(TODAY, 1))] })).toMatchObject({ score: 0 });
  });

  describe('one method for the whole span', () => {
    it('falls to minutes for every day when any workout in the span has no zones or effort, so two methods are never mixed', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(TODAY), run(before(3), 40)] });
      expect(load).toMatchObject({ method: 'minutes', score: dayScoreOf(60, 'minutes') });
    });
    it('reads effort times minutes when every workout carries an effort and not every one carries zones', () => {
      const rated = (day: string) => run(day, 30, { effort: { score: 6, method: 'rated' } });
      expect(dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [rated(TODAY), rated(before(2))] })).toMatchObject({ method: 'effort', score: dayScoreOf(180, 'effort') });
      const mixed = [rated(TODAY), run(before(2), 30, { effort: { score: 6, method: 'estimated' } })];
      expect(dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: mixed })).toMatchObject({ method: 'minutes' });
    });
    it('labels zones set from an observed peak as approximate, in the method\'s own name', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(TODAY), zoned(before(2), { zonesFromObservedPeak: true })] });
      expect(load).toMatchObject({ method: 'hr_zones_observed_peak', approximate: true, score: 78.4 });
    });
    it('ignores a workout older than the 28 days', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [zoned(TODAY), run(before(29), 40)] });
      expect(load).toMatchObject({ method: 'hr_zones' });
    });
  });

  describe('the owner\'s usual band', () => {
    // Fourteen observed days alternating 78.4 and 0: mean 39.2, spread 39.2, so one spread either side is 0 to 78.4.
    const alternating = (count: number) => prior(count).filter((_, i) => i % 2 === 0).map(day => zoned(day));
    it('is provisional below fourteen observed days, with the days still needed and no band', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(13)], workouts: [zoned(TODAY)] });
      expect(load).toMatchObject({ band: { state: 'provisional', own_days: 13, days_until_personal: 1 } });
      expect(dayLoad({ targetDay: TODAY, observedDays: [TODAY], workouts: [] })).toMatchObject({ band: { state: 'provisional', own_days: 0, days_until_personal: 14 } });
    });
    it('is personal at exactly fourteen, one spread either side of the mean of the served scores, floored at 0 and capped at 100', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(14)], workouts: [zoned(TODAY), ...alternating(14)] });
      expect(load).toMatchObject({ band: { state: 'personal', low: 0, centre: 39.2, high: 78.4, own_days: 14, days_until_personal: 0 } });
    });
    it('counts a rest day as 0 and leaves an unobserved day out, so a gap is not a rest', () => {
      // 20 days observed (the alternating pattern over 28 days has 14 workouts and 14 rest days), 8 unobserved.
      const observed = [TODAY, ...prior(28).filter((_, i) => i < 20)];
      const load = dayLoad({ targetDay: TODAY, observedDays: observed, workouts: [zoned(TODAY), ...alternating(20)] });
      expect(load).toMatchObject({ band: { state: 'personal', own_days: 20 } });
      const dropped = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(28).filter((_, i) => i < 13)], workouts: [zoned(TODAY), ...alternating(13)] });
      expect(dropped).toMatchObject({ band: { state: 'provisional', own_days: 13 } });
    });
    it('does not count today in its own band', () => {
      const load = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(14)], workouts: [zoned(TODAY, { zoneSeconds: [0, 0, 0, 0, 3600] }), ...alternating(14)] });
      expect(load).toMatchObject({ band: { own_days: 14, centre: 39.2 } });
    });
    it('serves a flat history as a band of one point, and no verdict of the score against any band', () => {
      const flat = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(14)], workouts: [zoned(TODAY)] });
      expect(flat).toMatchObject({ band: { state: 'personal', low: 0, centre: 0, high: 0 }, score: 78.4 });
      expect(flat).not.toHaveProperty('direction');
      const heavy = prior(14).map(day => zoned(day, { zoneSeconds: [0, 0, 0, 0, 3600] }));
      const morning = dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...prior(14)], workouts: heavy });
      expect(morning).toMatchObject({ score: 0, band: { state: 'personal' } });
      expect(morning).not.toHaveProperty('direction');
    });
  });
});
