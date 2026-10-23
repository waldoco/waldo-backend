import { describe, expect, it, vi } from 'vitest';
import { handleSignup } from '../src/channels/console-signup';
import { signupAuth } from '../src/identity/console-signup';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Sign-up asks for a name and a phone after the email is verified. The phone is unverified contact data until the owner
// texts their link code to Waldo from it; nothing is sent to it at sign-up.
const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'test-router', RESPONSIBILITY_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const cookieFrom = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!;
const post = (path: string, values: Record<string, string>, cookie = '') =>
  new Request(`https://w.test/console/signup${path}`, { method: 'POST', headers: { origin: 'https://w.test', cookie }, body: new URLSearchParams(values) });

const setup = (options: { profileStatus?: () => number; joinFails?: boolean } = {}) => {
  const signups: Record<string, string>[] = [], profiles: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/signup_owner_for_auth')) {
      signups.push(JSON.parse(String(init?.body)));
      return options.joinFails ? json({ code: 'XX000', message: 'internal error' }, 500) : json('owner-new');
    }
    if (url.includes('/rpc/')) return json(true);
    if (url.endsWith('/verify')) return json({ user: { id: 'u-1', email: 'person@example.com', email_confirmed_at: '2026-10-01Z' } });
    return json({});
  });
  const owner = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    if (new URL(String(input)).pathname !== '/signup-profile') return new Response('console-ticket');
    profiles.push({ name: JSON.parse(String(init?.body)).name, doName: new Headers(init?.headers).get('x-waldo-do-name') });
    return new Response(null, { status: options.profileStatus?.() ?? 204 });
  });
  const e = { ...env, OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: owner }) } as unknown as DurableObjectNamespace };
  const a = { sendCode: vi.fn(async () => true), throttle: vi.fn(async () => true), ownerCookie: vi.fn(async () => 'owner-session') } as unknown as ConsoleAuth;
  return { e, a, signup: signupAuth(e, fetcher)!, fetcher, signups, profiles };
};
const verified = async (s: ReturnType<typeof setup>) => {
  const sent = await handleSignup(post('/send', { email: 'person@example.com', invite: 'ABCDEFGHJKLMNPQRSTUV' }), s.e, s.a, s.signup);
  const draft = cookieFrom(sent);
  const progress = (await s.signup.read(new Request('https://w.test/console/signup', { headers: { cookie: draft } })))!;
  return { cookie: cookieFrom(await handleSignup(post('/verify', { csrf: progress.csrf, code: '123456' }, draft), s.e, s.a, s.signup)), csrf: progress.csrf };
};
const finish = (s: ReturnType<typeof setup>, v: Awaited<ReturnType<typeof verified>>, values: Record<string, string>) =>
  handleSignup(post('/complete', { csrf: v.csrf, ...values }, v.cookie), s.e, s.a, s.signup);

describe('sign-up asks for a name and a phone', () => {
  it('shows both on the finish step, and says the phone is checked later by texting Waldo from it', async () => {
    const s = setup(), v = await verified(s);
    const html = await (await handleSignup(new Request('https://w.test/console/signup', { headers: { cookie: v.cookie } }), s.e, s.a, s.signup)).text();
    expect(html).toMatch(/<input id="name" name="name"[^>]*autocomplete="given-name"[^>]*required/);
    expect(html).toMatch(/<input id="phone" name="phone" type="tel"[^>]*autocomplete="tel"[^>]*required/);
    expect(html).toContain('the first time you text your link code to Waldo from it');
    expect(html).toContain('Nothing is sent to this number now');
  });
  it('refuses to finish without a phone, or with one missing its country code, and creates no owner', async () => {
    const s = setup(), v = await verified(s);
    for (const phone of ['', '98765 43210', '+0 1234567']) {
      const refused = await finish(s, v, { name: 'Asha Menon', phone });
      expect(refused.status).toBe(200);
      expect(await refused.text()).toContain('Enter what Waldo should call you, and your phone with its country code');
    }
    expect(s.signups).toEqual([]);
    expect(s.profiles).toEqual([]);
  });
  it('refuses to finish without a name, or with one too long or carrying control characters', async () => {
    const s = setup(), v = await verified(s);
    for (const name of ['', '   ', 'a'.repeat(81), 'Asha\u0007Menon', 'Asha\nMenon']) {
      expect(await (await finish(s, v, { name, phone: '+919876543210' })).text()).toContain('Enter what Waldo should call you, and your phone with its country code');
    }
    expect(s.signups).toEqual([]);
  });
  it('creates the owner with the phone, records the name in the owner object, and opens the welcome page', async () => {
    const s = setup(), v = await verified(s);
    const done = await finish(s, v, { name: '  Asha   Menon ', phone: '+91 98765 43210' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/console/signup/welcome');
    expect(s.signups).toMatchObject([{ p_auth_user: 'u-1', p_email: 'person@example.com', p_phone: '+919876543210' }]);
    expect(s.profiles).toEqual([{ name: 'Asha Menon', doName: 'owner-new' }]);
    const cookies = done.headers.get('set-cookie')!;
    expect(cookies).toContain('waldo_owner=owner-session');
    expect(cookies).toContain('waldo_console=console-ticket');
  });
  it('keeps the verified progress when the name cannot be recorded, and a retry finishes without another email code', async () => {
    let profileStatus = 503;
    const s = setup({ profileStatus: () => profileStatus }), v = await verified(s);
    const failed = await finish(s, v, { name: 'Asha Menon', phone: '+919876543210' });
    expect(failed.status).toBe(200);
    expect(await failed.text()).toContain('temporarily unavailable');
    const retained = cookieFrom(failed);
    expect(await s.signup.read(new Request('https://w.test/console/signup', { headers: { cookie: retained } }))).toMatchObject({ name: 'Asha Menon', phone: '+919876543210' });
    profileStatus = 204;
    const retried = await handleSignup(post('/complete', { csrf: v.csrf, name: 'Asha Menon', phone: '+919876543210' }, retained), s.e, s.a, s.signup);
    expect(retried.status).toBe(303);
    expect(s.fetcher.mock.calls.filter(call => String(call[0]).endsWith('/verify'))).toHaveLength(1);
  });
  it('offers Google and phone verification as optional next steps, through the console flows that exist', async () => {
    const s = setup();
    const welcome = await handleSignup(new Request('https://w.test/console/signup/welcome'), s.e, s.a, s.signup);
    expect(welcome.status).toBe(200);
    const html = await welcome.text();
    expect(html).toContain('href="/console#/connections">Connect Google');
    expect(html).toContain('href="/console#/connections/imessage">');
    expect(html).toContain('href="/console">');
    expect(html).not.toMatch(/src="https?:/);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
});

describe('the sign-up phone stays out of the logs', () => {
  const PHONE = '+919876543210';
  const captured = () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); }));
    return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
  };
  for (const [label, options] of [['a sign-up that finishes', {}], ['a join the directory refuses', { joinFails: true }], ['a name the owner object cannot take', { profileStatus: () => 503 }]] as const) {
    it(`logs nothing carrying it on ${label}`, async () => {
      const s = setup(options), v = await verified(s), log = captured();
      try {
        await finish(s, v, { name: 'Asha Menon', phone: PHONE });
        expect(s.signups).toHaveLength(1);
        expect(log.lines.filter(line => line.includes('9876543210'))).toEqual([]);
      } finally { log.restore(); }
    });
  }
});
