import { describe, expect, it } from 'vitest';
import { healthChangesV1Schema } from '../../contracts/src/app/health-ingest';
import { computeDailyScores } from '../src/health/scores';
import { changesOf, type Change } from '../src/health/scores/changes';
import { SCORE_OF } from '../src/health/scores/stats';
import type { DailyScores, PartRow, TodayReading, UsualRow } from '../src/health/scores/types';
import { goldenScoreInputs, SYNTHETIC_TARGET, syntheticAddDays, syntheticInput, syntheticRun } from './support/health-golden';

// Synthetic owners only. What changed today: one list for the Body card and the model, from the owner's own bands.
const DAY = '2026-03-20';
const pillar = (score: number, version = 'v.test') => ({
  state: 'available' as const, score, zone: 'steady' as never, algorithm_version: version, activation: 'accepted' as const, coverage: 1, hrv_method: null, used: { signals: [], days: [] },
});
const scores = (recovery: number, form: number, weight: number, extra: Partial<DailyScores> = {}): DailyScores => ({
  recovery: pillar(recovery), form: pillar(form), weight: pillar(weight), drivers: [], sleep_debt: { state: 'unavailable', reason: 'no_readings' }, ...extra,
});
const stored = (day: string, recovery: number, form: number, weight: number, version = 'v.test', components?: object) => ({
  day, recovery: { score: recovery, algorithm_version: version }, form: { score: form, algorithm_version: version }, weight: { score: weight, algorithm_version: version }, ...(components ? { components } : {}),
});
// Twenty stored days before DAY whose day-to-day moves are +-spread in turn, so the owner's usual move is spread.
const steadyHistory = (spread: number, days = 20, version = 'v.test') =>
  Array.from({ length: days }, (_, i) => { const level = 60 + (i % 2 === 0 ? 0 : spread); return stored(syntheticAddDays(DAY, -(days - i)), level, level, level, version); });
const of = (changes: readonly Change[], tier: number, key: string) => changes.find(change => change.subject.tier === tier && change.subject.key === key);
const run = (today: DailyScores, yesterday: DailyScores | null, history: readonly unknown[] = steadyHistory(1), sameSource = true) => {
  const changes = changesOf({ day: DAY, today, yesterday, sameSource, history });
  expect(healthChangesV1Schema.safeParse(changes).success).toBe(true);
  return changes;
};

describe('the direction of good', () => {
  it('calls a heavier day declined and a lighter one improved, and the other pillars the other way round', () => {
    const up = run(scores(70, 70, 70), scores(60, 60, 60));
    expect(of(up, 1, 'weight')).toMatchObject({ from: 60, to: 70, verdict: 'declined', against: 'yesterday', unit: 'score', pillar: 'weight' });
    expect(of(up, 1, 'recovery')).toMatchObject({ verdict: 'improved' });
    expect(of(up, 1, 'form')).toMatchObject({ verdict: 'improved' });
    const down = run(scores(50, 50, 50), scores(60, 60, 60));
    expect(of(down, 1, 'weight')).toMatchObject({ verdict: 'improved' });
    expect(of(down, 1, 'recovery')).toMatchObject({ verdict: 'declined' });
  });
  it('says neutral, never improved, when nothing moved', () => {
    expect(of(run(scores(60, 60, 60), scores(60, 60, 60)), 1, 'recovery')).toMatchObject({ verdict: 'neutral', significant: false });
  });
  it('scores each sense the way its verdict reads: higher rises, lower falls, nearer usual peaks at usual', () => {
    expect(SCORE_OF.higher(1)).toBeGreaterThan(SCORE_OF.higher(0));
    expect(SCORE_OF.lower(1)).toBeLessThan(SCORE_OF.lower(0));
    expect(SCORE_OF.near(0)).toBeGreaterThan(SCORE_OF.near(1));
    expect(SCORE_OF.near(0)).toBeGreaterThan(SCORE_OF.near(-1));
  });
});

describe('significant is the owner\'s own usual move, never a fixed step', () => {
  it('counts the same five-point move as significant for a steady owner and not for one who swings', () => {
    expect(of(run(scores(65, 60, 60), scores(60, 60, 60), steadyHistory(1)), 1, 'recovery')!.significant).toBe(true);
    expect(of(run(scores(65, 60, 60), scores(60, 60, 60), steadyHistory(10)), 1, 'recovery')!.significant).toBe(false);
  });
  it('calls nothing significant from fewer than fourteen moves', () => {
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), steadyHistory(1, 14)), 1, 'recovery')!.significant).toBe(false);
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), steadyHistory(1, 15)), 1, 'recovery')!.significant).toBe(true);
  });
  it('counts only moves between consecutive days of today\'s version within the last thirty, never today\'s own row', () => {
    const otherVersion = steadyHistory(1, 20, 'v.old');
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), otherVersion), 1, 'recovery')!.significant).toBe(false);
    const everyOtherDay = steadyHistory(1, 30).filter((_, i) => i % 2 === 0);
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), everyOtherDay), 1, 'recovery')!.significant).toBe(false);
    const longAgo = steadyHistory(1, 20).map(day => ({ ...day, day: syntheticAddDays(day.day, -40) }));
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), longAgo), 1, 'recovery')!.significant).toBe(false);
    const withToday = [...steadyHistory(1, 14), stored(DAY, 99, 99, 99)];
    expect(of(run(scores(90, 60, 60), scores(60, 60, 60), withToday), 1, 'recovery')!.significant).toBe(false);
  });
  it('reads history it cannot parse as no history', () => {
    const changes = run(scores(90, 60, 60), scores(60, 60, 60), [null, 'x', { day: 3 }, { day: DAY, recovery: 'high' }]);
    expect(of(changes, 1, 'recovery')!.significant).toBe(false);
  });
});

