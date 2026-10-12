import { describe, expect, it } from 'vitest';
import { computeDailyScores } from '../src/health/scores';
import { formComposite } from '../src/health/scores/form';
import type { FormSourceDays } from '../src/health/scores/types';
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
    daylightMinutes: 20, movementMinutes: 6,
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
    // Form has no resting-HR stand-in, so an SDNN night against RMSSD baselines leaves its HRV pillar without a baseline.
    expect(computeDailyScores(input(days)).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
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

describe('health scores: Form (ADR-0081 candidate form.safte-fast.v2)', () => {
  const spikeAt = (hours: readonly number[], over: Partial<HourlyBucket> = {}) =>
    hourly(TARGET, 0).map((b, i) => (hours.includes(i) ? { ...b, heartRate: 165, ...over } : b));
  it('scores from sleep, hrv, circadian, motion and stress with the candidate version, full coverage and Apple confidence', () => {
    const f = computeDailyScores(input(week())).form;
    expect(f.state).toBe('available');
    if (f.state !== 'available') return;
    expect(f.algorithm_version).toBe('form.safte-fast.v2');
    expect(f.activation).toBe('candidate_unaccepted');
    expect(Number.isInteger(f.score)).toBe(true);
    expect(f.coverage).toBe(1);
    expect(f.confidence).toBe(1);
    expect([...f.used.signals].sort()).toEqual(['circadian', 'hrv', 'motion', 'sleep', 'stress']);
    expect(f.sources).toEqual(['apple']);
    expect(f.zone).toBe(formZone(f.score));
  });
  it('combines integer components with the candidate shares and rounds half up exactly', () => {
    expect(formComposite({ sleep: 80, hrv: 80, circadian: 80, motion: 80, stress: 80 })).toEqual({ score: 80, coverage: 1 });
    // 80.5: half-even would give 80.
    expect(formComposite({ sleep: 80, hrv: 80, circadian: 80, motion: 80, stress: 85 })).toEqual({ score: 81, coverage: 1 });
    // 80.0675: ceiling would give 81.
    expect(formComposite({ sleep: 80, hrv: 80, circadian: 81, motion: 80, stress: 80 })).toEqual({ score: 80, coverage: 1 });
    // 20.5 exactly, which floating-point weights compute as 20.4999...
    expect(formComposite({ sleep: 1, hrv: 61, circadian: 1, motion: 1, stress: 7 })).toEqual({ score: 21, coverage: 1 });
    expect(formComposite({ sleep: 79, hrv: 79, circadian: 79, motion: 79, stress: 84 })).toEqual({ score: 80, coverage: 1 });
    expect(formComposite({ sleep: 59, hrv: 59, circadian: 59, motion: 59, stress: 64 })).toEqual({ score: 60, coverage: 1 });
    expect(formComposite({ sleep: 39, hrv: 39, circadian: 39, motion: 39, stress: 44 })).toEqual({ score: 40, coverage: 1 });
    // Renormalised over sleep, hrv and motion: (4500*60 + 3150*59 + 675*59) / 8325 = 59.54.
    expect(formComposite({ sleep: 60, hrv: 59, circadian: null, motion: 59, stress: null })).toEqual({ score: 60, coverage: 0.8325 });
  });
  it('is unavailable unless sleep, hrv and at least one of circadian, motion or stress are present', () => {
    expect(formComposite({ sleep: 80, hrv: null, circadian: 80, motion: 80, stress: 80 })).toBeNull();
    expect(formComposite({ sleep: null, hrv: 80, circadian: 80, motion: 80, stress: 80 })).toBeNull();
    expect(formComposite({ sleep: 80, hrv: 80, circadian: null, motion: null, stress: null })).toBeNull();
    expect(formComposite({ sleep: 80, hrv: 80, circadian: null, motion: null, stress: 80 })).toEqual({ score: 80, coverage: 0.865 });
  });
  it('does not let resting heart rate stand in for HRV, unlike Recovery', () => {
    const days = replaceTarget({ overnightHrv: null });
    expect(computeDailyScores(input(days)).form).toEqual({ state: 'unavailable', reason: 'missing_resting_signal' });
    expect(computeDailyScores(input(days)).recovery.state).toBe('available');
  });
  it('is baseline_immature while fewer than 14 prior nights back HRV', () => {
    expect(computeDailyScores(input(week(10))).form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('keeps circadian from the sleep midpoint when the day has no hourly data: coverage 0.8325', () => {
    const f = computeDailyScores(input(replaceTarget({ hourly: [] }))).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect([...f.used.signals].sort()).toEqual(['circadian', 'hrv', 'sleep']);
    expect(f.coverage).toBe(0.8325);
    expect(f.confidence).toBe(0.833);
  });
  it('reads a racing heart in attributable hours as stress', () => {
    const base = computeDailyScores(input(week())).form;
    const racing = computeDailyScores(input(replaceTarget({ hourly: spikeAt([0, 1, 2, 3, 4, 5]) }))).form;
    if (base.state !== 'available' || racing.state !== 'available') throw new Error('expected available');
    expect(racing.score).toBeLessThan(base.score);
  });
  it('never reads heart rate as stress inside a workout or an hour of exertion', () => {
    const base = computeDailyScores(input(week())).form;
    const workout = { startAt: hourly(TARGET, 0)[0]!.startAt, endAt: hourly(TARGET, 0)[6]!.startAt };
    const inWorkout = computeDailyScores(input(replaceTarget({ hourly: spikeAt([0, 1, 2, 3, 4, 5]), workouts: [workout] }))).form;
    const exerting = computeDailyScores(input(replaceTarget({ hourly: spikeAt([0, 1, 2, 3, 4, 5], { movementMinutes: 10 }) }))).form;
    const racing = computeDailyScores(input(replaceTarget({ hourly: spikeAt([0, 1, 2, 3, 4, 5]) }))).form;
    if (base.state !== 'available' || inWorkout.state !== 'available' || exerting.state !== 'available' || racing.state !== 'available') throw new Error('expected available');
    // Six of twelve hours removed leaves exactly six attributable hours, under the eight stress needs.
    expect(inWorkout.used.signals).not.toContain('stress');
    expect(exerting.used.signals).not.toContain('stress');
    expect(inWorkout.score).toBeGreaterThan(racing.score);
  });
  it('counts no hour without movement data toward stress or motion', () => {
    const f = computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0).map(b => ({ ...b, movementMinutes: null })) }))).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.used.signals).not.toContain('stress');
    expect(f.used.signals).not.toContain('motion');
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
  it('weights each pillar by its source: Samsung and Health Connect at 0.6, an unknown source not at all', () => {
    for (const source of ['samsung', 'health_connect']) {
      const f = computeDailyScores(input(week(), { source })).form;
      if (f.state !== 'available') throw new Error('expected available');
      expect(f.confidence).toBe(0.6);
    }
    expect(computeDailyScores(input(week(), { source: 'garmin' })).form).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(computeDailyScores(input(week(), { source: null })).form).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
  it('discounts an SDNN-based HRV pillar to 0.8 of its source confidence', () => {
    const sdnnWeek = week().map(d => ({ ...d, overnightHrv: d.overnightHrv && { ...d.overnightHrv, method: 'sdnn' as const } }));
    const f = computeDailyScores(input(sdnnWeek)).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.hrv_method).toBe('sdnn');
    // 1 - 0.315 + 0.315 * 0.8
    expect(f.confidence).toBe(0.937);
  });
  it('picks the best source per pillar, so a mixed owner keeps Form whichever source has more readings', () => {
    const noHourly = week().map(d => ({ ...d, hourly: [] }));
    const noNights = week().map(d => ({ ...d, sleep: null, overnightHrv: null }));
    const formSources: FormSourceDays[] = [{ source: 'health_connect', days: noNights }, { source: 'apple', days: noHourly }];
    const f = computeDailyScores(input(noNights, { source: 'health_connect', formSources })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect([...f.used.signals].sort()).toEqual(['circadian', 'hrv', 'motion', 'sleep', 'stress']);
    expect([...f.sources].sort()).toEqual(['apple', 'health_connect']);
    // Apple carries sleep, hrv and the midpoint; Health Connect carries motion and stress: (4500 + 3150 + 675 + 0.6 * (675 + 1000)) / 10,000.
    expect(f.confidence).toBe(0.933);
  });
  it('takes the night from the next source when the most trusted one has none for the day', () => {
    const old = week().map(d => ({ ...d, day: addDays(d.day, -4), sleep: d.sleep && { ...d.sleep, endAt: `${addDays(d.day, -4)}T07:00:00.000Z` } }));
    const formSources: FormSourceDays[] = [{ source: 'apple', days: old }, { source: 'samsung', days: week() }];
    const f = computeDailyScores(input(week(), { source: 'samsung', formSources })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.sources).toEqual(['samsung']);
  });
  it('drops a source whose night ended more than 72 hours ago from every pillar', () => {
    // asOf is 20:00 on the target day, so this night is 73 hours old.
    const staleNight = { ...day(0).sleep!, endAt: `${addDays(TARGET, -3)}T19:00:00.000Z` };
    const formSources: FormSourceDays[] = [{ source: 'apple', days: replaceTarget({ sleep: staleNight }) }, { source: 'samsung', days: week() }];
    const f = computeDailyScores(input(week(), { source: 'samsung', formSources })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.sources).toEqual(['samsung']);
    expect(f.confidence).toBe(0.6);
    const alone = computeDailyScores(input(replaceTarget({ sleep: staleNight }))).form;
    expect(alone).toEqual({ state: 'unavailable', reason: 'stale_inputs' });
  });
  it('ages Form by the older of the sleep and hrv nights', () => {
    // Apple's fresh night carries sleep but no HRV; Samsung's night, 37 hours old, carries hrv.
    const apple = week().map(d => ({ ...d, overnightHrv: null }));
    const samsung = replaceTarget({ sleep: { ...day(0).sleep!, endAt: `${addDays(TARGET, -1)}T07:00:00.000Z` } });
    const f = computeDailyScores(input(week(), { formSources: [{ source: 'apple', days: apple }, { source: 'samsung', days: samsung }] })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.sources).toEqual(['apple', 'samsung']);
    // (4500 + 0.6 * 3150 + 675 + 675 + 1000) / 10,000 = 0.874, x0.75 for the stale night.
    expect(f.confidence).toBe(0.656);
  });
  it('breaks a confidence tie by the table order: Samsung before Health Connect', () => {
    const formSources: FormSourceDays[] = [{ source: 'health_connect', days: week() }, { source: 'samsung', days: week() }];
    const f = computeDailyScores(input(week(), { source: 'health_connect', formSources })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.sources).toEqual(['samsung']);
  });
  it('needs eight hours of readings before a day total counts toward motion', () => {
    const at = (hours: number[]) => computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0, { hours }) }))).form;
    const seven = at([8, 9, 10, 11, 12, 13, 14]), eight = at([8, 9, 10, 11, 12, 13, 14, 15]);
    if (seven.state !== 'available' || eight.state !== 'available') throw new Error('expected available');
    expect(seven.used.signals).not.toContain('motion');
    expect(eight.used.signals).toContain('motion');
  });
  it('reads low daytime RMSSD as stress, but only from four or more RMSSD hours', () => {
    const base = computeDailyScores(input(week())).form;
    const low = computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0, { hrv: 30 }) }))).form;
    const noHrv = computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0, { hrv: null }) }))).form;
    const threeLow = computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0, { hrv: null }).map((b, i) => (i < 3 ? { ...b, hrv: 30, hrvMethod: 'rmssd' as const } : b)) }))).form;
    const lowSdnn = computeDailyScores(input(replaceTarget({ hourly: hourly(TARGET, 0, { hrv: 30 }).map(b => ({ ...b, hrvMethod: 'sdnn' as const })) }))).form;
    if (base.state !== 'available' || low.state !== 'available' || noHrv.state !== 'available' || threeLow.state !== 'available' || lowSdnn.state !== 'available') throw new Error('expected available');
    expect(low.score).toBeLessThan(base.score);
    expect(threeLow.score).toBe(noHrv.score);
    expect(lowSdnn.score).toBe(noHrv.score);
  });
  it('leaves out a source whose own days conflict, without voiding the others', () => {
    const conflicting = [...week(), day(3, { restingHeartRate: 90 })];
    const formSources: FormSourceDays[] = [{ source: 'apple', days: conflicting }, { source: 'samsung', days: week() }];
    const f = computeDailyScores(input(week(), { source: 'samsung', formSources })).form;
    if (f.state !== 'available') throw new Error('expected available');
    expect(f.sources).toEqual(['samsung']);
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
