import { describe, expect, it, vi } from 'vitest';
import {
  healthConsentGrantSchema, healthIngestSchema, healthProducerDaySchema,
} from '../../contracts/src/health/ingest';
import { createHealthProduction, healthProductionRequest, produceHealthDailySummary, type HealthSignedCall } from '../src/health/production';
import { md5Hex } from '../src/channels/md5';

const NOW = new Date('2026-10-10T12:00:00Z');
const clock = { now: () => NOW };
const grant = healthConsentGrantSchema.parse({ request_id: 'grant-example-1', source: 'apple', purpose: 'storage_compute', version: 1, expected_epoch: 0, age_attested_18_plus: true });
const sample = { sample_id: 'sample-1', revision: 1, metric: 'sleep_duration', unit: 'minutes', value: 420, day: '2026-10-10', start_at: '2026-10-10T00:00:00Z', end_at: '2026-10-10T07:00:00Z' };
const upload = () => healthIngestSchema.parse({ request_id: 'upload-example-1', source: 'apple', consent_epoch: 1, timezone: 'UTC', anchor_before: null, anchor_after: 'anchor-1', samples: [sample], deletions: [] });
const receipt = { request_id: 'upload-example-1', source: 'apple', consent_epoch: 1, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'anchor-1', replayed: false };
const producerDay = () => healthProducerDaySchema.parse({ source: 'apple', consent_epoch: 1, timezone: 'UTC', compiled_at: '2026-10-10T07:00:00Z', day: '2026-10-10', samples: [sample], aggregates: [{ day: '2026-10-10', metrics: ['sleep_duration'], methods: [], conflicting_metrics: [] }] });

