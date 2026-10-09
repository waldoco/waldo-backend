import type { SanitiseDestination, SanitiseInput } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise, sanitiseVerifyOnly } from '../src/scribe/sanitiser';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'] as const;
const run = (payload: SanitiseInput['payload'], destination: SanitiseDestination, source_taint: 'external' | null) =>
  sanitise({ payload, destination, canary_tokens: [...CANARIES], source_taint });

const structured = { metric: 'hrv', measurement: 58, unit: 'ms' };

describe('owner health readings reach the owner-bound model destinations', () => {
  it.each<SanitiseDestination>(['system_prompt', 'internal_context', 'owner_reply'])('structured readings pass %s when the source is the owner or the system', (destination) => {
    expect(run(structured, destination, null)).toMatchObject({ ok: true });
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
