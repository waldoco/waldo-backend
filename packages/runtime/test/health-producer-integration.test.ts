import { describe, expect, it, vi } from 'vitest';
import { healthProducerDaySchema, healthConsentListSchema } from '../../contracts/src/health/ingest';
import { createHealthProduction, type HealthSignedCall } from '../src/health/production';
import { CANDIDATE_VERSIONS, candidateObservationSchema, type CandidateMetric, type CandidateSeries } from '../src/health/calculations';
import { iso8601Schema } from '../../contracts/src/core/error';
import { HEALTH_CALCULATION_REVIEW_PIN } from '../src/health/calculation-review';
import type { HealthCalculationActivation } from '../src/health/producer';

const day = '2026-10-10';
const origin = { read_api: 'healthkit', source_bundle_id: 'synthetic.health.sensor', source_package_name: null, source_version: '1', source_revision: 'sensor-revision-1', device_ref: 'sha256:' + '1'.repeat(64), recording_method: 'automatic' }; 
const past = (age: number) => new Date(Date.parse(day) - age * 86400000).toISOString().slice(0, 10);
const clock = { now: () => new Date(`${day}T12:00:00Z`) };
const consents = (epoch = 3, status: 'granted' | 'withdrawn' = 'granted') => healthConsentListSchema.parse({ consents: [{ consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 1, epoch, status, granted_at: `${past(40)}T10:00:00Z`, withdrawn_at: status === 'withdrawn' ? `${day}T11:00:00Z` : null, deletion_state: status === 'withdrawn' ? 'completed' : 'not_required' }] });
const producer = () => healthProducerDaySchema.parse({ source: 'apple', consent_epoch: 3, timezone: 'UTC', day, compiled_at: `${day}T10:00:00Z`, samples: [],
  aggregates: Array.from({ length: 31 }, (_, age) => {
    const current = age === 0;
    const metrics = ['sleep_duration', 'overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight_duration', 'movement_duration', 'perceived_stress', 'physical_load'];
    const values = { sleep_duration: current ? 480 : age % 2 ? 450 : 510, overnight_hrv: current ? Math.sqrt(40 * 60) : age % 2 ? 40 : 60,
      resting_heart_rate: current ? 60 : age % 2 ? 55 : 65, sleep_midpoint: current ? 240 : age % 2 ? 230 : 250,
      daylight_duration: current ? 60 : age % 2 ? 40 : 80, movement_duration: current ? 30 : age % 2 ? 20 : 40,
      perceived_stress: current ? 5 : age % 2 ? 3 : 7, physical_load: current ? 100 : age % 2 ? 50 : 150 };
    const methods = ['asleep_duration', 'rmssd', 'overnight_resting', 'sleep_midpoint', 'daylight_duration', 'active_minutes', 'self_report_0_10', 'provider_load'];
    return { day: past(age), timezone: 'UTC', observed_at: `${past(age)}T10:00:00Z`, metrics, methods: ['rmssd'], conflicting_metrics: [], values,
      observations: Object.fromEntries(metrics.map((metric, index) => [metric, { method: methods[index], origin, ...(index < 3 ? { eligibility: index === 2 ? 'admitted_resting_method' : 'admitted_sleep_context' } : {}), context_ref: index <= 3 ? 'overnight_daily' : 'intraday-10', observed_at: `${past(age)}T${index <= 3 ? '07' : '10'}:00:00Z`, revision: 1 }])) };
  }) });
