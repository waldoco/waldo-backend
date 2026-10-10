import { describe, expect, it, vi } from 'vitest';
import { healthDemandRecordSchema, healthDemandObservationSchema } from '../../contracts/src/health/demand';
import { createHealthDemandProduction } from '../src/health/demand';
import type { HealthSignedCall } from '../src/health/production';
import { calculateCandidate } from '../src/health/calculations';

const DAY = '2026-10-10', clock = { now: () => new Date(`${DAY}T12:00:00Z`) };
const past = (age: number) => new Date(Date.parse(DAY) - age * 86400000).toISOString().slice(0, 10);
const calendar = (age = 0, value: number | null = 120) => healthDemandObservationSchema.parse({
  metric: 'calendar_minutes', unit: 'minutes', method: 'union_busy_minutes', supplier: 'google_calendar',
  source_ref: 'calendar-actual-account-scope', context_ref: 'complete-local-day-UTC', day: past(age), timezone: 'UTC',
  observed_at: `${past(age)}T10:00:00Z`, queried_at: `${past(age)}T10:00:00Z`, revision: 1,
  value, query_complete: value !== null, evidence_ref: 'complete-provider-page-receipt',
  missing_reason: value === null ? 'incomplete_query' : null, connection_refs: ['a0000000-0000-4000-8000-000000000001'],
});
const record = (observations = [calendar()]) => healthDemandRecordSchema.parse({ request_id: 'demand-operation-0001', source: 'apple', consent_epoch: 3, observations });

