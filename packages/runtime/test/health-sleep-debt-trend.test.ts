import { describe, expect, it } from 'vitest';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScores, DayRecord } from '../src/health/scores/types';

// The sleep-debt trend: the debt of the target day against the two days before it, from the same nights. Synthetic nights.
const TARGET = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NEED = 480;

const night = (i: number, minutes: number | null): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'UTC',
    sleep: minutes === null ? null : { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: minutes, midpointMinute: 180 },
    overnightHrv: [], restingHeartRate: [{ value: 60, method: 'overnight_resting' }], hourly: [], workouts: [], demand: null,
  };
};
// minutes(i) is the night that ended i days before the target day.
const scores = (minutes: (i: number) => number | null, over: { provisional?: boolean } = {}): DailyScores =>
  computeDailyScores({
    access: 'granted', targetDay: TARGET, sleepNeedMinutes: NEED, asOf: `${TARGET}T20:00:00.000Z`, provisional: over.provisional ?? true,
    days: Array.from({ length: 25 }, (_, i) => night(i, minutes(i))),
  });
const trendOf = (result: DailyScores) => (result.sleep_debt.state === 'unavailable' ? undefined : result.sleep_debt.trend);

describe('sleep debt trend', () => {
  it('is building when the debt rose on both of the last two steps', () => {
    expect(trendOf(scores(i => (i === 0 ? 330 : i === 1 ? 400 : NEED)))).toBe('building');
  });
  it('is easing when the debt fell on both', () => {
    expect(trendOf(scores(i => (i === 2 ? 240 : i === 1 ? 560 : i === 0 ? 560 : NEED)))).toBe('easing');
  });
  it('is steady when the debt neither rose nor fell on both steps', () => {
    expect(trendOf(scores(() => NEED))).toBe('steady');
    expect(trendOf(scores(i => (i === 1 ? 300 : NEED)))).toBe('steady');
  });
  it('is steady when the debt is the same three days running', () => {
    expect(trendOf(scores(() => 400))).toBe('steady');
  });
  // A direction the nights cannot back is left out, never written as steady: the key is absent, not null or undefined.
  it('is absent when it cannot be computed: last night missing, too few nights, or a gap the day before', () => {
    const missingLast = scores(i => (i === 0 ? null : 400)), fewNights = scores(i => (i < 10 ? 400 : null)), gapBefore = scores(i => (i === 1 ? null : i === 0 ? 300 : 480));
    expect([missingLast.sleep_debt.state, fewNights.sleep_debt.state, gapBefore.sleep_debt.state]).toEqual(['partial', 'available', 'available']);
    for (const result of [missingLast, fewNights, gapBefore]) {
      expect('trend' in result.sleep_debt, result.sleep_debt.state).toBe(false);
      expect(JSON.stringify(result.sleep_debt)).not.toContain('trend');
    }
  });
  it('is absent from a partial debt', () => {
    const debt = scores(i => (i < 4 ? 400 : null)).sleep_debt;
    expect(debt.state).toBe('partial');
    expect('trend' in debt).toBe(false);
  });
  it('is present on an available debt whose three figures can all be computed', () => {
    expect(trendOf(scores(() => 400))).toBeDefined();
  });
  it('is not written when the debt has no nights at all', () => {
    expect(scores(() => null).sleep_debt).toMatchObject({ state: 'unavailable' });
  });
  it('does not exist without provisional scores, so the earlier output is untouched', () => {
    const off = scores(i => (i === 0 ? 330 : 480), { provisional: false });
    expect(JSON.stringify(off)).not.toContain('trend');
  });
  it('is the one definition: the same answer from the same nights however the days arrive', () => {
    const base = Array.from({ length: 25 }, (_, i) => night(i, i === 0 ? 330 : i === 1 ? 400 : NEED));
    const input = { access: 'granted' as const, targetDay: TARGET, sleepNeedMinutes: NEED, asOf: `${TARGET}T20:00:00.000Z`, provisional: true };
    expect(trendOf(computeDailyScores({ ...input, days: [...base].reverse() }))).toBe(trendOf(computeDailyScores({ ...input, days: base })));
  });
});