const demand = (metric: CandidateMetric, unit: string, method: string, mid: number): CandidateSeries => ({
  current: candidateObservationSchema.parse({ owner_ref: 'owner-a', consent_epoch: 3, source_ref: `owner-connected-${metric}`, context_ref: 'intraday-10', metric, unit, method, day, timezone: 'UTC', observed_at: `${day}T10:00:00Z`, revision: 1, value: mid }),
  history: Array.from({ length: 14 }, (_, i) => candidateObservationSchema.parse({ owner_ref: 'owner-a', consent_epoch: 3, source_ref: `owner-connected-${metric}`, context_ref: 'intraday-10', metric, unit, method, day: past(i + 1), timezone: 'UTC', observed_at: `${past(i + 1)}T10:00:00Z`, revision: 1, value: i % 2 ? mid * 1.5 : mid * .5 })),
});
const activation = (): HealthCalculationActivation => ({ review_ref: 'synthetic-review-only', versions: CANDIDATE_VERSIONS,
  review_receipt: { review_ref: 'synthetic-review-only', ...HEALTH_CALCULATION_REVIEW_PIN, formula_review_ref: 'synthetic-formula-fixture', privacy_review_ref: 'synthetic-privacy-fixture', reviewed_at: iso8601Schema.parse(`${past(1)}T10:00:00Z`), versions: CANDIDATE_VERSIONS },
  sleep_need: { basis: 'owner_confirmed', owner_ref: 'owner-a', consent_epoch: 3, minutes: 480, confirmed_at: iso8601Schema.parse(`${past(40)}T10:00:00Z`) },
  supplemental: async request => ({ weight: { calendar: demand('calendar_minutes', 'minutes', 'union_busy_minutes', 120), tasks: demand('task_minutes', 'minutes', 'owner_estimated_due_minutes', 60), messages: demand('message_count', 'count', 'requires_owner_response_count', 10), physical_load: request.physical_load } }),
});
const rpc = (data: unknown, state = consents()) => vi.fn<HealthSignedCall>(async (_fn, _message, args) => args.p_operation === 'consents' ? state : data);

