import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appAuthOptionsV1Schema, appIdTokenResultV1Schema, appVerifyResultV1Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { consoleAuth } from '../src/identity/console-auth';
import { OPEN_SIGNUP_EMAIL_DAILY_LIMIT, OPEN_SIGNUP_FALLBACK_CEILING_USD, OPEN_SIGNUP_IP_DAILY_LIMIT, openOwnerCeilingUsd, openSignupCaps } from '../src/identity/open-signup';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';
import { verifiedOpenOwnerMark } from '../src/identity/open-owner-hold';

const SECRET = 'fictional-open-signup-router-secret-0000000000', DIRECTORY = 'https://open-signup.fixture.invalid', KEY = 'fictional-public-key';
const NEWCOMER = 'newcomer@example.test', MEMBER = 'member@example.test', INVITED = 'invited@example.test', INVITE = 'ABCDEFGHJKLMNPQRSTUV';
const NONCE = 'raw-nonce-0123456789abcdef', CODE = '123456', IP = '203.0.113.9';
const OPEN = { OPEN_SIGNUP: '1', OPEN_SIGNUP_DAILY_CAP: '2', OPEN_SIGNUP_TOTAL_CAP: '3', APP_AGREEMENTS: '1', WALDO_COST_LEDGER_SYNC: 'on' };

