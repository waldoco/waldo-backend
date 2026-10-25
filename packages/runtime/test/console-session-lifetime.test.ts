import { describe, expect, it, vi } from 'vitest';
import { CONSOLE_SESSION_IDLE_MS, CONSOLE_SESSION_LIFETIME_MS, CONSOLE_STEP_UP_MS, consoleAuth } from '../src/identity/console-auth';
import { consoleStepUpRefusal } from '../src/channels/console-step-up';
import * as consoleAuthModule from '../src/identity/console-auth';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';
import { clearConsoleCookie, consoleAccess, consoleCookie, consoleSessionRows, signInPage } from '../src/channels/console';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { consoleCrossSiteRefusal } from '../src/channels/console-cross-site';
import { controlAction, controlRevision } from '../src/channels/dashboard-control-actions';
import type { ConsoleView } from '../src/channels/console';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const memoryStore = () => {
  const data = new Map<string, unknown>();
  const put = vi.fn(async (key: string, value: unknown) => { data.set(key, value); });
  return { data, put, get: async <T>(key: string) => data.get(key) as T | undefined, delete: async (key: string) => data.delete(key) };
};

describe('console session lifetime', () => {
  it('lasts 30 days from sign-in and ends after 7 days without use', () => {
    expect(CONSOLE_SESSION_LIFETIME_MS).toBe(30 * DAY);
    expect(CONSOLE_SESSION_IDLE_MS).toBe(7 * DAY);
  });

  it('both console cookies carry one policy: HttpOnly, Secure, Lax, the console path, and the 30-day lifetime', () => {
    expect(consoleCookie('waldo_console', 'abc')).toBe('waldo_console=abc; Path=/console; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000');
    expect(clearConsoleCookie('waldo_owner')).toBe('waldo_owner=; Path=/console; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  });
});

describe('directory session opened at console sign-in', () => {
  const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const at = 1_790_000_000_000;

  it('opens a console cookie session with the console lifetime, signed so the lifetimes cannot be changed', async () => {
    const fetcher = vi.fn(async () => json(true));
    const cookie = (await consoleAuth(env, fetcher as unknown as typeof fetch, () => at)!.ownerCookie('do-a'))!;
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.test/rest/v1/rpc/console_session_open_for');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const hash = await linkCodeHash(cookie.split('.')[1]!);
    expect(body).toMatchObject({ p_do_name: 'do-a', p_session_hash: hash, p_lifetime_seconds: 2_592_000, p_idle_seconds: 604_800 });
    expect(body.p_sig).toBe(await routerSignature('router', Math.floor(at / 1000), `consolesess.openfor.do-a.${hash}.2592000.604800`));
  });

  it('leaves the app bearer on the existing 12-hour rail', async () => {
    const fetcher = vi.fn(async () => json(true));
    await consoleAuth(env, fetcher as unknown as typeof fetch, () => at)!.ownerAppCredential('do-a');
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://db.test/rest/v1/rpc/console_session_open');
  });

  it('fails sign-in loudly when the long session cannot be opened', async () => {
    expect(await consoleAuth(env, vi.fn(async () => json(false)) as unknown as typeof fetch, () => at)!.ownerCookie('do-a')).toBeNull();
  });
});

describe('owner object console session', () => {
  it('stays signed in past 12 hours while used, and ends 7 days after the last use', async () => {
    let now = 1_000_000;
    const access = consoleAccess(memoryStore(), () => now);
    const token = await access.grant();
    now += 13 * HOUR;
    expect(await access.session(token)).not.toBeNull();
    now += 6 * DAY + 23 * HOUR;
    expect(await access.session(token)).not.toBeNull();
    now += CONSOLE_SESSION_IDLE_MS + 1;
    expect(await access.session(token)).toBeNull();
  });

  it('ends 30 days after sign-in even when used every day', async () => {
    let now = 1_000_000;
    const signedIn = now;
    const access = consoleAccess(memoryStore(), () => now);
    const token = await access.grant();
    while (now + DAY < signedIn + CONSOLE_SESSION_LIFETIME_MS) {
      now += DAY;
      expect(await access.session(token)).not.toBeNull();
    }
    now = signedIn + CONSOLE_SESSION_LIFETIME_MS + 1;
    expect(await access.session(token)).toBeNull();
  });

  it('renews on use at most once an hour, so a polling tab does not write on every request', async () => {
    let now = 1_000_000;
    const store = memoryStore();
    const access = consoleAccess(store, () => now);
    const token = await access.grant();
    store.put.mockClear();
    for (let minute = 0; minute < 59; minute += 1) { now += 60_000; await access.session(token); }
    expect(store.put).not.toHaveBeenCalled();
    now += 2 * 60_000;
    const renewed = await access.session(token);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(renewed?.expires).toBe(now + CONSOLE_SESSION_IDLE_MS);
  });

  it('keeps its token and csrf on renewal and reports when this browser signed in', async () => {
    let now = Date.parse('2026-10-20T00:00:00Z');
    const access = consoleAccess(memoryStore(), () => now);
    const token = await access.grant();
    const first = (await access.session(token))!;
    now += 2 * DAY;
    const later = (await access.session(token))!;
    expect(later.token).toBe(first.token);
    expect(later.csrf).toBe(first.csrf);
    expect(consoleSessionRows([later], later, 'UTC')).toEqual([{ signed_in: '2026-10-20 00:00', until: '2026-10-29 00:00', current: true }]);
  });

  it('a Telegram link redeemed on a signed-in browser starts a new session with both clocks restarted', async () => {
    let now = 1_000_000;
    const access = consoleAccess(memoryStore(), () => now);
    const mint = async () => new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    const token = (await access.redeem(await mint()))!;
    for (let day = 0; day < 29; day += 1) { now += DAY; expect(await access.session(token)).not.toBeNull(); }
    const fresh = (await access.redeem(await mint(), token))!;
    now += 2 * DAY;
    expect(await access.session(token)).toBeNull();
    expect(await access.session(fresh)).not.toBeNull();
  });

  it('sign-out and sign-out everywhere end long sessions, and a later read never revives one', async () => {
    let now = 1_000_000;
    const access = consoleAccess(memoryStore(), () => now);
    const a = await access.grant(), b = await access.grant();
    now += 3 * HOUR;
    await access.signOut(a);
    expect(await access.session(a)).toBeNull();
    expect(await access.session(b)).not.toBeNull();
    await access.signOutAll();
    now += 2 * HOUR;
    expect(await access.session(b)).toBeNull();
    expect(await access.list()).toEqual([]);
  });

  it('a session granted before this change keeps its fixed 12 hours', async () => {
    let now = 1_000_000;
    const store = memoryStore();
    store.data.set('console:sessions', { old: { token: 'old', csrf: 'old-csrf', expires: now + 12 * HOUR } });
    const access = consoleAccess(store, () => now);
    now += 11 * HOUR;
    expect((await access.session('old'))?.expires).toBe(1_000_000 + 12 * HOUR);
    now += 2 * HOUR;
    expect(await access.session('old')).toBeNull();
  });
});

describe('cross-site requests to the console', () => {
  const at = (path: string, method: string, headers: Record<string, string> = {}) => new Request(`https://waldo.test${path}`, { method, headers });
  const sameOrigin = { origin: 'https://waldo.test', 'sec-fetch-site': 'same-origin' };

  it('lets a link from mail or another site open the console, so a Lax cookie lands the owner signed in', () => {
    for (const path of ['/console', '/console/', '/console/signin', '/console/workspace/file?id=x&revision=1', '/console/whatsapp/link/abc'])
      expect(consoleCrossSiteRefusal(at(path, 'GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }))).toBeNull();
  });

  it('refuses every forged write: sign-in, code check, ticket, sign-out, actions and signup', () => {
    for (const path of ['/console', '/console/signin', '/console/verify', '/console/signout-all', '/console/action', '/console/dashboard/api/v1/actions', '/console/signup/send', '/console/workspace/upload']) {
      expect(consoleCrossSiteRefusal(at(path, 'POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' }))?.status, path).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'POST', { origin: 'https://evil.test' }))?.status, `${path} without fetch metadata`).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'POST', { 'sec-fetch-site': 'same-site', origin: 'https://sibling.waldo.test' }))?.status, `${path} from a sibling site`).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'POST', {}))?.status, `${path} with neither header`).toBe(403);
      for (const site of ['cross-site', 'same-site', 'none'])
        expect(consoleCrossSiteRefusal(at(path, 'POST', { 'sec-fetch-site': site }))?.status, `${path} ${site} with Origin stripped`).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'POST', sameOrigin)), `${path} from the console`).toBeNull();
      expect(consoleCrossSiteRefusal(at(path, 'POST', { origin: 'https://waldo.test' })), `${path} from the console, older browser`).toBeNull();
    }
  });

  it('accepts a form the console posts from its own no-referrer page, which says Origin: null', () => {
    for (const path of ['/console', '/console/action', '/console/verify'])
      expect(consoleCrossSiteRefusal(at(path, 'POST', { origin: 'null', 'sec-fetch-site': 'same-origin' })), path).toBeNull();
    for (const site of ['cross-site', 'same-site', 'none'])
      expect(consoleCrossSiteRefusal(at('/console/verify', 'POST', { origin: 'null', 'sec-fetch-site': site }))?.status, site).toBe(403);
    expect(consoleCrossSiteRefusal(at('/console/verify', 'POST', { origin: 'null' }))?.status, 'no fetch metadata').toBe(403);
  });

  it('serves both sign-in entry pages with a same-origin referrer policy, so a browser without fetch metadata still names the console as Origin', async () => {
    expect(signInPage('ab12').headers.get('referrer-policy')).toBe('same-origin');
    const page = await handleConsole(new Request('https://waldo.test/console/signin'), { OWNER_DO: {} as DurableObjectNamespace }, {} as ConsoleAuth);
    expect(page!.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('a same-origin fetch claim with a foreign Origin is still refused', () => {
    expect(consoleCrossSiteRefusal(at('/console/verify', 'POST', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.test' }))?.status).toBe(403);
  });

  it('refuses a cross-site start of the flows a GET begins: MCP, Google and Photon connects and the browser trial', () => {
    for (const path of ['/console/mcp/start/abcDEF123_-xyz', `/console/google/start/${'g'.repeat(43)}`, '/console/imessage/photon/start', '/console/browser/trial']) {
      expect(consoleCrossSiteRefusal(at(path, 'GET', { 'sec-fetch-site': 'cross-site' }))?.status, path).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'GET', { 'sec-fetch-site': 'same-site' }))?.status, path).toBe(403);
      expect(consoleCrossSiteRefusal(at(path, 'GET', { 'sec-fetch-site': 'same-origin' })), path).toBeNull();
      expect(consoleCrossSiteRefusal(at(path, 'GET', { 'sec-fetch-site': 'none' })), `${path} typed or opened from an app`).toBeNull();
    }
  });

  it('leaves every other path alone', () => {
    for (const path of ['/app/v1/chat', '/oauth/google/callback', '/consoles', '/c/abc', '/healthz'])
      expect(consoleCrossSiteRefusal(at(path, 'POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' })), path).toBeNull();
  });
});

