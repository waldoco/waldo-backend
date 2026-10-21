import { describe, expect, it } from 'vitest';
import { TOOL_ERRORS, errorCodeSchema, iso8601Schema, toolError, toolErrorCodeSchema, toolErrorSchema } from './error';

describe('toolError', () => {
  it('admits every adapter ErrorCode, so a tool result needs no translation', () => {
    for (const code of errorCodeSchema.options) expect(toolErrorCodeSchema.options).toContain(code);
  });

  it('has one catalogue entry per code and produces a valid ToolError', () => {
    expect(Object.keys(TOOL_ERRORS).sort()).toEqual([...toolErrorCodeSchema.options].sort());
    for (const code of toolErrorCodeSchema.options) expect(toolErrorSchema.safeParse(toolError(code)).success, code).toBe(true);
  });

  it('overrides only the cause; the fix and retryability stay the catalogue\'s', () => {
    expect(toolError('transient', 'provider timed out')).toEqual({ code: 'transient', cause: 'provider timed out', fix: TOOL_ERRORS.transient.fix, retryable: true });
    expect(toolError('invalid_args').cause).toBe(TOOL_ERRORS.invalid_args.cause);
  });
});

describe('errorCode', () => {
  it('is exactly the eight canonical codes, in order', () => {
    expect(errorCodeSchema.options).toEqual([
      'auth_failed',
      'not_found',
      'forbidden',
      'rate_limited',
      'transient',
      'oversize',
      'invalid_args',
      'rejected',
    ]);
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
