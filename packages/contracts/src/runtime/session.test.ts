import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '../tools/permissions';
import { expectedSessionTools, hasExactTriggerAcl, sessionStateSchema } from './session';

const baseSession = {
  session_id: 'session-1',
  user_id: 'user-1',
  trigger: 'fetch_alert',
  canary_tokens: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'],
  authorized_tools: TOOL_PERMISSIONS.fetch_alert,
  pending_approval_ids: [],
  sandbox_tokens: [],
  created_at: 1_000,
  rebuilt_at: 1_001,
};

describe('expectedSessionTools', () => {
  it('projects authorization directly from TOOL_PERMISSIONS', () => {
    expect(expectedSessionTools('fetch_alert')).toBe(TOOL_PERMISSIONS.fetch_alert);
    expect(expectedSessionTools('user_message')).toBe(TOOL_PERMISSIONS.user_message);
  });
});

describe('hasExactTriggerAcl', () => {
  it('accepts the canonical trigger ACL in order', () => {
    expect(
      hasExactTriggerAcl({
        trigger: 'fetch_alert',
        authorized_tools: TOOL_PERMISSIONS.fetch_alert,
      }),
    ).toBe(true);
  });

  it('rejects missing, added, or reordered tools', () => {
    expect(
      hasExactTriggerAcl({
        trigger: 'fetch_alert',
        authorized_tools: TOOL_PERMISSIONS.fetch_alert.slice(1),
      }),
    ).toBe(false);
    expect(
      hasExactTriggerAcl({
        trigger: 'fetch_alert',
        authorized_tools: [...TOOL_PERMISSIONS.fetch_alert, 'search_tools'],
      }),
    ).toBe(false);
    expect(
      hasExactTriggerAcl({
        trigger: 'fetch_alert',
        authorized_tools: [...TOOL_PERMISSIONS.fetch_alert].reverse(),
      }),
    ).toBe(false);
  });
});

describe('sessionState', () => {
  it('accepts a freshly rebuilt session with exact trigger authorization', () => {
    expect(sessionStateSchema.safeParse(baseSession).success).toBe(true);
  });

  it('rejects stale pending approvals on rebuild', () => {
    expect(
      sessionStateSchema.safeParse({
        ...baseSession,
        pending_approval_ids: ['approval-1'],
      }).success,
    ).toBe(false);
  });

  it('rejects stale sandbox authority on rebuild', () => {
    expect(
      sessionStateSchema.safeParse({
        ...baseSession,
        sandbox_tokens: ['sandbox-1'],
      }).success,
    ).toBe(false);
  });

  it('rejects stale authorization from another trigger', () => {
    expect(
      sessionStateSchema.safeParse({
        ...baseSession,
        trigger: 'fetch_alert',
        authorized_tools: TOOL_PERMISSIONS.user_message,
      }).success,
    ).toBe(false);
  });

  it('reuses the canonical three-canary contract', () => {
    expect(
      sessionStateSchema.safeParse({
        ...baseSession,
        canary_tokens: ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'cccccccccccccccc'],
      }).success,
    ).toBe(false);
  });
});
