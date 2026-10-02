import { afterEach, expect, it, vi } from 'vitest';
import { handleSignup } from '../src/channels/console-signup';
import { ownerDirectory } from '../src/identity/owner-directory';
import { consoleAuth } from '../src/identity/console-auth';
import { signupAuth, SIGNUP_COOKIE } from '../src/identity/console-signup';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router' };
const json = (value: unknown) => Response.json(value);
const never = <T>() => new Promise<T>(() => {});
afterEach(() => vi.useRealTimers());

it('signup OTP bounds a fetch that ignores abort and retains unverified progress', async () => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/rpc/')) return json(true);
    entered();
    return never<Response>();
  });
  const auth = signupAuth(env, fetcher as typeof fetch)!;
  const draft = await auth.begin('new@test.invalid', 'ABCDEFGHJKLMNPQRSTUV');
  const request = new Request('https://w.test/console/signup', { headers: { cookie: `${SIGNUP_COOKIE}=${draft}` } });
  const progress = (await auth.read(request))!;
  const pending = auth.sendCode(progress).then(() => 'success', () => 'timeout');
  await started;
  const outcome = Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 11_000))]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(await outcome).toBe('timeout');
  expect(await auth.read(request)).toMatchObject({ emailVerified: false, complete: false, phoneVerification: 'not_configured' });
  expect(fetcher.mock.calls.some(([url]) => /owner_for_auth|session|redeem/.test(String(url)))).toBe(false);
});

it('legacy verification bounds stalled JSON before owner resolution or session access', async () => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetcher = vi.fn(async () => ({ ok: true, json: () => { entered(); return never<unknown>(); } }) as Response);
  const auth = consoleAuth(env, fetcher as typeof fetch)!;
  const pending = auth.verify('new@test.invalid', '123456', '+14155550100', 'ABCDEFGHJKLMNPQRSTUV').then(() => 'success', () => 'timeout');
  await started;
  const outcome = Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 11_000))]);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(await outcome).toBe('timeout');
  expect(fetcher.mock.calls).toHaveLength(1);
});

it.each(['signup verify', 'legacy send', 'legacy verify', 'directory eligibility', 'directory route', 'directory throttle', 'directory redemption', 'directory legacy redemption'])('%s bounds an abort-ignoring fetch or stalled JSON and fences late success', async operation => {
  for (const stall of ['fetch', 'body', 'json'] as const) {
    // OTP send reads no response payload: its only required completion is the response headers.
    if (operation === 'legacy send' && stall !== 'fetch') continue;
    vi.useFakeTimers();
    let enter!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    let release!: (value: Response | unknown) => void;
    const held = new Promise<Response | unknown>(resolve => { release = resolve; });
    let cancel!: () => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const target = operation.startsWith('directory') || url.includes('/auth/');
      if (!target) return json(true);
      if (stall === 'fetch') { enter(); return held as Promise<Response>; }
      if (stall === 'body') {
        const response = new Response(new ReadableStream({ start(controller) { cancel = () => controller.close(); } }));
        enter();
        return response;
      }
      return { ok: true, json: () => { enter(); return held; } } as Response;
    });
    const auth = consoleAuth(env, fetcher as typeof fetch)!;
    const signup = signupAuth(env, fetcher as typeof fetch)!;
    const cookie = await signup.begin('new@test.invalid', 'ABCDEFGHJKLMNPQRSTUV');
    const progress = (await signup.read(new Request('https://w.test/console/signup', { headers: { cookie: `${SIGNUP_COOKIE}=${cookie}` } })))!;
    const directory = ownerDirectory(env, fetcher as typeof fetch);
    const work = operation === 'signup verify' ? signup.verifyEmail(progress, '123456')
      : operation === 'legacy send' ? auth.sendCode('new@test.invalid', 'ABCDEFGHJKLMNPQRSTUV')
      : operation === 'legacy verify' ? auth.verify('new@test.invalid', '123456', '+14155550100', 'ABCDEFGHJKLMNPQRSTUV')
      : operation === 'directory eligibility' ? auth.sendCode('new@test.invalid')
      : operation === 'directory throttle' ? auth.throttle('synthetic', 5, 900)
      : operation === 'directory legacy redemption' ? directory.redeem('telegram', '42', 'ABCDEFGHJK')
      : operation === 'directory redemption' ? directory.redeemHashed!('telegram', '42', 'a'.repeat(64))
      : directory.byPresence('telegram', '42');
    const pending = work.then(value => typeof value === 'object' && value && 'kind' in value && value.kind === 'uncertain' ? 'timeout' : 'success', () => 'timeout');
    await started;
    const outcome = Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still pending'), 11_000))]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await outcome).toBe('timeout');
    const count = fetcher.mock.calls.length;
    release(stall === 'fetch' ? json({ user: { id: 'auth-new', email: 'new@test.invalid' } }) : { user: { id: 'auth-new', email: 'new@test.invalid' } });
    cancel?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls).toHaveLength(count);
    expect(fetcher.mock.calls.some(([url]) => /owner_for_auth|console_session_open/.test(String(url)))).toBe(false);
    expect(await signup.read(new Request('https://w.test/console/signup', { headers: { cookie: `${SIGNUP_COOKIE}=${cookie}` } }))).toMatchObject({ emailVerified: false, complete: false });
    vi.useRealTimers();
  }
});

it('signup verify JSON timeout returns a retry form, preserves refresh progress and cannot grant a session even after late proof', async () => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: unknown) => void;
  const proof = new Promise(resolve => { release = resolve; });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/rpc/') ? json(true) : ({ ok: true, json: () => { entered(); return proof; } }) as Response);
  const auth = consoleAuth(env, fetcher as typeof fetch)!;
  const signup = signupAuth(env, fetcher as typeof fetch)!;
  const draft = await signup.begin('new@test.invalid', 'ABCDEFGHJKLMNPQRSTUV');
  const cookie = `${SIGNUP_COOKIE}=${draft}`;
  const get = () => new Request('https://w.test/console/signup', { headers: { cookie } });
  const progress = (await signup.read(get()))!;
  const routeEnv = { ...env, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit };
  const request = new Request('https://w.test/console/signup/verify', { method: 'POST', headers: { cookie, origin: 'https://w.test' }, body: new URLSearchParams({ csrf: progress.csrf, code: '123456' }) });
  const pending = handleSignup(request, routeEnv, auth, signup);
  await started;
  await vi.advanceTimersByTimeAsync(10_000);
  const response = await pending;
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.text()).toContain('Verification is temporarily unavailable');
  release({ user: { id: 'late-user', email: 'new@test.invalid', email_confirmed_at: '2026-10-01Z' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(await (await handleSignup(get(), routeEnv, auth, signup)).text()).toContain('Email: waiting for a code');
  expect(fetcher.mock.calls.some(([url]) => /owner_for_auth|console_session_open|redeem/.test(String(url)))).toBe(false);
});
