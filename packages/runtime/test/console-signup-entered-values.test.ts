import { describe, expect, it, vi } from 'vitest';
import { handleSignup } from '../src/channels/console-signup';
import { signupAuth } from '../src/identity/console-signup';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic only: example.com addresses, a made-up invite alphabet string, stubbed provider. No real invite, no network.
const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'test-router', RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit };
const auth = { sendCode: vi.fn(async () => true), throttle: vi.fn(async () => true) } as unknown as ConsoleAuth;
const post = (path: string, values: Record<string, string>) => new Request(`https://w.test/console/signup${path}`, { method: 'POST', headers: { origin: 'https://w.test', cookie: '' }, body: new URLSearchParams(values) });
const signup = () => signupAuth(env, vi.fn(async () => new Response('true')))!;

describe('signup entry keeps what the person typed when a field is refused', () => {
  it('keeps the email (not the invite code) when the invite code is missing or malformed', async () => {
    for (const invite of ['', 'SHORT']) {
      const html = await (await handleSignup(post('/send', { email: 'Typed.Person@example.com', invite }), env, auth, signup())).text();
      expect(html).toContain('Enter the recipient email');
      expect(html).toContain('value="typed.person@example.com"');
      expect(html).not.toContain('value="SHORT"');
    }
  });
  it('keeps the invite out of the page but keeps a valid-looking email when the email is the refused field', async () => {
    const html = await (await handleSignup(post('/send', { email: 'not-an-email', invite: 'ABCDEFGHJKLMNPQRSTUV' }), env, auth, signup())).text();
    expect(html).toContain('Enter the recipient email');
    expect(html).toContain('value="not-an-email"');
    expect(html).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  });
  it('escapes the retained email', async () => {
    const html = await (await handleSignup(post('/send', { email: '"><script>x</script>@example.com', invite: '' }), env, auth, signup())).text();
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&#34;&#62;&#60;script');
  });
});

// Behaviour pins for the other first-session cases (these passed before the change above; they guard it).
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const flow = () => {
  const state = { verify: 'ok' as 'ok' | 'expired' | 'other-user', otp: 200 };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/rpc/')) return json(true);
    if (url.endsWith('/auth/v1/otp')) return json({}, state.otp);
    if (state.verify === 'expired') return json({ error_code: 'otp_expired' }, 403);
    return json({ user: { id: state.verify === 'ok' ? 'u-a' : 'u-b', email: state.verify === 'ok' ? 'person@example.com' : 'someone.else@example.com', email_confirmed_at: '2026-10-01T00:00:00Z' } });
  });
  return { state, signup: signupAuth(env, fetcher)! };
};
const withCookie = (path: string, values: Record<string, string>, cookie: string) => new Request(`https://w.test/console/signup${path}`, { method: 'POST', headers: { origin: 'https://w.test', cookie }, body: new URLSearchParams(values) });
const begin = async (f: ReturnType<typeof flow>) => {
  const sent = await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), env, auth, f.signup);
  const cookie = sent.headers.get('set-cookie')!.split(';')[0]!;
  const progress = (await f.signup.read(new Request('https://w.test/console/signup', { headers: { cookie } })))!;
  return { cookie, csrf: progress.csrf };
};
describe('first-session OTP cases', () => {
  it('an expired code keeps the signup, does not clear the cookie, and a fresh code then works', async () => {
    const f = flow(); const { cookie, csrf } = await begin(f);
    f.state.verify = 'expired';
    const expired = await handleSignup(withCookie('/verify', { csrf, code: '111111' }, cookie), env, auth, f.signup);
    expect(expired.status).toBe(200);
    expect(expired.headers.get('set-cookie')).toBeNull();
    expect(await expired.text()).toContain(`value="${csrf}"`);
    f.state.verify = 'ok';
    expect((await handleSignup(withCookie('/verify', { csrf, code: '222222' }, cookie), env, auth, f.signup)).status).toBe(303);
  });
  it('a resend the provider refuses (cooldown) says so honestly and keeps the signup', async () => {
    const f = flow(); const { cookie, csrf } = await begin(f);
    f.state.otp = 429;
    const html = await (await handleSignup(withCookie('/resend', { csrf }, cookie), env, auth, f.signup)).text();
    expect(html).not.toContain('another email code was requested');
    expect(html).toContain(`value="${csrf}"`);
  });
  it('a code that verifies a different email never advances this signup', async () => {
    const f = flow(); const { cookie, csrf } = await begin(f);
    f.state.verify = 'other-user';
    const response = await handleSignup(withCookie('/verify', { csrf, code: '333333' }, cookie), env, auth, f.signup);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
