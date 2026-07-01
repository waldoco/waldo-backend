import { describe, expect, it } from 'vitest';
import { errorCodeSchema, iso8601Schema } from './error';

describe('errorCode', () => {
  it('accepts the seven canonical codes', () => {
    expect(errorCodeSchema.options).toHaveLength(7);
    for (const code of errorCodeSchema.options) {
      expect(errorCodeSchema.parse(code)).toBe(code);
    }
  });

  it('rejects an unknown code', () => {
    expect(errorCodeSchema.safeParse('boom').success).toBe(false);
  });
});

describe('iso8601', () => {
  it('accepts an offset datetime', () => {
    expect(iso8601Schema.parse('2026-07-01T09:30:00Z')).toBe('2026-07-01T09:30:00Z');
    expect(iso8601Schema.safeParse('2026-07-01T09:30:00+05:30').success).toBe(true);
  });

  it('rejects a date without time and a non-date', () => {
    expect(iso8601Schema.safeParse('2026-07-01').success).toBe(false);
    expect(iso8601Schema.safeParse('not-a-date').success).toBe(false);
  });
});
