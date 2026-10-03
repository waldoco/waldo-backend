import { describe, expect, it, vi } from 'vitest';
import { handleConsole, downloadReturnTarget } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const downloadTarget = '/console/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1';
it('returns expired DO download sessions to sign-in while preserving the exact file intent', async () => {
  const ns = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('unauthorized', { status: 401 }) }) } as unknown as DurableObjectNamespace;
  const response = (await handleConsole(new Request(`https://w.test${downloadTarget}`, { headers: { cookie: 'waldo_owner=signed' } }),
    { TELEGRAM_OWNER_DO: ns }, auth({ readOwnerCookie: async () => 'do-a' })))!;
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`/console/signin?return_to=${encodeURIComponent(downloadTarget)}`);
});
it('retains download intent when authentication is absent without reading file metadata', async () => {
  const ns = owners();
  const response = (await handleConsole(new Request(`https://w.test${downloadTarget}`), { TELEGRAM_OWNER_DO: ns.ns }, auth()))!;
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`/console/signin?return_to=${encodeURIComponent(downloadTarget)}`);
  expect(ns.fetch).not.toHaveBeenCalled();
  const page = (await handleConsole(new Request(`https://w.test/console/signin?return_to=${encodeURIComponent(downloadTarget)}`), { TELEGRAM_OWNER_DO: ns.ns }, auth()))!;
  const html = await page.text();
  expect(html).toContain('Continue to download');
  expect(html).toContain('name="return_to"');
});
it('finishes download OTP with an HTML link and unchanged cookie protections', async () => {
  const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', code: '123456', return_to: downloadTarget }),
    { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit },
    auth({ verify: async () => 'do-a' })))!;
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict');
  expect(await response.text()).toContain('id="signin-download"');
});

