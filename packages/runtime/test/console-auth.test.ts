import { describe, expect, it, vi } from 'vitest';
import { consoleAuth, OWNER_COOKIE } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const now = () => 1_790_000_000_000;
const withCookie = (value: string) => new Request('https://w.test/console', { headers: { cookie: `a=b; ${OWNER_COOKIE}=${value}` } });

describe('consoleAuth', () => {
  it('deleteOwner signs the deletion RPC for exactly this owner DO', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(true));
    const auth = consoleAuth(env, fetcher as unknown as typeof fetch, now)!;
    expect(await auth.deleteOwner('do-owner-1')).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/delete_owner');
    expect(JSON.parse(String(init.body))).toMatchObject({
      p_do_name: 'do-owner-1',
      p_sig: await routerSignature('router', 1_790_000_000, 'delown.do-owner-1'),
    });
    const denied = vi.fn().mockResolvedValueOnce(json(false));
    expect(await consoleAuth(env, denied as unknown as typeof fetch, now)!.deleteOwner('do-owner-1')).toBe(false);
  });


  it('is off without Supabase, so the Telegram link sign-in stays', () => {
    expect(consoleAuth({})).toBeNull();
    expect(consoleAuth({ ...env, WALDO_ROUTER_HMAC_SECRET: undefined })).toBeNull();
  });

  it('sends an OTP only to an invited or known address, and says nothing either way', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(false));
    await consoleAuth(env, fetcher as unknown as typeof fetch, now)!.sendCode(' Stranger@Example.com ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/signin_allowed');
    expect(JSON.parse(String(init.body))).toMatchObject({ p_email: 'stranger@example.com', p_sig: await routerSignature('router', 1_790_000_000, 'signin.stranger@example.com') });

    const allowed = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json({}));
    await consoleAuth(env, allowed as unknown as typeof fetch, now)!.sendCode('owner@example.com');
    expect((allowed.mock.calls[1] as [string])[0]).toBe('https://db.test/auth/v1/otp');
  });

  it('maps a verified code to the owner Durable Object', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'jwt', user: { id: 'u-1', email: 'owner@example.com' } }))
      .mockResolvedValueOnce(json('do-a'));
    expect(await consoleAuth(env, fetcher as unknown as typeof fetch, now)!.verify('Owner@example.com', ' 123456 ')).toBe('do-a');
    expect(JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ type: 'email', email: 'owner@example.com', token: '123456' });
  });

  it('a wrong code, or a session for a different address, maps to nobody', async () => {
    const wrong = vi.fn().mockResolvedValueOnce(json({ error: 'otp_expired' }, 403));
    expect(await consoleAuth(env, wrong as unknown as typeof fetch, now)!.verify('owner@example.com', '000000')).toBeNull();
    const swapped = vi.fn().mockResolvedValueOnce(json({ user: { id: 'u-2', email: 'other@example.com' } }));
    expect(await consoleAuth(env, swapped as unknown as typeof fetch, now)!.verify('owner@example.com', '123456')).toBeNull();
    expect(swapped).toHaveBeenCalledTimes(1);
  });

  it('the owner cookie resists forgery and owner swapping', async () => {
    const fetcher = vi.fn(async () => json(true));
    const auth = consoleAuth(env, fetcher as unknown as typeof fetch, now)!;
    const cookie = await auth.ownerCookie('do-a');
    expect(cookie).not.toBeNull();
    // doName + session id + HMAC, and the session was opened server-side.
    expect(cookie!.split('.')).toHaveLength(3);
    expect(String((fetcher.mock.calls[0] as unknown as [string])[0])).toContain('console_session_open');
    expect(await auth.readOwnerCookie(withCookie(cookie!))).toBe('do-a');
    expect(await auth.readOwnerCookie(withCookie(cookie!.replace('do-a', 'do-b')))).toBeNull();
    expect(await auth.readOwnerCookie(withCookie('do-b.forged'))).toBeNull();
    expect(await auth.readOwnerCookie(withCookie(''))).toBeNull();
    expect(await consoleAuth({ ...env, WALDO_ROUTER_HMAC_SECRET: 'other' })!.readOwnerCookie(withCookie(cookie!))).toBeNull();
  });

  it('a killed session invalidates its cookie and sign-in fails when the session cannot open', async () => {
    const alive = vi.fn(async () => json(true));
    const auth = consoleAuth(env, alive as unknown as typeof fetch, now)!;
    const cookie = (await auth.ownerCookie('do-a'))!;
    const dead = vi.fn(async (input: RequestInfo) => json(!String(input).includes('console_session_touch')));
    expect(await consoleAuth(env, dead as unknown as typeof fetch, now)!.readOwnerCookie(withCookie(cookie))).toBeNull();
    expect(await consoleAuth(env, vi.fn(async () => json(false)) as unknown as typeof fetch, now)!.ownerCookie('do-a')).toBeNull();
  });

  it('issues a readable link code and stores only its hash', async () => {
    const fetcher = vi.fn(async () => json(true));
    const code = await consoleAuth(env, fetcher as unknown as typeof fetch, now)!.issueLinkCode('do-a');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(code!);
  });

  it('writes settings through the signed function and reports whether they landed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(true)).mockResolvedValueOnce(json(false));
    const auth = consoleAuth(env, fetcher as unknown as typeof fetch, now)!;
    expect(await auth.saveSettings('do-a', { timezone: 'Asia/Kolkata', quiet_start: '22:00', quiet_end: null, volume: 'low' })).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/set_owner_settings');
    expect(JSON.parse(String(init.body))).toMatchObject({ p_do_name: 'do-a', p_timezone: 'Asia/Kolkata', p_quiet_start: '22:00', p_quiet_end: '', p_volume: 'low', p_sig: await routerSignature('router', 1_790_000_000, 'settings.do-a.Asia/Kolkata.22:00..low') });
    expect(await auth.saveSettings('do-a', { timezone: 'Mars/Olympus', quiet_start: null, quiet_end: null, volume: 'normal' })).toBe(false);
  });
});