const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// A fictional Supabase and owner directory that answer as the SQL does: the open join counts the day's and all-time joins
// against the signed caps, refuses an address another owner row holds, and trusts the identity that joined.
const directory = async () => {
  const inviteHash = await linkCodeHash(INVITE);
  const state = {
    users: new Map<string, string>(), owners: new Map<string, { auth: string; doName: string; open: boolean }>(), held: new Set<string>(),
    trusted: new Set<string>(), joinsToday: 0, joinsEver: 0, attempts: new Map<string, number>(), otp: [] as string[], calls: [] as string[],
    inviteLive: true, live: new Set<string>(), invitedByEmail: new Set<string>(), marks: [] as string[], markStatus: 204,
  };
  const userFor = (email: string) => { if (!state.users.has(email)) state.users.set(email, crypto.randomUUID()); return state.users.get(email)!; };
  const token = (provider: 'apple' | 'google', email: string) => `fixture.${base64url(new TextEncoder().encode(JSON.stringify({ sub: `${provider}-${email}`, email })))}.signature`;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), a = JSON.parse(String(init?.body));
    expect(url.origin).toBe(DIRECTORY);
    if (url.pathname === '/auth/v1/otp') { state.otp.push(a.email); return Response.json({}); }
    if (url.pathname === '/auth/v1/verify') {
      if (a.token !== CODE) return new Response('', { status: 403 });
      return Response.json({ user: { id: userFor(a.email), email: a.email } });
    }
    if (url.pathname === '/auth/v1/token') {
      const claims = JSON.parse(atob(a.id_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { email: string };
      const id = userFor(claims.email);
      return Response.json({ access_token: 'fixture-access', user: { id, email: claims.email, email_confirmed_at: new Date().toISOString(), identities: [] } });
    }
    const fn = url.pathname.split('/').at(-1)!;
    state.calls.push(fn);
    const signed: Record<string, string> = {
      console_auth_throttle: `throttle.${a.p_key}.${a.p_limit}.${a.p_window_seconds}`, signin_allowed: `signin.${a.p_email}.${a.p_code_hash}`,
      owner_for_auth: `owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`, signup_owner_for_auth: `signup.owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`,
      signup_owner_with_signin_identity: `signinid.signup.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}.${a.p_phone}.${a.p_code_hash}`,
      signin_identity_trusted: `signinid.trusted.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}`,
      signup_owner_open: `signup.open.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}.${a.p_phone}.${a.p_daily_cap}.${a.p_total_cap}`,
      open_signup_room: `signup.open.room.${a.p_daily_cap}.${a.p_total_cap}`, open_signup_throttle: `signup.open.throttle.${a.p_key}.${a.p_limit}`,
      console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`,
      open_owner_state: `openowner.state.${a.p_do_name}`, console_session_inventory: `consolesess.inventory.${a.p_do_name}`, app_session_rotate: `appsess.rotate.${a.p_do_name}.${a.p_session_hash}.${a.p_new_session_hash}`,
    };
    expect(signed[fn], `unlisted fixture RPC ${fn}`).toBeDefined();
    expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
    const owner = state.owners.get(a.p_email);
    if (fn === 'console_auth_throttle') return Response.json(true);
    if (fn === 'signin_allowed') return Response.json(state.owners.has(a.p_email) || (a.p_email === INVITED && a.p_code_hash === inviteHash));
    if (fn === 'owner_for_auth') return Response.json(owner && owner.auth === a.p_auth_user ? owner.doName : null);
    if (fn === 'signin_identity_trusted') return Response.json(state.trusted.has(`${owner?.doName}|${a.p_provider}|${a.p_subject}`));
    if (fn === 'signup_owner_for_auth' || fn === 'signup_owner_with_signin_identity') {
      if (!(state.inviteLive && a.p_email === INVITED && a.p_code_hash === inviteHash)) return Response.json(null);
      state.inviteLive = false;
      const doName = `owner-${crypto.randomUUID()}`;
      state.owners.set(a.p_email, { auth: a.p_auth_user, doName, open: false });
      return fn === 'signup_owner_for_auth' ? Response.json(doName) : Response.json({ do_name: doName, created: true });
    }
    if (fn === 'open_signup_throttle') {
      const used = (state.attempts.get(a.p_key) ?? 0) + 1;
      state.attempts.set(a.p_key, used);
      return Response.json(used <= a.p_limit);
    }
    if (fn === 'open_owner_state') {
      const found = [...state.owners.values()].find(row => row.doName === a.p_do_name);
      return Response.json(found ? found.open ? 'held' : 'member' : null);
    }
    if (fn === 'open_signup_room') return Response.json(state.joinsToday < a.p_daily_cap && state.joinsEver < a.p_total_cap);
    if (fn === 'signup_owner_open') {
      if (owner) return Response.json(owner.auth === a.p_auth_user ? { do_name: owner.doName, created: false } : { refused: 'taken' });
      if (state.invitedByEmail.delete(a.p_email)) {
        const doName = `owner-${crypto.randomUUID()}`;
        state.owners.set(a.p_email, { auth: a.p_auth_user, doName, open: false });
        return Response.json({ do_name: doName, created: true });
      }
      if (!(state.joinsToday < a.p_daily_cap && state.joinsEver < a.p_total_cap)) return Response.json({ refused: 'cap' });
      const doName = `owner-${crypto.randomUUID()}`;
      state.owners.set(a.p_email, { auth: a.p_auth_user, doName, open: true });
      state.held.add(doName);
      if (a.p_provider) state.trusted.add(`${doName}|${a.p_provider}|${a.p_subject}`);
      state.joinsToday += 1; state.joinsEver += 1;
      return Response.json({ do_name: doName, created: true });
    }
    if (fn === 'console_session_open') { state.live.add(`${a.p_do_name}:${a.p_session_hash}`); return Response.json(true); }
    if (fn === 'app_session_rotate') return Response.json(false);
    return Response.json([...state.live].filter(row => row.startsWith(`${a.p_do_name}:`)).map(row => ({ session: row.split(':')[1], created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date().toISOString() })));
  });
  const member = (email = MEMBER) => { state.owners.set(email, { auth: userFor(email), doName: `owner-${crypto.randomUUID()}`, open: false }); };
  const settings = { ...env, SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: KEY, WALDO_ROUTER_HMAC_SECRET: SECRET, APP_ID_TOKEN_SIGNIN: '1',
    RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const auth = consoleAuth(settings, fetcher as typeof fetch)!;
  // The owner objects, as far as a sign-in reaches them: the Worker's mark, checked against the router secret.
  const owners = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
    expect(await verifiedOpenOwnerMark(request, SECRET, value => value === name)).toBe(true);
    state.calls.push('mark');
    state.marks.push(name);
    return new Response(null, { status: state.markStatus });
  } }) };
  const app = async (path: string, body: unknown, overrides: Record<string, string> = {}, ip = IP) => {
    const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }),
      { ...settings, OWNER_DO: owners, ...overrides } as never, auth);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  return { app, state, member, token };
};
const google = (id_token: string, extra: Record<string, unknown> = {}) => ({ provider: 'google', id_token, nonce: NONCE, request_id: 'signin-request-1', ...extra });
const captureLogs = () => {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); }));
  return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
};

describe('open sign-up in the app', () => {
  it('with the flag off, joining still takes an invite on every path, and nothing open is asked for', async () => {
    const { app, state, token } = await directory();
    expect(await app('/auth/code', { email: NEWCOMER })).toEqual({ status: 200, body: { ok: true } });
    expect(state.otp).toEqual([]);
    expect((await app('/auth/verify', { email: NEWCOMER, code: CODE })).body).toEqual({ state: 'needs_invite' });
    expect((await app('/auth/id_token', google(token('google', NEWCOMER)))).body).toEqual({ state: 'needs_invite' });
    expect(state.owners.has(NEWCOMER)).toBe(false);
    expect(state.calls.filter(fn => fn.startsWith('open_') || fn === 'signup_owner_open' || fn === 'mark')).toEqual([]);
  });

  it('stays off, and says so without an address, while the agreements or the spend ledger are off or a cap is malformed', async () => {
    for (const broken of [{ APP_AGREEMENTS: '0' }, { WALDO_COST_LEDGER_SYNC: 'off' }, { OPEN_SIGNUP_DAILY_CAP: '0' }, { OPEN_SIGNUP_TOTAL_CAP: 'ten' }]) {
      const { app, state, token } = await directory();
      const logs = captureLogs();
      try {
        expect((await app('/auth/id_token', google(token('google', NEWCOMER)), { ...OPEN, ...broken })).body).toEqual({ state: 'needs_invite' });
        expect(state.owners.has(NEWCOMER)).toBe(false);
        expect(logs.lines.some(line => line.includes('open_signup_misconfigured'))).toBe(true);
        expect(logs.lines.join('\n')).not.toContain(NEWCOMER);
      } finally { logs.restore(); }
    }
  });

  it('joins a newcomer through Google with no invite, as an open owner whose identity signs them in next time', async () => {
    const { app, state, token } = await directory();
    const joined = await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN);
    expect(joined.status).toBe(200);
    expect(appIdTokenResultV1Schema.safeParse(joined.body).success).toBe(true);
    expect(joined.body).toMatchObject({ state: 'active', surface: 'app' });
    const owner = state.owners.get(NEWCOMER)!;
    expect(owner.open).toBe(true);
    expect(state.trusted.has(`${owner.doName}|google|google-${NEWCOMER}`)).toBe(true);
    // The owner object is marked before the session is opened, so no credential reaches the owner ahead of their hold.
    expect(state.marks).toEqual([owner.doName]);
    expect(state.calls.indexOf('mark')).toBeLessThan(state.calls.indexOf('console_session_open'));
    const again = await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN);
    expect(again.body).toMatchObject({ state: 'active' });
    expect(state.joinsEver).toBe(1);
  });

  it('emails a code to a newcomer while a join fits, and joins them on the code', async () => {
    const { app, state } = await directory();
    expect(await app('/auth/code', { email: NEWCOMER }, OPEN)).toEqual({ status: 200, body: { ok: true } });
    expect(state.otp).toEqual([NEWCOMER]);
    const verified = await app('/auth/verify', { email: NEWCOMER, code: CODE }, OPEN);
    expect(appVerifyResultV1Schema.safeParse(verified.body).success).toBe(true);
    expect(verified.body).toMatchObject({ state: 'active' });
    expect(state.owners.get(NEWCOMER)?.open).toBe(true);
  });

  it('a person whose invite is addressed to their email joins as invited without its code, and is not marked as open', async () => {
    const { app, state, token } = await directory();
    state.invitedByEmail.add(NEWCOMER);
    expect((await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN)).body).toMatchObject({ state: 'active' });
    expect(state.owners.get(NEWCOMER)).toMatchObject({ open: false });
    expect(state.marks).toEqual([]);
  });

  it('a sign-in whose owner object cannot be marked opens no session', async () => {
    const { app, state, token } = await directory();
    state.markStatus = 503;
    expect(await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN)).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(state.calls).not.toContain('console_session_open');
    // The join committed; the retry finds the owner, marks it, and only then opens the session.
    state.markStatus = 204;
    expect((await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN)).body).toMatchObject({ state: 'active' });
    expect(state.marks).toHaveLength(2);
    expect(state.joinsEver).toBe(1);
  });

  it('spends an invite first when one is sent, so the one who sent it stays named', async () => {
    const { app, state } = await directory();
    const verified = await app('/auth/verify', { email: INVITED, code: CODE, invite: INVITE }, OPEN);
    expect(verified.body).toMatchObject({ state: 'active' });
    expect(state.owners.get(INVITED)).toMatchObject({ open: false });
    expect(state.inviteLive).toBe(false);
    expect(state.calls).not.toContain('signup_owner_open');
  });

  it('a member signs in as before and is never joined again', async () => {
    const { app, state, member } = await directory();
    member();
    expect((await app('/auth/verify', { email: MEMBER, code: CODE }, OPEN)).body).toMatchObject({ state: 'active' });
    expect(state.calls).not.toContain('signup_owner_open');
    expect(state.calls).not.toContain('open_signup_throttle');
    expect(state.marks).toEqual([]);
  });

  it('once the day is full: no code goes out, and a join answers needs_invite, logged by code alone', async () => {
    const { app, state, token } = await directory();
    state.joinsToday = 2;
    const logs = captureLogs();
    try {
      expect(await app('/auth/code', { email: NEWCOMER }, OPEN)).toEqual({ status: 200, body: { ok: true } });
      expect(state.otp).toEqual([]);
      expect((await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN)).body).toEqual({ state: 'needs_invite' });
      expect(state.owners.has(NEWCOMER)).toBe(false);
      expect(logs.lines.some(line => line.includes('open_signup_cap'))).toBe(true);
      expect(logs.lines.join('\n')).not.toContain(NEWCOMER);
      expect(logs.lines.join('\n')).not.toContain('fixture.');
    } finally { logs.restore(); }
  });

  it('refuses an address another owner row holds, without a second tenant or a retryable error', async () => {
    const { app, state, token } = await directory();
    state.owners.set(NEWCOMER, { auth: 'someone-else', doName: 'owner-suspended', open: false });
    const answer = await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN);
    expect(answer).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.get(NEWCOMER)?.doName).toBe('owner-suspended');
  });

  it('limits open joins per address and per email per day', async () => {
    const { app, state, token } = await directory();
    state.joinsToday = -100; state.joinsEver = -100;
    for (let i = 0; i < OPEN_SIGNUP_IP_DAILY_LIMIT; i += 1)
      expect((await app('/auth/id_token', google(token('google', `person${i}@example.test`)), OPEN)).body).toMatchObject({ state: 'active' });
    expect((await app('/auth/id_token', google(token('google', 'one.more@example.test')), OPEN)).body).toEqual({ state: 'needs_invite' });
    expect(state.owners.has('one.more@example.test')).toBe(false);
    // The same email from fresh addresses: its own limit, keyed by the email's digest, never the address itself.
    state.owners.set('taken@example.test', { auth: 'someone-else', doName: 'owner-taken', open: false });
    for (let i = 0; i < OPEN_SIGNUP_EMAIL_DAILY_LIMIT; i += 1) await app('/auth/id_token', google(token('google', 'taken@example.test')), OPEN, `198.51.100.${i}`);
    const before = state.calls.filter(fn => fn === 'signup_owner_open').length;
    await app('/auth/id_token', google(token('google', 'taken@example.test')), OPEN, '198.51.100.200');
    expect(state.calls.filter(fn => fn === 'signup_owner_open').length).toBe(before);
    // Keyed by the router secret: a plain digest of the email names no key.
    expect([...state.attempts.keys()]).toContain(`email.${await routerSignature(SECRET, 0, 'openthrottle.taken@example.test')}`);
    expect([...state.attempts.keys()]).not.toContain(`email.${await sha('taken@example.test')}`);
    expect([...state.attempts.keys()].join(',')).not.toContain('taken@example.test');
    expect([...state.attempts.keys()].join(',')).not.toContain(IP);
  });
});

describe('the sign-up screen asks the server first', () => {
  it('says open only while open sign-up is on with its preconditions, and asks no directory', async () => {
    const { state } = await directory();
    const options = async (overrides: Record<string, string>) => {
      const response = await handleApp(new Request('https://app.fixture.invalid/app/v1/auth/options', { headers: { 'cf-connecting-ip': IP } }),
        { ...env, SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: KEY, WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...overrides } as never);
      return { status: response!.status, body: appAuthOptionsV1Schema.parse(await response!.json()) };
    };
    expect(await options(OPEN)).toEqual({ status: 200, body: { open_signup: true } });
    expect(await options({})).toEqual({ status: 200, body: { open_signup: false } });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { expect(await options({ ...OPEN, WALDO_COST_LEDGER_SYNC: 'off' })).toEqual({ status: 200, body: { open_signup: false } }); }
    finally { quiet.mockRestore(); }
    expect(state.calls).toEqual([]);
  });
});

describe('open sign-up settings', () => {
  it('reads caps only when every precondition holds', () => {
    expect(openSignupCaps({ ...OPEN })).toEqual({ dailyCap: 2, totalCap: 3 });
    expect(openSignupCaps({ ...OPEN, OPEN_SIGNUP: '0' })).toBeNull();
    expect(openSignupCaps({})).toBeNull();
    expect(openSignupCaps({ ...OPEN, OPEN_SIGNUP_DAILY_CAP: '1000' })).toBeNull();
  });
  it('an open owner\'s ceiling is the set amount, else the low fallback', () => {
    expect(openOwnerCeilingUsd({ OPEN_SIGNUP_SPEND_CEILING_USD: '7.5' })).toBe(7.5);
    for (const bad of [undefined, '', '0', '-3', 'five', 'Infinity']) expect(openOwnerCeilingUsd({ OPEN_SIGNUP_SPEND_CEILING_USD: bad })).toBe(OPEN_SIGNUP_FALLBACK_CEILING_USD);
  });
});
