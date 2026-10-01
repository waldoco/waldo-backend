import { describe, expect, it, vi } from 'vitest';
import { signupAuth, SIGNUP_COOKIE } from '../src/identity/console-signup';
const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'test-router' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const request = (cookie: string) => new Request('https://w.test/console/signup', { headers: { cookie: `${SIGNUP_COOKIE}=${cookie}` } });
describe('verified email signup continuation', () => {
  it('verifies email without provisioning, stores only the invite hash and resumes pending phone', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user: { id: 'auth-1', email: 'person@example.com', email_confirmed_at: '2026-10-01T00:00:00Z' } }));
    const auth = signupAuth(env, fetcher as typeof fetch, () => 1_800_000_000_000)!;
    const draft = await auth.begin('Person@example.com', 'ABCDEFGHJKLMNPQRSTUV');
    const cookie = await auth.verifyEmail((await auth.read(request(draft)))!, '123456');
    expect(cookie).toBeTruthy();
    expect(await auth.read(request(cookie!))).toMatchObject({ email: 'person@example.com', authUser: 'auth-1', phone: null, phoneVerification: 'not_configured', complete: false });
    expect(cookie).not.toContain('ABCDEFGHJKLMNPQRSTUV');
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(['https://db.test/rest/v1/rpc/signin_allowed', 'https://db.test/auth/v1/verify']);
  });
});

it.each(['expired', 'revoked', 'used', 'wrong-email'])('denies a %s invite before sending or verifying an OTP', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => json(false));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const progress = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.sendCode(progress)).toBe(false);
  expect(await auth.verifyEmail(progress, '123456')).toBeNull();
  expect(fetcher.mock.calls.map(c => c[0])).toEqual(['https://db.test/rest/v1/rpc/signin_allowed', 'https://db.test/rest/v1/rpc/signin_allowed']);
});
const now = () => 1_800_000_000_000;
it.each([
  { id: 'other', email: 'other@example.com', email_confirmed_at: '2026-10-01Z' },
  { id: 'person', email: 'person@example.com' },
  { email: 'person@example.com', email_confirmed_at: '2026-10-01Z' },
])('requires the verified auth identity and matching email: %j', async user => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user }));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const p = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.verifyEmail(p, '123456')).toBeNull();
});
it('rejects tampered/oversize cookies and exact expiry; pending never extends the original deadline', async () => {
  let clock = now();
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user: { id: 'u', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' } })).mockResolvedValueOnce(json(true));
  const auth = signupAuth(env, fetcher as typeof fetch, () => clock)!;
  const draft = await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV');
  expect(await auth.read(request(draft.replace(/^./, 'Z')))).toBeNull();
  expect(await auth.read(request('A'.repeat(3000)))).toBeNull();
  const initial = (await auth.read(request(draft)))!;
  clock += 300_000;
  const proof = await auth.verifyEmail(initial, '123456');
  const p = (await auth.read(request(proof!)))!;
  const phone = await auth.collectPhone(p, '+14155550100');
  expect(await auth.read(request(phone!))).toMatchObject({ emailVerified: true, phone: '+14155550100', phoneVerification: 'not_configured', complete: false, expires: initial.expires });
  expect(fetcher.mock.calls.every(c => !String(c[0]).includes('owner_for_auth'))).toBe(true);
  clock = initial.expires * 1000;
  expect(await auth.read(request(phone!))).toBeNull();
});
it('refuses phone before email proof and rechecks eligibility after proof (including revocation)', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user: { id: 'u', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' } })).mockResolvedValueOnce(json(false));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const initial = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.collectPhone(initial, '+14155550100')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  const proof = await auth.verifyEmail(initial, '123456');
  expect(await auth.collectPhone((await auth.read(request(proof!)))!, '+14155550100')).toBeNull();
});
it('supports resend with a hash, never leaking raw invite or Supabase session tokens to continuation', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({}));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const initial = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.sendCode(initial)).toBe(true);
  expect(await auth.sendCode(initial)).toBe(true);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  expect(fetcher.mock.calls.filter(c => String(c[0]).endsWith('/otp'))).toHaveLength(2);
});
