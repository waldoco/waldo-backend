import { describe, expect, it } from 'vitest';
import { cyclePhaseOn, type PeriodDates } from '../src/health/cycle/phase';
import { computeDailyScores, type CycleContext } from '../src/health/scores';
import type { DailyScoresInput, DayRecord } from '../src/health/scores/types';

// Proposed ADR-0085 D5: phase-adjusted baselines. Every value here is synthetic.
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TARGET = '2026-03-20';
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
// A regular 28-day cycle whose current period started 20 days before the target, so the target is luteal (ovulation on day 14).
const periodsFrom = (cycles: number): PeriodDates[] =>
  Array.from({ length: cycles }, (_, k) => { const start = addDays(TARGET, -20 - 28 * k); return { start, end: addDays(start, 4) }; });
const PERIODS = periodsFrom(5);
const luteal = (day: string, periods: readonly PeriodDates[] = PERIODS) => cyclePhaseOn(day, periods, '1').phase === 'luteal';

type Night = { hrv: number; resting: number; temperature: number; breathing: number };
// The owner's luteal nights run lower HRV, higher resting heart rate, warmer wrist and faster breathing than the rest.
const usualNight = (day: string, i: number, periods?: readonly PeriodDates[]): Night => (luteal(day, periods)
  ? { hrv: 50 + wobble(i, 3), resting: 58 + wobble(i, 1), temperature: 34.4 + wobble(i, 0.08), breathing: 14.6 + wobble(i, 0.2) }
  : { hrv: 64 + wobble(i, 3), resting: 53 + wobble(i, 1), temperature: 34.0 + wobble(i, 0.08), breathing: 14.0 + wobble(i, 0.2) });
const record = (i: number, night: Night): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 460 + wobble(i, 10), midpointMinute: 180 + wobble(i, 10) },
    overnightHrv: [{ value: night.hrv, method: 'rmssd' }],
    restingHeartRate: [{ value: night.resting, method: 'overnight_resting' }],
    hourly: [], workouts: [], demand: null,
    vitals: { breathingRate: night.breathing, bloodOxygen: 96 + wobble(i, 1), awakeMinutes: 25 + wobble(i, 5), walkingHeartRate: 100 + wobble(i, 3),
      wristTemperature: [{ value: night.temperature, method: 'absolute' }] },
  };
};
const history = (today: Night, periods?: readonly PeriodDates[]): DayRecord[] =>
  [record(0, today), ...Array.from({ length: 90 }, (_, k) => record(k + 1, usualNight(addDays(TARGET, -(k + 1)), k + 1, periods)))];
const phasesOf = (days: readonly DayRecord[], periods: readonly PeriodDates[], flag = '1'): CycleContext =>
  ({ phases: new Map(days.map(day => [day.day, cyclePhaseOn(day.day, periods, flag)])), lookback: days });
// The ordinary computation reads its usual 30 days; the 90-day lookback reaches the phase prior only through the cycle context.
const input = (days: DayRecord[], cycle?: CycleContext): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days: days.slice(0, 31), sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z`, ...(cycle ? { cycle } : {}) });
const scoreOf = (pillar: { state: string; score?: number }) => (pillar.state === 'available' ? pillar.score! : null);
const LUTEAL_NIGHT: Night = { hrv: 50, resting: 58, temperature: 34.4, breathing: 14.6 };

describe('cycle-phase baselines', () => {
  it('a usual luteal night reads as usual for this phase, and says why', () => {
    const days = history(LUTEAL_NIGHT);
    const plain = computeDailyScores(input(days));
    const phased = computeDailyScores(input(days, phasesOf(days, PERIODS)));
    expect(scoreOf(phased.recovery)!).toBeGreaterThan(scoreOf(plain.recovery)!);
    expect(phased.drivers.filter(driver => driver.startsWith('wrist temperature') || driver.startsWith('breathing rate'))).toEqual([]);
    expect(phased.basis).toEqual({ kind: 'cycle_phase', explanation: 'Read against your own usual readings for this part of your cycle.' });
    expect(plain.basis).toBeUndefined();
  });

  it('is a baseline change, never a bonus: a night unusual even for this phase still reads as unusual', () => {
    const days = history({ hrv: 38, resting: 63, temperature: 35.0, breathing: 15.4 });
    const phased = computeDailyScores(input(days, phasesOf(days, PERIODS)));
    const usual = computeDailyScores(input(history(LUTEAL_NIGHT), phasesOf(days, PERIODS)));
    expect(scoreOf(phased.recovery)!).toBeLessThan(scoreOf(usual.recovery)!);
    expect(phased.drivers).toEqual(expect.arrayContaining(['wrist temperature far above usual', 'breathing rate far above usual']));
  });

  it('golden: an unknown phase gives output identical to the non-cycle path', () => {
    const days = history(LUTEAL_NIGHT);
    const plain = computeDailyScores(input(days));
    // A late period: the target is past the expected start, so it is unknown.
    const late = PERIODS.slice(1);
    expect(computeDailyScores(input(days, phasesOf(days, late)))).toEqual(plain);
    // No period in the last 60 days.
    expect(computeDailyScores(input(days, phasesOf(days, [{ start: addDays(TARGET, -70), end: addDays(TARGET, -66) }])))).toEqual(plain);
    // No phase at all, and the kill switch.
    expect(computeDailyScores(input(days, { phases: new Map(), lookback: days }))).toEqual(plain);
    expect(computeDailyScores(input(days, phasesOf(days, PERIODS, 'paused')))).toEqual(plain);
    expect(computeDailyScores(input(days, phasesOf(days, PERIODS, '0')))).toEqual(plain);
  });

  it('uses the ordinary baseline until the phase has two cycles of data', () => {
    // Only the current cycle has luteal days inside the history.
    const recent = periodsFrom(2);
    const days = history(LUTEAL_NIGHT, recent).filter(day => day.day >= addDays(TARGET, -20));
    expect(computeDailyScores(input(days, phasesOf(days, recent)))).toEqual(computeDailyScores(input(days)));
  });

  it('changes nothing when the owner\'s phases do not differ', () => {
    const flat = history({ hrv: 64, resting: 53, temperature: 34.0, breathing: 14.0 }).map((day, i) => (i === 0 ? day : record(i, { hrv: 64 + wobble(i, 3), resting: 53 + wobble(i, 1), temperature: 34.0 + wobble(i, 0.08), breathing: 14.0 + wobble(i, 0.2) })));
    const plain = computeDailyScores(input(flat));
    const phased = computeDailyScores(input(flat, phasesOf(flat, PERIODS)));
    expect([scoreOf(phased.recovery), phased.drivers]).toEqual([scoreOf(plain.recovery), plain.drivers]);
    if (phased.basis === undefined) expect(phased).toEqual(plain);
  });

  it('never applies without health access', () => {
    const days = history(LUTEAL_NIGHT);
    expect(computeDailyScores({ ...input(days, phasesOf(days, PERIODS)), access: 'consent_withdrawn' })).toEqual(computeDailyScores({ ...input(days), access: 'consent_withdrawn' }));
  });

  it('works on the provisional engine too', () => {
    const days = history(LUTEAL_NIGHT);
    const plain = computeDailyScores({ ...input(days), provisional: true });
    const phased = computeDailyScores({ ...input(days, phasesOf(days, PERIODS)), provisional: true });
    expect(scoreOf(phased.recovery)!).toBeGreaterThan(scoreOf(plain.recovery)!);
    expect(phased.basis?.kind).toBe('cycle_phase');
  });
});