const owners = () => {
  const fetch = vi.fn(async (input: RequestInfo) => new Response(typeof input === 'string' && input.endsWith('/grant-console') ? 'session-token' : 'console page'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const auth = (overrides: Partial<ConsoleAuth> = {}): ConsoleAuth => ({
  sendCode: vi.fn(async () => true),
  throttle: vi.fn(async () => true),
  verify: vi.fn(async () => null),
  issueLinkCode: vi.fn(async () => null),
  saveSettings: vi.fn(async () => true),
  unlinkTelegram: vi.fn(async () => true),
  assertChannelPresence: vi.fn(async () => true),
  deleteOwner: vi.fn(async () => true),
  adminOverview: vi.fn(async () => null),
  invite: vi.fn(async () => false),
  memberInvite: vi.fn(async () => false),
  memberInvites: vi.fn(async () => []),
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

  it('correlates a failed auth request without logging email, phone, or code', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await handleConsole(form('/console/signin', { email: 'private@example.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns }, auth());
      expect(response?.status).toBe(200);
      const trace = response?.headers.get('x-waldo-trace');
      expect(trace).toMatch(/^console-[0-9a-f-]{36}$/);
      const logged = spy.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain(trace!);
      expect(logged).toContain('limiter_absent');
      expect(logged).not.toContain('private@example.com');
      expect(logged).not.toContain('+14155550100');
    } finally { spy.mockRestore(); }
  });

  it('does not call a failed DO session grant a successful sign-in', async () => {
    const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const ns = { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const ownerCookie = vi.fn(async () => 'cookie');
    const response = await handleConsole(form('/console/verify', { email: 'owner@example.com', phone: '+14155550100', code: '123456' }),
      { TELEGRAM_OWNER_DO: ns, RESPONSIBILITY_RATE_LIMITER: limiter }, auth({ verify: vi.fn(async () => 'do-a'), ownerCookie }));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('Sign-in is having trouble');
    expect(ownerCookie).not.toHaveBeenCalled();
  });

  it('stays out of the way when Supabase sign-in is not configured', async () => {
    expect(await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, null)).toBeNull();
  });

  it('lets the Telegram one-time ticket link fall through to the owner DO console', async () => {
    // Staging receipt 2026-09-28: with Supabase console auth configured, GET /console?t=<ticket>
    // 303'd to the email form and the bot's sign-in link could never redeem. The ticket flow
    // (GET with ?t=, and the redeem POST back to /console) belongs to the owner DO's branch.
    expect(await handleConsole(new Request('https://w.test/console?t=ticket123'), { TELEGRAM_OWNER_DO: owners().ns }, auth())).toBeNull();
    expect(await handleConsole(form('/console', { t: 'ticket123' }), { TELEGRAM_OWNER_DO: owners().ns }, auth())).toBeNull();
  });

  it('lets a request carrying the DO console cookie fall through to the owner DO', async () => {
    // The ticket session lives in the waldo_console cookie; without this fallthrough a
    // redeemed ticket still 303'd every page to the email form.
    const req = new Request('https://w.test/console', { headers: { cookie: 'waldo_console=abc.def.ghi' } });
    expect(await handleConsole(req, { TELEGRAM_OWNER_DO: owners().ns }, auth())).toBeNull();
  });

  it('routes an email-code member using the signed owner cookie despite also carrying a DO cookie', async () => {
    const { ns, fetch, idFromName } = owners();
    const req = new Request('https://w.test/console', { headers: { cookie: 'waldo_console=member-session; waldo_owner=member-do.signed' } });
    const result = await handleConsole(req, { TELEGRAM_OWNER_DO: ns }, auth({ readOwnerCookie: vi.fn(async () => 'member-do') }));
    expect(await result?.text()).toBe('console page');
    expect(idFromName).toHaveBeenCalledWith('member-do');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not use a ticket URL to switch an email-code member to the deploy owner', async () => {
    const { ns, idFromName } = owners();
    const req = new Request('https://w.test/console?t=other-owners-ticket', { headers: { cookie: 'waldo_console=member-session; waldo_owner=member-do.signed' } });
    const result = await handleConsole(req, { TELEGRAM_OWNER_DO: ns }, auth({ readOwnerCookie: vi.fn(async () => 'member-do') }));
    expect(await result?.text()).toBe('console page');
    expect(idFromName).toHaveBeenCalledWith('member-do');
  });

  it('does not fall back to deploy owner if a signed-owner cookie is invalid', async () => {
    const req = new Request('https://w.test/console', { headers: { cookie: 'waldo_console=some-session; waldo_owner=invalid' } });
    const result = await handleConsole(req, { TELEGRAM_OWNER_DO: owners().ns }, auth({ readOwnerCookie: vi.fn(async () => null) }));
    expect(result?.status).toBe(303);
    expect(result?.headers.get('location')).toBe('/console/signin');
  });

  it('sends a signed-out visitor to the email form', async () => {
    const response = await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, auth());
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/console/signin');
  });

  it('refuses an OTP send when the strict per-email throttle is exhausted', async () => {
    const sendCode = vi.fn(async () => true);
    const throttle = vi.fn(async (key: string) => !key.startsWith('send:'));
    const a = auth({ sendCode, throttle });
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = (await handleConsole(form('/console/signin', { email: 'owner@example.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter }, a))!;
    expect(await response.text()).toContain('Too many attempts');
    expect(sendCode).not.toHaveBeenCalled();
    expect(throttle).toHaveBeenCalledWith('send:owner@example.com', 5, 900);
  });

  it('fails closed when the strict throttle cannot answer', async () => {
    const sendCode = vi.fn(async () => true);
    const a = auth({ sendCode, throttle: vi.fn(async () => { throw new Error('directory down'); }) });
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = (await handleConsole(form('/console/signin', { email: 'owner@example.com', phone: '+14155550100' }), { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter }, a))!;
    expect(await response.text()).toContain('Too many attempts');
    expect(sendCode).not.toHaveBeenCalled();
  });

  it('refuses a verify when the strict per-email guess throttle is exhausted', async () => {
    const verify = vi.fn(async () => 'do-a');
    const throttle = vi.fn(async (key: string) => !key.startsWith('verify:'));
    const ns = owners().ns;
    const a = auth({ verify, throttle });
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', phone: '+14155550100', code: '123456' }), { TELEGRAM_OWNER_DO: ns, RESPONSIBILITY_RATE_LIMITER: limiter }, a))!;
    expect(await response.text()).toContain('Too many attempts');
    expect(verify).not.toHaveBeenCalled();
    expect(throttle).toHaveBeenCalledWith('verify:owner@example.com', 10, 900);
    expect(throttle).not.toHaveBeenCalledWith('ip:unknown', 30, 900);
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

describe('invite-gated signup', () => {
  it('carries an invite through OTP send and verify and escapes it in the hidden field', async () => {
    const sendCode = vi.fn(async () => true);
    const verify = vi.fn(async () => 'owner-1');
    const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter };
    const signIn = await handleConsole(form('/console/signin', { email: 'invitee@example.com', phone: '+14155550100', invite: ' abc<123 ' }), env, auth({ sendCode, verify }));
    expect(sendCode).toHaveBeenCalledWith('invitee@example.com', 'ABC<123');
    expect(await signIn!.text()).toContain('name="invite" value="ABC&#60;123"');
    const done = await handleConsole(form('/console/verify', { email: 'invitee@example.com', phone: '+14155550100', invite: ' ABC<123 ', code: '123456' }), env, auth({ sendCode, verify }));
    expect(done?.status).toBe(303);
    expect(verify).toHaveBeenCalledWith('invitee@example.com', '123456', '+14155550100', 'ABC<123');
  });

  it('legacy existing-owner signin retains normalized phone fields without asserting provisioning', async () => {
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
    expect(verify).toHaveBeenCalledWith('new@example.com', '123456', '+919876543210', '');
  });

  it('allows code send without a phone, and refuses an un-normalizable supplied phone', async () => {
    const sendCode = vi.fn(async () => true);
    const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit };
    const missing = await handleConsole(form('/console/signin', { email: 'a@b.com' }), env, auth({ sendCode }));
    expect(await missing!.text()).toContain('Email sign-in code');
    const bad = await handleConsole(form('/console/signin', { email: 'a@b.com', phone: 'call me maybe' }), env, auth({ sendCode }));
    expect(await bad!.text()).toContain('Enter your phone number');
    expect(sendCode).toHaveBeenCalledTimes(1);
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
    expect(sendCode).toHaveBeenCalledWith('fresh@x.com', '');
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

it('associates visible legacy labels and preserves a labelled OTP retry after transport failure', async () => {
  const limiter = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;
  const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: limiter };
  const a = auth({ verify: vi.fn(async () => { throw new Error('synthetic timeout'); }) });
  const html = await (await handleConsole(new Request('https://w.test/console/signin'), env, a))!.text();
  for (const control of ['email', 'phone', 'invite']) {
    expect(html).toContain(`<label for="signin-${control}">`);
    expect(html).toContain(`id="signin-${control}" name="${control}"`);
  }
  const failed = (await handleConsole(form('/console/verify', { email: 'person@test.invalid', phone: '+14155550100', code: '123456' }), env, a))!;
  expect(failed.headers.get('set-cookie')).toBeNull();
  const retry = await failed.text();
  expect(retry).toContain('<label for="signin-code">Email sign-in code</label>');
  expect(retry).toContain('Verification is temporarily unavailable');
  expect(a.ownerCookie).not.toHaveBeenCalled();
});

it('keeps editable details after a send refusal without retaining an OTP', async () => {
  const response = await handleConsole(form('/console/signin', {
    email: 'person@test.invalid', phone: 'bad phone', invite: 'A<"B', code: 'synthetic-secret-otp',
  }), { TELEGRAM_OWNER_DO: owners().ns }, auth());
  const html = await response!.text();
  expect(html).toContain('value="person@test.invalid"');
  expect(html).toContain('value="bad phone"');
  expect(html).toContain('value="A&#60;&#34;B"');
  expect(html).not.toContain('synthetic-secret-otp');
});

it('opens populated resend details without requesting or checking a code', async () => {
  const a = auth();
  const limit = vi.fn(async () => ({ success: true }));
  const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit } as unknown as RateLimit };
  const html = await (await handleConsole(form('/console/verify', { email: 'person@test.invalid', phone: '+14155550100', invite: 'ABC', code: 'synthetic-secret-otp' }), env, a))!.text();
  expect(html).toContain('name="intent" value="edit"');
  expect(html).not.toContain('href="/console/signin"');
  expect(html).not.toContain('synthetic-secret-otp');
  vi.clearAllMocks();
  const edited = await (await handleConsole(form('/console/signin', { intent: 'edit', email: 'person@test.invalid', phone: '+14155550100', invite: 'ABC' }), env, a))!.text();
  expect(edited).toContain('id="signin-email" name="email" value="person@test.invalid"');
  expect(edited).toContain('id="signin-phone" name="phone" value="+14155550100"');
  expect(edited).toContain('id="signin-invite" name="invite" value="ABC"');
  expect(a.sendCode).not.toHaveBeenCalled();
  expect(a.verify).not.toHaveBeenCalled();
  expect(a.throttle).not.toHaveBeenCalled();
  expect(limit).not.toHaveBeenCalled();
});

it.each([
  ['email', { email: 'invalid', phone: '+14155550100', invite: 'ABC' }, 'email'],
  ['phone', { email: 'person@test.invalid', phone: 'bad', invite: 'ABC' }, 'phone'],
  ['limiter absent', { email: 'person@test.invalid', phone: '+14155550100', invite: 'ABC' }, 'absent'],
  ['binding throttle', { email: 'person@test.invalid', phone: '+14155550100', invite: 'ABC' }, 'binding'],
  ['durable throttle', { email: 'person@test.invalid', phone: '+14155550100', invite: 'ABC' }, 'durable'],
])('retains details on %s refusal', async (_name, details, mode) => {
  const a = auth({ throttle: vi.fn(async () => mode !== 'durable') });
  const env = { TELEGRAM_OWNER_DO: owners().ns, ...(mode === 'absent' ? {} : { RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: mode !== 'binding' })) } as unknown as RateLimit }) };
  const html = await (await handleConsole(form('/console/signin', details), env, a))!.text();
  for (const value of Object.values(details)) expect(html).toContain(`value="${value}"`);
  expect(a.sendCode).not.toHaveBeenCalled();
});

it('offers explicit loading messages on request, verify and edit forms', async () => {
  const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit };
  const start = await (await handleConsole(new Request('https://w.test/console/signin'), env, auth()))!.text();
  expect(start).toContain('data-pending="Requesting an email code…"');
  const retry = await (await handleConsole(form('/console/verify', { email: 'person@test.invalid', phone: '+14155550100', code: '000000' }), env, auth()))!.text();
  expect(retry).toContain('data-pending="Checking your code…"');
  expect(retry).toContain('data-pending="Opening your details…"');
});

it.each(['send unavailable', 'verify unavailable', 'invalid or expired code', 'invalid verify phone'])('%s preserves retry details and omits the submitted OTP', async mode => {
  const fields = { email: 'person@test.invalid', phone: mode === 'invalid verify phone' ? 'bad phone' : '+14155550100', invite: 'ABC', code: 'synthetic-secret-otp' };
  const a = auth({
    sendCode: async () => { throw new Error('synthetic send unavailable'); },
    verify: async () => { if (mode === 'verify unavailable') throw new Error('synthetic verify unavailable'); return null; },
  });
  const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit };
  const response = (await handleConsole(form(mode === 'send unavailable' ? '/console/signin' : '/console/verify', fields), env, a))!;
  const html = await response.text();
  for (const value of [fields.email, fields.phone, fields.invite]) expect(html).toContain(`value="${value}"`);
  expect(html).not.toContain(fields.code);
  expect(response.headers.get('set-cookie')).toBeNull();
});

it.each([
  'https://evil.test'+downloadTarget, 'https://w.test'+downloadTarget, '//evil.test'+downloadTarget,
  '/console/workspace/%66ile?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1',
  '/console/workspace/../workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1',
  '/console/workspace/%2e%2e/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1',
  downloadTarget+'&id=def993c9-db4d-49c4-8998-8465bed3606e', downloadTarget+'&revision=2',
  downloadTarget+'&extra=1', downloadTarget+'#fragment', downloadTarget+'\n',
  downloadTarget.replace('revision=1', 'revision=0'), downloadTarget.replace('revision=1', 'revision=01'),
  downloadTarget.replace('revision=1', 'revision=9007199254740992'), downloadTarget.replace('id=d', 'id=%64'),
  '/console/workspace/remove',
])('rejects unsafe or noncanonical continuation %s', async target => {
  expect(downloadReturnTarget([target])).toBeNull();
  const response = (await handleConsole(new Request(`https://w.test/console/signin?return_to=${encodeURIComponent(target)}`), { TELEGRAM_OWNER_DO: owners().ns }, auth()))!;
  expect(await response.text()).not.toContain('Continue to download');
});
it('rejects duplicate continuation fields on GET and POST', async () => {
  const query = `return_to=${encodeURIComponent(downloadTarget)}&return_to=${encodeURIComponent(downloadTarget)}`;
  const page = (await handleConsole(new Request(`https://w.test/console/signin?${query}`), { TELEGRAM_OWNER_DO: owners().ns }, auth()))!;
  expect(await page.text()).not.toContain('Continue to download');
  const body = new URLSearchParams({ email: 'owner@example.com', code: '123456' });
  body.append('return_to', downloadTarget); body.append('return_to', downloadTarget);
  const done = (await handleConsole(new Request('https://w.test/console/verify', { method: 'POST', body }),
    { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit }, auth({ verify: async () => 'do-a' })))!;
  expect(done.status).toBe(303); expect(done.headers.get('location')).toBe('/console');
});
it('keeps download intent and recipient across OTP retry, edit and resend', async () => {
  const env = { TELEGRAM_OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit };
  const a = auth();
  for (const fields of [
    { email: 'owner@example.com', return_to: downloadTarget },
    { email: 'owner@example.com', return_to: downloadTarget, code: 'wrong' },
    { email: 'owner@example.com', return_to: downloadTarget, intent: 'edit' },
    { email: 'owner@example.com', return_to: downloadTarget },
  ] as Record<string, string>[]) {
    const page = (await handleConsole(form('code' in fields ? '/console/verify' : '/console/signin', fields), env, a))!;
    const html = await page.text();
    expect(html).toContain('name="return_to" value="'+downloadTarget.replace('&','&#38;')+'"');
    expect(html).toContain('name="email" value="owner@example.com"');
    expect(html).not.toContain('id="signin-download"');
  }
});