describe('control receipts in a long session', () => {
  const day = { version: 1, view: 'day', state: 'available', csrf: 'csrf', data: { timezone: 'UTC', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } };
  const form = (revision: string, id: string) => { const f = new FormData(); for (const [k, v] of Object.entries({ csrf: 'csrf', revision, view: 'day', request_id: id, action: 'timezone.set', value: 'UTC' })) f.set(k, v); return f; };
  const setup = (start: number) => {
    const rows = new Map<string, unknown>();
    const act = vi.fn(async (): Promise<boolean | string> => true);
    const deps = { csrf: 'csrf', expires: start + CONSOLE_SESSION_IDLE_MS, sessions: async () => [{ csrf: 'csrf', expires: deps.expires }], projection: async () => day,
      view: async () => ({ cards: [], proactivity: day.data.proactivity }) as unknown as ConsoleView, act,
      store: { get: async <T>(k: string) => rows.get(k) as T | undefined, put: async (k: string, v: unknown) => { rows.set(k, v); } } };
    return { act, deps };
  };

  it('keeps duplicate protection for 12 hours, then lets the session make new changes instead of locking it for weeks', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const { act, deps } = setup(start);
      const revision = await controlRevision(day);
      for (let i = 0; i < 100; i += 1) expect((await controlAction(form(revision, `request-${String(i).padStart(4, '0')}`), deps)).status).toBe(200);
      expect((await controlAction(form(revision, 'request-0100'), deps)).status).toBe(429);
      clock.mockReturnValue(start + 11 * HOUR);
      deps.expires = start + 11 * HOUR + CONSOLE_SESSION_IDLE_MS;
      expect(await (await controlAction(form(revision, 'request-0000'), deps)).json()).toMatchObject({ duplicate: true });
      clock.mockReturnValue(start + 12 * HOUR + 1);
      deps.expires = start + 12 * HOUR + 1 + CONSOLE_SESSION_IDLE_MS;
      expect((await controlAction(form(revision, 'request-0100'), deps)).status).toBe(200);
      expect(act).toHaveBeenCalledTimes(101);
    } finally { clock.mockRestore(); }
  });
});

