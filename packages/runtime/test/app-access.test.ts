import { describe, expect, it, vi } from 'vitest';
import { appAccessRequest, appStoredProfile, appProfileContext, type AppAccessHost } from '../src/channels/app-access';
import { appAccessAccountsV1Schema, appOnboardingV1Schema, appProfileV1Schema } from '../../contracts/src/app/access';
import { GOOGLE_FEATURE_SCOPES } from '../src/connectors/google';

const fixture = () => {
  const values = new Map<string, unknown>(); let live = true, firstValueRef: string | null = null, sourceRevision = 0;
  const host: AppAccessHost = { accountRef: `acct_${'a'.repeat(64)}`, sessionHash: 'b'.repeat(64), storage: { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key, value) => { values.set(key, structuredClone(value)); } },
    now: () => 1000, assertCurrent: async () => { if (!live) throw Error('revoked'); }, rateLimit: async () => true,
    commit: work => { if (!live) throw Error('revoked'); const prior = new Map(values); try { return work(); } catch (error) { values.clear(); prior.forEach((value, key) => values.set(key, value)); throw error; } },
    profileChanged: vi.fn(() => { sourceRevision += 1; }), sourceRevision: () => sourceRevision,
    googleConfigured: () => true, googleAccounts: async () => [{ id: 'connection-a', email: 'a@example.invalid', scopes: GOOGLE_FEATURE_SCOPES.mail, error: null }, { id: 'connection-b', email: 'b@example.invalid', scopes: GOOGLE_FEATURE_SCOPES.tasks, error: 'invalid_grant' }],
    connect: vi.fn(async args => ({ url: 'https://app.invalid/c/abcdefghijklmnopqrstuv', expires_at: 2000, connection_ref: args.connection_ref ?? null })),
    disconnect: vi.fn(async () => true), forgetDerived: vi.fn(async () => 'recorded' as const),
    sessions: async () => [{ session_ref: `sess_${'b'.repeat(64)}`, current: true, created_at: 0, last_seen_at: 1000, absolute_expires_at: 2000 }],
    revokeSession: vi.fn(async () => true), onboardingEvidence: async () => ({ firstValueRef, steps: {} }),
  };
  return { host, revoke: () => { live = false; }, evidence: (ref: string) => { firstValueRef = ref; } };
};
const request = (path: string, body?: unknown) => new Request(`https://app.invalid${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = async (host: AppAccessHost, path: string, body?: unknown) => (await appAccessRequest(request(path, body), host))!;
describe('typed authenticated owner access', () => {
  it('durably saves explicit profile under CAS, feeds context and reconciles an identical operation after restart', async () => {
    const f = fixture(), args = { operation_id: 'profile-save-0001', expected_revision: 0, preferences: { name: 'Actual owner', about: 'Vegetarian', timezone: 'Asia/Kolkata', wake_time: '07:00', autonomy_preference: 'scoped' } };
    const receipt = await (await call(f.host, '/app/v1/profile', args)).json();
    const readback = appProfileV1Schema.parse(await (await call(f.host, '/app/v1/profile')).json());
    expect(readback.revision).toBe(1); expect(readback.preferences).toEqual(args.preferences); expect(readback.authority).toBe('preferences_only'); expect(appProfileContext(readback)).toContain('Vegetarian'); expect(f.host.profileChanged).toHaveBeenCalledTimes(1);
    expect(await (await call({ ...f.host }, '/app/v1/profile', args)).json()).toEqual(receipt);
    expect(await (await call(f.host, '/app/v1/access/operations/profile-save-0001')).json()).toEqual(receipt);
    const nextSession = { ...f.host, sessionHash: 'c'.repeat(64) };
    expect(await (await call(nextSession, '/app/v1/access/operations/profile-save-0001')).json()).toEqual(receipt);
    expect((await call(nextSession, '/app/v1/profile', args)).status).toBe(409);
    expect((await call(f.host, '/app/v1/profile', { ...args, preferences: { name: 'changed' } })).status).toBe(409);
    expect((await call(f.host, '/app/v1/profile', { ...args, operation_id: 'profile-save-0002' })).status).toBe(409);
    expect(f.host.sourceRevision()).toBe(1);
  });
  it('validates timezone, origin, admission and atomic rollback before durable profile state', async () => {
    const f = fixture(), args = { operation_id: 'profile-save-0001', expected_revision: 0, preferences: { timezone: 'Not/A_Zone' } };
    expect((await call(f.host, '/app/v1/profile', args)).status).toBe(400); expect(appStoredProfile(f.host).revision).toBe(0);
    const cross = request('/app/v1/profile', { ...args, preferences: { name: 'Owner' } }); cross.headers.set('origin', 'https://evil.invalid'); expect((await appAccessRequest(cross, f.host))?.status).toBe(403);
    f.host.profileChanged = () => { throw Error('atomic host unavailable'); }; expect((await call(f.host, '/app/v1/profile', { ...args, preferences: { name: 'Owner' } })).status).toBe(503); expect(appStoredProfile(f.host).revision).toBe(0);
    f.revoke(); expect((await call(f.host, '/app/v1/profile')).status).toBe(503);
  });
  it('exposes all progressive steps without fabricated legal, health or first-value completion', async () => {
    const f = fixture(); let setup = appOnboardingV1Schema.parse(await (await call(f.host, '/app/v1/onboarding')).json());
    expect(setup.steps).toHaveLength(17); expect(setup.setup_state).toBe('new'); expect(setup.required_steps).toEqual([]); expect(setup.first_value.state).toBe('pending');
    await call(f.host, '/app/v1/onboarding', { operation_id: 'onboarding-visit-01', expected_revision: 0, step: 'legal', disposition: 'visit' });
    setup = appOnboardingV1Schema.parse(await (await call(f.host, '/app/v1/onboarding')).json()); expect(setup.steps.find(row => row.step === 'legal')?.state).toBe('visited'); expect(setup.first_value.state).toBe('pending');
    f.evidence('actual-completed-owner-message'); setup = appOnboardingV1Schema.parse(await (await call(f.host, '/app/v1/onboarding')).json()); expect(setup.setup_state).toBe('first_value_observed'); expect(setup.first_value.evidence_ref).toBe('actual-completed-owner-message');
  });
  it('lists actual multiple accounts, feature scopes and server sessions without credentials', async () => {
    const f = fixture(), response = await call(f.host, '/app/v1/access/accounts'), text = await response.text(), accounts = appAccessAccountsV1Schema.parse(JSON.parse(text));
    expect(accounts.accounts).toHaveLength(2); expect(accounts.accounts[0]?.grants.find(row => row.feature === 'mail')?.read).toBe('granted'); expect(accounts.accounts[0]?.grants.find(row => row.feature === 'tasks')?.read).toBe('missing'); expect(accounts.accounts[1]?.grants.find(row => row.feature === 'tasks')?.read).toBe('reauth_required'); expect(text).not.toContain('token');
    expect((await call(f.host, '/app/v1/access/sessions')).status).toBe(200);
  });
  it('binds reconnect to owned connection and a first-party expiring handoff; uncertain I/O is never replayed', async () => {
    const f = fixture(), args = { operation_id: 'connect-operation-01', provider: 'google', mode: 'reauth', feature: 'mail', connection_ref: 'connection-a' };
    const receipt = await (await call(f.host, '/app/v1/access/connect', args)).json() as { handoff: { connection_ref: string }; state: string };
    expect(receipt.state).toBe('recorded'); expect(receipt.handoff.connection_ref).toBe('connection-a');
    expect(await (await call(f.host, '/app/v1/access/connect', args)).json()).toEqual(receipt); expect(f.host.connect).toHaveBeenCalledTimes(1);
    expect((await (await call(f.host, '/app/v1/access/connect', { ...args, operation_id: 'connect-operation-02', connection_ref: 'foreign' })).json() as { state: string }).state).toBe('rejected');
    f.host.connect = vi.fn(async () => { throw Error('lost response'); }); const uncertain = { ...args, operation_id: 'connect-operation-03' }; expect((await (await call(f.host, '/app/v1/access/connect', uncertain)).json() as { state: string }).state).toBe('unconfirmed'); await call(f.host, '/app/v1/access/connect', uncertain); expect(f.host.connect).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch disconnect/forget for a foreign connection or stale source revision', async () => {
    const f = fixture(); await call(f.host, '/app/v1/access/disconnect', { operation_id: 'disconnect-operation-01', connection_ref: 'foreign' }); expect(f.host.disconnect).not.toHaveBeenCalled();
    await call(f.host, '/app/v1/access/forget-derived', { operation_id: 'forget-operation-01', connection_ref: 'connection-a', expected_source_revision: 99 }); expect(f.host.forgetDerived).not.toHaveBeenCalled();
    const result = await (await call(f.host, '/app/v1/access/forget-derived', { operation_id: 'forget-operation-02', connection_ref: 'connection-a', expected_source_revision: 0 })).json() as { state: string }; expect(result.state).toBe('recorded'); expect(f.host.forgetDerived).toHaveBeenCalledTimes(1);
  });
});
