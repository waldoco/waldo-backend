import { describe, expect, it } from 'vitest';
import driverSql from '../../../supabase/migrations/20261023140000_health_sleep_debt_drivers.sql?raw';
import { computeDailyScores } from '../src/health/scores';
import { DRIVER_SUBJECTS } from '../src/health/scores/drivers';
import type { DailyScoresInput, DayRecord, DayVitals, HourlyBucket } from '../src/health/scores/types';

// Recovery v2, Weight v4 and the drivers (ADR-0081 amendment AW-2 and AW-3). Every value here is synthetic.
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TARGET = '2026-03-20';
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;

const hourly = (day: string, offset: number, energy: number | null = null): HourlyBucket[] =>
  [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(h => ({
    startAt: new Date(Date.parse(`${day}T00:00:00Z`) + h * 3_600_000).toISOString(),
    heartRate: 72 + wobble(h + offset, 2), hrv: 55, hrvMethod: 'rmssd', daylightMinutes: 20, movementMinutes: 12,
    activeEnergyKcal: energy === null ? null : energy + wobble(h + offset, 3),
  }));
const vitals = (i: number, over: Partial<DayVitals> = {}): DayVitals => ({
  breathingRate: 14 + wobble(i, 0.6), bloodOxygen: 96 + wobble(i, 1), awakeMinutes: 25 + wobble(i, 8), walkingHeartRate: 100 + wobble(i, 3),
  wristTemperature: [{ value: 34 + wobble(i, 0.3), method: 'absolute' }], ...over,
});
// The owner's usual: each earlier day wobbles around these, so the target day reads as usual unless a test moves it.
const usual: DayVitals = { breathingRate: 14, bloodOxygen: 96, awakeMinutes: 25, walkingHeartRate: 100, wristTemperature: [{ value: 34, method: 'absolute' }] };
const day = (i: number, over: Partial<DayRecord> = {}): DayRecord => {
  const d = addDays(TARGET, -i);
  return {
    day: d, timezone: 'Europe/London',
    sleep: { startAt: `${addDays(d, -1)}T23:00:00.000Z`, endAt: `${d}T07:00:00.000Z`, asleepMinutes: 450 + wobble(i, 20), midpointMinute: 180 + wobble(i, 15) },
    overnightHrv: [{ value: 60 + wobble(i, 6), method: 'rmssd' }],
    restingHeartRate: [{ value: 55 + wobble(i, 2), method: 'provider_resting_daily' }],
    hourly: hourly(d, i), workouts: [], vitals: i === 0 ? usual : vitals(i),
    demand: { meetingMinutes: 240 + wobble(i, 40), messageCount: null, openTaskMinutes: null, physicalLoad: 100 + wobble(i, 10) },
    ...over,
  };
};
const month = (over: (i: number) => Partial<DayRecord> = () => ({})): DayRecord[] => Array.from({ length: 21 }, (_, i) => day(i, over(i)));
const input = (days: DayRecord[]): DailyScoresInput => ({ access: 'granted', targetDay: TARGET, days, sleepNeedMinutes: 480, asOf: `${TARGET}T20:00:00.000Z` });
const withTarget = (days: DayRecord[], over: Partial<DayRecord>): DayRecord[] => [{ ...days[0]!, ...over }, ...days.slice(1)];
const scoreOf = (pillar: { state: string; score?: number }) => (pillar.state === 'available' ? pillar.score : null);

describe('health scores v2: versions', () => {
  it('labels Recovery v2, Form v5 and Weight v4, all still candidates', () => {
    const scores = computeDailyScores(input(month()));
    expect([scores.recovery, scores.form, scores.weight].map(p => (p.state === 'available' ? [p.algorithm_version, p.activation] : p.reason)))
      .toEqual([['recovery.candidate.v2', 'candidate_unaccepted'], ['form.candidate.v5', 'candidate_unaccepted'], ['weight.candidate.v4', 'candidate_unaccepted']]);
  });
});

describe('Recovery v2: HRV, one method per night with a fallback', () => {
  const sdnnMonth = () => month(i => ({ overnightHrv: [{ value: 45 + wobble(i, 5), method: 'sdnn' }] }));
  it('uses SDNN with its mature baseline on a night whose RMSSD has no baseline yet, instead of dropping HRV', () => {
    const days = withTarget(sdnnMonth(), { overnightHrv: [{ value: 30, method: 'rmssd' }, { value: 46, method: 'sdnn' }] });
    const recovery = computeDailyScores(input(days)).recovery;
    expect(recovery.state === 'available' && [recovery.hrv_method, recovery.used.signals.includes('hrv')]).toEqual(['sdnn', true]);
    // The RMSSD reading has no baseline of its own and is never read against the SDNN one.
    const sdnnOnly = computeDailyScores(input(withTarget(sdnnMonth(), { overnightHrv: [{ value: 46, method: 'sdnn' }] }))).recovery;
    expect(scoreOf(recovery)).toBe(scoreOf(sdnnOnly));
  });
  it('prefers RMSSD when both methods have a mature baseline', () => {
    const both = month(i => ({ overnightHrv: [{ value: 60 + wobble(i, 6), method: 'rmssd' }, { value: 45 + wobble(i, 5), method: 'sdnn' }] }));
    const recovery = computeDailyScores(input(withTarget(both, { overnightHrv: [{ value: 40, method: 'rmssd' }, { value: 45, method: 'sdnn' }] }))).recovery;
    const rmssdOnly = computeDailyScores(input(withTarget(both, { overnightHrv: [{ value: 40, method: 'rmssd' }] }))).recovery;
    expect(recovery.state === 'available' && recovery.hrv_method).toBe('rmssd');
    expect(scoreOf(recovery)).toBe(scoreOf(rmssdOnly));
  });
  it('leaves HRV out when no method of the night has a mature baseline', () => {
    const recovery = computeDailyScores(input(withTarget(sdnnMonth(), { overnightHrv: [{ value: 30, method: 'rmssd' }] }))).recovery;
    expect(recovery.state === 'available' && [recovery.hrv_method, recovery.used.signals]).toEqual([null, ['sleep', 'resting_heart_rate']]);
  });
});

describe('Recovery v2: resting heart rate, a baseline per method', () => {
  it('never reads one method against another method\'s days', () => {
    // Ten nightly minimums and eleven daily estimates: neither method alone has fourteen days.
    const mixed = month(i => ({ overnightHrv: [], restingHeartRate: [{ value: i % 2 ? 49 + wobble(i, 1) : 56 + wobble(i, 1), method: i % 2 ? 'overnight_resting' : 'provider_resting_daily' }] }));
    expect(computeDailyScores(input(mixed)).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });
  it('takes the mature method on a day holding two, and the order overnight, daily, measured, unknown when both are mature', () => {
    const daily = month(i => ({ overnightHrv: [] }));
    const twoMethods = computeDailyScores(input(withTarget(daily, { restingHeartRate: [{ value: 40, method: 'overnight_resting' }, { value: 56, method: 'provider_resting_daily' }] }))).recovery;
    const dailyOnly = computeDailyScores(input(withTarget(daily, { restingHeartRate: [{ value: 56, method: 'provider_resting_daily' }] }))).recovery;
    expect(scoreOf(twoMethods)).toBe(scoreOf(dailyOnly));
    const bothMature = month(i => ({ overnightHrv: [], restingHeartRate: [{ value: 49 + wobble(i, 1), method: 'overnight_resting' }, { value: 56 + wobble(i, 1), method: 'provider_resting_daily' }] }));
    const preferred = computeDailyScores(input(withTarget(bothMature, { restingHeartRate: [{ value: 53, method: 'overnight_resting' }, { value: 56, method: 'provider_resting_daily' }] }))).recovery;
    const overnightOnly = computeDailyScores(input(withTarget(bothMature, { restingHeartRate: [{ value: 53, method: 'overnight_resting' }] }))).recovery;
    const dailyOfBoth = computeDailyScores(input(withTarget(bothMature, { restingHeartRate: [{ value: 56, method: 'provider_resting_daily' }] }))).recovery;
    expect(scoreOf(preferred)).toBe(scoreOf(overnightOnly));
    expect(scoreOf(preferred)).not.toBe(scoreOf(dailyOfBoth));
  });
});

describe('Weight v4: physical load from active energy', () => {
  const energyMonth = () => month(i => ({ hourly: hourly(addDays(TARGET, -i), i, 30) }));
  it('reads the day\'s active energy against the owner\'s own, so more energy is a heavier day', () => {
    const quiet = scoreOf(computeDailyScores(input(withTarget(energyMonth(), { hourly: hourly(TARGET, 0, 20) }))).weight)!;
    const busy = scoreOf(computeDailyScores(input(withTarget(energyMonth(), { hourly: hourly(TARGET, 0, 45) }))).weight)!;
    expect(busy).toBeGreaterThan(quiet);
  });
  it('ignores minutes on a day it reads energy for', () => {
    const target = { hourly: hourly(TARGET, 0, 30) };
    const few = computeDailyScores(input(withTarget(energyMonth(), { ...target, demand: { ...day(0).demand!, physicalLoad: 10 } }))).weight;
    const many = computeDailyScores(input(withTarget(energyMonth(), { ...target, demand: { ...day(0).demand!, physicalLoad: 300 } }))).weight;
    expect(scoreOf(few)).toBe(scoreOf(many));
  });
  it('falls back to movement and workout minutes, against minutes, on a day with no energy reading', () => {
    const noEnergy = { hourly: hourly(TARGET, 0) };
    const few = scoreOf(computeDailyScores(input(withTarget(energyMonth(), { ...noEnergy, demand: { ...day(0).demand!, physicalLoad: 10 } }))).weight)!;
    const many = scoreOf(computeDailyScores(input(withTarget(energyMonth(), { ...noEnergy, demand: { ...day(0).demand!, physicalLoad: 300 } }))).weight)!;
    expect(many).toBeGreaterThan(few);
  });
  it('falls back to minutes while energy has fewer than fourteen earlier days, never mixing the two in one baseline', () => {
    const young = month(i => (i <= 10 ? { hourly: hourly(addDays(TARGET, -i), i, 30) } : {}));
    const quiet = computeDailyScores(input(withTarget(young, { hourly: hourly(TARGET, 0, 5), demand: { ...day(0).demand!, physicalLoad: 100 } }))).weight;
    const busy = computeDailyScores(input(withTarget(young, { hourly: hourly(TARGET, 0, 90), demand: { ...day(0).demand!, physicalLoad: 100 } }))).weight;
    expect(scoreOf(quiet)).toBe(scoreOf(busy));
    expect(quiet.state === 'available' && quiet.used.signals).toContain('physical_load');
  });
});

describe('drivers: deviations from the owner\'s own usual', () => {
  const phrase = new RegExp(`^(${DRIVER_SUBJECTS.join('|')})( far)? (above|below) usual$`);
  it('names a wrist temperature far above usual, and leaves every score exactly as it was without it', () => {
    const plain = month();
    const warm = withTarget(plain, { vitals: { ...usual, wristTemperature: [{ value: 36.5, method: 'absolute' }] } });
    const scores = computeDailyScores(input(warm));
    expect(scores.drivers).toEqual(['wrist temperature far above usual']);
    const without = computeDailyScores(input(withTarget(plain, { vitals: undefined })));
    expect([scores.recovery, scores.form, scores.weight]).toEqual([without.recovery, without.form, without.weight]);
  });
  it('says above or below, and far only from two spreads out, and nothing inside one', () => {
    const scores = computeDailyScores(input(withTarget(month(), { vitals: { ...usual, breathingRate: 14.6, bloodOxygen: 95, awakeMinutes: 70 } })));
    expect(scores.drivers).toEqual(['awake time in the night far above usual', 'blood oxygen below usual', 'breathing rate above usual']);
    expect(computeDailyScores(input(month())).drivers).toEqual([]);
  });
  it('orders drivers strongest first and writes only closed, digit-free phrases', () => {
    const drivers = computeDailyScores(input(withTarget(month(), { vitals: { breathingRate: 17, bloodOxygen: 92, awakeMinutes: 60, walkingHeartRate: 108, wristTemperature: [{ value: 35, method: 'absolute' }] } }))).drivers;
    expect(drivers.length).toBe(5);
    for (const driver of drivers) { expect(driver).toMatch(phrase); expect(driver).not.toMatch(/\d/); expect(driver.length).toBeLessThanOrEqual(80); }
  });
  it('says nothing for a signal with fewer than fourteen earlier days, or one that has never varied', () => {
    const young = month(i => (i > 10 ? { vitals: undefined } : {}));
    expect(computeDailyScores(input(withTarget(young, { vitals: { ...usual, breathingRate: 20 } }))).drivers).toEqual([]);
    const flat = month(i => ({ vitals: i === 0 ? usual : vitals(i, { bloodOxygen: 97 }) }));
    expect(computeDailyScores(input(withTarget(flat, { vitals: { ...usual, bloodOxygen: 96 } }))).drivers).toEqual([]);
  });
  it('reads a temperature only against its own method', () => {
    const delta = withTarget(month(), { vitals: { ...usual, wristTemperature: [{ value: 2.5, method: 'baseline_delta' }] } });
    expect(computeDailyScores(input(delta)).drivers).toEqual([]);
  });
  it('reports none when health access is not granted', () => {
    expect(computeDailyScores({ ...input(month()), access: 'consent_withdrawn' }).drivers).toEqual([]);
  });
  it('is the vocabulary the derived-row writer admits, word for word', () => {
    expect(driverSql).toContain(`v_driver constant text := '^(${DRIVER_SUBJECTS.join('|')})( far)? (above|below) usual$';`);
  });
});
