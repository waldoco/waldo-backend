import { describe, expect, it } from 'vitest';
import { calculateCandidate, candidateObservationSchema, type CandidateMetric, type CandidateObservation, type CandidateSeries } from '../src/health/calculations';

const day = '2026-10-10';
const previousDay = (age: number) => new Date(Date.parse(`${day}T00:00:00Z`) - age * 86400000).toISOString().slice(0, 10);
const common = { owner_ref: 'owner-a', consent_epoch: 3, day, timezone: 'UTC', as_of: `${day}T12:00:00Z` };
const units: Record<CandidateMetric, string> = {
  sleep_minutes: 'minutes', hrv_ms: 'milliseconds', resting_heart_rate: 'beats_per_minute',
  sleep_midpoint: 'local_minute', daylight_minutes: 'minutes', movement_minutes: 'minutes',
  stress_rating: 'rating_0_10', calendar_minutes: 'minutes', task_minutes: 'minutes',
  message_count: 'count', physical_load: 'source_units',
};
const methods: Record<CandidateMetric, string> = {
  sleep_minutes: 'asleep_duration', hrv_ms: 'rmssd', resting_heart_rate: 'overnight_resting',
  sleep_midpoint: 'sleep_midpoint', daylight_minutes: 'daylight_duration', movement_minutes: 'active_minutes',
  stress_rating: 'self_report_0_10', calendar_minutes: 'union_busy_minutes', task_minutes: 'owner_estimated_due_minutes',
  message_count: 'requires_owner_response_count', physical_load: 'provider_load',
};
const observation = (metric: CandidateMetric, value: number | null, age = 0, revision = 1): CandidateObservation => candidateObservationSchema.parse({
  owner_ref: common.owner_ref, consent_epoch: common.consent_epoch, source_ref: 'source-a',
  context_ref: metric === 'sleep_minutes' || metric === 'hrv_ms' || metric === 'resting_heart_rate' || metric === 'sleep_midpoint' ? 'night-regime-a' : 'intraday-12',
  metric, method: methods[metric], unit: units[metric], day: previousDay(age), timezone: common.timezone,
  observed_at: `${previousDay(age)}T10:00:00Z`, revision, value,
});
const series = (metric: CandidateMetric, value: number | null, low: number, high: number): CandidateSeries => ({
  current: observation(metric, value),
  history: Array.from({ length: 14 }, (_, index) => observation(metric, index % 2 ? high : low, index + 1)),
});
const confirmedNeed = { basis: 'owner_confirmed' as const, owner_ref: common.owner_ref, consent_epoch: common.consent_epoch, minutes: 480, confirmed_at: `${previousDay(20)}T10:00:00Z` };
const recovery = () => ({
  sleep: series('sleep_minutes', 480, 450, 510),
  hrv: series('hrv_ms', Math.sqrt(40 * 60), 40, 60),
  resting_heart_rate: series('resting_heart_rate', 60, 55, 65),
  sleep_need: confirmedNeed,
});
const form = () => ({ ...common, kind: 'form' as const, recovery: recovery(), intraday_context_ref: 'intraday-12',
  sleep_midpoint: series('sleep_midpoint', 240, 230, 250), daylight: series('daylight_minutes', 60, 40, 80),
  motion: series('movement_minutes', 30, 20, 40), stress: series('stress_rating', 5, 3, 7),
});
const weight = () => ({ ...common, kind: 'weight' as const,
  calendar: series('calendar_minutes', 120, 60, 180), tasks: series('task_minutes', 60, 30, 90),
  messages: series('message_count', 10, 5, 15), physical_load: series('physical_load', 100, 50, 150),
});
const debt = () => ({ ...common, kind: 'sleep_debt' as const,
  nights: Array.from({ length: 14 }, (_, age) => observation('sleep_minutes', 420, age)),
  sleep_need: confirmedNeed, reference_history: [] as CandidateObservation[],
});

