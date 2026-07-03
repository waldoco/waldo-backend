import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '../tools/permissions';
import { buildSessionState, sessionStateSchema, sessionToolAllowed } from './session';

const canaryTokens = ['0123456789abcdef', '1111111111111111', '2222222222222222'];

describe('sessionState', () => {
  it('builds a fresh trust envelope from the trigger ACL', () => {
    const session = buildSessionState({
      trigger: 'brief',
      canary_tokens: canaryTokens,
      started_at: 1_000,
    });

    expect(session.tool_permissions).toEqual(TOOL_PERMISSIONS.brief);
    expect(session.context).toBeNull();
    expect(session.iteration_count).toBe(0);
    expect(session.cost_spent).toBe(0);
    expect(session.pending_approvals).toEqual([]);
    expect(session.active_sandbox).toBeNull();
    expect(session.rate_limit_window).toEqual({ started_at: 1_000, tool_counts: {} });
  });

  it('does deny-first tool checks against the rebuilt ACL', () => {
    const session = buildSessionState({
      trigger: 'brief',
      canary_tokens: canaryTokens,
      started_at: 1_000,
    });

    expect(sessionToolAllowed(session, 'get_health')).toBe(true);
    expect(sessionToolAllowed(session, 'execute_code')).toBe(false);
  });

  it('rejects stale trust from a prior invocation', () => {
    const session = buildSessionState({
      trigger: 'user_message',
      canary_tokens: canaryTokens,
      started_at: 1_000,
    });

    expect(sessionStateSchema.safeParse({ ...session, context: { recalled: true } }).success).toBe(
      false,
    );
    expect(sessionStateSchema.safeParse({ ...session, iteration_count: 1 }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ ...session, cost_spent: 1 }).success).toBe(false);
    expect(
      sessionStateSchema.safeParse({ ...session, pending_approvals: ['approval-1'] }).success,
    ).toBe(false);
    expect(sessionStateSchema.safeParse({ ...session, active_sandbox: 'sandbox-1' }).success).toBe(
      false,
    );
  });

  it('rejects a permission slate that does not match the trigger', () => {
    const session = buildSessionState({
      trigger: 'brief',
      canary_tokens: canaryTokens,
      started_at: 1_000,
    });

    expect(
      sessionStateSchema.safeParse({
        ...session,
        tool_permissions: [...session.tool_permissions, 'execute_code'],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate canaries and replay/auth carryover fields', () => {
    expect(
      sessionStateSchema.safeParse({
        trigger: 'brief',
        tool_permissions: TOOL_PERMISSIONS.brief,
        canary_tokens: ['0123456789abcdef', '0123456789ABCDEF', '2222222222222222'],
        context: null,
        iteration_count: 0,
        cost_spent: 0,
        pending_approvals: [],
        active_sandbox: null,
        rate_limit_window: { started_at: 1_000, tool_counts: {} },
      }).success,
    ).toBe(false);

    const session = buildSessionState({
      trigger: 'brief',
      canary_tokens: canaryTokens,
      started_at: 1_000,
    });

    expect(
      sessionStateSchema.safeParse({ ...session, previous_session_id: 'session-1' }).success,
    ).toBe(false);
  });
});
