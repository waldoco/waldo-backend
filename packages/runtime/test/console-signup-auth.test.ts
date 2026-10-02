import { describe, expect, it, vi } from 'vitest';
import { routerSignature } from '../src/identity/owner-directory';
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

it('denies access before sending or verifying an OTP when eligibility returns false (invite states are tested against canonical SQL)', async () => {
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

it('uses readable signed bearer progress that can be copied until expiry, without raw OTP or session tokens', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user: { id: 'u', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' }, access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })).mockResolvedValueOnce(json(true));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const draft = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  const emailProof = (await auth.verifyEmail(draft, '654321'))!;
  const cookie = (await auth.collectPhone((await auth.read(request(emailProof)))!, '+14155550100'))!;
  const payload = atob(cookie.split('.')[0]!.replaceAll('-', '+').replaceAll('_', '/'));
  expect(JSON.parse(payload)).toMatchObject({ email: 'person@example.com', phone: '+14155550100', inviteHash: expect.stringMatching(/^[0-9a-f]{64}$/), complete: false });
  for (const absent of ['654321', 'synthetic-access', 'synthetic-refresh', 'ABCDEFGHJKLMNPQRSTUV']) expect(payload).not.toContain(absent);
  expect(await auth.read(new Request('https://w.test/console/signup', { headers: { cookie: `${SIGNUP_COOKIE}=${cookie}`, 'user-agent': 'another-synthetic-browser' } }))).toMatchObject({ emailVerified: true, phoneVerification: 'not_configured', complete: false });
});

it('completes a verified invite without phone using a distinct signed admission RPC', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({ user: { id: 'auth-1', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' } })).mockResolvedValueOnce(json('owner-new'));
  const auth = signupAuth(env, fetcher as typeof fetch, now)!;
  const draft = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  const verified = (await auth.read(request((await auth.verifyEmail(draft, '123456'))!)))!;
  expect(await auth.complete(verified, '')).toBe('owner-new');
  expect(String(fetcher.mock.calls[2]![0])).toBe('https://db.test/rest/v1/rpc/signup_owner_for_auth');
  expect(JSON.parse(String(fetcher.mock.calls[2]![1].body))).toMatchObject({ p_auth_user: 'auth-1', p_email: 'person@example.com', p_phone: '', p_code_hash: verified.inviteHash });
});

it('fails closed without confirmed progress or after expiry and never uses phone as an identity key', async () => {
  let clock = now();
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json('owner-new'));
  const auth = signupAuth(env, fetcher as typeof fetch, () => clock)!;
  const initial = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.complete(initial, '+14155550100')).toBeNull();
  const proof = { ...initial, emailVerified: true, authUser: 'auth-1' };
  expect(await auth.complete(proof, 'bad')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await auth.complete(proof, '+14155550100')).toBe('owner-new');
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body).toMatchObject({ p_auth_user: 'auth-1', p_email: 'person@example.com', p_phone: '+14155550100' });
  expect(body).not.toHaveProperty('phone_verified_at');
  expect(body.p_sig).toBe(await routerSignature(env.WALDO_ROUTER_HMAC_SECRET, Math.floor(now() / 1000), `signup.owner.auth-1.person@example.com.+14155550100.${initial.inviteHash}`));
  clock = initial.expires * 1000;
  expect(await auth.complete(proof, '')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([null, false, true, {}])('rejects non-owner admission replies (%j)', async reply => {
  const auth = signupAuth(env, vi.fn(async () => json(reply)) as typeof fetch, now)!;
  const p = (await auth.read(request(await auth.begin('person@example.com', 'ABCDEFGHJKLMNPQRSTUV'))))!;
  expect(await auth.complete({ ...p, authUser: 'auth-1', emailVerified: true }, '')).toBeNull();
});
