import { describe, expect, it, vi } from 'vitest';
import { consoleAuth, OWNER_COOKIE } from '../src/identity/console-auth';
import { routerSignature } from '../src/identity/owner-directory';

const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const now = () => 1_790_000_000_000;
const withCookie = (value: string) => new Request('https://w.test/console', { headers: { cookie: `a=b; ${OWNER_COOKIE}=${value}` } });

describe('consoleAuth', () => {
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
    const auth = consoleAuth(env)!;
    const cookie = await auth.ownerCookie('do-a');
    expect(await auth.readOwnerCookie(withCookie(cookie))).toBe('do-a');
    expect(await auth.readOwnerCookie(withCookie(cookie.replace('do-a', 'do-b')))).toBeNull();
    expect(await auth.readOwnerCookie(withCookie('do-b.forged'))).toBeNull();
    expect(await auth.readOwnerCookie(withCookie(''))).toBeNull();
    expect(await consoleAuth({ ...env, WALDO_ROUTER_HMAC_SECRET: 'other' })!.readOwnerCookie(withCookie(cookie))).toBeNull();
  });

  it('issues a readable link code and stores only its hash', async () => {
    const fetcher = vi.fn(async () => json(true));
    const code = await consoleAuth(env, fetcher as unknown as typeof fetch, now)!.issueLinkCode('do-a');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(code!);
  });
});