describe('signed health demand production and durable baseline source', () => {
  it('requires complete actual query evidence, owner-estimate references and proper account scope before signed dispatch', async () => {
    const call = vi.fn<HealthSignedCall>();
    const service = createHealthDemandProduction(call, 'owner-a', clock);
    for (const invalid of [
      { ...record(), observations: [{ ...calendar(), query_complete: false }] },
      { ...record(), observations: [{ ...calendar(), connection_refs: [] }] },
      { ...record(), observations: [{ ...calendar(), value: null, missing_reason: null }] },
      { ...record(), observations: [{ ...calendar(), metric: 'task_minutes', supplier: 'google_tasks', method: 'owner_estimated_due_minutes', estimate_refs: [] }] },
      { ...record(), observations: [calendar(), calendar()] },
    ]) expect(await service.record(invalid as never)).toEqual({ ok: false, error: 'invalid_request' });
    expect(call).not.toHaveBeenCalled();
  });
  it('records real observed zero and unknown null without inventing a baseline or leaking input through receipts', async () => {
    const input = record([calendar(0, 0), calendar(1, null)]);
    const call = vi.fn<HealthSignedCall>(async () => ({ request_id: input.request_id, source: 'apple', consent_epoch: 3, accepted: 2, ignored: 0, replayed: false }));
    const result = await createHealthDemandProduction(call, 'owner-a', clock).record(input);
    expect(result).toEqual({ ok: true, data: { request_id: input.request_id, source: 'apple', consent_epoch: 3, accepted: 2, ignored: 0, replayed: false } });
    expect(call).toHaveBeenCalledWith('health_demand', expect.stringMatching(/^healthdemand\.owner-a\.record\./), expect.objectContaining({ p_do_name: 'owner-a', p_operation: 'record' }));
    expect(result).not.toHaveProperty('observations');
  });
  it('rejects future, wrong-local-day and malformed producer receipts', async () => {
    const call = vi.fn<HealthSignedCall>(async () => ({ request_id: 'other-request-0001', source: 'apple', consent_epoch: 3, accepted: 1, ignored: 0, replayed: false }));
    const service = createHealthDemandProduction(call, 'owner-a', clock);
    expect(await service.record({ ...record(), observations: [{ ...calendar(), day: past(1) }] })).toEqual({ ok: false, error: 'invalid_request' });
    expect(await service.record({ ...record(), observations: [{ ...calendar(), queried_at: '2026-10-11T10:00:00Z' as never }] })).toEqual({ ok: false, error: 'invalid_request' });
    expect(await service.record(record())).toEqual({ ok: false, error: 'unavailable' });
  });
  it('derives an actual source-bound CandidateSeries through the signed read rail, keeping gaps null', async () => {
    const observations = [calendar(0, null), ...Array.from({ length: 14 }, (_, index) => calendar(index + 1, index % 2 ? 60 : 180))];
    const call = vi.fn<HealthSignedCall>(async () => ({ source: 'apple', consent_epoch: 3, observations }));
    const service = createHealthDemandProduction(call, 'owner-a', clock);
    const result = await service.series({ source: 'apple', consent_epoch: 3, metric: 'calendar_minutes', source_ref: calendar().source_ref, context_ref: calendar().context_ref, day: DAY, timezone: 'UTC' }, 'model');
    expect(result).toMatchObject({ ok: true, data: { current: { owner_ref: 'owner-a', value: null }, history: expect.arrayContaining([expect.objectContaining({ value: 180, source_ref: calendar().source_ref })]) } });
    const payload = JSON.parse(String(call.mock.calls[0]![2].p_payload)) as Record<string, unknown>;
    expect(payload).toMatchObject({ audience: 'model', from: past(30), to: DAY });
    if (result.ok) expect(result.data.history).toHaveLength(14);
  });
  it('builds all three actual demand baselines for Weight while physical load remains independently sourced', async () => {
    const metricRows = (metric: 'calendar_minutes' | 'task_minutes' | 'message_count') => Array.from({ length: 15 }, (_, age) => {
      const base = calendar(age, age === 0 ? 120 : age % 2 ? 60 : 180);
      return healthDemandObservationSchema.parse(metric === 'calendar_minutes' ? base : metric === 'task_minutes'
        ? { ...base, metric, method: 'owner_estimated_due_minutes', supplier: 'owner_work', connection_refs: [], estimate_refs: ['actual-owner-estimate-claim'] }
        : { ...base, metric, method: 'requires_owner_response_count', unit: 'count', supplier: 'responsibilities', connection_refs: [] });
    });
    const service = createHealthDemandProduction(async (_fn, _message, args) => { const input = JSON.parse(String(args.p_payload)) as { metric: 'calendar_minutes' | 'task_minutes' | 'message_count' }; return { source: 'apple', consent_epoch: 3, observations: metricRows(input.metric) }; }, 'owner-a', clock);
    const read = async (metric: 'calendar_minutes' | 'task_minutes' | 'message_count') => {
      const result = await service.series({ source: 'apple', consent_epoch: 3, metric, source_ref: calendar().source_ref, context_ref: calendar().context_ref, day: DAY, timezone: 'UTC' });
      if (!result.ok) throw new Error('synthetic supplier failed'); return result.data;
    };
    const calendarSeries = await read('calendar_minutes'), tasks = await read('task_minutes'), messages = await read('message_count');
    const physical = { current: { ...calendarSeries.current!, source_ref: 'apple', metric: 'physical_load', unit: 'source_units', method: 'provider_load' }, history: calendarSeries.history.map(row => ({ ...row, source_ref: 'apple', metric: 'physical_load', unit: 'source_units', method: 'provider_load' })) };
    expect(calculateCandidate({ kind: 'weight', owner_ref: 'owner-a', consent_epoch: 3, day: DAY, timezone: 'UTC', as_of: clock.now().toISOString(), calendar: calendarSeries, tasks, messages, physical_load: physical })).toMatchObject({ state: 'available', score: 50, algorithm_version: 'weight.candidate.v1' });
  });
  it('returns no stale or cross-scope source data after read failure, disconnect or restart', async () => {
    const scope = { source: 'apple' as const, consent_epoch: 3, metric: 'calendar_minutes' as const, source_ref: calendar().source_ref, context_ref: calendar().context_ref, day: DAY, timezone: 'UTC' };
    for (const response of [{ error: 'epoch_conflict' }, { source: 'oura', consent_epoch: 3, observations: [calendar()] }, { source: 'apple', consent_epoch: 4, observations: [calendar()] }, { source: 'apple', consent_epoch: 3, observations: [{ ...calendar(), source_ref: 'other-account' }] }]) {
      const result = await createHealthDemandProduction(async () => response, 'owner-a', clock).series(scope);
      expect(result.ok).toBe(false);
    }
    expect(await createHealthDemandProduction(async () => { throw new Error('private health and provider data'); }, 'owner-a', clock).series(scope)).toEqual({ ok: false, error: 'unavailable' });
    expect(await createHealthDemandProduction(null, 'owner-a', clock).series(scope)).toEqual({ ok: false, error: 'not_linked' });
  });
});
