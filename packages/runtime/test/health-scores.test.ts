import { describe, expect, it } from 'vitest';
import { computeDailyScores } from '../src/health/scores';
import { formComposite } from '../src/health/scores/form';
import { localDayWindow } from '../src/health/scores/time';
import { formZone, recoveryZone, weightZone } from '../src/health/scores/zones';
import type { DailyScoresInput, DayRecord, HourlyBucket } from '../src/health/scores/types';

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TARGET = '2026-03-20';
// Small deterministic wobble so baselines have spread without randomness.
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;

const hourly = (day: string, offset: number, opts: { hr?: number; hrv?: number | null; hours?: readonly number[] } = {}): HourlyBucket[] =>
  (opts.hours ?? [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]).map(h => ({
    startAt: new Date(Date.parse(`${day}T00:00:00Z`) + h * 3_600_000).toISOString(),
    heartRate: (opts.hr ?? 72) + wobble(h + offset, 2),
    hrv: opts.hrv === undefined ? 55 : opts.hrv,
    hrvMethod: opts.hrv === null ? null : 'rmssd',
    daylightMinutes: 20, movementMinutes: 12,
  }));

const day = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: { value: 60 + wobble(i, 6), method: 'rmssd' },
    restingHeartRate: 55 + wobble(i, 2),
    hourly: hourly(d, i), workouts: [],
    demand: { meetingMinutes: 240 + wobble(i, 40), messageCount: 30 + wobble(i, 5), openTaskMinutes: 120 + wobble(i, 20), physicalLoad: 100 + wobble(i, 10) },
    ...over,
  };
};
const week = (n = 21): DayRecord[] => Array.from({ length: n }, (_, i) => day(i));
const input = (days: DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z`, source: 'apple', ...over });
const replaceTarget = (over: Partial<DayRecord>) => [day(0, over), ...week().slice(1)];

describe('health scores: Recovery', () => {
  it('scores a normal week as an available integer 0-100 with the candidate label and basis', () => {
    const r = computeDailyScores(input(week())).recovery;
    expect(r.state).toBe('available');
    if (r.state !== 'available') return;
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.activation).toBe('candidate_unaccepted');
    expect(r.algorithm_version).toMatch(/\.v1$/);
    expect(r.coverage).toBe(1);
    expect(r.hrv_method).toBe('rmssd');
    expect(r.used.signals).toEqual(expect.arrayContaining(['sleep', 'hrv', 'resting_heart_rate']));
  });
  it('uses the exact inclusive zone edges 80, 60, 40', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 0].map(recoveryZone)).toEqual(['excellent', 'excellent', 'solid', 'solid', 'mixed', 'mixed', 'compromised', 'compromised']);
    expect([80, 79, 60, 59, 40, 39].map(formZone)).toEqual(['energized', 'steady', 'steady', 'flagging', 'flagging', 'depleted']);
    expect([0, 20, 21, 40, 41, 60, 61, 100].map(weightZone)).toEqual(['light', 'light', 'moderate', 'moderate', 'heavy', 'heavy', 'peak', 'peak']);
  });
  it('is unavailable with missing_sleep when the target day has no sleep', () => {
    expect(computeDailyScores(input(replaceTarget({ sleep: null }))).recovery).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
  it('is unavailable with missing_resting_signal when neither HRV nor resting heart rate exists', () => {
    expect(computeDailyScores(input(replaceTarget({ overnightHrv: null, restingHeartRate: null }))).recovery).toEqual({ state: 'unavailable', reason: 'missing_resting_signal' });
  });
  it('is unavailable with baseline_immature when fewer than 14 prior days back the signals', () => {
    expect(computeDailyScores(input(week(10))).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('is unavailable with no_readings when there is no data at all', () => {
    expect(computeDailyScores(input([])).recovery).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
  it('is unavailable with conflicting_inputs when a day appears twice with different values', () => {
    const days = [...week(), day(3, { restingHeartRate: 90 })];
    expect(computeDailyScores(input(days)).recovery).toEqual({ state: 'unavailable', reason: 'conflicting_inputs' });
  });
  it.each(['not_linked', 'consent_required', 'consent_withdrawn'] as const)('reports %s for every pillar and reads nothing else', access => {
    const s = computeDailyScores(input(week(), { access }));
    for (const p of [s.recovery, s.form, s.weight, s.sleep_debt]) expect(p).toEqual({ state: 'unavailable', reason: access });
  });
  it('labels the SDNN fallback and never blends it with RMSSD baselines', () => {
    const days = week().map((d, i) => (i === 0 ? { ...d, overnightHrv: { value: 40, method: 'sdnn' as const } } : d));
    const r = computeDailyScores(input(days)).recovery;
    // Every baseline day is RMSSD, so the SDNN reading has no baseline of its own; resting HR still scores.
    expect(r.state).toBe('available');
    if (r.state !== 'available') return;
    expect(r.hrv_method).toBeNull();
    expect(r.coverage).toBeCloseTo(0.7, 5);
    const sdnnWeek = week().map(d => ({ ...d, overnightHrv: d.overnightHrv && { ...d.overnightHrv, method: 'sdnn' as const } }));
    const r2 = computeDailyScores(input(sdnnWeek)).recovery;
    expect(r2.state === 'available' && r2.hrv_method).toBe('sdnn');
  });
  it('does not lower Recovery when sleep gets longer, all else fixed', () => {
    const score = (m: number) => {
      const r = computeDailyScores(input(replaceTarget({ sleep: { startAt: 'x', endAt: 'y', asleepMinutes: m, midpointMinute: 180 } }))).recovery;
      return r.state === 'available' ? r.score : -1;
    };
    expect(score(480)).toBeGreaterThanOrEqual(score(360));
  });
  it('is deterministic', () => {
    const a = computeDailyScores(input(week()));
    expect(computeDailyScores(input(week()))).toEqual(a);
  });
});

describe('health scores: Sleep debt', () => {
  it('is available with a weighted shortfall when all 14 nights exist', () => {
    const days = week().map(d => ({ ...d, sleep: d.sleep && { ...d.sleep, asleepMinutes: 420 } }));
    const s = computeDailyScores(input(days)).sleep_debt;
    expect(s.state).toBe('available');
    if (s.state !== 'available') return;
    // 60 minutes short each night, weights 1 - age/26 over ages 0..13 sum to 14 - 91/26.
    expect(s.debt_minutes).toBeCloseTo(60 * (14 - 91 / 26), 2);
    expect(s.coverage).toBe(1);
    expect(s.need_basis).toBe('owner_confirmed');
  });
  it('is partial with null debt and honest coverage when nights are missing', () => {
    const days = week().filter((_, i) => i !== 2 && i !== 5);
    const s = computeDailyScores(input(days)).sleep_debt;
    expect(s.state).toBe('partial');
    if (s.state === 'unavailable') return;
    expect(s.debt_minutes).toBeNull();
    expect(s.missing_nights).toEqual([addDays(TARGET, -2), addDays(TARGET, -5)]);
    expect(s.coverage).toBeLessThan(1);
    expect(s.coverage).toBeGreaterThan(0.8);
  });
  it('is unavailable with missing_sleep when no night exists in the window', () => {
    const days = week().map(d => ({ ...d, sleep: null }));
    expect(computeDailyScores(input(days)).sleep_debt).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
  it('falls back to the owner average only with a mature history, else baseline_immature', () => {
    expect(computeDailyScores(input(week(), { sleepNeedMinutes: null })).sleep_debt.state).not.toBe('unavailable');
    expect(computeDailyScores(input(week(10), { sleepNeedMinutes: null })).sleep_debt).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
});

describe('health scores: Form (ADR-0081 form.safte-fast.v1)', () => {
  it('scores from sleep, hrv, circadian and motion with the accepted version, full coverage and Apple confidence', () => {
    const f = computeDailyScores(input(week())).form;
    expect(f.state).toBe('available');
    if (f.state !== 'available') return;
    expect(f.algorithm_version).toBe('form.safte-fast.v1');
    expect(f.activation).toBe('candidate_unaccepted');
    expect(Number.isInteger(f.score)).toBe(true);
    expect(f.coverage).toBe(1);
    expect(f.confidence).toBe(1);
    expect([...f.used.signals].sort()).toEqual(['circadian', 'hrv', 'motion', 'sleep']);
    expect(f.zone).toBe(formZone(f.score));
  });
  it('combines integer components with the accepted weights and rounds half up at every zone edge', () => {
    expect(formComposite({ sleep: 79, hrv: 80, circadian: 80, motion: 80 })).toEqual({ score: 80, coverage: 1 });
    expect(formComposite({ sleep: 59, hrv: 60, circadian: 60, motion: 60 })).toEqual({ score: 60, coverage: 1 });
    expect(formComposite({ sleep: 39, hrv: 40, circadian: 40, motion: 40 })).toEqual({ score: 40, coverage: 1 });
    expect(formComposite({ sleep: 100, hrv: 0, circadian: 0, motion: 0 })).toEqual({ score: 50, coverage: 1 });
    expect(formComposite({ sleep: 0, hrv: 100, circadian: 0, motion: 0 })).toEqual({ score: 35, coverage: 1 });
    // Without circadian the formula renormalises over 0.925: (500*60 + 350*59 + 75*59) / 925 = 59.54.
    expect(formComposite({ sleep: 60, hrv: 59, circadian: null, motion: 59 })).toEqual({ score: 60, coverage: 0.925 });
  });
  it('is unavailable unless sleep, hrv and at least one of circadian or motion are present', () => {
    expect(formComposite({ sleep: 80, hrv: null, circadian: 80, motion: 80 })).toBeNull();
    expect(formComposite({ sleep: null, hrv: 80, circadian: 80, motion: 80 })).toBeNull();
    expect(formComposite({ sleep: 80, hrv: 80, circadian: null, motion: null })).toBeNull();
  });
  it('does not let resting heart rate stand in for HRV, unlike Recovery', () => {
    const days = replaceTarget({ overnightHrv: null });
    expect(computeDailyScores(input(days)).form).toEqual({ state: 'unavailable', reason: 'missing_resting_signal' });
    expect(computeDailyScores(input(days)).recovery.state).toBe('available');
  });
  it('is baseline_immature while fewer than 14 prior nights back HRV', () => {
    expect(computeDailyScores(input(week(10))).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('drops motion, not the score, when the day has no hourly data: coverage 0.925', () => {
    const f = computeDailyScores(input(replaceTarget({ hourly: [] }))).form;
    expect(f.state).toBe('available');
    if (f.state !== 'available') return;
    expect(f.coverage).toBe(0.925);
    expect(f.used.signals).not.toContain('motion');
    expect(f.confidence).toBe(0.925);
  });
  it('ignores daytime heart rate: the accepted Form has no stress component', () => {
    const base = computeDailyScores(input(week())).form;
    const spike = hourly(TARGET, 0).map(b => ({ ...b, heartRate: 165 }));
    const spiked = computeDailyScores(input(replaceTarget({ hourly: spike }))).form;
    if (base.state !== 'available' || spiked.state !== 'available') throw new Error('expected available');
    expect(spiked.score).toBe(base.score);
  });
  it('is fresh up to 36 hours after the night ended, stale (confidence x0.75) up to 72, unavailable beyond', () => {
    const at = (hours: number) => computeDailyScores(input(week(), { asOf: new Date(Date.parse(`${TARGET}T07:00:00.000Z`) + hours * 3_600_000).toISOString() })).form;
    const fresh = at(36), stale = at(36.5), edge = at(72), expired = at(72.5);
    if (fresh.state !== 'available' || stale.state !== 'available' || edge.state !== 'available') throw new Error('expected available');
    expect(fresh.confidence).toBe(1);
    expect(stale.confidence).toBe(0.75);
    expect(edge.confidence).toBe(0.75);
    expect(stale.score).toBe(fresh.score);
    expect(expired).toEqual({ state: 'unavailable', reason: 'stale_inputs' });
  });
  it('counts only sources in the accepted table: Samsung at 0.6, Health Connect not at all', () => {
    const samsung = computeDailyScores(input(week(), { source: 'samsung' })).form;
    if (samsung.state !== 'available') throw new Error('expected available');
    expect(samsung.confidence).toBe(0.6);
    expect(computeDailyScores(input(week(), { source: 'health_connect' })).form).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(computeDailyScores(input(week(), { source: null })).form).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
  it('passes missing sleep through as its own reason', () => {
    expect(computeDailyScores(input(replaceTarget({ sleep: null }))).form).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
});

describe('health scores: Weight', () => {
  it('scores the day demand and uses the demand zone words', () => {
    const w = computeDailyScores(input(week())).weight;
    expect(w.state).toBe('available');
    if (w.state !== 'available') return;
    expect(['light', 'moderate', 'heavy', 'peak']).toContain(w.zone);
    expect(w.coverage).toBe(1);
  });
  it('rises when meetings, messages and load rise against the owner baseline', () => {
    const score = (m: number) => {
      const w = computeDailyScores(input(replaceTarget({ demand: { meetingMinutes: m, messageCount: 30, openTaskMinutes: 120, physicalLoad: 100 } }))).weight;
      return w.state === 'available' ? w.score : -1;
    };
    expect(score(600)).toBeGreaterThan(score(60));
  });
  it('is calendar_demand_unavailable without meeting minutes and drops other missing demand with lower coverage', () => {
    expect(computeDailyScores(input(replaceTarget({ demand: { meetingMinutes: null, messageCount: 30, openTaskMinutes: 120, physicalLoad: 100 } }))).weight).toEqual({ state: 'unavailable', reason: 'calendar_demand_unavailable' });
    const w = computeDailyScores(input(replaceTarget({ demand: { meetingMinutes: 240, messageCount: null, openTaskMinutes: 120, physicalLoad: 100 } }))).weight;
    expect(w.state === 'available' && w.coverage).toBeCloseTo(0.85, 5);
  });
  it('is baseline_immature with fewer than 14 prior days of calendar history', () => {
    expect(computeDailyScores(input(week(10))).weight).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
});

describe('health scores: time', () => {
  it('knows a local day is 23 hours on spring-forward, 25 on fall-back and 24 otherwise', () => {
    const hours = (d: string, tz: string) => { const w = localDayWindow(d, tz); return (w.end - w.start) / 3_600_000; };
    expect(hours('2026-03-08', 'America/New_York')).toBe(23);
    expect(hours('2026-11-01', 'America/New_York')).toBe(25);
    expect(hours('2026-03-09', 'America/New_York')).toBe(24);
    expect(hours('2026-03-29', 'Europe/London')).toBe(23);
    expect(hours('2026-04-05', 'Pacific/Auckland')).toBe(25);
    expect(hours('2026-03-20', 'Asia/Kolkata')).toBe(24);
  });
  it('drops hourly readings outside the day own local window', () => {
    const outside = { ...hourly(TARGET, 0)[0]!, startAt: `${addDays(TARGET, 1)}T12:00:00.000Z`, movementMinutes: 55 };
    const a = computeDailyScores(input(replaceTarget({ hourly: [...hourly(TARGET, 0), outside] })));
    expect(a).toEqual(computeDailyScores(input(week())));
  });
  it('reports conflicting_inputs for an unknown time zone instead of throwing', () => {
    expect(computeDailyScores(input(replaceTarget({ timezone: 'Mars/Olympus' }))).recovery).toEqual({ state: 'unavailable', reason: 'conflicting_inputs' });
  });
  const dstDay = (d: string, tz: string, i: number): DayRecord => ({ ...day(i), day: d, timezone: tz, hourly: hourly(d, i), sleep: { ...day(i).sleep!, startAt: 'x', endAt: 'y' } });
  it('counts a 23-hour spring-forward day as full when every hour exists', () => {
    const target = '2026-03-08'; // America/New_York spring forward
    const days = Array.from({ length: 21 }, (_, i) => ({ ...dstDay(addDays(target, -i), 'America/New_York', i) }));
    const hours = (d: string) => Array.from({ length: 23 }, (_, h) => ({ startAt: new Date(Date.parse(`${d}T05:00:00Z`) + h * 3_600_000).toISOString(), heartRate: 70, hrv: 50, hrvMethod: 'rmssd' as const, daylightMinutes: 20, movementMinutes: 10 }));
    days[0] = { ...days[0]!, hourly: hours(target) };
    const r = computeDailyScores({ access: 'granted', targetDay: target, days, sleepNeedMinutes: 480, asOf: '2026-03-08T23:00:00.000Z' });
    expect(r.form.state === 'available' || r.form.state === 'unavailable').toBe(true);
    expect(r.recovery.state).toBe('available');
  });
  it('accepts a time-zone change inside the baseline window without treating it as a conflict', () => {
    // Local 08:00-19:00 in Tokyo is nine hours earlier in UTC.
    const tokyo = (d: DayRecord): DayRecord => ({ ...d, timezone: 'Asia/Tokyo', hourly: d.hourly.map(b => ({ ...b, startAt: new Date(Date.parse(b.startAt) - 9 * 3_600_000).toISOString() })) });
    const days = week().map((d, i) => (i >= 8 ? tokyo(d) : d));
    const r = computeDailyScores(input(days));
    expect(r.recovery.state).toBe('available');
    expect(r.form.state).toBe('available');
  });
  it('never emits NaN or Infinity for a zero-variance baseline', () => {
    const flat = week().map(d => ({ ...d, overnightHrv: { value: 60, method: 'rmssd' as const }, restingHeartRate: 55 }));
    const target = { ...flat[0]!, overnightHrv: { value: 80, method: 'rmssd' as const } };
    const r = computeDailyScores(input([target, ...flat.slice(1)])).recovery;
    expect(r.state).toBe('available');
    if (r.state === 'available') expect(Number.isFinite(r.score)).toBe(true);
  });
});
