import type { SanitiseDestination, SanitiseInput } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise, sanitiseVerifyOnly } from '../src/scribe/sanitiser';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;
const run = (payload: SanitiseInput['payload'], destination: SanitiseDestination, source_taint: 'external' | null) =>
  sanitise({ payload, destination, canary_tokens: [...CANARIES], source_taint });

const structured = { metric: 'hrv', measurement: 58, unit: 'ms' };

describe('owner health readings reach the owner-bound model destinations', () => {
  it('structured readings pass internal_context when the source is the owner or the system', () => {
    expect(run(structured, 'internal_context', null)).toMatchObject({ ok: true });
  });

  it.each<SanitiseDestination>(['system_prompt', 'owner_reply'])('text readings pass %s when the source is the owner or the system', (destination) => {
    expect(run('Resting HR 52 bpm, HRV 58 ms, slept 6h 10m', destination, null)).toMatchObject({ ok: true });
  });

  it('the final prompt verify pass accepts the same readings', () => {
    const result = sanitiseVerifyOnly({ payload: 'HRV 58 ms, resting HR 52 bpm', destination: 'system_prompt', canary_tokens: [...CANARIES], source_taint: null });
    expect(result).toMatchObject({ ok: true });
  });

  it.each<SanitiseDestination>(['send_message', 'draft_email', 'draft_document', 'audit_log', 'r2_summary', 'outbox', 'memory_block'])('%s still denies readings', (destination) => {
    expect(run(structured, destination, null)).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
  });

  it('externally tainted structured readings stay denied even at model destinations', () => {
    expect(run(structured, 'internal_context', 'external')).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
  });

  it('secrets and canaries still deny at the owner-bound destinations', () => {
    expect(run('HRV 58 ms 1111111111111111', 'owner_reply', null)).toMatchObject({ ok: false, check: 'canary_token' });
  });
});

describe('recovery.v1 derived view', () => {
  const view = {
    authority: 'backend',
    algorithm_version: 'recovery.v1',
    recovery_zone: 'mixed',
    trend: 'steady',
    freshness: 'fresh',
    missing_components: [],
    confidence_band: 'high',
    provenance_refs: ['hpr_0123456789abcdef0123456789abcdef'],
    destination_eligibility: ['trigger_prompt', 'volatile_run', 'runtime_trace'],
  };

  it('is recognised as a derived view at the model destinations and the trace', () => {
    expect(run(view, 'internal_context', null)).toMatchObject({ ok: true });
    expect(run(view, 'audit_log', null)).toMatchObject({ ok: true });
  });

  it('is denied where it is not eligible, even for the owner', () => {
    expect(run({ ...view, destination_eligibility: ['trigger_prompt'] }, 'audit_log', null)).toMatchObject({ ok: false, check: 'health_value' });
    expect(run(view, 'send_message', null)).toMatchObject({ ok: false, check: 'health_value' });
  });

  it('a view that carries a raw field is not a view and is denied outside the owner destinations', () => {
    expect(run({ ...view, recovery_score: 41 }, 'audit_log', null)).toMatchObject({ ok: false, check: 'health_value' });
  });
});
