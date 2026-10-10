import { describe, expect, it, vi } from 'vitest';
import { createOwnerHealthProduction, type OwnerHealthProductionHost } from '../src/health/owner-production';
import { healthProducerDaySchema } from '../../contracts/src/health/ingest';
import type { HealthSignedCall } from '../src/health/production';
import { HEALTH_CALCULATION_REVIEW_PIN } from '../src/health/calculation-review';
import { CANDIDATE_VERSIONS } from '../src/health/calculations';
import { iso8601Schema } from '../../contracts/src/core/error';
import type { HealthDemandObservation } from '../../contracts/src/health/demand';
import type { GoogleClient } from '../src/connectors/google';

const DAY = '2026-10-10', NOW = new Date(`${DAY}T12:00:00Z`);
const OWNER = 'canonical-signed-owner-a', ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const past = (age: number) => new Date(Date.parse(DAY) - age * 86400000).toISOString().slice(0, 10);
const origin = { read_api: 'healthkit', source_bundle_id: 'synthetic.owner.health', source_package_name: null, source_version: '1', source_revision: '1', device_ref: 'sha256:' + '1'.repeat(64), recording_method: false };
const producer = () => healthProducerDaySchema.parse({ source: 'apple', consent_epoch: 3, timezone: 'UTC', day: DAY, compiled_at: NOW.toISOString(), samples: [],
  aggregates: Array.from({ length: 31 }, (_, age) => {
    const current = age === 0;
    const metrics = ['sleep_duration', 'overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight_duration', 'movement_duration', 'perceived_stress', 'physical_load'];
    const values = { sleep_duration: current ? 480 : age % 2 ? 450 : 510, overnight_hrv: current ? Math.sqrt(40 * 60) : age % 2 ? 40 : 60,
      resting_heart_rate: current ? 60 : age % 2 ? 55 : 65, sleep_midpoint: current ? 240 : age % 2 ? 230 : 250,
      daylight_duration: current ? 60 : age % 2 ? 40 : 80, movement_duration: current ? 30 : age % 2 ? 20 : 40,
      perceived_stress: current ? 5 : age % 2 ? 3 : 7, physical_load: current ? 100 : age % 2 ? 50 : 150 };
    const methods = ['asleep_duration', 'rmssd', 'overnight_resting', 'sleep_midpoint', 'daylight_duration', 'active_minutes', 'self_report_0_10', 'provider_load'];
    return { day: past(age), timezone: 'UTC', observed_at: `${past(age)}T12:00:00Z`, metrics, methods: ['rmssd'], conflicting_metrics: [], values,
      observations: Object.fromEntries(metrics.map((metric, i) => [metric, { method: methods[i], origin,
        ...(i < 3 ? { eligibility: 'admitted_sleep_context', sleep_ended_at: `${past(age)}T07:00:00Z` } : {}),
        context_ref: i <= 3 ? 'overnight_daily' : 'intraday-12', observed_at: `${past(age)}T${i <= 3 ? '07' : '12'}:00:00Z`, revision: 1 }])) };
  }) });
