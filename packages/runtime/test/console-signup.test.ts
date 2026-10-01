import { describe, expect, it, vi } from 'vitest';
import { handleSignup } from '../src/channels/console-signup';
import { signupAuth, SIGNUP_COOKIE } from '../src/identity/console-signup';
import type { ConsoleAuth } from '../src/identity/console-auth';
const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'test-router', RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit };
const consoleAuth = { sendCode: vi.fn(async () => true), throttle: vi.fn(async () => true) } as unknown as ConsoleAuth;
describe('signup entry', () => {
  it.each(['GET', 'HEAD'])('serves %s without OTP, invite reads or consumption', async method => {
    const fetcher = vi.fn();
    const response = await handleSignup(new Request('https://w.test/console/signup', { method }), env, consoleAuth, signupAuth(env, fetcher)!);
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(fetcher).not.toHaveBeenCalled();
    expect(consoleAuth.sendCode).not.toHaveBeenCalled();
    if (method === 'GET') {
      const html = await response.text();
      expect(html).toContain('<label for="email">');
      expect(html).toContain('history.replaceState');
      expect(html).toContain("addEventListener('hashchange'");
      expect(html).not.toMatch(/src="https?:/);
    }
  });
});

const cookieFrom = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!;
const post = (path: string, values: Record<string, string>, cookie = '', origin = 'https://w.test') => new Request(`https://w.test/console/signup${path}`, { method: 'POST', headers: { origin, cookie }, body: new URLSearchParams(values) });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const setup = () => {
  let allowed = true;
  let providerStatus = 200;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/rpc/') ? json(allowed) : String(input).endsWith('/verify') ? json({ user: { id: 'u-1', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' }, access_token: 'never-retain', refresh_token: 'never-retain' }, providerStatus) : json({}, providerStatus));
  const signup = signupAuth(env, fetcher)!;
  const a = { ...consoleAuth, throttle: vi.fn(async () => true) } as ConsoleAuth;
  return { signup, a, fetcher, revoke: () => { allowed = false; }, fail: (status = 500) => { providerStatus = status; } };
};
const start = async (s: ReturnType<typeof setup>) => {
  const response = await handleSignup(post('/send', { email: 'Person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), env, s.a, s.signup);
  expect(response.status).toBe(303);
  const cookie = cookieFrom(response);
  const progress = (await s.signup.read(new Request('https://w.test/console/signup', { headers: { cookie } })))!;
  return { cookie, progress };
};
it('continues through email, phone pending, resend, refresh and repeated submit without an owner or consumption', async () => {
  const s = setup();
  const { cookie, progress } = await start(s);
  const retry = await handleSignup(post('/resend', { csrf: progress.csrf, email: 'attacker@example.com' }, cookie), env, s.a, s.signup);
  expect(await retry.text()).toContain('another email code');
  expect(s.fetcher.mock.calls.filter(c => String(c[0]).endsWith('/otp'))).toHaveLength(2);
  const verified = await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, s.signup);
  expect(verified.status).toBe(303);
  const verifiedCookie = cookieFrom(verified);
  const phoneForm = await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: verifiedCookie } }), env, s.a, s.signup);
  expect(await phoneForm.text()).toContain('Email verified. Next');
  const collected = await handleSignup(post('/phone', { csrf: progress.csrf, phone: '+91 98765 43210' }, verifiedCookie), env, s.a, s.signup);
  expect(collected.status).toBe(303);
  const pendingCookie = cookieFrom(collected);
  const refresh = await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: pendingCookie } }), env, s.a, s.signup);
  const html = await refresh.text();
  expect(html).toContain('entered, not verified');
  expect(html).toContain('SMS verification is not configured');
  expect(html).toContain('value="+919876543210"');
  expect(html).toContain('invite has not been consumed');
  expect(html).toContain("addEventListener('hashchange'");
  expect(html).not.toContain('never-retain');
  expect(pendingCookie).not.toContain('waldo_owner');
  const again = await handleSignup(post('/phone', { csrf: progress.csrf, phone: '+919876543210' }, pendingCookie), env, s.a, s.signup);
  expect(again.status).toBe(303);
  expect(s.fetcher.mock.calls.every(c => !String(c[0]).includes('owner_for_auth'))).toBe(true);
  const fresh = await handleSignup(new Request('https://w.test/console/signup?restart=1', { headers: { cookie: pendingCookie } }), env, s.a, s.signup);
  expect(await fresh.text()).toContain('id="invite"');
  expect(fresh.headers.get('set-cookie')).toContain('Max-Age=0');
});
it.each(['https://attacker.test', 'null', ''])('rejects cross-origin POST (%s) before OTP or directory calls', async origin => {
  const s = setup();
  expect((await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }, '', origin), env, s.a, s.signup)).status).toBe(403);
  expect(s.fetcher).not.toHaveBeenCalled();
});
it('rejects wrong CSRF, expired/lost continuation and unverified phone POST without effect', async () => {
  const s = setup();
  const { cookie, progress } = await start(s);
  s.fetcher.mockClear();
  expect(await (await handleSignup(post('/verify', { csrf: 'wrong', code: '123456' }, cookie), env, s.a, s.signup)).text()).toContain('expired');
  expect(await (await handleSignup(post('/phone', { csrf: progress.csrf, phone: '+14155550100' }, cookie), env, s.a, s.signup)).text()).toContain('Verify your email before');
  expect(await (await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }), env, s.a, s.signup)).text()).toContain('expired');
  expect(s.fetcher).not.toHaveBeenCalled();
});
it('allows a failed OTP to retry with retained signed context and no secret reflected in error pages', async () => {
  const s = setup();
  const { cookie, progress } = await start(s);
  s.fail(400);
  const failed = await handleSignup(post('/verify', { csrf: progress.csrf, code: 'wrong' }, cookie), env, s.a, s.signup);
  const html = await failed.text();
  expect(html).toContain('We could not continue');
  expect(html).toContain(`value="${progress.csrf}"`);
  expect(html).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  expect(html).not.toContain('value="wrong"');
  s.fail(200);
  expect((await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, s.signup)).status).toBe(303);
});
it.each(['limiter_absent', 'coarse_throttle', 'durable_throttle', 'directory_down'])('fails closed at %s without sending OTP', async kind => {
  const s = setup();
  const e = { ...env, RESPONSIBILITY_RATE_LIMITER: kind === 'limiter_absent' ? undefined : { limit: vi.fn(async () => ({ success: kind !== 'coarse_throttle' })) } as unknown as RateLimit };
  if (kind === 'durable_throttle') s.a = { ...s.a, throttle: vi.fn(async () => false) };
  if (kind === 'directory_down') s.a = { ...s.a, throttle: vi.fn(async () => { throw new Error('private provider body'); }) };
  const denied = await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), e, s.a, s.signup);
  expect(denied.status).toBe(303);
  const cookie = cookieFrom(denied);
  const retry = await handleSignup(new Request(`https://w.test${denied.headers.get('location')}`, { headers: { cookie } }), e, s.a, s.signup);
  const html = await retry.text();
  expect(html).toMatch(/Too many attempts|could not confirm/);
  expect(html).toContain('person@example.com');
  expect(html).not.toContain('private provider body');
  expect(s.fetcher).not.toHaveBeenCalled();
});
it('renders provider failure honestly and keeps invite denial non-enumerating', async () => {
  const denied = setup(); denied.revoke();
  const allowed = setup();
  const [a, b] = await Promise.all([start(denied), start(allowed)]);
  const pageA = await (await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: a.cookie } }), env, denied.a, denied.signup)).text();
  const pageB = await (await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: b.cookie } }), env, allowed.a, allowed.signup)).text();
  expect(pageA.replaceAll(a.progress.csrf, 'CSRF').replace(/nonce="[^"]+"/g, '')).toBe(pageB.replaceAll(b.progress.csrf, 'CSRF').replace(/nonce="[^"]+"/g, ''));
  const failure = setup(); failure.fail();
  const failed = await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), env, failure.a, failure.signup);
  expect(failed.status).toBe(303);
  expect(failed.headers.get('location')).toContain('send=unconfirmed');
  const cookie = cookieFrom(failed);
  const refreshed = await handleSignup(new Request('https://w.test/console/signup?send=unconfirmed', { headers: { cookie } }), env, failure.a, failure.signup);
  const html = await refreshed.text();
  expect(html).toContain('could not confirm');
  expect(html).not.toContain('on its way');
  failure.fail(200);
  const p = (await failure.signup.read(new Request('https://w.test/console/signup', { headers: { cookie } })))!;
  expect(await (await handleSignup(post('/resend', { csrf: p.csrf }, cookie), env, failure.a, failure.signup)).text()).toContain('another email code');
});