describe('real health producer consumed by authenticated service', () => {
  it('uses actual stored metric values for Recovery/Form/debt and actual supplemental demand for Weight', async () => {
    const configured = activation(); const supplement = vi.fn(configured.supplemental!); const extra = { ...configured, supplemental: supplement };
    const service = createHealthProduction(rpc(producer()), 'owner-a', clock, extra);
    const result = await service.today('apple');
    expect(result).toMatchObject({ ok: true, data: {
      recovery: { state: 'available', score: 75, algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' },
      form: { state: 'available', score: 80, algorithm_version: 'form.candidate.v1' },
      weight: { state: 'available', score: 50, algorithm_version: 'weight.candidate.v1' },
      baseline: { state: 'mature', required_days: 14 }, sleep_debt: { state: 'available', observed_nights: 14, coverage: 1 },
      calculation_review: { review_ref: 'synthetic-review-only', clinical_validation: 'not_established' },
    } });
    expect(supplement).toHaveBeenCalledWith(expect.objectContaining({ owner_ref: 'owner-a', consent_epoch: 3, physical_load: expect.objectContaining({ current: expect.objectContaining({ value: 100, source_ref: expect.stringMatching(/^apple:[0-9a-f]{32}$/), method: 'provider_load' }) }) }));
    if (result.ok && result.data?.form.state === 'available') expect(result.data.form.components?.find(component => component.component === 'stress_rating')).toMatchObject({ source_ref: expect.stringMatching(/^apple:[0-9a-f]{32}$/), method: 'self_report_0_10', observed_at: `${day}T10:00:00Z` });
  });
  it('keeps absent observations and unknown nights unavailable or partial instead of replacing them with zeros', async () => {
    const data = producer(); data.aggregates = data.aggregates.filter(entry => entry.day !== past(2));
    delete data.aggregates[0]!.values!.perceived_stress;
    const result = await createHealthProduction(rpc(data), 'owner-a', clock, activation()).today('apple');
    expect(result).toMatchObject({ ok: true, data: { form: { state: 'unavailable', reason: 'missing_signal' }, sleep_debt: { state: 'partial', debt_minutes: null, observed_nights: 13, missing_nights: [past(2)] } } });
  });
  it('makes a mixed method/context aggregate unavailable instead of assigning it a method', async () => {
    const data = producer(); data.aggregates[0]!.conflicting_metrics = ['overnight_hrv'];
    const result = await createHealthProduction(rpc(data), 'owner-a', clock, activation()).today('apple');
    expect(result).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'missing_signal' } } });
  });
  it('uses the full pre-window sleep reference and keeps older measurement changes outside Recovery baselines', async () => {
    const data = producer();
    for (let age = 31; age <= 43; age++) {
      const older = structuredClone(data.aggregates[30]!);
      older.day = past(age);
      older.observed_at = iso8601Schema.parse(`${past(age)}T10:00:00Z`);
      for (const observation of Object.values(older.observations!)) observation.observed_at = iso8601Schema.parse(`${past(age)}T07:00:00Z`);
      older.observations!.overnight_hrv!.method = 'sdnn';
      older.methods = ['sdnn'];
      data.aggregates.push(older);
    }
    for (const entry of data.aggregates) entry.values!.sleep_duration = entry.day > past(14) ? 360 : 480;
    const config = { ...activation(), sleep_need: { basis: 'provisional_baseline' as const } };
    const result = await createHealthProduction(rpc(data), 'owner-a', clock, config).today('apple');
    expect(result).toMatchObject({ ok: true, data: {
      recovery: { state: 'available', algorithm_version: 'recovery.candidate.v1' },
      sleep_debt: { state: 'available', observed_nights: 14, debt_minutes: 1260, reference_minutes: 480, reference_baseline_days: 30, reference_basis: 'provisional_baseline' },
    } });
  });
  it('rechecks consent after external input awaits, blocks withdrawn/regranted reads, and leaks no supplier exception', async () => {
    for (const state of [consents(3, 'withdrawn'), consents(4)]) {
      expect(await createHealthProduction(rpc(producer(), state), 'owner-a', clock, activation()).today('apple')).toEqual({ ok: false, error: 'consent_withdrawn' });
    }
    expect(await createHealthProduction(rpc(producer()), 'owner-a', clock, { ...activation(), supplemental: async () => { throw new Error('private calendar and health payload'); } }).today('apple')).toEqual({ ok: false, error: 'unavailable' });
  });
  it('never activates by app claims or a mismatched host version and works after restart', async () => {
    const call = rpc(producer());
    expect(await createHealthProduction(call, 'owner-a', clock).today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' } } });
    expect(await createHealthProduction(call, 'owner-a', clock, { ...activation(), versions: { ...CANDIDATE_VERSIONS, recovery: 'recovery.v1' } as unknown as typeof CANDIDATE_VERSIONS }).today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' } } });
    expect(await createHealthProduction(call, 'owner-a', clock, activation()).today('apple')).toEqual(await createHealthProduction(call, 'owner-a', clock, activation()).today('apple'));
  });
  it('refuses a bare or wrong-source review string and keeps source regimes separate', async () => {
    const bare = { ...activation(), review_receipt: undefined } as unknown as HealthCalculationActivation;
    expect(await createHealthProduction(rpc(producer()), 'owner-a', clock, bare).today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' } } });
    const changedReceipt = { ...activation(), review_receipt: { ...activation().review_receipt, algorithm_source_sha256: '0'.repeat(64) } };
    expect(await createHealthProduction(rpc(producer()), 'owner-a', clock, changedReceipt).today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' } } });
    const data = producer();
    data.aggregates[1]!.observations!.overnight_hrv!.origin = { ...data.aggregates[1]!.observations!.overnight_hrv!.origin!, source_bundle_id: 'synthetic.different.sensor' };
    expect(await createHealthProduction(rpc(data), 'owner-a', clock, activation()).today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'source_method_context_mismatch' } } });
  });
  it('rejects source/epoch/date mismatched provider data at serving and demand from a different owner', async () => {
    expect(await createHealthProduction(rpc({ ...producer(), source: 'oura' }), 'owner-a', clock, activation()).today('apple')).toEqual({ ok: false, error: 'unavailable' });
    const config: HealthCalculationActivation = { ...activation(), supplemental: async request => ({ weight: { calendar: { ...demand('calendar_minutes', 'minutes', 'union_busy_minutes', 120), current: { ...demand('calendar_minutes', 'minutes', 'union_busy_minutes', 120).current!, owner_ref: 'owner-b' } }, tasks: demand('task_minutes', 'minutes', 'owner_estimated_due_minutes', 60), messages: demand('message_count', 'count', 'requires_owner_response_count', 10), physical_load: request.physical_load } }) };
    expect(await createHealthProduction(rpc(producer()), 'owner-a', clock, config).today('apple')).toMatchObject({ ok: true, data: { weight: { state: 'unavailable', reason: 'conflicting_inputs' } } });
  });
});
