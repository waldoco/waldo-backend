import { describe, expect, it } from 'vitest';
import { computeDailyScores } from '../src/health/scores';
import { localIso, localToEpoch } from '../src/channels/reminders';
import { localDayWindow } from '../src/health/scores/time';
import { formZone, heldZone, recoveryZone, weightZone } from '../src/health/scores/zones';
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
    daylightMinutes: 20, movementMinutes: 12, activeEnergyKcal: null,
  }));

const day = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: [{ value: 60 + wobble(i, 6), method: 'rmssd' }],
    restingHeartRate: [{ value: 55 + wobble(i, 2), method: 'provider_resting_daily' }],
    hourly: hourly(d, i), workouts: [],
    demand: { meetingMinutes: 240 + wobble(i, 40), messageCount: 30 + wobble(i, 5), openTaskMinutes: 120 + wobble(i, 20), physicalLoad: 100 + wobble(i, 10) },
    ...over,
  };
};
const week = (n = 21): DayRecord[] => Array.from({ length: n }, (_, i) => day(i));
const input = (days: DayRecord[], over: Partial<DailyScoresInput> = {}): DailyScoresInput =>
  ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z`, ...over });
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
    expect(r.algorithm_version).toBe('recovery.candidate.v2');
    expect(r.coverage).toBe(1);
    expect(r.hrv_method).toBe('rmssd');
    expect(r.used.signals).toEqual(expect.arrayContaining(['sleep', 'hrv', 'resting_heart_rate']));
  });
  it('uses the exact inclusive zone edges 80, 60, 40', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 0].map(recoveryZone)).toEqual(['excellent', 'excellent', 'solid', 'solid', 'mixed', 'mixed', 'compromised', 'compromised']);
    expect([80, 79, 60, 59, 40, 39].map(formZone)).toEqual(['energized', 'steady', 'steady', 'flagging', 'flagging', 'depleted']);
    expect([0, 20, 21, 40, 41, 60, 61, 100].map(weightZone)).toEqual(['light', 'light', 'moderate', 'moderate', 'heavy', 'heavy', 'peak', 'peak']);
  });
  it('holds a zone through a move of five points or fewer past it, and leaves it on a larger one, in every band shape', () => {
    expect([75, 74, 90].map(score => heldZone(formZone, score, 'energized'))).toEqual(['energized', 'steady', 'energized']);
    expect([84, 85, 55, 54].map(score => heldZone(formZone, score, 'steady'))).toEqual(['steady', 'energized', 'steady', 'flagging']);
    expect([25, 26].map(score => heldZone(weightZone, score, 'light'))).toEqual(['light', 'moderate']);
    expect([79, 61, 35].map(score => heldZone(recoveryZone, score, null))).toEqual(['solid', 'solid', 'compromised']);
    // Two zones away is never held, however near an edge.
    expect(heldZone(formZone, 61, 'depleted')).toBe('steady');
  });
  it('is unavailable with missing_sleep when the target day has no sleep', () => {
    expect(computeDailyScores(input(replaceTarget({ sleep: null }))).recovery).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
  it('is unavailable with missing_resting_signal when neither HRV nor resting heart rate exists', () => {
    expect(computeDailyScores(input(replaceTarget({ overnightHrv: [], restingHeartRate: [] }))).recovery).toEqual({ state: 'unavailable', reason: 'missing_resting_signal' });
  });
  it('is unavailable with baseline_immature when fewer than 14 prior days back the signals', () => {
    expect(computeDailyScores(input(week(10))).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('is unavailable with no_readings when there is no data at all', () => {
    expect(computeDailyScores(input([])).recovery).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });
  it('is unavailable with conflicting_inputs when a day appears twice with different values', () => {
    const days = [...week(), day(3, { restingHeartRate: [{ value: 90, method: 'provider_resting_daily' }] })];
    expect(computeDailyScores(input(days)).recovery).toEqual({ state: 'unavailable', reason: 'conflicting_inputs' });
  });
  it.each(['not_linked', 'consent_required', 'consent_withdrawn'] as const)('reports %s for every pillar and reads nothing else', access => {
    const s = computeDailyScores(input(week(), { access }));
    for (const p of [s.recovery, s.form, s.weight, s.sleep_debt]) expect(p).toEqual({ state: 'unavailable', reason: access });
  });
  it('labels the SDNN fallback and never blends it with RMSSD baselines', () => {
    const days = week().map((d, i) => (i === 0 ? { ...d, overnightHrv: [{ value: 40, method: 'sdnn' as const }] } : d));
    const r = computeDailyScores(input(days)).recovery;
    // Every baseline day is RMSSD, so the SDNN reading has no baseline of its own; resting HR still scores.
    expect(r.state).toBe('available');
    if (r.state !== 'available') return;
    expect(r.hrv_method).toBeNull();
    expect(r.coverage).toBeCloseTo(0.7, 5);
    const sdnnWeek = week().map(d => ({ ...d, overnightHrv: d.overnightHrv.map(reading => ({ ...reading, method: 'sdnn' as const })) }));
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

describe('health scores: Form', () => {
  it('scores with recovery, circadian, motion and stress components', () => {
    const f = computeDailyScores(input(week())).form;
    expect(f.state).toBe('available');
    if (f.state !== 'available') return;
    expect(f.coverage).toBe(1);
    expect(f.used.signals).toEqual(expect.arrayContaining(['sleep', 'sleep_midpoint', 'daylight', 'movement', 'stress']));
    expect(['energized', 'steady', 'flagging', 'depleted']).toContain(f.zone);
  });
  it('ignores heart rate during a recorded workout so it does not read as stress', () => {
    const base = computeDailyScores(input(week())).form;
    const spike = hourly(TARGET, 0).map(b => (['2026-03-20T16:00:00.000Z', '2026-03-20T17:00:00.000Z'].includes(b.startAt) ? { ...b, heartRate: 165 } : b));
    const withoutWorkout = computeDailyScores(input(replaceTarget({ hourly: spike }))).form;
    const withWorkout = computeDailyScores(input(replaceTarget({ hourly: spike, workouts: [{ startAt: '2026-03-20T16:00:00.000Z', endAt: '2026-03-20T18:00:00.000Z' }] }))).form;
    if (base.state !== 'available' || withoutWorkout.state !== 'available' || withWorkout.state !== 'available') throw new Error('expected available');
    expect(withoutWorkout.score).toBeLessThan(base.score);
    expect(withWorkout.score).toBeGreaterThan(withoutWorkout.score);
  });
  it('is intraday_inputs_unavailable when the target day has no hourly data', () => {
    expect(computeDailyScores(input(replaceTarget({ hourly: [] }))).form).toEqual({ state: 'unavailable', reason: 'intraday_inputs_unavailable' });
  });
  it('is stale_inputs while the day is still running and its newest hourly data is older than 6 hours', () => {
    const morning = replaceTarget({ hourly: hourly(TARGET, 0, { hours: [4, 5, 6, 7, 8, 9, 10, 11, 12] }) });
    expect(computeDailyScores(input(morning, { asOf: `${TARGET}T19:30:00.000Z` })).form).toEqual({ state: 'unavailable', reason: 'stale_inputs' });
  });
  it('judges a finished day on the hours it has, so the next morning\'s recompute does not mark it stale', () => {
    const evening = computeDailyScores(input(week(), { asOf: `${TARGET}T20:30:00.000Z` })).form;
    const nextMorning = computeDailyScores(input(week(), { asOf: `${addDays(TARGET, 1)}T08:00:00.000Z` })).form;
    expect(evening.state).toBe('available');
    expect(nextMorning).toEqual(evening);
  });
  it('passes a Recovery failure through as its own reason', () => {
    expect(computeDailyScores(input(replaceTarget({ sleep: null }))).form).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
  });
  it('leaves out daylight and movement when the hours carry heart rate but no reading for them, instead of scoring them as usual', () => {
    const heartRateOnly = (record: DayRecord): DayRecord => ({ ...record, hourly: record.hourly.map(bucket => ({ ...bucket, daylightMinutes: null, movementMinutes: null })) });
    const f = computeDailyScores(input(week().map(heartRateOnly))).form;
    expect(f.state).toBe('available');
    if (f.state !== 'available') return;
    expect(f.used.signals).not.toContain('daylight');
    expect(f.used.signals).not.toContain('movement');
    expect(f.coverage).toBeLessThan(1);
  });
  it('counts an hour the phone left out as none on a day that carries the reading, as the phone sends only hours that hold some', () => {
    const daylightIn = (record: DayRecord, hours: number): DayRecord => ({ ...record, hourly: record.hourly.map((bucket, i) => (i < hours ? bucket : { ...bucket, daylightMinutes: null })) });
    const history = week().slice(1).map(record => daylightIn(record, 3));
    const usual = computeDailyScores(input([daylightIn(day(0), 3), ...history])).form;
    const less = computeDailyScores(input([daylightIn(day(0), 1), ...history])).form;
    if (usual.state !== 'available' || less.state !== 'available') throw new Error('expected available');
    expect(usual.used.signals).toContain('daylight');
    expect(less.used.signals).toContain('daylight');
    expect(less.score).toBeLessThan(usual.score);
  });
});

// A day of identical habits by the owner's own wall clock: a bucket every local hour, daylight 07:00-19:00, movement
// 07:00-22:00, asleep 23:00-07:00. With every day alike, any difference in Form comes from how the day is compared.
const wallHour = (d: string, tz: string, h: number): number | null => {
  const local = `${d}T${String(h).padStart(2, '0')}:00`, at = localToEpoch(local, tz);
  return localIso(at, tz) === local ? at : null;
};
const habitual = (d: string, tz: string, through = 24): DayRecord => ({
  day: d, timezone: tz,
  sleep: { startAt: new Date(wallHour(addDays(d, -1), tz, 23)!).toISOString(), endAt: new Date(wallHour(d, tz, 7)!).toISOString(), asleepMinutes: 450, midpointMinute: 180 },
  overnightHrv: [{ value: 60, method: 'rmssd' }], restingHeartRate: [{ value: 55, method: 'provider_resting_daily' }], workouts: [], demand: null,
  hourly: Array.from({ length: through }, (_, h) => h).flatMap(h => {
    const at = wallHour(d, tz, h);
    return at === null ? [] : [{ startAt: new Date(at).toISOString(), heartRate: 70, hrv: 55, hrvMethod: 'rmssd' as const, daylightMinutes: h >= 7 && h < 19 ? 20 : null, movementMinutes: h >= 7 && h < 22 ? 10 : null, activeEnergyKcal: null }];
  }),
});
const formOn = (target: string, tz: string, through: number, historyTz: (i: number) => string = () => tz) => {
  const days = [habitual(target, tz, through), ...Array.from({ length: 21 }, (_, i) => habitual(addDays(target, -(i + 1)), historyTz(i + 1)))];
  const asOf = new Date((wallHour(target, tz, Math.min(through, 23)) ?? 0) + (through >= 24 ? 2 : 0.5) * 3_600_000).toISOString();
  return computeDailyScores({ access: 'granted', targetDay: target, days, sleepNeedMinutes: 480, asOf }).form;
};

describe('health scores: Form on a day still in progress', () => {
  it('compares the hours so far with the same hours of earlier days, so a usual morning reads as usual, not low', () => {
    const afternoon = formOn(TARGET, 'Europe/London', 15), wholeDay = formOn(TARGET, 'Europe/London', 24);
    if (afternoon.state !== 'available' || wholeDay.state !== 'available') throw new Error('expected available');
    expect(afternoon.used.signals).toEqual(expect.arrayContaining(['daylight', 'movement', 'stress']));
    expect(afternoon.score).toBe(wholeDay.score);
    expect(afternoon.algorithm_version).toBe('form.candidate.v5');
  });
  it('still reads a day that is really behind its usual hours as lower', () => {
    const quiet = (record: DayRecord): DayRecord => ({ ...record, hourly: record.hourly.map(bucket => ({ ...bucket, daylightMinutes: bucket.daylightMinutes && 5, movementMinutes: bucket.movementMinutes && 2 })) });
    const days = [quiet(habitual(TARGET, 'Europe/London', 15)), ...Array.from({ length: 21 }, (_, i) => habitual(addDays(TARGET, -(i + 1)), 'Europe/London'))];
    const behind = computeDailyScores({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T15:30:00.000Z` }).form;
    const usual = formOn(TARGET, 'Europe/London', 15);
    if (behind.state !== 'available' || usual.state !== 'available') throw new Error('expected available');
    expect(behind.score).toBeLessThan(usual.score);
  });
  // Counting elapsed hours instead would cut the earlier days an hour short of 15:00 here, in daylight.
  it('matches hours by the wall clock on a spring-forward day, whose 15:00 is only 14 hours after midnight', () => {
    const afternoon = formOn('2026-03-08', 'America/New_York', 15), wholeDay = formOn('2026-03-08', 'America/New_York', 24);
    if (afternoon.state !== 'available' || wholeDay.state !== 'available') throw new Error('expected available');
    expect(afternoon.score).toBe(wholeDay.score);
  });
  it('matches hours by the wall clock on a fall-back day, whose 15:00 is 16 hours after midnight', () => {
    const afternoon = formOn('2026-10-25', 'Europe/London', 15), wholeDay = formOn('2026-10-25', 'Europe/London', 24);
    if (afternoon.state !== 'available' || wholeDay.state !== 'available') throw new Error('expected available');
    expect(afternoon.score).toBe(wholeDay.score);
  });
  it('matches each earlier day by its own zone\'s clock after the owner changes time zone', () => {
    const travelled = (i: number) => (i >= 3 ? 'Asia/Kolkata' : 'Europe/London');
    const afternoon = formOn(TARGET, 'Europe/London', 15, travelled), wholeDay = formOn(TARGET, 'Europe/London', 24, travelled);
    if (afternoon.state !== 'available' || wholeDay.state !== 'available') throw new Error('expected available');
    expect(afternoon.score).toBe(wholeDay.score);
  });
  it('leaves out the hour the phone is still filling, on both sides, until it ends', () => {
    // At 15:20 the 15:00 window holds twenty minutes of an hour the earlier days hold in full.
    const growing = habitual(TARGET, 'Europe/London', 16);
    const days = [{ ...growing, hourly: growing.hourly.map((bucket, h) => (h === 15 ? { ...bucket, daylightMinutes: 7, movementMinutes: 3 } : bucket)) },
      ...Array.from({ length: 21 }, (_, i) => habitual(addDays(TARGET, -(i + 1)), 'Europe/London'))];
    const midHour = computeDailyScores({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T15:20:00.000Z` }).form;
    const wholeDay = formOn(TARGET, 'Europe/London', 24);
    if (midHour.state !== 'available' || wholeDay.state !== 'available') throw new Error('expected available');
    expect(midHour.score).toBe(wholeDay.score);
  });
  it('does not move when only the clock moves and no new hours arrive', () => {
    const days = [habitual(TARGET, 'Europe/London', 15), ...Array.from({ length: 21 }, (_, i) => habitual(addDays(TARGET, -(i + 1)), 'Europe/London'))];
    const at = (iso: string) => computeDailyScores({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: iso }).form;
    expect(at(`${TARGET}T19:00:00.000Z`)).toEqual(at(`${TARGET}T15:30:00.000Z`));
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
    const hours = (d: string) => Array.from({ length: 23 }, (_, h) => ({ startAt: new Date(Date.parse(`${d}T05:00:00Z`) + h * 3_600_000).toISOString(), heartRate: 70, hrv: 50, hrvMethod: 'rmssd' as const, daylightMinutes: 20, movementMinutes: 10, activeEnergyKcal: null }));
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
    const flat = week().map(d => ({ ...d, overnightHrv: [{ value: 60, method: 'rmssd' as const }], restingHeartRate: [{ value: 55, method: 'provider_resting_daily' as const }] }));
    const target = { ...flat[0]!, overnightHrv: [{ value: 80, method: 'rmssd' as const }] };
    const r = computeDailyScores(input([target, ...flat.slice(1)])).recovery;
    expect(r.state).toBe('available');
    if (r.state === 'available') expect(Number.isFinite(r.score)).toBe(true);
  });
});
