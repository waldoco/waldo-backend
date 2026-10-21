import { TOOL_ERRORS } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { runHooks, HookHaltError, type HookRuntimeContext } from '../src/hooks/registry';

const ctx = (): HookRuntimeContext => ({
  authenticatedUserId: 'user-1',
  trigger: 'user_message',
  canaryTokens: ['1111111111111111', '2222222222222222', '3333333333333333'],
  now: () => 1_700_000_000_000,
  rateLimitCheck: () => true,
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise: ({ payload, source_taint }) => ({ ok: true, payload, source_taint, redactions: [] }),
});

describe('Tool-arg typed recovery', () => {
  it('the zod gate halts the exact live-failure args with a readable, actionable message', async () => {
    const c = ctx();
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-args' }, c);
    const error = await runHooks(
      'PreToolUse',
      { event: 'PreToolUse', tool: 'query_calendar', args: { date_range: { from: '2026-09-26T00:00', to: '2026-09-26T23:59' } } },
      c,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HookHaltError);
    const halt = error as HookHaltError;
    expect(halt.hook).toBe('tool_arg_zod_validate');
    expect(halt.code).toBe('invalid_args');
    expect(halt.clientMessage).toContain('date_range');
    expect(halt.clientMessage).toContain('offset');
    expect(halt.clientMessage).not.toBe('hook halted');
  });

  it('non-arg halts map to a catalogue cause, so security and infrastructure reasons never reach the model', () => {
    const expected = { forbidden: 'acl_denied', rate_limited: 'rate_limited', auth_failed: 'unauthenticated', transient: 'hook_failed' } as const;
    for (const code of ['forbidden', 'rate_limited', 'auth_failed', 'transient'] as const) {
      const halt = new HookHaltError('acl_check', 'tool outside trigger ACL', code);
      expect(halt.toolError.code).toBe(expected[code]);
      expect(halt.clientMessage).toBe(TOOL_ERRORS[expected[code]].cause);
      expect(halt.clientMessage).not.toContain('tool outside trigger ACL');
    }
  });

  it('an egress denial tells the model the address cannot be opened, without the host policy detail', () => {
    const halt = new HookHaltError('egress_allowlist_check', 'egress destination denied', 'forbidden');
    expect(halt.toolError.code).toBe('egress_denied');
    expect(halt.clientMessage).toBe(TOOL_ERRORS.egress_denied.cause);
    expect(halt.clientMessage).not.toContain('egress destination denied');
  });
});
