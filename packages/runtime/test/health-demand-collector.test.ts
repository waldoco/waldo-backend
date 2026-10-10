import { describe, expect, it, vi } from 'vitest';
import { createHealthDemandCollector, healthDemandDayBounds, type HealthDemandCollectorHost } from '../src/health/demand-collector';
import { createHealthDemandProduction } from '../src/health/demand';
import { createHealthProduction } from '../src/health/production';
import type { HealthDemandObservation } from '../../contracts/src/health/demand';
import type { GoogleClient } from '../src/connectors/google';

const DAY = '2026-10-10', NOW = new Date(`${DAY}T12:00:00Z`), ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const input = { source: 'apple' as const, consent_epoch: 3, day: DAY, timezone: 'UTC', as_of: NOW.toISOString() };
const grant = (epoch = 3) => ({ consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 1, status: 'granted', epoch, granted_at: '2026-10-09T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
const fixture = (fixtureNow = NOW) => {
  let epoch = 3, sourceRevision = 'grant1', revoked = false;
  const saved: HealthDemandObservation[] = [];
  const call = vi.fn(async (_fn: string, _message: string, args: Record<string, string | number>) => {
    if (args.p_operation === 'consents') return { consents: [grant(epoch)] };
    const request = JSON.parse(String(args.p_payload));
    if (args.p_operation === 'record') {
      saved.push(...request.observations);
      return { request_id: request.request_id, source: request.source, consent_epoch: request.consent_epoch, accepted: request.observations.length, ignored: 0, replayed: false };
    }
    return { source: request.source, consent_epoch: request.consent_epoch, observations: saved.filter(row => row.metric === request.metric && row.source_ref === request.source_ref && row.context_ref === request.context_ref) };
  });
  const health = createHealthProduction(call, 'owner-a', { now: () => fixtureNow }), demand = createHealthDemandProduction(call, 'owner-a', { now: () => fixtureNow });
  const google = {
    freeBusy: vi.fn(async (from: string, to: string) => ({ from, to, calendars: { primary: { busy: [{ start: `${DAY}T09:00:00Z`, end: `${DAY}T10:00:00Z` }, { start: `${DAY}T09:30:00Z`, end: `${DAY}T10:30:00Z` }] } } })),
    tasksPage: vi.fn(async (_list: string, _status: string, _limit: number, token?: string) => ({ tasks: token ? [{ id: 'task2', title: 'private second task', status: 'todo' as const, due: DAY, task_list_id: 'list1' }] : [{ id: 'task1', title: 'private first task', status: 'todo' as const, due: DAY, task_list_id: 'list1' }], task_list_ids: ['list1'], next_page_token: token ? null : 'page2', fetched_count: 1, account: { connection_id: ACCOUNT, email: 'owner@example.invalid' }, observed_at: input.as_of })),
  } as unknown as GoogleClient;
  const host: HealthDemandCollectorHost = {
    owner_ref: 'owner-a', health, demand,
    assertCurrent: vi.fn(async () => { if (revoked) throw new Error('source revoked'); }),
    accounts: vi.fn(async () => [{ id: ACCOUNT, revision: sourceRevision, calendar_ids: ['primary'], task_list_ids: ['list1'] }]),
    google: vi.fn(async () => google),
    ownerEstimates: vi.fn(async () => ({ complete: true, estimates: [{ account_ref: ACCOUNT, task_list_ref: 'list1', task_ref: 'task1', due_day: DAY, minutes: 20, evidence_ref: 'owner-confirmed-estimate1' }, { account_ref: ACCOUNT, task_list_ref: 'list1', task_ref: 'task2', due_day: DAY, minutes: 40, evidence_ref: 'owner-confirmed-estimate2' }] })),
    responses: vi.fn(async () => ({ complete: true, account_refs: [ACCOUNT], obligations: [{ id: 'response1', account_ref: ACCOUNT, revision: 2, state: 'requires_owner_response' as const, evidence_ref: 'canonical-response-evidence' }, { id: 'response2', account_ref: ACCOUNT, revision: 3, state: 'resolved' as const, evidence_ref: 'sent-readback-evidence' }] })),
  };
  return { host, google, saved, call, revoke: () => { revoked = true; }, bumpSource: () => { sourceRevision = 'grant2'; }, bumpEpoch: () => { epoch = 5; } };
};

describe('actual owner source demand suppliers', () => {
  it('unions actual free/busy intervals, exhausts Tasks pagination and records only explicit estimates and canonical response states', async () => {
    const f = fixture();
    const result = await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input);
    expect(result.ok).toBe(true);
    expect(f.saved.map(row => [row.metric, row.value])).toEqual([['calendar_minutes', 90], ['task_minutes', 60], ['message_count', 1]]);
    expect(f.google.tasksPage).toHaveBeenCalledTimes(2);
    expect(f.google.freeBusy).toHaveBeenCalledWith(`${DAY}T00:00:00.000Z`, '2026-10-11T00:00:00.000Z', ['primary'], 'UTC');
    expect(JSON.stringify(f.saved)).not.toContain('private first task');
    expect(JSON.stringify(result)).not.toContain('value');
    expect(f.saved[1]).toMatchObject({ estimate_refs: ['owner-confirmed-estimate1', 'owner-confirmed-estimate2'], connection_refs: [ACCOUNT] });
  });
  it('keeps missing estimates and unknown responsibility state null instead of inferring duration or treating unread as demand', async () => {
    const f = fixture();
    f.host = { ...f.host, ownerEstimates: async () => ({ complete: true, estimates: [] }), responses: async () => ({ complete: true, account_refs: [ACCOUNT], obligations: [{ id: 'response1', account_ref: ACCOUNT, revision: 1, state: 'unknown', evidence_ref: 'canonical1' }] }) };
    expect((await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input)).ok).toBe(true);
    expect(f.saved[1]).toMatchObject({ value: null, missing_reason: 'missing_owner_estimates' });
    expect(f.saved[2]).toMatchObject({ value: null, missing_reason: 'unknown_responsibility_state' });
  });
  it('records actual zero only when the query and canonical owner scope are complete', async () => {
    const f = fixture();
    f.host = { ...f.host, accounts: async () => [], ownerEstimates: async () => ({ complete: true, estimates: [] }), responses: async () => ({ complete: true, account_refs: [], obligations: [] }) };
    expect((await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input)).ok).toBe(true);
    expect(f.saved.map(row => [row.metric, row.value])).toEqual([['task_minutes', 0], ['message_count', 0]]);
    expect(f.saved).not.toContainEqual(expect.objectContaining({ metric: 'calendar_minutes' }));
    expect(f.google.freeBusy).not.toHaveBeenCalled();
  });
  it('does not claim full calendar or task coverage after per-calendar errors, cyclic pages or a wrong account', async () => {
    const f = fixture();
    vi.mocked(f.google.freeBusy).mockResolvedValue({ from: `${DAY}T00:00:00.000Z`, to: '2026-10-11T00:00:00.000Z', calendars: { primary: { busy: [], errors: [{ reason: 'forbidden' }] } } });
    vi.mocked(f.google.tasksPage!).mockResolvedValue({ tasks: [], task_list_ids: ['list1'], next_page_token: 'same', fetched_count: 0, account: { connection_id: 'b0000000-0000-4000-8000-000000000001', email: null }, observed_at: input.as_of });
    expect((await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input)).ok).toBe(true);
    expect(f.saved[0]).toMatchObject({ value: null, missing_reason: 'incomplete_query' });
    expect(f.saved[1]).toMatchObject({ value: null });
  });
  it('fences revocation during provider IO, source revision changes and consent epoch changes before durable admission', async () => {
    for (const change of ['revoke', 'source', 'epoch'] as const) {
      const f = fixture();
      const read = f.google.freeBusy;
      vi.mocked(f.google.freeBusy).mockImplementation(async (...args) => {
        const result = { from: args[0], to: args[1], calendars: { primary: { busy: [] } } };
        if (change === 'revoke') f.revoke(); else if (change === 'source') f.bumpSource(); else f.bumpEpoch();
        return result;
      });
      expect((await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input)).ok).toBe(false);
      expect(f.saved).toEqual([]);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
  it('returns no old numeric series after restart with unavailable source, and refuses another owner', async () => {
    const f = fixture();
    await createHealthDemandCollector(f.host, { now: () => NOW }).capture(input);
    const collector = createHealthDemandCollector({ ...f.host, assertCurrent: async () => { throw new Error('disconnected'); } }, { now: () => NOW });
    const physical_load = { current: null, history: [] };
    expect(await collector.supplemental({ ...input, owner_ref: 'owner-a', physical_load })).toEqual({});
    expect(await createHealthDemandCollector(f.host, { now: () => NOW }).supplemental({ ...input, owner_ref: 'other-owner', physical_load })).toEqual({});
  });
  it('keeps timezone and query cutoff in the baseline regime and supplies all three independent series', async () => {
    const f = fixture(), physical_load = { current: null, history: [] };
    const result = await createHealthDemandCollector(f.host, { now: () => NOW }).supplemental({ ...input, owner_ref: 'owner-a', physical_load });
    expect(result).toMatchObject({ weight: { calendar: { current: { value: 90 } }, tasks: { current: { value: 60 } }, messages: { current: { value: 1 } }, physical_load } });
    expect(f.saved.every(row => row.context_ref === 'day-demand.v1.UTC.1200')).toBe(true);
  });
  it('refuses to fabricate historical snapshots from current providers and reads only prior stored demand', async () => {
    const f = fixture(), collector = createHealthDemandCollector(f.host, { now: () => NOW });
    const previous = { ...input, day: '2026-10-09', as_of: '2026-10-09T12:00:00Z' };
    expect(await collector.capture(previous)).toEqual({ ok: false, error: 'invalid_request' });
    expect(f.saved).toEqual([]);
    const result = await collector.supplemental({ ...previous, owner_ref: 'owner-a', physical_load: { current: null, history: [] } });
    expect(result).toMatchObject({ weight: { calendar: { current: null }, tasks: { current: null }, messages: { current: null } } });
    expect(f.google.freeBusy).not.toHaveBeenCalled();
    expect(f.google.tasksPage).not.toHaveBeenCalled();
    expect(f.host.responses).not.toHaveBeenCalled();
  });
  it('returns no numeric input after an account revision changes during series readback', async () => {
    const f = fixture(), oldCall = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      const result = await oldCall(...args);
      if (args[2].p_operation === 'read') f.bumpSource();
      return result;
    });
    const result = await createHealthDemandCollector(f.host, { now: () => NOW }).supplemental({ ...input, owner_ref: 'owner-a', physical_load: { current: null, history: [] } });
    expect(result).toEqual({});
  });
  it('accepts a complete 25-hour civil-day busy query rather than rejecting real DST duration', async () => {
    const at = new Date('2026-11-01T17:00:00Z'), f = fixture(at);
    vi.mocked(f.google.freeBusy).mockImplementation(async (from, to) => ({ from, to, calendars: { primary: { busy: [{ start: from, end: to }] } } }));
    vi.mocked(f.google.tasksPage!).mockResolvedValue({ tasks: [], task_list_ids: ['list1'], next_page_token: null, fetched_count: 0, account: { connection_id: ACCOUNT, email: null }, observed_at: at.toISOString() });
    const capture = { ...input, day: '2026-11-01', timezone: 'America/New_York', as_of: at.toISOString() };
    expect((await createHealthDemandCollector(f.host, { now: () => at }).capture(capture)).ok).toBe(true);
    expect(f.saved[0]).toMatchObject({ metric: 'calendar_minutes', value: 1500 });
  });
  it('derives exact local dates across DST and rejects nonexistent dates without normalizing them', () => {
    expect(healthDemandDayBounds('2026-03-08', 'America/New_York')).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(healthDemandDayBounds('2026-11-01', 'America/New_York')).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    expect(() => healthDemandDayBounds('2026-02-30', 'UTC')).toThrow('invalid demand date');
    expect(() => healthDemandDayBounds('2011-12-30', 'Pacific/Apia')).toThrow('local demand date absent');
  });
});