const FIVE_MINUTES = 5 * 60_000;

// By owner ruling, a sign-in in a browser that holds a live session (a confirm, among others) does not end that session:
// only the new one carries the code, and the old one keeps ordinary access for 5 minutes so a running turn finishes.
describe('a new sign-in in a browser lets that browser\'s old session run out', () => {
  const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
  const at = 1_790_000_000_000;
  const directory = (answer: (name: string) => unknown = () => true) => {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const name = url.split('/rpc/')[1]!;
      calls.push({ name, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(answer(name)));
    });
    return { calls, auth: consoleAuth(env, fetcher as unknown as typeof fetch, () => at)! };
  };
  const presenting = (cookie: string) => new Request('https://w.test/console/verify', { method: 'POST', headers: { cookie } });

  it('runs out five minutes after the sign-in that replaced it', () => {
    expect((consoleAuthModule as Record<string, unknown>).CONSOLE_REPLACED_SESSION_MS).toBe(FIVE_MINUTES);
  });

  it('a link redeemed in a signed-in browser issues a new token; the old one keeps ordinary access, without the code, for five minutes', async () => {
    let now = at;
    const access = consoleAccess(memoryStore(), () => now);
    const old = await access.grant();
    const before = (await access.session(old))!;
    const link = new URL(await access.mintLink('https://w.test')).searchParams.get('t')!;
    now += 60_000;
    const fresh = (await access.redeem(link, old))!;
    expect(fresh).not.toBe(old);
    const capped = (await access.session(old))!;
    expect(capped).toMatchObject({ token: old, csrf: before.csrf, expires: now + FIVE_MINUTES });
    expect(capped.verified_at).toBeUndefined();
    const after = (await access.session(fresh))!;
    expect(after.csrf).not.toBe(before.csrf);
    expect(after.signed_in).toBe(now);
    expect(after.verified_at).toBe(at);
    expect(await access.list()).toHaveLength(2);
    now += FIVE_MINUTES;
    expect(await access.session(old)).not.toBeNull();
    now += 1;
    expect(await access.session(old)).toBeNull();
    expect(await access.session(fresh)).not.toBeNull();
  });

  it('an email sign-in in a signed-in browser caps that browser\'s old owner object session and no other', async () => {
    let now = at;
    const access = consoleAccess(memoryStore(), () => now);
    const old = await access.grant();
    const otherBrowser = await access.grant();
    now += 60_000;
    const fresh = await access.grant(old);
    const capped = await access.session(old);
    expect(capped).toMatchObject({ expires: now + FIVE_MINUTES });
    expect(capped?.verified_at).toBeUndefined();
    expect(await access.session(otherBrowser)).toMatchObject({ verified_at: at });
    expect((await access.session(fresh))!.verified_at).toBe(now);
    expect(await access.list()).toHaveLength(3);
  });

  it('a capped session is never renewed past its cap, and a second sign-in never lengthens it', async () => {
    let now = at;
    const access = consoleAccess(memoryStore(), () => now);
    const old = await access.grant();
    now += 60_000;
    await access.grant(old);
    const cap = now + FIVE_MINUTES;
    now += 2 * 60_000;
    expect(await access.session(old)).toMatchObject({ expires: cap });
    await access.grant(old);
    expect(await access.session(old)).toMatchObject({ expires: cap });
    now = cap + 1;
    expect(await access.session(old)).toBeNull();
  });

  it('sign-out and sign-out everywhere still end a capped session at once', async () => {
    let now = at;
    const access = consoleAccess(memoryStore(), () => now);
    const old = await access.grant();
    const fresh = await access.grant(old);
    await access.signOut(old);
    expect(await access.session(old)).toBeNull();
    const again = await access.grant(fresh);
    await access.signOutAll();
    expect(await access.session(fresh)).toBeNull();
    expect(await access.session(again)).toBeNull();
  });

  it('caps the directory row of the owner cookie the browser presented, before opening the new one', async () => {
    const d = directory();
    const presented = (await d.auth.ownerCookie('do-a'))!;
    d.calls.length = 0;
    const fresh = (await d.auth.ownerCookie('do-a', presenting(`waldo_owner=${presented}`)))!;
    expect(fresh).not.toBe(presented);
    expect(d.calls.map(call => call.name)).toEqual(['console_session_cap', 'console_session_open_for']);
    const hash = await linkCodeHash(presented.split('.')[1]!);
    expect(d.calls[0]!.body).toMatchObject({ p_do_name: 'do-a', p_session_hash: hash });
    expect(d.calls[0]!.body.p_sig).toBe(await routerSignature('router', d.calls[0]!.body.p_at as number, `consolesess.cap.do-a.${hash}`));
  });

  it('caps another owner\'s row the same way, and leaves a cookie it cannot verify alone', async () => {
    const d = directory();
    const otherOwner = (await d.auth.ownerCookie('do-b'))!;
    d.calls.length = 0;
    expect(await d.auth.ownerCookie('do-a', presenting(`waldo_owner=${otherOwner}`))).not.toBeNull();
    expect(d.calls.map(call => call.name)).toEqual(['console_session_cap', 'console_session_open_for']);
    expect(d.calls[0]!.body).toMatchObject({ p_do_name: 'do-b', p_session_hash: await linkCodeHash(otherOwner.split('.')[1]!) });
    for (const cookie of ['waldo_owner=do-a.forged.0000', 'waldo_console=only']) {
      d.calls.length = 0;
      expect(await d.auth.ownerCookie('do-a', presenting(cookie))).not.toBeNull();
      expect(d.calls.map(call => call.name), cookie).toEqual(['console_session_open_for']);
    }
  });

  it('opens no new session when the presented row cannot be capped', async () => {
    const presented = (await directory().auth.ownerCookie('do-a'))!;
    const d = directory(name => name === 'console_session_cap' ? null : true);
    await expect(d.auth.ownerCookie('do-a', presenting(`waldo_owner=${presented}`))).rejects.toThrow();
    expect(d.calls.map(call => call.name)).toEqual(['console_session_cap']);
  });
});