describe('owner-bound health production service', () => {
  it('fails closed without the signed owner identity and never fabricates absence from a store failure', async () => {
    const unlinked = createHealthProduction(null, null, clock);
    expect(await unlinked.today('apple')).toEqual({ ok: false, error: 'not_linked' });
    const service = createHealthProduction(async () => { throw new Error('private-provider-body'); }, 'owner-a', clock);
    expect(await service.today('apple')).toEqual({ ok: false, error: 'unavailable' });
  });

  it('binds exact canonical payload and owner into the existing signed rail', async () => {
    const call = vi.fn<HealthSignedCall>(async () => receipt);
    const service = createHealthProduction(call, 'owner-a', clock);
    expect(await service.ingest(upload())).toEqual({ ok: true, data: receipt });
    const body = JSON.stringify(upload());
    expect(call).toHaveBeenCalledWith('health_plane', `healthplane.owner-a.ingest.${md5Hex(body)}`, { p_do_name: 'owner-a', p_operation: 'ingest', p_payload: body });
    const secondOwner = createHealthProduction(call, 'owner-b', clock);
    await secondOwner.ingest(upload());
    expect(call.mock.calls[1]?.[2]).toMatchObject({ p_do_name: 'owner-b' });
  });

  it('uses strict grant evidence and never passes upload-provided owner identity to the database', async () => {
    const call = vi.fn(async () => receipt);
    const service = createHealthProduction(call, 'owner-a', clock);
    expect(await service.grant({ ...grant, user_id: 'owner-b' } as typeof grant)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await service.grant({ ...grant, age_attested_18_plus: false } as unknown as typeof grant)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await service.ingest({ ...upload(), user_id: 'owner-b' } as ReturnType<typeof upload>)).toEqual({ ok: false, error: 'invalid_request' });
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects mismatched local day, future values, invalid units and duplicate sample/deletion identities', async () => {
    const call = vi.fn(async () => receipt);
    const service = createHealthProduction(call, 'owner-a', clock);
    for (const value of [
      { ...upload(), samples: [{ ...sample, day: '2026-10-09' }] },
      { ...upload(), samples: [{ ...sample, end_at: '2026-10-11T07:00:00Z', day: '2026-10-11' }] },
      { ...upload(), samples: [{ ...sample, unit: 'hours' }] },
      { ...upload(), samples: [sample, sample] },
      { ...upload(), deletions: [{ sample_id: sample.sample_id, metric: sample.metric, revision: 2 }] },
    ]) expect(await service.ingest(value as ReturnType<typeof upload>)).toEqual({ ok: false, error: 'invalid_request' });
    expect(call).not.toHaveBeenCalled();
  });

  it('verifies native source sleep union, actual efficiency denominator and HRV sleep attribution', async () => {
    const origin = { read_api: 'healthkit' as const, source_bundle_id: 'com.synthetic.sensor', source_package_name: null, source_version: '1', source_revision: null, device_ref: null, recording_method: false };
    const context = { source_ref: 'com.synthetic.sensor', session_ref: 'night-session-1', waking_day: '2026-10-10', reducer_version: 'asleep-interval-union.v1' as const, contributor_ids: ['stage-a', 'stage-b', 'bed'], intervals: [
      { contributor_id: 'stage-a', kind: 'asleep' as const, start_at: '2026-10-09T23:00:00Z', end_at: '2026-10-10T03:00:00Z' },
      { contributor_id: 'stage-b', kind: 'asleep' as const, start_at: '2026-10-10T02:00:00Z', end_at: '2026-10-10T06:00:00Z' },
      { contributor_id: 'bed', kind: 'in_bed' as const, start_at: '2026-10-09T22:00:00Z', end_at: '2026-10-10T06:00:00Z' },
    ] };
    const reading = { ...sample, origin, method: 'asleep_duration' as const, sleep_context: context, start_at: '2026-10-09T23:00:00Z', end_at: '2026-10-10T06:00:00Z' };
    const call = vi.fn<HealthSignedCall>(async () => receipt), service = createHealthProduction(call, 'owner-a', clock);
    expect((await service.ingest(healthIngestSchema.parse({ ...upload(), samples: [reading] }))).ok).toBe(true);
    expect(JSON.parse(String(call.mock.calls[0]![2].p_payload)).samples[0]).toEqual(reading);
    for (const invalid of [{ ...reading, value: 480 }, { ...reading, sleep_context: undefined }, { ...reading, sleep_context: { ...context, source_ref: 'com.other.sensor' } }]) expect(await service.ingest({ ...upload(), samples: [invalid] } as never)).toEqual({ ok: false, error: 'invalid_request' });
    const { method: _sleepMethod, ...efficiencyBase } = reading;
    const efficiency = { ...efficiencyBase, metric: 'sleep_efficiency', unit: 'ratio', value: .875 };
    expect((await service.ingest({ ...upload(), samples: [efficiency] } as never)).ok).toBe(true);
    expect(await service.ingest({ ...upload(), samples: [{ ...efficiency, sleep_context: { ...context, intervals: context.intervals.filter(interval => interval.kind === 'asleep') } }] } as never)).toEqual({ ok: false, error: 'invalid_request' });
    const hrv = { ...reading, metric: 'overnight_hrv', unit: 'milliseconds', value: 50, method: 'sdnn', start_at: '2026-10-09T23:30:00Z', end_at: '2026-10-09T23:31:00Z' };
    expect((await service.ingest({ ...upload(), samples: [hrv] } as never)).ok).toBe(true);
    expect(await service.ingest({ ...upload(), samples: [{ ...hrv, start_at: '2026-10-10T09:00:00Z', end_at: '2026-10-10T09:01:00Z' }] } as never)).toEqual({ ok: false, error: 'invalid_request' });
  });
  it('propagates durable consent/revision/anchor errors without retaining raw response text', async () => {
    for (const error of ['consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'sample_conflict', 'anchor_conflict'] as const) {
      const service = createHealthProduction(async () => ({ error }), 'owner-a', clock);
      expect(await service.ingest(upload())).toEqual({ ok: false, error });
    }
    const malformed = createHealthProduction(async () => ({ error: 'private health values', raw: 420 }), 'owner-a', clock);
    expect(await malformed.ingest(upload())).toEqual({ ok: false, error: 'unavailable' });
  });

  it('recovers receipt replay through a new service instance without any local health cache', async () => {
    const call = vi.fn(async () => ({ ...receipt, replayed: true }));
    const first = createHealthProduction(call, 'owner-a', clock);
    const afterRestart = createHealthProduction(call, 'owner-a', clock);
    expect(await first.ingest(upload())).toEqual(await afterRestart.ingest(upload()));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('never acknowledges a substituted source, epoch, request, anchor or count receipt', async () => {
    for (const changed of [{ source: 'oura' }, { consent_epoch: 2 }, { request_id: 'other-receipt-001' }, { anchor_after: 'unwitnessed-anchor' }, { accepted: 0 }]) {
      expect(await createHealthProduction(async () => ({ ...receipt, ...changed }), 'owner-a', clock).ingest(upload())).toEqual({ ok: false, error: 'unavailable' });
    }
  });
  it('advances a zero-change OS anchor query only through an acknowledged RPC', async () => {
    const data = { ...receipt, accepted: 0 };
    const service = createHealthProduction(async () => data, 'owner-a', clock);
    expect(await service.ingest({ ...upload(), samples: [] })).toEqual({ ok: true, data });
  });

  it('reports null for genuinely absent data and keeps score/form/weight unavailable without accepted calculations', async () => {
    const absent = createHealthProduction(async () => null, 'owner-a', clock);
    expect(await absent.today('apple')).toEqual({ ok: true, data: null });
    const day = producerDay();
    day.samples.push(healthIngestSchema.parse({ ...upload(), samples: [{ ...sample, sample_id: 'sample-hrv', metric: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: 50 }] }).samples[0]!);
    const service = createHealthProduction(async () => day, 'owner-a', clock);
    const result = await service.today('apple');
    expect(result).toMatchObject({ ok: true, data: { recovery: { state: 'unavailable', reason: 'algorithm_not_accepted' }, baseline: { state: 'not_computed', required_days: null }, form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' }, weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' } } });
    expect(JSON.stringify(result)).not.toContain('score');
    expect(JSON.stringify(result)).not.toContain('420');
  });

  it('preserves historical coverage from aggregates after raw retention expiry and separates measurement methods', () => {
    const day = producerDay(); day.samples = [];
    day.aggregates[0] = { day: day.day, metrics: ['sleep_duration', 'overnight_hrv'], methods: ['rmssd'], conflicting_metrics: [] };
    day.aggregates.push({ day: '2026-10-09', metrics: ['sleep_duration', 'overnight_hrv'], methods: ['sdnn'], conflicting_metrics: [] });
    day.aggregates.push({ day: '2026-10-08', metrics: ['sleep_duration', 'overnight_hrv'], methods: ['rmssd'], conflicting_metrics: [] });
    const summary = produceHealthDailySummary(day, clock);
    expect(summary.coverage).toMatchObject({ sleep: true, hrv: true });
    expect(summary.baseline.distinct_days).toBe(1);
    expect(summary.baseline.method).toBe('rmssd');
    expect(summary.recovery).toEqual({ state: 'unavailable', reason: 'algorithm_not_accepted' });
  });

  it('forwards a source cursor to exhaust owner readings and rejects an unresumable partial response', async () => {
    const query = { source: 'apple' as const, from: '2026-10-10', to: '2026-10-10', consent_epoch: 1, cursor: 'signedsourcecursor_1' };
    const call = vi.fn<HealthSignedCall>(async () => ({ source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: true, next_cursor: 'signedsourcecursor_2' }));
    const service = createHealthProduction(call, 'owner-a', clock);
    expect(await service.readings(query, 'owner')).toMatchObject({ ok: true, data: { next_cursor: 'signedsourcecursor_2' } });
    expect(JSON.parse(String(call.mock.calls[0]![2].p_payload))).toMatchObject({ cursor: query.cursor, audience: 'owner' });
    const response = await healthProductionRequest(new Request('https://app.invalid/app/v1/health/readings?source=apple&from=2026-10-10&to=2026-10-10&consent_epoch=1&cursor=signedsourcecursor_1'), service);
    expect(response?.status).toBe(200);
    call.mockResolvedValue({ source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: true });
    expect(await service.readings(query, 'owner')).toEqual({ ok: false, error: 'unavailable' });
    call.mockResolvedValue({ source: 'apple', consent_epoch: 1, samples: [sample], count: 0, has_more: false });
    expect(await service.readings(query, 'owner')).toEqual({ ok: false, error: 'unavailable' });
  });
  it('rejects signed raw readings outside the exact requested date range or trusted observation clock', async () => {
    const query = { source: 'apple' as const, from: '2026-10-10', to: '2026-10-10', consent_epoch: 1 };
    for (const malformed of [{ ...sample, day: '2026-10-09' }, { ...sample, day: '2026-10-11' }, { ...sample, end_at: '2026-10-10T13:00:00Z' }, { ...sample, start_at: '2026-10-10T08:00:00Z' }]) {
      const service = createHealthProduction(async () => ({ source: 'apple', consent_epoch: 1, samples: [malformed], count: 1, has_more: false }), 'owner-a', clock);
      expect(await service.readings(query, 'model')).toEqual({ ok: false, error: 'unavailable' });
    }
  });
  it('preserves typed failure for malformed producer dates/timezone and oversized historical day arrays', async () => {
    for (const input of [{ ...producerDay(), timezone: 'private/invalid' }, { ...producerDay(), compiled_at: 'invalid' }, { ...producerDay(), day: 'invalid' }, { ...producerDay(), compiled_at: '2026-10-11T07:00:00Z' }]) {
      expect(await createHealthProduction(async () => input, 'owner-a', clock).today('apple')).toEqual({ ok: false, error: 'unavailable' });
    }
  });
});

describe('strict authenticated health request adapter', () => {
  it('requires the idempotency header and rejects forged owner fields before RPC', async () => {
    const call = vi.fn(async () => receipt);
    const service = createHealthProduction(call, 'owner-a', clock);
    const request = (body: unknown, key?: string) => new Request('https://app.invalid/app/v1/health/ingest', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
    expect((await healthProductionRequest(request(upload()), service))?.status).toBe(400);
    expect((await healthProductionRequest(request({ ...upload(), owner: 'owner-b' }, receipt.request_id), service))?.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
    const response = await healthProductionRequest(request(upload(), receipt.request_id), service);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  it('bounds streamed UTF-8 bytes and rejects invalid JSON with no provider call', async () => {
    const call = vi.fn(async () => receipt);
    const service = createHealthProduction(call, 'owner-a', clock);
    const request = new Request('https://app.invalid/app/v1/health/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'न'.repeat(40000) });
    expect((await healthProductionRequest(request, service))?.status).toBe(413);
    const malformed = new Request('https://app.invalid/app/v1/health/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect((await healthProductionRequest(malformed, service))?.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
});
