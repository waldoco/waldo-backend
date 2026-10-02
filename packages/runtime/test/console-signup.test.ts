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
  expect(await phoneForm.text()).toContain('Email verified. Finish');
  const collected = await handleSignup(post('/phone', { csrf: progress.csrf, phone: '+91 98765 43210' }, verifiedCookie), env, s.a, s.signup);
  expect(collected.status).toBe(303);
  const pendingCookie = cookieFrom(collected);
  const refresh = await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: pendingCookie } }), env, s.a, s.signup);
  const html = await refresh.text();
  expect(html).toContain('entered, not verified');
  expect(html).toContain('No SMS is sent');
  expect(html).toContain('value="+919876543210"');
  expect(html).toContain('retrying opens that same account');
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

it('finishes verified signup with an optional blank phone and both owner-scoped console cookies', async () => {
  const s = setup();
  const grant = vi.fn(async () => new Response('console-ticket'));
  const e = { ...env, TELEGRAM_OWNER_DO: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch: grant })) } as unknown as DurableObjectNamespace };
  const a = { ...s.a, ownerCookie: vi.fn(async () => 'owner-session') };
  const { cookie, progress } = await start(s);
  const verified = await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), e, a, s.signup);
  const verifiedCookie = cookieFrom(verified);
  const complete = vi.fn(async () => 'owner-new');
  const signup = { ...s.signup, complete };
  const result = await handleSignup(post('/complete', { csrf: progress.csrf, phone: '' }, verifiedCookie), e, a, signup);
  expect(result.status).toBe(303);
  expect(result.headers.get('location')).toBe('/console');
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ authUser: 'u-1', emailVerified: true }), '');
  expect(grant).toHaveBeenCalledWith('https://telegram-owner/grant-console', expect.objectContaining({ headers: { 'x-waldo-do-name': 'owner-new' } }));
  const cookies = result.headers.get('set-cookie')!;
  expect(cookies).toContain('waldo_owner=owner-session');
  expect(cookies).toContain('waldo_console=console-ticket');
  expect(cookies).toContain('waldo_signup=;');
  expect(cookies).toContain('HttpOnly; Secure; SameSite=Strict');
});

it.each(['grant', 'session', 'response'])('retains verified proof and optional contact on %s failure, then retries without another OTP', async failure => {
  const s = setup();
  let failed = true;
  const grant = vi.fn(async () => new Response('ticket', { status: failed && failure === 'grant' ? 503 : 200 }));
  const e = { ...env, TELEGRAM_OWNER_DO: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch: grant })) } as unknown as DurableObjectNamespace };
  const a = { ...s.a, ownerCookie: vi.fn(async () => failed && failure === 'session' ? null : 'owner-cookie') };
  const { cookie, progress } = await start(s);
  const verifiedCookie = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), e, a, s.signup));
  const complete = vi.fn(async () => { if (failed && failure === 'response') throw new Error('private body'); return 'owner-new'; });
  const signup = { ...s.signup, complete };
  const result = await handleSignup(post('/complete', { csrf: progress.csrf, phone: '+1 415 555 0100' }, verifiedCookie), e, a, signup);
  expect(result.status).toBe(200);
  const retained = cookieFrom(result);
  const p = (await signup.read(new Request('https://w.test/console/signup', { headers: { cookie: retained } })))!;
  expect(p).toMatchObject({ emailVerified: true, authUser: 'u-1', phone: '+14155550100' });
  const html = await result.text();
  expect(html).toContain('value="+14155550100"');
  expect(html).not.toContain('private body');
  failed = false;
  expect((await handleSignup(post('/complete', { csrf: p.csrf, phone: p.phone! }, retained), e, a, signup)).status).toBe(303);
  expect(s.fetcher.mock.calls.filter(c => String(c[0]).endsWith('/verify'))).toHaveLength(1);
});

it('refuses completion before email proof, with wrong CSRF, or without owner routing', async () => {
  const s = setup(); const { cookie, progress } = await start(s);
  const complete = vi.fn(async () => 'owner-new'); const signup = { ...s.signup, complete };
  expect(await (await handleSignup(post('/complete', { csrf: progress.csrf }, cookie), env, s.a, signup)).text()).toContain('Verify your email before');
  expect(await (await handleSignup(post('/complete', { csrf: 'wrong' }, cookie), env, s.a, signup)).text()).toContain('expired');
  const verifiedCookie = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, signup));
  expect(await (await handleSignup(post('/complete', { csrf: progress.csrf }, verifiedCookie), env, s.a, signup)).text()).toContain('temporarily unavailable');
  expect(complete).not.toHaveBeenCalled();
});