describe('explicit unaccepted health calculation candidates', () => {
  it('computes a complete source-backed Recovery candidate with personal baselines', () => {
    const result = calculateCandidate({ ...common, kind: 'recovery', ...recovery() });
    expect(result).toMatchObject({ state: 'available', kind: 'recovery', activation: 'candidate_unaccepted', algorithm_version: 'recovery.candidate.v1', score: 75, coverage: 1 });
    if (result.state === 'available' && result.kind !== 'sleep_debt') {
      expect(result.components.map(component => component.baseline_days)).toEqual([14, 14, 14]);
    }
  });
  it('uses actual intraday context and explicit stress to change Form, with circular sleep timing', () => {
    const input = form();
    input.sleep_midpoint = series('sleep_midpoint', 0, 1430, 10);
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', kind: 'form', score: 80 });
    input.stress.current!.value = 7;
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', kind: 'form', score: 76 });
    input.stress = { current: null, history: [] };
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'missing_signal', component: 'stress_rating' });
  });
  it('makes higher actual demand raise Weight, keeping all four contributing sources separate', () => {
    const input = weight();
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', kind: 'weight', score: 50, sleep_reference_basis: null });
    for (const source of [input.calendar, input.tasks, input.messages, input.physical_load]) source.current!.value = source.history[1]!.value;
    const result = calculateCandidate(input);
    expect(result).toMatchObject({ state: 'available', kind: 'weight', score: 70 });
    if (result.state === 'available' && result.kind === 'weight') expect(result.components.map(value => [value.component, value.weight])).toEqual([
      ['calendar_minutes', 0.35], ['task_minutes', 0.3], ['message_count', 0.15], ['physical_load', 0.2],
    ]);
    input.physical_load.current = null;
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'missing_signal', component: 'physical_load' });
  });
  it('computes exact recency-weighted fourteen-night shortfall without crediting surplus sleep', () => {
    const input = debt();
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', kind: 'sleep_debt', debt_minutes: 630, observed_nights: 14, coverage: 1, interpretation: 'shortfall_from_owner_target' });
    input.nights[0]!.value = 600;
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', debt_minutes: 570 });
  });
  it('keeps missing nights explicit and never reports their unknown contribution as zero debt', () => {
    const input = debt();
    input.nights[0]!.value = null;
    input.nights.pop();
    expect(calculateCandidate(input)).toMatchObject({ state: 'partial', debt_minutes: null, observed_weighted_shortfall_minutes: 540, observed_nights: 12, coverage: 0.857, missing_nights: [day, previousDay(13)] });
    input.nights = [];
    expect(calculateCandidate(input)).toMatchObject({ state: 'partial', debt_minutes: null, observed_weighted_shortfall_minutes: 0, observed_nights: 0, coverage: 0 });
  });
  it('distinguishes usual-sleep reference from a confirmed target and excludes the debt period from calibration', () => {
    const input = { ...debt(), sleep_need: { basis: 'provisional_baseline' as const },
      reference_history: Array.from({ length: 14 }, (_, index) => observation('sleep_minutes', 450, index + 14)),
    };
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', debt_minutes: 315, sleep_reference_minutes: 450, sleep_reference_basis: 'provisional_baseline', interpretation: 'shortfall_from_usual_sleep' });
    input.reference_history[0] = observation('sleep_minutes', 450, 13);
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'sleep_minutes' });
  });
  it.each([
    ['owner_ref', 'owner-b', 'owner_mismatch'], ['consent_epoch', 4, 'epoch_mismatch'],
    ['timezone', 'America/New_York', 'time_mismatch'], ['source_ref', 'source-b', 'source_method_context_mismatch'],
    ['context_ref', 'regime-b', 'source_method_context_mismatch'], ['method', 'sdnn', 'source_method_context_mismatch'],
  ] as const)('rejects an HRV history %s change instead of blending incompatible measurements', (key, value, reason) => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    Object.assign(input.hrv.history[0]!, { [key]: value });
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason, component: 'hrv_ms' });
  });
  it('keeps Form intraday measurement regimes aligned and rejects ambiguous circular baseline', () => {
    const input = form();
    input.intraday_context_ref = 'intraday-16';
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'source_method_context_mismatch', component: 'daylight_minutes' });
    input.intraday_context_ref = 'intraday-12';
    input.sleep_midpoint = series('sleep_midpoint', 0, 0, 720);
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'baseline_ambiguous', component: 'sleep_midpoint' });
  });
  it('uses distinct days in the preceding thirty days, excluding null baselines', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    input.hrv.history.push(...input.hrv.history);
    input.hrv.history[0] = observation('hrv_ms', null, 1);
    input.hrv.history[14] = observation('hrv_ms', null, 1);
    input.hrv.history.push(observation('hrv_ms', 40, 31));
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'baseline_immature', component: 'hrv_ms' });
  });
  it('handles a flat baseline without fabricating a normalization scale', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    input.resting_heart_rate = series('resting_heart_rate', 60, 60, 60);
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', score: 75 });
    input.resting_heart_rate.current!.value = 61;
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'baseline_variance_zero', component: 'resting_heart_rate' });
  });
  it('keeps mathematically constant log-HRV and circular timing baselines exactly flat', () => {
    const input = form();
    input.recovery.hrv = series('hrv_ms', 40, 40, 40);
    input.sleep_midpoint = series('sleep_midpoint', 1430, 1430, 1430);
    const result = calculateCandidate(input);
    expect(result).toMatchObject({ state: 'available', score: 80 });
    if (result.state === 'available' && result.kind === 'form') expect(result.components.find(value => value.component === 'recovery.hrv')?.score).toBe(50);
    input.recovery.hrv.current!.value = 41;
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'baseline_variance_zero', component: 'hrv_ms' });
  });
  it('resolves highest daily revisions independent of order and rejects tied latest conflicts', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    const old = observation('hrv_ms', 30, 1, 0), conflictingOld = observation('hrv_ms', 35, 1, 0);
    input.hrv.history.unshift(old, conflictingOld);
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', score: 75 });
    input.hrv.history.reverse();
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', score: 75 });
    input.hrv.history.push(observation('hrv_ms', 60, 1, 1));
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'conflicting_observations', component: 'hrv_ms' });
  });
  it('requires an explicit sleep reference and binds confirmed targets to the same owner and epoch', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery(), sleep_need: null };
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'sleep_reference_required', component: 'sleep_need' });
    expect(calculateCandidate({ ...input, sleep_need: { ...confirmedNeed, owner_ref: 'owner-b' } })).toMatchObject({ state: 'unavailable', reason: 'owner_mismatch', component: 'sleep_need' });
    expect(calculateCandidate({ ...input, sleep_need: { ...confirmedNeed, consent_epoch: 2 } })).toMatchObject({ state: 'unavailable', reason: 'epoch_mismatch', component: 'sleep_need' });
    expect(calculateCandidate({ ...input, sleep_need: { ...confirmedNeed, confirmed_at: `${day}T13:00:00Z` } })).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'sleep_need' });
    expect(calculateCandidate({ ...input, sleep_need: { basis: 'provisional_baseline' } })).toMatchObject({ state: 'available', sleep_reference_basis: 'provisional_baseline', score: 75 });
  });
  it('checks as-of day, future observations, and intraday freshness', () => {
    const input = form();
    expect(calculateCandidate({ ...input, day: previousDay(1) })).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'request' });
    input.stress.current = candidateObservationSchema.parse({ ...input.stress.current, observed_at: `${day}T13:00:00Z` });
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'stress_rating' });
    input.stress.current = candidateObservationSchema.parse({ ...input.stress.current, observed_at: `${day}T05:00:00Z` });
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'stale_signal', component: 'stress_rating' });
  });
  it('rejects debt cross-owner custody, mixed source regimes, and latest-revision conflicts', () => {
    const input = debt();
    input.nights[3]!.owner_ref = 'owner-b';
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'owner_mismatch', component: 'sleep_minutes' });
    input.nights[3]!.owner_ref = common.owner_ref;
    input.nights[3]!.source_ref = 'source-b';
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'source_method_context_mismatch', component: 'sleep_minutes' });
    input.nights[3]!.source_ref = 'source-a';
    input.nights.push(observation('sleep_minutes', 430, 3, 1));
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'conflicting_observations', component: 'sleep_minutes' });
  });
  it('uses corrected nights and tombstones in debt without resurrecting an earlier revision', () => {
    const input = debt();
    input.nights.push(observation('sleep_minutes', 480, 0, 2));
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', debt_minutes: 570 });
    input.nights.push(observation('sleep_minutes', null, 0, 3));
    expect(calculateCandidate(input)).toMatchObject({ state: 'partial', debt_minutes: null, observed_nights: 13, missing_nights: [day] });
  });
  it('fails a provisional debt reference when nulls, age or duplicate days leave fewer than fourteen nights', () => {
    const input = { ...debt(), sleep_need: { basis: 'provisional_baseline' as const },
      reference_history: Array.from({ length: 14 }, (_, index) => observation('sleep_minutes', 450, index + 14)),
    };
    input.reference_history[0]!.value = null;
    input.reference_history.push(input.reference_history[1]!, observation('sleep_minutes', 450, 44));
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'baseline_immature', component: 'sleep_need' });
  });
  it.each([`${day}T13:00:00Z`, `${day}T09:00:00Z`, `${previousDay(-1)}T10:00:00Z`])('rejects invalid supplied current sleep attribution %s without ordinary-date fallback', sleep_ended_at => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    input.hrv.current = candidateObservationSchema.parse({ ...input.hrv.current!, sleep_ended_at });
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'hrv_ms' });
  });
  it('checks historical and debt sleep ends and rejects attribution on unrelated intraday metrics', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    input.hrv.history[0] = candidateObservationSchema.parse({ ...input.hrv.history[0]!, sleep_ended_at: `${previousDay(1)}T09:00:00Z` });
    expect(calculateCandidate(input)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'hrv_ms' });
    const debtInput = debt();
    debtInput.nights[0] = candidateObservationSchema.parse({ ...debtInput.nights[0]!, sleep_ended_at: `${day}T13:00:00Z` });
    expect(calculateCandidate(debtInput)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'sleep_minutes' });
    const formInput = form();
    formInput.motion.current = candidateObservationSchema.parse({ ...formInput.motion.current!, sleep_ended_at: `${day}T11:00:00Z` });
    expect(calculateCandidate(formInput)).toMatchObject({ state: 'unavailable', reason: 'time_mismatch', component: 'movement_minutes' });
  });
  it('retains valid same-source cross-midnight waking attribution for current, baseline and debt observations', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    input.hrv.current = candidateObservationSchema.parse({ ...input.hrv.current!, observed_at: `${previousDay(1)}T23:00:00Z`, sleep_ended_at: `${day}T07:00:00Z` });
    input.hrv.history[0] = candidateObservationSchema.parse({ ...input.hrv.history[0]!, observed_at: `${previousDay(2)}T23:00:00Z`, sleep_ended_at: `${previousDay(1)}T07:00:00Z` });
    expect(calculateCandidate(input)).toMatchObject({ state: 'available', kind: 'recovery', score: 75 });
    const debtInput = debt();
    debtInput.nights[0] = candidateObservationSchema.parse({ ...debtInput.nights[0]!, observed_at: `${previousDay(1)}T23:00:00Z`, sleep_ended_at: `${day}T07:00:00Z` });
    expect(calculateCandidate(debtInput)).toMatchObject({ state: 'available', kind: 'sleep_debt', debt_minutes: 630 });
  });
  it('does not convert unsupported units/methods, invalid ranges or inferred stress into scores', () => {
    const input = { ...common, kind: 'recovery' as const, ...recovery() };
    for (const replacement of [{ unit: 'seconds' }, { method: 'hf_power' }, { value: 0 }, { value: Number.POSITIVE_INFINITY }]) {
      expect(calculateCandidate({ ...input, hrv: { ...input.hrv, current: { ...input.hrv.current, ...replacement } } })).toMatchObject({ state: 'unavailable', reason: 'invalid_input' });
    }
    const formInput = form();
    expect(calculateCandidate({ ...formInput, stress: { ...formInput.stress, current: { ...formInput.stress.current, method: 'sentiment_inference' } } })).toMatchObject({ state: 'unavailable', reason: 'invalid_input' });
    const weightInput = weight();
    expect(calculateCandidate({ ...weightInput, messages: { ...weightInput.messages, current: { ...weightInput.messages.current, value: 1.5 } } })).toMatchObject({ state: 'unavailable', reason: 'invalid_input' });
  });
  it.each([undefined, null, {}, { kind: 'recovery' }, { ...common, kind: 'recovery', ...recovery(), secret: 'discard-me' },
    { ...common, kind: 'recovery', ...recovery(), sleep: { ...series('sleep_minutes', 480, 450, 510), current: { ...observation('sleep_minutes', 480), value: Number.NaN } } },
  ])('returns a privacy-safe typed unavailable for malformed input %j', input => {
    expect(calculateCandidate(input)).toEqual({ state: 'unavailable', kind: 'invalid', activation: 'candidate_unaccepted', reason: 'invalid_input', component: 'request' });
  });
});