const configuration = () => ({
  review_receipt: { review_ref: 'synthetic-host-review-only', ...HEALTH_CALCULATION_REVIEW_PIN, formula_review_ref: 'synthetic-formula-only', privacy_review_ref: 'synthetic-privacy-only', reviewed_at: iso8601Schema.parse('2026-10-09T12:00:00Z'), versions: CANDIDATE_VERSIONS },
  sleep_need: { basis: 'owner_confirmed' as const, owner_ref: OWNER, consent_epoch: 3, minutes: 480, confirmed_at: iso8601Schema.parse('2026-09-01T00:00:00Z') },
});
const grant = { consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 1, status: 'granted', epoch: 3, granted_at: '2026-09-01T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' };
const fixture = () => {
  let active = true;
  const current = vi.fn(async () => { if (!active) throw new Error('private owner lifecycle detail'); });
  const stored: HealthDemandObservation[] = [], data = producer();
  const call = vi.fn<HealthSignedCall>(async (_fn, _message, args) => {
    if (args.p_operation === 'consents') return { consents: [grant] };
    const payload = JSON.parse(String(args.p_payload));
    if (args.p_operation === 'record') {
      const observations = payload.observations as HealthDemandObservation[];
      stored.push(...observations);
      // Synthetic pre-existing, matching-regime baselines; these are not claimed
      // as actual provider history. Current values still come from the collector.
      for (const row of observations) for (let age = 1; age <= 14; age++) stored.push({ ...row, day: past(age), observed_at: iso8601Schema.parse(`${past(age)}T12:00:00Z`), queried_at: iso8601Schema.parse(`${past(age)}T12:00:00Z`), revision: 1,
        value: row.value === null ? null : row.metric === 'message_count' ? age % 2 ? 0 : 2 : row.value * (age % 2 ? .5 : 1.5) });
      return { request_id: payload.request_id, source: payload.source, consent_epoch: payload.consent_epoch, accepted: observations.length, ignored: 0, replayed: false };
    }
    if (args.p_operation === 'read') return { source: payload.source, consent_epoch: payload.consent_epoch, observations: stored.filter(row => row.metric === payload.metric && row.source_ref === payload.source_ref && row.context_ref === payload.context_ref && row.day >= payload.from && row.day <= payload.to) };
    return data;
  });
  const host: OwnerHealthProductionHost = {
    doName: OWNER, call, assertCurrent: current,
    accounts: async () => [], google: async () => { throw new Error('no account'); },
    ownerEstimates: async () => ({ complete: false, estimates: [] }),
    responses: async () => ({ complete: false, account_refs: [], obligations: [] }),
  };
  return { host, call, current, stored, data, revoke: () => { active = false; } };
};

