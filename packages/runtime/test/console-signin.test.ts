import { describe, expect, it, vi } from 'vitest';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const owners = () => {
  const fetch = vi.fn(async (input: RequestInfo) => new Response(typeof input === 'string' && input.endsWith('/grant-console') ? 'session-token' : 'console page'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const auth = (overrides: Partial<ConsoleAuth> = {}): ConsoleAuth => ({
  sendCode: vi.fn(async () => true),
  verify: vi.fn(async () => null),
  issueLinkCode: vi.fn(async () => null),
  saveSettings: vi.fn(async () => true),
  unlinkTelegram: vi.fn(async () => true),
  deleteOwner: vi.fn(async () => true),
  adminOverview: vi.fn(async () => null),
  invite: vi.fn(async () => false),
  revokeInvite: vi.fn(async () => false),
  ownerCookie: vi.fn(async (doName: string) => `${doName}.session.sig`),
  readOwnerCookie: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  revokeSession: vi.fn(async () => true),
  signOutAll: vi.fn(async () => 2),
  ...overrides,
});
const form = (path: string, fields: Record<string, string>) => new Request(`https://w.test${path}`, { method: 'POST', body: new URLSearchParams(fields) });

describe('handleConsole', () => {
  it('sign-out-everywhere drops server-side sessions and clears both cookies', async () => {
    const signOutAll = vi.fn(async () => 3);
    const response = await handleConsole(
      new Request('https://w.test/console/signout-all', { method: 'POST' }),
      { TELEGRAM_OWNER_DO: owners().ns },
      auth({ readOwnerCookie: vi.fn(async () => 'do-a'), signOutAll }),
    );
    expect(response?.status).toBe(303);
    expect(signOutAll).toHaveBeenCalledWith('do-a');
    const cleared = response?.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('waldo_owner=');
    expect(cleared).toContain('Max-Age=0');
  });

  it('stays out of the way when Supabase sign-in is not configured', async () => {
    expect(await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, null)).toBeNull();
  });

  it('sends a signed-out visitor to the email form', async () => {
    const response = await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, auth());
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/console/signin');
  });

  it('gives the same answer for an invited and an unknown address', async () => {
    const a = auth();
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const known = await (await handleConsole(form('/console/signin', { email: 'owner@example.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter }, a))!.text();
    const unknown = await (await handleConsole(form('/console/signin', { email: 'nobody@example.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter }, a))!.text();
    expect(known.replaceAll('owner@example.com', 'X')).toBe(unknown.replaceAll('nobody@example.com', 'X'));
    expect(a.sendCode).toHaveBeenCalledTimes(2);
  });

  it('a verified code gets a session from that owner DO and both cookies', async () => {
    const { ns, fetch, idFromName } = owners();
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', phone: '+14155550100', code: '123456' }), { TELEGRAM_OWNER_DO: ns, RESPONSIBILITY_RATE_LIMITER: limiter }, auth({ verify: vi.fn(async () => 'do-a') })))!;
    expect(response.status).toBe(303);
    expect(idFromName).toHaveBeenCalledWith('do-a');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://telegram-owner/grant-console');
    const cookies = [...response.headers].filter(([name]) => name === 'set-cookie').map(([, value]) => value);
    expect(cookies.some((cookie) => cookie.startsWith('waldo_console=session-token;') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('waldo_owner=do-a.session.sig;'))).toBe(true);
  });

  it('a wrong code wakes no owner DO', async () => {
    const { ns, fetch } = owners();
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', phone: '+14155550100', code: '000000' }), { TELEGRAM_OWNER_DO: ns, RESPONSIBILITY_RATE_LIMITER: limiter }, auth()))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('did not work');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes a signed-in request to the owner named by the verified cookie only', async () => {
    const { ns, fetch, idFromName } = owners();
    await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: ns }, auth({ readOwnerCookie: vi.fn(async () => 'do-b') }));
    expect(idFromName).toHaveBeenCalledWith('do-b');
    expect((fetch.mock.calls[0]?.[0] as Request).headers.get('x-waldo-do-name')).toBe('do-b');
  });
});

describe('open signup', () => {
  it('phone is required and normalized to E.164; it rides hidden into verify and reaches owner provisioning', async () => {
    const verify = vi.fn(async () => 'owner-abc');
    const a = auth({ verify });
    const limiter = { limit: vi.fn(async () => ({ success: true })) as unknown as RateLimit['limit'] } as unknown as RateLimit;
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter };
    const send = await handleConsole(form('/console/signin', { email: 'New@Example.com', phone: '+91 98765 43210' }), env, a);
    const html = await send!.text();
    expect(html).toContain('name="phone" value="+919876543210"');
    expect(html).toContain('name="email" value="new@example.com"');
    const done = await handleConsole(form('/console/verify', { email: 'new@example.com', phone: '+91 98765 43210', code: '123456' }), env, a);
    expect(done?.status).toBe(303);
    expect(verify).toHaveBeenCalledWith('new@example.com', '123456', '+919876543210');
  });

  it('refuses code send without a phone, and refuses an un-normalizable phone', async () => {
    const sendCode = vi.fn(async () => true);
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit };
    const missing = await handleConsole(form('/console/signin', { email: 'a@b.com' }), env, auth({ sendCode }));
    expect(await missing!.text()).toContain('Enter your phone number');
    const bad = await handleConsole(form('/console/signin', { email: 'a@b.com', phone: 'call me maybe' }), env, auth({ sendCode }));
    expect(await bad!.text()).toContain('Enter your phone number');
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('a tampered verify form with an invalid hidden phone never reaches auth.verify', async () => {
    const verify = vi.fn(async () => 'owner-abc');
    const done = await handleConsole(form('/console/verify', { email: 'a@b.com', phone: '1', code: '123456' }), { TELEGRAM_OWNER_DO: owners().ns }, auth({ verify }));
    expect(await done!.text()).toContain('Enter your phone number');
    expect(verify).not.toHaveBeenCalled();
  });

  it('throttles code sends per email and per IP', async () => {
    const sendCode = vi.fn(async () => true);
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: !key.includes('repeat@x.com') }));
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit } as unknown as RateLimit };
    const blocked = await handleConsole(
      new Request('https://w.test/console/signin', { method: 'POST', body: new URLSearchParams({ email: 'repeat@x.com', phone: '+14155550100' }), headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      env, auth({ sendCode }));
    expect(await blocked!.text()).toContain('Too many attempts');
    expect(sendCode).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: 'console-signin:repeat@x.com' });
    expect(limit).toHaveBeenCalledWith({ key: 'console-signin-ip:1.2.3.4' });
    const allowed = await handleConsole(form('/console/signin', { email: 'fresh@x.com', phone: '+14155550100' }), env, auth({ sendCode }));
    expect(await allowed!.text()).toContain('name="code"');
    expect(sendCode).toHaveBeenCalledWith('fresh@x.com');
  });

  it('throttles verify attempts per email and per IP: auth.verify never runs', async () => {
    const verify = vi.fn(async () => 'owner-abc');
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: !key.includes('guess@x.com') }));
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit } as unknown as RateLimit };
    const blocked = await handleConsole(
      new Request('https://w.test/console/verify', { method: 'POST', body: new URLSearchParams({ email: 'guess@x.com', phone: '+14155550100', code: '123456' }), headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      env, auth({ verify }));
    const html = await blocked!.text();
    expect(html).toContain('Too many attempts');
    expect(html).toContain('name="phone" value="+14155550100"');
    expect(verify).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: 'console-verify:guess@x.com' });
    expect(limit).toHaveBeenCalledWith({ key: 'console-verify-ip:1.2.3.4' });
  });

  it('verify fails CLOSED without the limiter binding: no code check happens', async () => {
    const verify = vi.fn(async () => 'owner-abc');
    const response = await handleConsole(form('/console/verify', { email: 'a@b.com', phone: '+14155550100', code: '123456' }), { TELEGRAM_OWNER_DO: owners().ns }, auth({ verify }));
    const html = await response!.text();
    expect(html).toContain('temporarily unavailable');
    expect(html).toContain('name="phone" value="+14155550100"');
    expect(verify).not.toHaveBeenCalled();
  });

  it('a session-storage failure keeps the phone on the retry form instead of swallowing the error text', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = await handleConsole(
      form('/console/verify', { email: 'a@b.com', phone: '+14155550100', code: '123456' }),
      { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter },
      auth({ verify: vi.fn(async () => 'do-a'), ownerCookie: vi.fn(async () => null) }));
    const html = await response!.text();
    expect(html).toContain('having trouble');
    expect(html).toContain('name="phone" value="+14155550100"');
    expect(html).not.toContain('name="phone" value="Sign-in is having trouble');
  });

  it('fails CLOSED without the limiter binding: no code is sent on a public endpoint', async () => {
    const sendCode = vi.fn(async () => true);
    const response = await handleConsole(form('/console/signin', { email: 'a@b.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns }, auth({ sendCode }));
    expect(await response!.text()).toContain('temporarily unavailable');
    expect(sendCode).not.toHaveBeenCalled();
  });
});
