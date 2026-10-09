// Invariants under test: a sign-in verify result carries credentials only when the account is
// active; not_activated, needs_invite and needs_phone_proof can never carry a token or device
// authority; the current-session view never exposes an owner routing name; revoke reports an
// honest pending state; a session's absolute expiry never moves when it is rotated.
import { describe, expect, it } from 'vitest';
import {
  appCurrentSessionSchema,
  appRevokeResultSchema,
  appVerifyResultSchema,
  rotatedExpiryHolds,
} from './app-session';

const active = {
  status: 'active',
  access_token: 'opaque-access',
  refresh_token: 'opaque-refresh',
  session: { account_ref: 'acct_9f2c', surface: 'app', install_id: 'inst_1', absolute_expires_at: 2_000, idle_expires_at: 1_500 },
} as const;

describe('appVerifyResultSchema', () => {
  it('parses an active result with credentials', () => {
    expect(appVerifyResultSchema.safeParse(active).success).toBe(true);
  });
  it.each(['not_activated', 'needs_invite', 'needs_phone_proof'] as const)('%s parses without credentials', (status) => {
    expect(appVerifyResultSchema.safeParse({ status }).success).toBe(true);
  });
  it.each(['not_activated', 'needs_invite', 'needs_phone_proof'] as const)('%s carrying a token or device authority fails', (status) => {
    expect(appVerifyResultSchema.safeParse({ status, access_token: 'x' }).success).toBe(false);
    expect(appVerifyResultSchema.safeParse({ status, refresh_token: 'x' }).success).toBe(false);
    expect(appVerifyResultSchema.safeParse({ status, device_authority: 'x' }).success).toBe(false);
    expect(appVerifyResultSchema.safeParse({ status, session: active.session }).success).toBe(false);
  });
  it('active without a token fails', () => {
    const { access_token: _drop, ...rest } = active;
    expect(appVerifyResultSchema.safeParse(rest).success).toBe(false);
  });
  it('an unknown status fails', () => {
    expect(appVerifyResultSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});

describe('appCurrentSessionSchema', () => {
  const view = { account_ref: 'acct_9f2c', surface: 'app', install_id: 'inst_1', absolute_expires_at: 2_000, idle_expires_at: 1_500 };
  it('parses the opaque view', () => {
    expect(appCurrentSessionSchema.safeParse(view).success).toBe(true);
  });
  it('rejects an owner routing name', () => {
    expect(appCurrentSessionSchema.safeParse({ ...view, do_name: 'owner-1' }).success).toBe(false);
    expect(appCurrentSessionSchema.safeParse({ ...view, owner_id: 'o1' }).success).toBe(false);
  });
  it('rejects idle expiry after absolute expiry', () => {
    expect(appCurrentSessionSchema.safeParse({ ...view, idle_expires_at: 3_000 }).success).toBe(false);
  });
});

describe('appRevokeResultSchema', () => {
  it('reports revoked and pending as distinct states', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'revoked', revoked_at: 1 }).success).toBe(true);
    expect(appRevokeResultSchema.safeParse({ status: 'pending' }).success).toBe(true);
  });
  it('a pending result cannot claim a revocation time', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'pending', revoked_at: 1 }).success).toBe(false);
  });
  it('a revoked result carries its time', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'revoked', revoked_at: 1 }).success).toBe(true);
    expect(appRevokeResultSchema.safeParse({ status: 'revoked' }).success).toBe(false);
  });
});

describe('rotatedExpiryHolds', () => {
  it('accepts a rotation that keeps the absolute expiry', () => {
    expect(rotatedExpiryHolds({ absolute_expires_at: 2_000 }, { absolute_expires_at: 2_000 })).toBe(true);
  });
  it('rejects a rotation that moves it later or earlier', () => {
    expect(rotatedExpiryHolds({ absolute_expires_at: 2_000 }, { absolute_expires_at: 2_500 })).toBe(false);
    expect(rotatedExpiryHolds({ absolute_expires_at: 2_000 }, { absolute_expires_at: 1_900 })).toBe(false);
  });
});
