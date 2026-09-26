import { SANITISE_DESTINATION_POLICIES } from '@waldo/contracts';
import type { SanitiseInput } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';

const CEILING = SANITISE_DESTINATION_POLICIES.internal_context.max_chars;
const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'];

const input = (payload: unknown, override?: number): SanitiseInput => ({
  payload: payload as SanitiseInput['payload'],
  destination: 'internal_context',
  canary_tokens: CANARIES,
  source_taint: null,
  ...(override === undefined ? {} : { max_chars_override: override }),
});

const sizedPayload = (chars: number) => ({ text: 'a'.repeat(chars) });

describe('scribe max_chars_override (dynamic per-model budget, tighten-only)', () => {
  it('payload under the wire ceiling passes with no override (today\'s behavior)', () => {
    const result = sanitise(input(sizedPayload(CEILING - 2_000)));
    expect(result.ok).toBe(true);
  });

  it('payload over the wire ceiling denies with no override', () => {
    const result = sanitise(input(sizedPayload(CEILING + 2_000)));
    expect(result).toEqual({ ok: false, check: 'size_cap', reason: 'oversize' });
  });

  it('override below the ceiling tightens: payload between override and ceiling now denies', () => {
    const override = 4_096;
    const result = sanitise(input(sizedPayload(override + 2_000), override));
    expect(result).toEqual({ ok: false, check: 'size_cap', reason: 'oversize' });
  });

  it('override below the ceiling still passes a payload under the override', () => {
    const override = 4_096;
    const result = sanitise(input(sizedPayload(override - 2_000), override));
    expect(result.ok).toBe(true);
  });

  it('override above the ceiling never loosens: ceiling still binds', () => {
    const result = sanitise(input(sizedPayload(CEILING + 2_000), CEILING * 4));
    expect(result).toEqual({ ok: false, check: 'size_cap', reason: 'oversize' });
  });
});