it('routes two fresh email-only members and an existing member to distinct canonical owner consoles', async () => {
  const { consoleAuth: createAuth } = await import('../src/identity/console-auth');
  const { handleConsole } = await import('../src/channels/console-signin');
  const sessions = new Set<string>();
  const created = new Map<string, string>();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/signin_allowed') || url.endsWith('/console_auth_throttle')) return json(true);
    if (url.endsWith('/otp')) return json({});
    if (url.endsWith('/verify')) return json({ user: { id: body.email === 'other@example.com' ? '00000000-0000-0000-0000-000000000003' : '00000000-0000-0000-0000-000000000002', email: body.email, email_confirmed_at: '2026-10-01Z' } });
    if (url.endsWith('/signup_owner_for_auth')) {
      if (!created.has(body.p_auth_user)) created.set(body.p_auth_user, created.size === 0 ? 'owner-new' : 'owner-other');
      return json(created.get(body.p_auth_user));
    }
    const key = `${body.p_do_name}:${body.p_session_hash}`;
    if (url.endsWith('/console_session_open')) { sessions.add(key); return json(true); }
    if (url.endsWith('/console_session_touch')) return json(sessions.has(key));
    throw new Error('unexpected fixture endpoint');
  });
  const ns = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (input: RequestInfo) => new Response(String(input).endsWith('/grant-console') ? `ticket-${name}` : `console-${name}`) }) } as unknown as DurableObjectNamespace;
  const e = { ...env, TELEGRAM_OWNER_DO: ns };
  const auth = createAuth(e, fetcher)!; const signup = signupAuth(e, fetcher)!;
  const existing = await auth.ownerCookie('owner-existing');
  const initial = await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), e, auth, signup);
  const draftCookie = cookieFrom(initial); const progress = (await signup.read(new Request('https://w.test/console/signup', { headers: { cookie: draftCookie } })))!;
  const proofCookie = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, draftCookie), e, auth, signup));
  const done = await handleSignup(post('/complete', { csrf: progress.csrf, phone: '' }, proofCookie), e, auth, signup);
  expect(done.status).toBe(303);
  const ownerCookie = done.headers.get('set-cookie')!.split(/, (?=waldo_)/).find(cookie => cookie.startsWith('waldo_owner='))!.split(';')[0]!;
  const newConsole = await handleConsole(new Request('https://w.test/console', { headers: { cookie: ownerCookie } }), e, auth);
  const oldConsole = await handleConsole(new Request('https://w.test/console', { headers: { cookie: `waldo_owner=${existing}` } }), e, auth);
  expect(await newConsole!.text()).toBe('console-owner-new');
  expect(await oldConsole!.text()).toBe('console-owner-existing');
  const otherInitial = await handleSignup(post('/send', { email: 'other@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), e, auth, signup);
  const otherDraft = cookieFrom(otherInitial);
  const otherProgress = (await signup.read(new Request('https://w.test/console/signup', { headers: { cookie: otherDraft } })))!;
  const otherProof = cookieFrom(await handleSignup(post('/verify', { csrf: otherProgress.csrf, code: '123456' }, otherDraft), e, auth, signup));
  const otherDone = await handleSignup(post('/complete', { csrf: otherProgress.csrf, phone: '' }, otherProof), e, auth, signup);
  expect(otherDone.status).toBe(303);
  const otherCookie = otherDone.headers.get('set-cookie')!.split(/, (?=waldo_)/).find(cookie => cookie.startsWith('waldo_owner='))!.split(';')[0]!;
  const otherConsole = await handleConsole(new Request('https://w.test/console', { headers: { cookie: otherCookie } }), e, auth);
  expect(await otherConsole!.text()).toBe('console-owner-other');
  expect(created.size).toBe(2);
  expect(await auth.readOwnerCookie(new Request('https://w.test/console', { headers: { cookie: ownerCookie.replace('owner-new', 'owner-existing') } }))).toBeNull();
  const forgedRoute = await handleConsole(new Request('https://w.test/console', { headers: { cookie: ownerCookie.replace('owner-new', 'owner-existing') } }), e, auth);
  expect(forgedRoute!.status).toBe(303);
  expect(forgedRoute!.headers.get('location')).toBe('/console/signin');
});

it('can finish with verified proof when the OTP-send budget is exhausted', async () => {
  const s = setup(); const { cookie, progress } = await start(s);
  const verifiedCookie = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, s.signup));
  const a = { ...s.a, throttle: vi.fn(async (key: string) => !key.startsWith('send:')), ownerCookie: vi.fn(async () => 'session') };
  const e = { ...env, TELEGRAM_OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('ticket') }) } as unknown as DurableObjectNamespace };
  const complete = vi.fn(async () => 'owner-new');
  const result = await handleSignup(post('/complete', { csrf: progress.csrf, phone: '' }, verifiedCookie), e, a, { ...s.signup, complete });
  expect(result.status).toBe(303);
  expect(a.throttle).toHaveBeenCalledWith('complete:person@example.com', 10, 900);
});

it.each(['fetch', 'body'])('bounds hanging console grant %s and retains signup recovery', async phase => {
  const s = setup(); const { cookie, progress } = await start(s);
  const proof = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, s.signup));
  const hang = () => new Promise<never>(() => {});
  const grant = vi.fn(async () => phase === 'fetch' ? hang() : ({ ok: true, text: hang } as unknown as Response));
  const e = { ...env, TELEGRAM_OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: grant }) } as unknown as DurableObjectNamespace };
  const a = { ...s.a, ownerCookie: vi.fn(async () => 'session') };
  vi.useFakeTimers();
  try {
    const pending = handleSignup(post('/complete', { csrf: progress.csrf, phone: '+14155550100' }, proof), e, a, { ...s.signup, complete: vi.fn(async () => 'owner-new') });
    await vi.waitFor(() => expect(grant).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await Promise.race([pending, Promise.resolve(null)]);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.headers.get('set-cookie')).toContain('waldo_signup=');
    expect(await result!.text()).toContain('Retry Finish signup');
  } finally { vi.useRealTimers(); }
});

it('retains entered optional contact when a completion throttle refuses the attempt', async () => {
  const s = setup(); const { cookie, progress } = await start(s);
  const proof = cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, cookie), env, s.a, s.signup));
  const a = { ...s.a, throttle: vi.fn(async () => false) };
  const denied = await handleSignup(post('/complete', { csrf: progress.csrf, phone: '+14155550100' }, proof), env, a, s.signup);
  expect(await denied.text()).toContain('value="+14155550100"');
});