describe('a request another site started renews no session', () => {
  const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
  const at = 1_790_000_000_000;

  it('the owner object reads such a session without renewing it', async () => {
    let now = at;
    const store = memoryStore();
    const access = consoleAccess(store, () => now);
    const token = await access.grant();
    now += DAY;
    store.put.mockClear();
    expect(await access.session(token, false)).not.toBeNull();
    expect(store.put).not.toHaveBeenCalled();
    expect((await access.session(token))!.expires).toBe(now + CONSOLE_SESSION_IDLE_MS);
  });

  it('the directory checks such a cookie against the live sessions without touching it', async () => {
    const names: string[] = [];
    let listed: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const name = url.split('/rpc/')[1]!;
      names.push(name);
      if (name === 'console_session_open_for') listed.push(String((JSON.parse(String(init.body)) as { p_session_hash: string }).p_session_hash));
      if (name === 'console_session_list') return new Response(JSON.stringify(listed.map(session => ({ session, created_at: '2026-10-23T00:00:00Z', last_seen_at: '2026-10-23T00:00:00Z' }))));
      return new Response('true');
    });
    const auth = consoleAuth(env, fetcher as unknown as typeof fetch, () => at)!;
    const cookie = `waldo_owner=${(await auth.ownerCookie('do-a'))!}`;
    for (const site of ['cross-site', 'same-site']) {
      names.length = 0;
      expect(await auth.readOwnerCookie(new Request('https://w.test/console', { headers: { cookie, 'sec-fetch-site': site } })), site).toBe('do-a');
      expect(names, site).toEqual(['console_session_list']);
    }
    listed = [];
    expect(await auth.readOwnerCookie(new Request('https://w.test/console', { headers: { cookie, 'sec-fetch-site': 'cross-site' } }))).toBeNull();
    for (const headers of [{ cookie }, { cookie, 'sec-fetch-site': 'same-origin' }, { cookie, 'sec-fetch-site': 'none' }] as Record<string, string>[]) {
      names.length = 0;
      await auth.readOwnerCookie(new Request('https://w.test/console', { headers }));
      expect(names).toEqual(['console_session_touch']);
    }
  });
});

