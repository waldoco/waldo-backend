import { describe, expect, it } from 'vitest';
import { createHealthProduction } from '../src/health/production';
import { createHealthModelContext, createOwnerHealthTurnSources } from '../src/health/model-context';

const NOW = new Date('2026-10-10T12:00:00Z');
const sample = { sample_id: 'synthetic-sleep-1', revision: 1, metric: 'sleep_duration', unit: 'minutes', value: 420, day: '2026-10-10', start_at: '2026-10-10T00:00:00Z', end_at: '2026-10-10T07:00:00Z' };
const day = { source: 'apple', consent_epoch: 1, timezone: 'UTC', compiled_at: '2026-10-10T07:00:00Z', day: '2026-10-10', samples: [sample], aggregates: [] };
const consent = (purpose: string, epoch = 1, status = 'granted') => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 1, status, epoch, granted_at: '2026-10-09T07:00:00Z', withdrawn_at: status === 'withdrawn' ? '2026-10-10T10:00:00Z' : null, deletion_state: status === 'withdrawn' ? 'completed' : 'not_required' });

describe('consent-fenced volatile health model context', () => {
  it('never reads owner numerics with only storage consent', async () => {
    const operations: string[] = [];
    const service = createHealthProduction(async (_fn, _message, args) => {
      operations.push(String(args.p_operation));
      return { consents: [consent('storage_compute')] };
    }, 'owner-a', { now: () => NOW });
    const book = createHealthModelContext(service, 'apple', { now: () => NOW });
    expect(await book.read(NOW.getTime())).toEqual({ ok: false, error: 'consent_required' });
    expect(operations).toEqual(['consents']);
  });

  it('carries actual own readings and source/method/time in nonretaining health provenance fragments', async () => {
    const service = createHealthProduction(async (_fn, _message, args) => {
      if (args.p_operation === 'consents') return { consents: [consent('storage_compute'), consent('model_processing')] };
      if (args.p_operation === 'today') return day;
      const input = JSON.parse(String(args.p_payload)) as Record<string, unknown>;
      expect(input.audience).toBe('model');
      return { source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: false };
    }, 'owner-a', { now: () => NOW });
    const book = createHealthModelContext(service, 'apple', { now: () => NOW });
    const result = await book.read(NOW.getTime());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fence).toEqual({ source: 'apple', storage_epoch: 1, model_epoch: 1 });
    const fragment = result.data.fragments[0]!;
    expect(fragment.source).toMatchObject({ source_key: 'health:apple:2026-10-10:1:1', source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: Date.parse(day.compiled_at) });
    expect(JSON.parse(fragment.text)).toMatchObject({ context_kind: 'owner_health', source: 'apple', readings: [sample], clinical_validation: 'not_established' });
    expect(await book.recheck(result.data.fence)).toBe(true);
    expect(await book.recheck({ ...result.data.fence, source: 'manual' })).toBe(false);
  });

  it('rejects withdrawal/regrant during a read and rejects a stale fence after restart', async () => {
    let consentReads = 0;
    const service = createHealthProduction(async (_fn, _message, args) => {
      if (args.p_operation === 'consents') return { consents: [consent('storage_compute', ++consentReads === 1 ? 1 : 3), consent('model_processing', consentReads === 1 ? 1 : 3)] };
      if (args.p_operation === 'today') return day;
      return { source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: false };
    }, 'owner-a', { now: () => NOW });
    expect(await createHealthModelContext(service, 'apple', { now: () => NOW }).read(NOW.getTime())).toEqual({ ok: false, error: 'consent_withdrawn' });
    expect(await createHealthModelContext(service, 'apple', { now: () => NOW }).recheck({ source: 'apple', storage_epoch: 1, model_epoch: 1 })).toBe(false);
  });

  it('returns truthful absence while preserving consent fence and blocks post-snapshot readings', async () => {
    const call = async (_fn: string, _message: string, args: Record<string, string | number>) => args.p_operation === 'consents' ? { consents: [consent('storage_compute'), consent('model_processing')] } : null;
    const service = createHealthProduction(call, 'owner-a', { now: () => NOW });
    expect(await createHealthModelContext(service, 'apple', { now: () => NOW }).read(NOW.getTime())).toMatchObject({ ok: true, data: { state: 'absent', fragments: [] } });
    const newer = createHealthProduction(async (_fn, _message, args) => args.p_operation === 'consents' ? { consents: [consent('storage_compute'), consent('model_processing')] } : day, 'owner-a', { now: () => NOW });
    expect(await createHealthModelContext(newer, 'apple', { now: () => NOW }).read(Date.parse('2026-10-10T06:00:00Z'))).toEqual({ ok: false, error: 'epoch_conflict' });
  });
});


it('the actual owner-turn source factory preserves source origins and fences all admitted context', async () => {
  let epoch = 1;
  const service = createHealthProduction(async (_fn, _message, args) => {
    if (args.p_operation === 'consents') return { consents: [consent('storage_compute', epoch), consent('model_processing', epoch)] };
    if (args.p_operation === 'today') return day;
    return { source: 'apple', consent_epoch: 1, samples: [sample], count: 1, has_more: false };
  }, 'canonical-owner-with-no-telegram', { now: () => NOW });
  const sources = createOwnerHealthTurnSources(service, { now: () => NOW });
  expect(await sources.read(NOW.getTime())).toEqual([]);
  const fragments = await sources.readCurrent(NOW.getTime());
  expect(fragments).toHaveLength(1);
  expect(JSON.parse(fragments[0]!.text).sources[0].health).toMatchObject({ source: 'apple', readings: [sample] });
  await expect(sources.assertCurrent()).resolves.toBeUndefined();
  epoch = 3;
  await expect(sources.assertCurrent()).rejects.toThrow('authority changed');
  await expect(sources.read(NOW.getTime())).rejects.toThrow('authority changed');
});

it('no model grant or unavailable health leaves owner general capabilities usable without reading numerics', async () => {
  const operations: string[] = [];
  const service = createHealthProduction(async (_fn, _message, args) => { operations.push(String(args.p_operation)); return { consents: [consent('storage_compute')] }; }, 'app-only-owner', { now: () => NOW });
  expect(await createOwnerHealthTurnSources(service, { now: () => NOW }).read()).toEqual([]);
  expect(operations).toEqual([]);
  expect(await createOwnerHealthTurnSources(createHealthProduction(null, null), { now: () => NOW }).read()).toEqual([]);
});

it('bounded model tool reads retain current source provenance and report truncation', async () => {
  const service = createHealthProduction(async (_fn, _message, args) => args.p_operation === 'consents' ? { consents: [consent('storage_compute'), consent('model_processing')] } : args.p_operation === 'today' ? day : { source: 'apple', consent_epoch: 1, samples: [sample, { ...sample, sample_id: 'another' }], count: 2, has_more: false }, 'app-only-owner', { now: () => NOW });
  const result = await createOwnerHealthTurnSources(service, { now: () => NOW }).readings({ metrics: ['sleep'], range_days: 1, max_samples: 1 });
  expect(result).toMatchObject({ ok: true, data: { custody: 'volatile_owner_health', sources: [{ samples: [sample], returned_samples: 1, coverage: 'partial_narrow_request' }] } });
});
