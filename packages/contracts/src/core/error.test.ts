import { describe, expect, it } from 'vitest';
import { RUNG_BLOCKED_FIX, TOOL_ERRORS, errorCodeSchema, iso8601Schema, rungBlockedOutcomeSchema, toolError, toolErrorCodeSchema, toolErrorSchema } from './error';

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

describe('a structured block', () => {
  it('names one of four blocks, each with a fix naming the next rung, and is never retryable as is', () => {
    expect(rungBlockedOutcomeSchema.options).toEqual(['challenge', 'login_required', 'js_required', 'device_offline']);
    expect(Object.keys(RUNG_BLOCKED_FIX).sort()).toEqual([...rungBlockedOutcomeSchema.options].sort());
    for (const blocked of rungBlockedOutcomeSchema.options) {
      const error = toolError('transient', 'The site asked for something.', blocked);
      expect(error).toEqual({ code: 'transient', cause: 'The site asked for something.', fix: RUNG_BLOCKED_FIX[blocked], retryable: false, blocked });
      expect(toolErrorSchema.safeParse(error).success).toBe(true);
    }
    expect(RUNG_BLOCKED_FIX.js_required).toContain('browse_page');
    expect(RUNG_BLOCKED_FIX.login_required).toMatch(/Never ask for a password/);
  });

  it('device_offline says nothing was sent, forbids claiming it was, and leaves the next step to the owner', () => {
    expect(RUNG_BLOCKED_FIX.device_offline).toMatch(/nothing was sent/i);
    expect(RUNG_BLOCKED_FIX.device_offline).toMatch(/do not say it was sent/i);
    expect(RUNG_BLOCKED_FIX.device_offline).toMatch(/ask again/i);
    expect(toolError('rejected', 'The Mac is offline.', 'device_offline')).toMatchObject({ code: 'rejected', retryable: false, blocked: 'device_offline' });
  });

  it('a result or error from before the Mac block still parses: the vocabulary only grew', () => {
    for (const blocked of ['challenge', 'login_required', 'js_required']) expect(toolErrorSchema.safeParse({ ...toolError('rejected'), blocked }).success).toBe(true);
    expect(toolErrorSchema.safeParse(toolError('rejected')).success).toBe(true);
  });

  it('rejects a block outside the vocabulary', () => {
    expect(toolErrorSchema.safeParse({ ...toolError('rejected'), blocked: 'captcha' }).success).toBe(false);
  });
});

describe('spend_ceiling_reached', () => {
  it('is a host-stage tool refusal in the one refusal shape, not retryable', () => {
    expect(toolErrorSchema.safeParse(toolError('spend_ceiling_reached')).success).toBe(true);
    expect(toolError('spend_ceiling_reached')).toMatchObject({ code: 'spend_ceiling_reached', retryable: false });
  });

  it('is not an adapter ErrorCode, so a handler cannot return it, and the refusal shape still rejects a missing fix', () => {
    expect(errorCodeSchema.safeParse('spend_ceiling_reached').success).toBe(false);
    const { fix: _fix, ...withoutFix } = toolError('spend_ceiling_reached');
    expect(toolErrorSchema.safeParse(withoutFix).success).toBe(false);
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