describe('against yesterday only like for like', () => {
  it('compares no pillar across two sources, two versions, or a day with no score', () => {
    expect(run(scores(70, 70, 70), scores(60, 60, 60), steadyHistory(1), false).filter(change => change.subject.tier < 3)).toEqual([]);
    expect(of(run(scores(70, 70, 70), { ...scores(60, 60, 60), recovery: pillar(60, 'v.other') }), 1, 'recovery')).toBeUndefined();
    expect(of(run(scores(70, 70, 70), { ...scores(60, 60, 60), form: { state: 'unavailable', reason: 'stale_inputs' } }), 1, 'form')).toBeUndefined();
    expect(run(scores(70, 70, 70), null).filter(change => change.subject.tier < 3)).toEqual([]);
  });
});

const part = (key: string, score: number): PartRow => ({ key, state: 'available', score, share: 0.5, points: score / 2, direction: null, signals: [], baseline: null });
describe('parts and groups', () => {
  it('judges a Weight part like Weight and a Recovery group like Recovery, against the owner\'s own moves of that part', () => {
    const withParts = (calendar: number, resting: number): Partial<DailyScores> => ({
      components: { weight: [part('calendar', calendar)], recovery: [part('sleep', 60)], groups: [{ ...part('resting_state', resting), pillar: 'recovery', parts: ['hrv', 'resting_heart_rate'] } as never] },
    });
    const history = steadyHistory(1).map(day => ({ ...day, components: { weight: [part('calendar', 50)], groups: [{ key: 'resting_state', pillar: 'recovery', state: 'available', score: 50 }] } }));
    const changes = run(scores(60, 60, 60, withParts(70.4, 41.6)), scores(60, 60, 60, withParts(60.2, 50.3)), history);
    expect(of(changes, 2, 'calendar')).toMatchObject({ from: 60, to: 70, verdict: 'declined', pillar: 'weight', significant: true });
    expect(of(changes, 2, 'resting_state')).toMatchObject({ from: 50, to: 42, verdict: 'declined', pillar: 'recovery', significant: true });
    expect(of(changes, 2, 'sleep')).toMatchObject({ verdict: 'neutral', significant: false });
  });
});

