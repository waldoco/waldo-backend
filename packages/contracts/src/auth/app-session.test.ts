// Proposed wire shapes for app sign-in; the credential rail is not an owner decision yet, so the
// active result carries one opaque rotating credential and nothing rail-specific.
// Invariants under test: credentials exist only on an active result; not_activated, needs_invite
// and needs_phone_proof carry no token, session or device authority; the app session view is
// literally the app surface and never carries an owner routing name; refs must match the opaque
// identifier format (issuance and ownership are handler checks, not schema checks); revoke is idempotent and pending carries a reconciliation handle; rotation
// never moves the absolute expiry.
import { describe, expect, it } from 'vitest';
import {
  appCurrentSessionSchema,
  appRevokeRequestSchema,
  appRevokeResultSchema,
  appVerifyResultSchema,
  consoleSessionListItemSchema,
  rotatedExpiryHolds,
} from './app-session';

const session = {
  session_ref: 'sess_0123456789abcdef0123',
  account_ref: 'acct_0123456789abcdef0123',
  install_id: 'inst_0123456789abcdef0123',
  surface: 'app',
  absolute_expires_at: 2_000,
  idle_expires_at: 1_500,
  credential_expires_at: 1_200,
  renew_after: 1_000,
} as const;
const active = { status: 'active', credential: 'opaque-credential', session } as const;

describe('appVerifyResultSchema', () => {
  it('parses an active result', () => {
    expect(appVerifyResultSchema.safeParse(active).success).toBe(true);
  });
  it.each(['not_activated', 'needs_invite', 'needs_phone_proof'] as const)('%s parses bare', (status) => {
    expect(appVerifyResultSchema.safeParse({ status }).success).toBe(true);
  });
  it.each(['not_activated', 'needs_invite', 'needs_phone_proof'] as const)('%s carrying authority fails', (status) => {
    for (const extra of [{ credential: 'x' }, { access_token: 'x' }, { refresh_token: 'x' }, { device_authority: 'x' }, { session }]) {
      expect(appVerifyResultSchema.safeParse({ status, ...extra }).success).toBe(false);
    }
  });
  it('active without a credential fails', () => {
    const { credential: _drop, ...rest } = active;
    expect(appVerifyResultSchema.safeParse(rest).success).toBe(false);
  });
  it('active with a console session fails', () => {
    expect(appVerifyResultSchema.safeParse({ ...active, session: { ...session, surface: 'console' } }).success).toBe(false);
  });
  it('an unknown status fails', () => {
    expect(appVerifyResultSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});

describe('appCurrentSessionSchema', () => {
  it('parses the opaque view', () => {
    expect(appCurrentSessionSchema.safeParse(session).success).toBe(true);
  });
  it('rejects routing names and extra fields', () => {
    expect(appCurrentSessionSchema.safeParse({ ...session, do_name: 'owner-1' }).success).toBe(false);
    expect(appCurrentSessionSchema.safeParse({ ...session, owner_id: 'o1' }).success).toBe(false);
  });
  it.each(['account_ref', 'install_id', 'session_ref'] as const)('%s must match the opaque ref format', (field) => {
    const bad = [
      'owner-1',
      '5f0c9d66-3d52-4e1e-9d4c-0a1b2c3d4e5f',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      'acct_short',
      'acct_0123456789abcdef0123 ',
      '',
    ];
    for (const value of bad) expect(appCurrentSessionSchema.safeParse({ ...session, [field]: value }).success).toBe(false);
  });
  it('a ref cannot carry another kind prefix', () => {
    expect(appCurrentSessionSchema.safeParse({ ...session, account_ref: 'inst_0123456789abcdef0123' }).success).toBe(false);
  });
  it('requires an install on the app surface', () => {
    const { install_id: _drop, ...rest } = session;
    expect(appCurrentSessionSchema.safeParse(rest).success).toBe(false);
  });
  it('enforces ordering of renew, credential, idle and absolute times', () => {
    expect(appCurrentSessionSchema.safeParse({ ...session, idle_expires_at: 3_000 }).success).toBe(false);
    expect(appCurrentSessionSchema.safeParse({ ...session, credential_expires_at: 1_600 }).success).toBe(false);
    expect(appCurrentSessionSchema.safeParse({ ...session, renew_after: 1_300 }).success).toBe(false);
  });
  it('a console surface is not an app session', () => {
    expect(appCurrentSessionSchema.safeParse({ ...session, surface: 'console' }).success).toBe(false);
  });
});

describe('consoleSessionListItemSchema', () => {
  const item = { session_ref: 'sess_0123456789abcdef0123', surface: 'console', created_at: 1, last_seen_at: 2 };
  it('lists a console session without credentials', () => {
    expect(consoleSessionListItemSchema.safeParse(item).success).toBe(true);
    expect(consoleSessionListItemSchema.safeParse({ ...item, credential: 'x' }).success).toBe(false);
    expect(consoleSessionListItemSchema.safeParse({ ...item, surface: 'app' }).success).toBe(false);
  });
});

describe('revoke', () => {
  it('names the session by an opaque ref', () => {
    expect(appRevokeRequestSchema.safeParse({ session_ref: 'sess_0123456789abcdef0123' }).success).toBe(true);
    expect(appRevokeRequestSchema.safeParse({ session_ref: 'abc' }).success).toBe(false);
    expect(appRevokeRequestSchema.safeParse({}).success).toBe(false);
  });
  it('has revoked, already_gone and pending as distinct results', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'revoked', revoked_at: 1 }).success).toBe(true);
    expect(appRevokeResultSchema.safeParse({ status: 'already_gone' }).success).toBe(true);
    expect(appRevokeResultSchema.safeParse({ status: 'pending', reconcile_ref: 'recon_0123456789abcdef0123', retry_after_ms: 5_000 }).success).toBe(true);
  });
  it('pending needs its reconciliation handle and cannot claim a time', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(appRevokeResultSchema.safeParse({ status: 'pending', reconcile_ref: 'recon_0123456789abcdef0123', retry_after_ms: 1, revoked_at: 1 }).success).toBe(false);
  });
  it('revoked carries its time and already_gone carries none', () => {
    expect(appRevokeResultSchema.safeParse({ status: 'revoked' }).success).toBe(false);
    expect(appRevokeResultSchema.safeParse({ status: 'already_gone', revoked_at: 1 }).success).toBe(false);
  });
});

describe('rotatedExpiryHolds', () => {
  it('accepts a rotation that keeps the absolute expiry and changes the credential time', () => {
    expect(rotatedExpiryHolds(session, { ...session, credential_expires_at: 1_300, renew_after: 1_100 })).toBe(true);
  });
  it('rejects a rotation that moves the session to another account, install or surface', () => {
    expect(rotatedExpiryHolds(session, { ...session, account_ref: 'acct_ffffffffffffffffffff' })).toBe(false);
    expect(rotatedExpiryHolds(session, { ...session, install_id: 'inst_ffffffffffffffffffff' })).toBe(false);
    expect(rotatedExpiryHolds(session, { ...session, surface: 'console' } as never)).toBe(false);
  });
  it('rejects a rotation that moves the absolute expiry or changes the session ref', () => {
    expect(rotatedExpiryHolds(session, { ...session, absolute_expires_at: 2_500 })).toBe(false);
    expect(rotatedExpiryHolds(session, { ...session, absolute_expires_at: 1_900, idle_expires_at: 1_500 })).toBe(false);
    expect(rotatedExpiryHolds(session, { ...session, session_ref: 'sess_ffffffffffffffffffff' })).toBe(false);
  });
});