describe('when the browser last proved an email code', () => {
  it('an email-code grant records the time; a link sign-in does not', async () => {
    let now = 1_790_000_000_000;
    const access = consoleAccess(memoryStore(), () => now);
    const byCode = await access.grant();
    expect((await access.session(byCode))!.verified_at).toBe(now);
    now += 60_000;
    const link = new URL(await access.mintLink('https://w.test')).searchParams.get('t')!;
    const byLink = (await access.redeem(link))!;
    expect((await access.session(byLink))!.verified_at).toBeUndefined();
  });

  it('a link redeemed in a browser that proved a code keeps that code\'s time; a new code replaces it', async () => {
    let now = 1_790_000_000_000;
    const access = consoleAccess(memoryStore(), () => now);
    const proved = now;
    const first = await access.grant();
    now += 30 * 60_000;
    const link = new URL(await access.mintLink('https://w.test')).searchParams.get('t')!;
    const relinked = (await access.redeem(link, first))!;
    expect((await access.session(relinked))!.verified_at).toBe(proved);
    now += 60_000;
    const again = await access.grant(relinked);
    expect((await access.session(again))!.verified_at).toBe(now);
  });

  it('renewing a session by use never moves the time of the code', async () => {
    let now = 1_790_000_000_000;
    const store = memoryStore();
    const access = consoleAccess(store, () => now);
    const proved = now;
    const token = await access.grant();
    now += 2 * DAY;
    const renewed = (await access.session(token))!;
    expect(renewed.expires).toBe(now + CONSOLE_SESSION_IDLE_MS);
    expect(renewed.verified_at).toBe(proved);
    expect((store.data.get('console:sessions') as Record<string, { verified_at?: number }>)[token]!.verified_at).toBe(proved);
  });

  it('a code counts for two hours and not a millisecond more', async () => {
    expect(CONSOLE_STEP_UP_MS).toBe(2 * HOUR);
    const now = 1_790_000_000_000;
    const pair = () => new Request(`https://w.test${CONTROL_ACTION_PATH}`, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ view: 'devices', action: 'device.pair' }) });
    const session = (verified_at: number) => ({ token: 't', csrf: 'c', expires: now + HOUR, signed_in: verified_at, verified_at });
    expect(await consoleStepUpRefusal(pair(), session(now - CONSOLE_STEP_UP_MS + 1), now)).toBeNull();
    const refused = await consoleStepUpRefusal(pair(), session(now - CONSOLE_STEP_UP_MS), now);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ error: 'step_up_required' });
  });
});