const band = (signal: string, low: number, centre: number, high: number, over: Partial<UsualRow> = {}): UsualRow => ({
  signal, method: null, state: 'personal', low, centre, high, own_days: 20, own_share: 1, days_until_personal: 0, window_days: 30, estimator: 'own_mean_sd', ...over,
});
const reading = (signal: string, value: number, sense: TodayReading['sense'], method: string | null = null): TodayReading => ({ signal, method, value, sense });
describe('readings against the owner\'s usual band', () => {
  const today = (usual: UsualRow[], readings: TodayReading[]) => scores(60, 60, 60, { usual, readings });
  it('is significant only outside the band, and judged the way the engine scores that reading', () => {
    const changes = run(today([
      band('resting_heart_rate', 52, 55, 58, { method: 'provider_resting_daily', estimator: 'shrunk_predictive', own_share: 0.8 }),
      band('overnight_hrv', 50, 60, 72, { method: 'rmssd', estimator: 'shrunk_predictive', own_share: 0.8 }),
      band('daylight', 10, 20, 30, { estimator: 'shrunk_predictive', own_share: 1 }),
      band('breathing_rate', 13, 14, 15),
      band('spo2', 95, 96, 97),
    ], [
      reading('resting_heart_rate', 50.4, 'lower', 'provider_resting_daily'), reading('overnight_hrv', 47, 'higher', 'rmssd'), reading('daylight', 45, 'near'),
      reading('breathing_rate', 16.2, 'none'), reading('spo2', 96.5, 'none'),
    ]), null);
    expect(of(changes, 3, 'resting_heart_rate')).toMatchObject({ from: 55, to: 50.4, unit: 'beats_per_minute', against: 'usual', verdict: 'improved', significant: true, pillar: 'recovery' });
    expect(of(changes, 3, 'overnight_hrv')).toMatchObject({ from: 60, to: 47, unit: 'milliseconds', verdict: 'declined', significant: true });
    expect(of(changes, 3, 'daylight')).toMatchObject({ verdict: 'declined', significant: true, pillar: 'form' });
    expect(of(changes, 3, 'breathing_rate')).toMatchObject({ verdict: 'neutral', significant: true });
    expect(of(changes, 3, 'spo2')).toMatchObject({ verdict: 'neutral', significant: false });
  });
  it('leaves out a reading whose band still leans on the population, or that has no band, or no reading', () => {
    const changes = run(today([
      band('resting_heart_rate', 52, 55, 58, { method: 'provider_resting_daily', estimator: 'shrunk_predictive', state: 'provisional', own_days: 9, own_share: 0.4, days_until_personal: 5 }),
      band('awake_time', 10, 25, 40),
    ], [reading('resting_heart_rate', 40, 'lower', 'provider_resting_daily'), reading('walking_heart_rate', 140, 'none')]), null);
    expect(changes).toEqual([]);
  });
  it('reads a clock band across midnight on the clock', () => {
    const changes = run(today([band('sleep_midpoint', 1380, 20, 100, { estimator: 'shrunk_predictive' })], [reading('sleep_midpoint', 1410, 'near')]), null);
    expect(of(changes, 3, 'sleep_midpoint')).toMatchObject({ from: 20, to: 1410, unit: 'local_minute', significant: false });
    const late = run(today([band('sleep_midpoint', 1380, 20, 100, { estimator: 'shrunk_predictive' })], [reading('sleep_midpoint', 200, 'near')]), null);
    expect(of(late, 3, 'sleep_midpoint')).toMatchObject({ verdict: 'declined', significant: true });
  });
  it('puts the significant changes first, the furthest first', () => {
    const changes = run(today([band('breathing_rate', 13, 14, 15), band('awake_time', 10, 25, 40)], [reading('breathing_rate', 14.5, 'none'), reading('awake_time', 80, 'none')]), scores(40, 60, 60));
    expect(changes.map(change => [change.subject.key, change.significant])).toEqual([['recovery', true], ['awake_time', true], ['breathing_rate', false], ['form', false], ['weight', false]]);
  });
});

describe('from the score engine', () => {
  const engine = (targetDay: string, input = goldenScoreInputs().mature_own_average_need!) =>
    computeDailyScores({ ...input, targetDay, provisional: true, parts: true, usual: true });
  it('carries each reading with a band, in the band\'s unit, on the side its part says, and never into a served field', () => {
    const today = engine(SYNTHETIC_TARGET);
    const readings = today.readings ?? [];
    expect(readings.map(entry => entry.signal)).toEqual(expect.arrayContaining(['overnight_hrv', 'resting_heart_rate', 'breathing_rate']));
    expect(readings.find(entry => entry.signal === 'overnight_hrv')!.sense).toBe('higher');
    expect(readings.find(entry => entry.signal === 'resting_heart_rate')!.sense).toBe('lower');
    expect(readings.find(entry => entry.signal === 'daylight')!.sense).toBe('near');
    for (const entry of readings) {
      const usual = today.usual!.find(row => row.signal === entry.signal);
      expect(usual, entry.signal).toBeDefined();
      expect(entry.method).toBe(usual!.method);
    }
    const parts = today.components!.recovery!.filter((row): row is Extract<PartRow, { state: 'available' }> => row.state === 'available' && row.direction !== null && row.direction !== 'usual');
    for (const row of parts) {
      const signal = row.signals[0]!, value = readings.find(entry => entry.signal === signal)!.value, usual = today.usual!.find(entry => entry.signal === signal)!;
      expect(Math.sign(value - usual.centre), row.key).toBe(row.direction === 'above_usual' ? 1 : -1);
    }
  });
  it('gives a list the contract takes for every synthetic owner, today against yesterday', () => {
    for (const [name, input] of Object.entries(goldenScoreInputs()).filter(([key]) => key !== 'no_access')) {
      const today = engine(SYNTHETIC_TARGET, input), yesterday = engine(syntheticAddDays(SYNTHETIC_TARGET, -1), input);
      const changes = changesOf({ day: SYNTHETIC_TARGET, today, yesterday, sameSource: true, history: [] });
      expect(healthChangesV1Schema.safeParse(changes).success, name).toBe(true);
      expect(changes.every(change => change.subject.tier === 3 || !change.significant), name).toBe(true);
    }
  });
  it('gives nothing to compare on a plain or first day', () => {
    const first = computeDailyScores({ ...syntheticInput(syntheticRun(1)), provisional: true, parts: true, usual: true });
    expect(changesOf({ day: SYNTHETIC_TARGET, today: first, yesterday: null, sameSource: true, history: [] })).toEqual([]);
  });
});
