import { describe, expect, it } from 'vitest';
import { lintClaimsAgainstVerification, type TurnStep } from '../src/hooks/claim-verify-lint';

const VERIFIERS = ['read_owner_context', 'query_calendar', 'search_communication'] as const;
const call = (name: string, ok = true): TurnStep => ({ kind: 'tool_call', name, ok });
const reply = (text: string): TurnStep => ({ kind: 'reply', text });

describe('claim-after-fresh-verification lint (advisory)', () => {
  it('flags a completion claim with no verification call earlier in the turn', () => {
    const out = lintClaimsAgainstVerification([reply('Done, I saved that to your calendar.')], VERIFIERS);
    expect(out).toEqual([{ step: 0, claim: 'saved', reason: 'no_verification_before_claim' }]);
  });
  it('passes when a successful verifier ran before the claim', () => {
    expect(lintClaimsAgainstVerification([call('query_calendar'), reply('I scheduled it and confirmed it is on your calendar.')], VERIFIERS)).toEqual([]);
  });
  it('a failed verifier or one that runs only after the claim does not count', () => {
    expect(lintClaimsAgainstVerification([call('query_calendar', false), reply('It was booked.')], VERIFIERS)).toHaveLength(1);
    expect(lintClaimsAgainstVerification([reply('It was booked.'), call('query_calendar')], VERIFIERS)).toHaveLength(1);
  });
  it('ignores replies with no completion claim, and negated or question forms', () => {
    expect(lintClaimsAgainstVerification([reply('Want me to save this?')], VERIFIERS)).toEqual([]);
    expect(lintClaimsAgainstVerification([reply("I couldn't send it, nothing was sent.")], VERIFIERS)).toEqual([]);
    expect(lintClaimsAgainstVerification([reply('Here are your three options.')], VERIFIERS)).toEqual([]);
  });
  it('unknown verifier list fails closed: every claim is flagged', () => {
    expect(lintClaimsAgainstVerification([call('query_calendar'), reply('Saved.')], [])).toHaveLength(1);
  });
});