describe('canonical owner health host composition', () => {
  it('defaults to inactive engineering candidates and fences the actual signed owner read', async () => {
    const f = fixture();
    const owner = createOwnerHealthProduction(f.host, { now: () => NOW });
    expect(owner.activation).toEqual({ state: 'inactive', reason: 'review_receipt_required' });
    expect(await owner.health.today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable' } } });
    expect(f.call).toHaveBeenCalledWith('health_plane', expect.stringContaining('canonical-signed-owner-a'), expect.objectContaining({ p_do_name: 'canonical-signed-owner-a' }));
    expect(f.current).toHaveBeenCalledWith({ plane: 'health', operation: 'today', source: 'apple' });
    f.revoke();
    const before = f.call.mock.calls.length;
    expect(await owner.health.consents()).toEqual({ ok: false, error: 'unavailable' });
    expect(f.call).toHaveBeenCalledTimes(before);
  });
  it('composes all four numeric candidates with actual current provider and canonical responsibility suppliers', async () => {
    const f = fixture();
    const google = {
      freeBusy: vi.fn(async (from: string, to: string) => ({ from, to, calendars: { primary: { busy: [{ start: `${DAY}T09:00:00Z`, end: `${DAY}T10:00:00Z` }, { start: `${DAY}T09:30:00Z`, end: `${DAY}T10:30:00Z` }] } } })),
      tasksPage: vi.fn(async () => ({ tasks: [{ id: 'task1', title: 'synthetic private task', status: 'todo' as const, due: DAY, task_list_id: 'list1' }], task_list_ids: ['list1'], next_page_token: null, fetched_count: 1, account: { connection_id: ACCOUNT, email: null }, observed_at: NOW.toISOString() })),
    } as unknown as GoogleClient;
    const host: OwnerHealthProductionHost = { ...f.host,
      accounts: async () => [{ id: ACCOUNT, revision: 'account-grant-1', calendar_ids: ['primary'], task_list_ids: ['list1'] }], google: async () => google,
      ownerEstimates: async () => ({ complete: true, estimates: [{ account_ref: ACCOUNT, task_list_ref: 'list1', task_ref: 'task1', due_day: DAY, minutes: 60, evidence_ref: 'explicit-owner-estimate' }] }),
      responses: async () => ({ complete: true, account_refs: [ACCOUNT], obligations: [{ id: 'response1', account_ref: ACCOUNT, revision: 1, state: 'requires_owner_response', evidence_ref: 'canonical-response' }] }),
    };
    const owner = createOwnerHealthProduction(host, { now: () => NOW }, configuration());
    expect(owner.activation).toMatchObject({ state: 'reviewed_candidate', review_ref: 'synthetic-host-review-only', clinical_validation: 'not_established' });
    const result = await owner.health.today('apple');
    expect(result).toMatchObject({ ok: true, data: {
      recovery: { state: 'available', score: 75, activation: 'candidate_unaccepted' },
      form: { state: 'available', score: 80, activation: 'candidate_unaccepted' },
      weight: { state: 'available', score: 50, activation: 'candidate_unaccepted' },
      sleep_debt: { state: 'available', coverage: 1, observed_nights: 14, activation: 'candidate_unaccepted' },
      calculation_review: { review_ref: 'synthetic-host-review-only', clinical_validation: 'not_established' },
    } });
    expect(f.stored.slice(0, 3).map(row => [row.metric, row.value])).toEqual([['calendar_minutes', 90], ['task_minutes', 60], ['message_count', 1]]);
    expect(google.freeBusy).toHaveBeenCalledTimes(1);
    expect(f.call.mock.calls.every(([, , args]) => args.p_do_name === OWNER)).toBe(true);
    expect(f.current).toHaveBeenCalledWith({ plane: 'health_demand', operation: 'record', source: 'apple', consent_epoch: 3 });
    expect(f.current).toHaveBeenCalledWith(expect.objectContaining({ plane: 'health_demand', operation: 'read', audience: 'owner', source: 'apple', consent_epoch: 3 }));
    expect(JSON.stringify(f.stored)).not.toContain('synthetic private task');
  });

  it('keeps missing explicit estimates and unknown obligations unavailable without invented zero demand', async () => {
    const f = fixture();
    const owner = createOwnerHealthProduction(f.host, { now: () => NOW }, configuration());
    expect(await owner.capture({ source: 'apple', consent_epoch: 3, day: DAY, timezone: 'UTC', as_of: NOW.toISOString() })).toMatchObject({ ok: true });
    expect(f.stored.slice(0, 2)).toMatchObject([
      { metric: 'task_minutes', value: null, missing_reason: 'missing_owner_estimates' },
      { metric: 'message_count', value: null, missing_reason: 'unknown_responsibility_state' },
    ]);
    const result = await owner.health.today('apple');
    expect(result).toMatchObject({ ok: true, data: { recovery: { state: 'available' }, form: { state: 'available' }, weight: { state: 'unavailable', reason: 'missing_signal' } } });
  });
  it('checks lifecycle after read IO and source revocation before demand can be written', async () => {
    const f = fixture(), call = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => { const result = await call(...args); if (args[2].p_operation === 'today') f.revoke(); return result; });
    expect(await createOwnerHealthProduction(f.host, { now: () => NOW }).health.today('apple')).toEqual({ ok: false, error: 'unavailable' });
    const fresh = fixture();
    const google = { freeBusy: async (from: string, to: string) => { fresh.revoke(); return { from, to, calendars: { primary: { busy: [] } } }; } } as unknown as GoogleClient;
    const host = { ...fresh.host, accounts: async () => [{ id: ACCOUNT, revision: 'grant-1', calendar_ids: ['primary'], task_list_ids: [] }], google: async () => google };
    expect(await createOwnerHealthProduction(host, { now: () => NOW }).capture({ source: 'apple', consent_epoch: 3, day: DAY, timezone: 'UTC', as_of: NOW.toISOString() })).toEqual({ ok: false, error: 'unavailable' });
    expect(fresh.stored).toEqual([]);
    expect(fresh.call.mock.calls.some(([, , args]) => args.p_operation === 'record')).toBe(false);
  });
  it('passes exact purpose-bearing read scope through source-current fences and never leaks failed provider details', async () => {
    const f = fixture();
    f.call.mockResolvedValue({ source: 'apple', consent_epoch: 3, samples: [], count: 0, has_more: false, next_cursor: null });
    const owner = createOwnerHealthProduction(f.host, { now: () => NOW });
    expect(await owner.health.readings({ source: 'apple', consent_epoch: 3, from: DAY, to: DAY }, 'model')).toMatchObject({ ok: true });
    expect(f.current).toHaveBeenCalledWith({ plane: 'health', operation: 'readings', source: 'apple', consent_epoch: 3, audience: 'model' });
    expect(f.current.mock.calls).toHaveLength(2);
    f.call.mockRejectedValue(new Error('synthetic private physiological/provider payload'));
    expect(await owner.health.consents()).toEqual({ ok: false, error: 'unavailable' });
  });
  it('refuses old capture and reads historical demand only from the exact stored cutoff regime', async () => {
    const f = fixture(), accounts = vi.fn(async () => [{ id: ACCOUNT, revision: 'grant-1', calendar_ids: ['primary'], task_list_ids: ['list1'] }]);
    const google = vi.fn(async () => { throw new Error('current provider must not be called'); });
    const responses = vi.fn(f.host.responses), estimates = vi.fn(f.host.ownerEstimates);
    const pastDay = past(1), stored = { ...f.data, day: pastDay, compiled_at: `${pastDay}T10:00:00Z`, aggregates: f.data.aggregates.filter(row => row.day <= pastDay) };
    const call = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => args[2].p_operation === 'history' ? { days: [stored] } : call(...args));
    const owner = createOwnerHealthProduction({ ...f.host, accounts, google, responses, ownerEstimates: estimates }, { now: () => NOW }, configuration());
    expect(await owner.capture({ source: 'apple', consent_epoch: 3, day: pastDay, timezone: 'UTC', as_of: `${pastDay}T10:00:00Z` })).toEqual({ ok: false, error: 'invalid_request' });
    expect(await owner.health.history({ source: 'apple', consent_epoch: 3, from: pastDay, to: pastDay })).toMatchObject({ ok: true, data: { days: [{ weight: { state: 'unavailable' } }] } });
    expect(google).not.toHaveBeenCalled(); expect(responses).not.toHaveBeenCalled(); expect(estimates).not.toHaveBeenCalled();
    expect(f.stored).toEqual([]);
    const queries = f.call.mock.calls.filter(([, , args]) => args.p_operation === 'read').map(([, , args]) => JSON.parse(String(args.p_payload)));
    expect(queries).toHaveLength(3);
    expect(queries.every(query => query.context_ref === 'day-demand.v1.UTC.1000')).toBe(true);
  });
  it('cannot activate mismatched review targets and an unlinked owner cannot capture or read', async () => {
    const f = fixture(), config = configuration();
    const owner = createOwnerHealthProduction(f.host, { now: () => NOW }, { ...config, review_receipt: { ...config.review_receipt, algorithm_source_sha256: '0'.repeat(64) } });
    expect(owner.activation).toEqual({ state: 'inactive', reason: 'review_receipt_invalid' });
    expect(await owner.health.today('apple')).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' } } });
    expect(f.stored).toEqual([]);
    const absent = createOwnerHealthProduction({ ...f.host, doName: null }, { now: () => NOW }, configuration());
    expect(absent.health.linked()).toBe(false);
    expect(await absent.health.today('apple')).toEqual({ ok: false, error: 'not_linked' });
    expect(await absent.capture({ source: 'apple', consent_epoch: 3, day: DAY, timezone: 'UTC', as_of: NOW.toISOString() })).toEqual({ ok: false, error: 'not_linked' });
  });

});
