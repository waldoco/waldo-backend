import { expect, it, vi } from 'vitest';
import { appPushDirectory } from '../src/rights/push-directory';
import { appIdentityErasure } from '../src/rights/identity-erasure';
import { appSessionAuthority } from '../src/identity/app-session-authority';

const config = { SUPABASE_PROJECT_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const owner = 'owner-do', session = 'a'.repeat(64), installation = '10000000-0000-4000-8000-000000000001';
const device = { installation_id: installation, provider: 'apns', environment: 'sandbox', device_epoch: 1, state: 'active', registered_at: 1000, delivery: 'native_ack_unverified' };
const register = { operation_id: 'register-operation-0001', installation_id: installation, provider: 'apns' as const, environment: 'sandbox' as const, token: 'synthetic-token-00000000', expected_device_epoch: 0 };
it('rejects a shape-valid push receipt for another installation, epoch, state or provider', async () => {
  for (const patch of [{ installation_id: crypto.randomUUID() }, { device_epoch: 2 }, { state: 'revoked' }, { provider: 'fcm' }, { environment: 'production' }]) {
    const fetcher = vi.fn(async () => Response.json({ device: { ...device, ...patch }, result: 'registered' }));
    await expect(appPushDirectory(config, owner, session, fetcher).register(register)).rejects.toThrow('rights_unavailable');
  }
});
it('rejects a shape-valid device revoke acknowledgment for the wrong installation, state or epoch', async () => {
  const revoked = { ...device, state: 'revoked', device_epoch: 2 };
  for (const patch of [{ installation_id: crypto.randomUUID() }, { device_epoch: 3 }, { state: 'active' }]) {
    const fetcher = vi.fn(async () => Response.json({ device: { ...revoked, ...patch }, result: 'revoked' }));
    await expect(appPushDirectory(config, owner, session, fetcher).revoke({ operation_id: 'revoke-operation-0001', installation_id: installation, expected_device_epoch: 1 })).rejects.toThrow('rights_unavailable');
  }
});
it('keeps real push tokens out of DTOs and signs their exact hash instead of the raw token', async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(init!.body as string); return Response.json({ device, result: 'registered' }); });
  const result = await appPushDirectory(config, owner, session, fetcher).register(register);
  expect(JSON.stringify(result)).not.toContain(register.token); expect(body?.p_token).toBe(register.token);
  expect(body?.p_do_name).toBe(owner); expect(body?.p_session_hash).toBe(session); expect(body?.p_sig).toMatch(/^[a-f0-9]{64}$/);
});
it('admits exact app-only owner sessions and refuses mismatched, expired, revoked or widened authority', async () => {
  const good = { owner_id: installation, do_name: owner, session_hash: session, state_version: 0, admission_revision: '1', expires_at: Date.now() + 60000 };
  expect(await appSessionAuthority(config, async () => Response.json(good))(owner, session)).toMatchObject({ ownerId: installation, doName: owner, revision: '0:1' });
  for (const bad of [null, { ...good, do_name: 'another-owner' }, { ...good, session_hash: 'b'.repeat(64) }, { ...good, expires_at: Date.now() - 1 }, { ...good, state_version: -1 }, { ...good, telegram_subject: 'forged' }]) {
    await expect(appSessionAuthority(config, async () => Response.json(bad))(owner, session)).rejects.toThrow(/app session (revoked|authority rejected)/);
  }
});
it('identity erasure requires exact reviewed receipt and independent auth/directory absence proof', async () => {
  const receipt = crypto.randomUUID(), result = { version: 'identity-erasure.v1', receipt_id: receipt, state: 'completed', auth_absent: true, directory_absent: true, public_identities_deleted: 1, auth_sessions_deleted: 2, retained: 'receipt_and_workspace_custody_only' };
  expect(await appIdentityErasure(config, owner, async () => Response.json(result)).erase(receipt)).toEqual(result);
  for (const bad of [{ ...result, receipt_id: crypto.randomUUID() }, { ...result, auth_absent: false }, { ...result, directory_absent: false }, { ...result, token: 'must-not-leak' }, null]) {
    await expect(appIdentityErasure(config, owner, async () => Response.json(bad)).erase(receipt)).rejects.toThrow('rights_unavailable');
  }
});
