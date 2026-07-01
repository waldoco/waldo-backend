import { describe, expect, it } from 'vitest';
import { briefVariantSchema, canaryTokensSchema, triggerTypeSchema } from './trigger';

const hex = (c: string): string => c.repeat(16).slice(0, 16);

describe('triggerType', () => {
  it('holds the eleven canonical triggers incl. pre_activity_spot', () => {
    expect(triggerTypeSchema.options).toHaveLength(11);
    expect(triggerTypeSchema.safeParse('pre_activity_spot').success).toBe(true);
  });

  it('rejects a retired/unknown trigger', () => {
    expect(triggerTypeSchema.safeParse('morning_wag').success).toBe(false);
  });
});

describe('briefVariant', () => {
  it('rejects an unknown variant', () => {
    expect(briefVariantSchema.safeParse('night').success).toBe(false);
  });
});

describe('canaryTokens', () => {
  it('accepts three unique 16-char hex tokens', () => {
    const tokens = ['a', 'b', 'c'].map(hex);
    expect(canaryTokensSchema.parse(tokens)).toEqual(tokens);
  });

  it('rejects the wrong count', () => {
    expect(canaryTokensSchema.safeParse([hex('a'), hex('b')]).success).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(canaryTokensSchema.safeParse([hex('a'), hex('a'), hex('b')]).success).toBe(false);
  });

  it('rejects a non-hex token', () => {
    expect(canaryTokensSchema.safeParse(['zz', hex('b'), hex('c')]).success).toBe(false);
  });
});
