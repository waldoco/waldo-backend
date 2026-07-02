import { describe, expect, it } from 'vitest';
import { admissionVerdictSchema, loopPolicySchema } from './loop-policy';

describe('governor verdict', () => {
  it('is exactly admit | deny', () => {
    expect(admissionVerdictSchema.options).toEqual(['admit', 'deny']);
  });

  it('rejects an out-of-domain verdict', () => {
    expect(admissionVerdictSchema.safeParse('defer').success).toBe(false);
  });
});

describe('loopPolicy', () => {
  it('accepts a minimal policy', () => {
    expect(loopPolicySchema.safeParse({ name: 'tracer', admit: true }).success).toBe(true);
  });

  it('rejects extra fields (strict) and a missing name', () => {
    expect(
      loopPolicySchema.safeParse({ name: 'tracer', admit: true, priority: 1 }).success,
    ).toBe(false);
    expect(loopPolicySchema.safeParse({ admit: true }).success).toBe(false);
  });
});
