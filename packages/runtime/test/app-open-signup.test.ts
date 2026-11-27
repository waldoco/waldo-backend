import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { APP_CONTRACT_HEADER, appAuthErrorV1Schema, appAuthOptionsV1Schema, appIdTokenResultV1Schema, appIdTokenResultV2Schema, appJoinResultV1Schema, appVerifyResultV1Schema, appVerifyResultV2Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { consoleAuth } from '../src/identity/console-auth';
import { OPEN_SIGNUP_EMAIL_DAILY_LIMIT, OPEN_SIGNUP_FALLBACK_CEILING_USD, OPEN_SIGNUP_IP_DAILY_LIMIT, openOwnerCeilingUsd, openSignupOn } from '../src/identity/open-signup';
import { APP_AUTH_IP_LIMIT } from '../src/channels/app-api';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';
import { verifiedOpenOwnerMark } from '../src/identity/open-owner-hold';

const SECRET = 'fictional-open-signup-router-secret-0000000000', DIRECTORY = 'https://open-signup.fixture.invalid', KEY = 'fictional-public-key';
const NEWCOMER = 'newcomer@example.test', MEMBER = 'member@example.test', INVITED = 'invited@example.test', INVITE = 'ABCDEFGHJKLMNPQRSTUV';
const NONCE = 'raw-nonce-0123456789abcdef', CODE = '123456', IP = '203.0.113.9';
const OPEN = { OPEN_SIGNUP: '1', APP_AGREEMENTS: '1', WALDO_COST_LEDGER_SYNC: 'on' };
// A build that names auth revision 2: specific refusals, and a yes before a new account.
const AUTH2 = { [APP_CONTRACT_HEADER]: 'chat=7,auth=2' };

const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// A fictional Supabase and owner directory that answer as the SQL does: the open join admits every confirmed email with no cap,
// counts the day's joins, refuses an address another owner row holds, and trusts the identity that joined.
const directory = async () => {
  const inviteHash = await linkCodeHash(INVITE);
  const state = {
    users: new Map<string, string>(), owners: new Map<string, { auth: string; doName: string; open: boolean }>(), held: new Set<string>(),
    trusted: new Set<string>(), joinsToday: 0, joinsEver: 0, attempts: new Map<string, number>(), otp: [] as string[], calls: [] as string[],
    inviteLive: true, live: new Set<string>(), invitedByEmail: new Set<string>(), marks: [] as string[], markStatus: 204,
    throttles: [] as { key: string; limit: number }[],
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
      signup_owner_open_uncapped: `signup.open.uncapped.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}.${a.p_phone}`,
      open_signup_throttle: `signup.open.throttle.${a.p_key}.${a.p_limit}`,
      console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`,
      open_owner_state: `openowner.state.${a.p_do_name}`, console_session_inventory: `consolesess.inventory.${a.p_do_name}`, app_session_rotate: `appsess.rotate.${a.p_do_name}.${a.p_session_hash}.${a.p_new_session_hash}`,
    };
    expect(signed[fn], `unlisted fixture RPC ${fn}`).toBeDefined();
    expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
    const owner = state.owners.get(a.p_email);
    if (fn === 'console_auth_throttle') { state.throttles.push({ key: a.p_key, limit: a.p_limit }); return Response.json(true); }
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
    if (fn === 'signup_owner_open_uncapped') {
      if (owner) return Response.json(owner.auth === a.p_auth_user ? { do_name: owner.doName, created: false } : { refused: 'taken' });
      if (state.invitedByEmail.delete(a.p_email)) {
        const doName = `owner-${crypto.randomUUID()}`;
        state.owners.set(a.p_email, { auth: a.p_auth_user, doName, open: false });
        return Response.json({ do_name: doName, created: true });
      }
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
  const app = async (path: string, body: unknown, overrides: Record<string, string> = {}, ip = IP, headers: Record<string, string> = {}) => {
    const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers }, body: JSON.stringify(body) }),
      { ...settings, OWNER_DO: owners, ...overrides } as never, auth);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  const app2 = (path: string, body: unknown, overrides: Record<string, string> = OPEN, ip = IP) => app(path, body, overrides, ip, AUTH2);
  return { app, app2, state, member, token, settings, auth, owners };
};
const google = (id_token: string, extra: Record<string, unknown> = {}) => ({ provider: 'google', id_token, nonce: NONCE, request_id: 'signin-request-1', ...extra });
const captureLogs = () => {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); }));
  return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
};

describe('open sign-up in the app', () => {
  it('with the flag off, no account is made, and a code that was not sent is never answered ok', async () => {
    const { app, app2, state, token } = await directory();
    const refused = await app('/auth/code', { email: NEWCOMER });
    expect(refused).toEqual({ status: 403, body: { error: 'signup_closed' } });
    expect(appAuthErrorV1Schema.safeParse(refused.body).success).toBe(true);
    expect(state.otp).toEqual([]);
    expect((await app('/auth/verify', { email: NEWCOMER, code: CODE })).body).toEqual({ state: 'needs_invite' });
    expect((await app('/auth/id_token', google(token('google', NEWCOMER)))).body).toEqual({ state: 'needs_invite' });
    // A build that names auth=2 is told why.
    expect((await app2('/auth/id_token', google(token('google', NEWCOMER)), {})).body).toEqual({ state: 'join_refused', reason: 'signup_closed' });
    expect(state.owners.has(NEWCOMER)).toBe(false);
    expect(state.calls.filter(fn => fn.startsWith('open_') || fn.startsWith('signup_owner_open') || fn === 'mark')).toEqual([]);
  });

  it('stays off, and says so without an address, while the agreements or the spend ledger are off', async () => {
    for (const broken of [{ APP_AGREEMENTS: '0' }, { WALDO_COST_LEDGER_SYNC: 'off' }]) {
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

  it('emails a code to any newcomer, and joins them on the code', async () => {
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

  it('has no join cap: a gym cohort joins from one hotel network, each with a code', async () => {
    const { app, state, token } = await directory();
    for (let i = 0; i < 12; i += 1) {
      const email = `member${i}@example.test`;
      expect(await app('/auth/code', { email }, OPEN)).toEqual({ status: 200, body: { ok: true } });
      expect((await app('/auth/id_token', google(token('google', email)), OPEN)).body).toMatchObject({ state: 'active' });
    }
    expect(state.otp).toHaveLength(12);
    expect(state.joinsEver).toBe(12);
    // Each join is throttled per network well above a cohort's size, and the app's auth throttle on that network too.
    expect(OPEN_SIGNUP_IP_DAILY_LIMIT).toBeGreaterThanOrEqual(300);
    expect(state.calls).not.toContain('open_signup_room');
    const ipThrottles = state.throttles.filter(row => !row.key.startsWith('send:') && !row.key.startsWith('verify:') && !row.key.startsWith('id_token:'));
    expect(new Set(ipThrottles.map(row => row.key))).toEqual(new Set([`app-ip:${IP}`]));
    expect(ipThrottles.every(row => row.limit === APP_AUTH_IP_LIMIT)).toBe(true);
    expect(APP_AUTH_IP_LIMIT).toBeGreaterThanOrEqual(300);
  });

  it('refuses an address another owner row holds, without a second tenant or a retryable error', async () => {
    const { app, state, token } = await directory();
    state.owners.set(NEWCOMER, { auth: 'someone-else', doName: 'owner-suspended', open: false });
    const answer = await app('/auth/id_token', google(token('google', NEWCOMER)), OPEN);
    expect(answer).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.get(NEWCOMER)?.doName).toBe('owner-suspended');
  });

  it('a build that names auth=2 is told the address belongs to another account', async () => {
    const { app2, state } = await directory();
    state.owners.set(NEWCOMER, { auth: 'someone-else', doName: 'owner-suspended', open: false });
    const verified = await app2('/auth/verify', { email: NEWCOMER, code: CODE });
    // The mailbox is proven, but owner_for_auth finds no owner bound to this Auth user, so a yes is asked first; the join then refuses.
    expect(verified.body).toMatchObject({ state: 'new_account', email: NEWCOMER });
    const joined = await app2('/auth/join', { ticket: verified.body.ticket });
    expect(joined).toEqual({ status: 200, body: { state: 'join_refused', reason: 'account_conflict' } });
    expect(appJoinResultV1Schema.safeParse(joined.body).success).toBe(true);
  });

  it('limits open joins per address and per email per day, and says so to a build that names auth=2', async () => {
    const { app, app2, state, token } = await directory();
    state.attempts.set(`ip.${await routerSignature(SECRET, 0, `openthrottle.${IP}`)}`, OPEN_SIGNUP_IP_DAILY_LIMIT);
    expect((await app('/auth/id_token', google(token('google', 'one.more@example.test')), OPEN)).body).toEqual({ state: 'needs_invite' });
    expect(state.owners.has('one.more@example.test')).toBe(false);
    const asked = await app2('/auth/id_token', google(token('google', 'one.more@example.test')));
    expect(asked.body).toMatchObject({ state: 'new_account' });
    expect((await app2('/auth/join', { ticket: asked.body.ticket })).body).toEqual({ state: 'join_refused', reason: 'join_limited' });
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

describe('auth revision 2: a yes before a new account', () => {
  it('a newcomer\'s proven email code makes no account until the yes, then /auth/join opens it', async () => {
    const { app, app2, state } = await directory();
    expect(await app('/auth/code', { email: NEWCOMER }, OPEN)).toEqual({ status: 200, body: { ok: true } });
    const asked = await app2('/auth/verify', { email: NEWCOMER, code: CODE, phone: '+919876543210' });
    expect(asked.status).toBe(200);
    expect(appVerifyResultV2Schema.safeParse(asked.body).success).toBe(true);
    expect(asked.body).toMatchObject({ state: 'new_account', email: NEWCOMER });
    expect(state.owners.has(NEWCOMER)).toBe(false);
    expect(state.calls).not.toContain('open_signup_throttle');
    const joined = await app2('/auth/join', { ticket: asked.body.ticket, phone: '+919876543210' });
    expect(appJoinResultV1Schema.safeParse(joined.body).success).toBe(true);
    expect(joined.body).toMatchObject({ state: 'active', surface: 'app' });
    const owner = state.owners.get(NEWCOMER)!;
    expect(owner.open).toBe(true);
    expect(state.marks).toEqual([owner.doName]);
    // The same yes again opens the same account; it never makes a second one.
    expect((await app2('/auth/join', { ticket: asked.body.ticket })).body).toMatchObject({ state: 'active' });
    expect(state.joinsEver).toBe(1);
  });

  it('a Hide My Email address or a typo is asked about first, and a member is never asked', async () => {
    const { app2, state, member, token } = await directory();
    member();
    const relay = 'x7k2@privaterelay.appleid.com';
    const asked = await app2('/auth/id_token', { provider: 'apple', id_token: token('apple', relay), nonce: NONCE, request_id: 'signin-request-2' });
    expect(appIdTokenResultV2Schema.safeParse(asked.body).success).toBe(true);
    expect(asked.body).toMatchObject({ state: 'new_account', email: relay });
    expect(state.owners.has(relay)).toBe(false);
    expect((await app2('/auth/id_token', google(token('google', MEMBER)))).body).toMatchObject({ state: 'confirm_with_email_code', email: MEMBER });
    expect((await app2('/auth/verify', { email: MEMBER, code: CODE })).body).toMatchObject({ state: 'active' });
    // The yes to the relay address: the identity that joined is trusted, so the next Apple sign-in goes straight through.
    const joined = await app2('/auth/join', { ticket: asked.body.ticket });
    expect(joined.body).toMatchObject({ state: 'active' });
    expect(state.trusted.has(`${state.owners.get(relay)!.doName}|apple|apple-${relay}`)).toBe(true);
  });

  it('a wrong code is code_invalid, never mistaken for a refused account', async () => {
    const { app2 } = await directory();
    expect(await app2('/auth/verify', { email: NEWCOMER, code: '999999' })).toEqual({ status: 200, body: { state: 'code_invalid' } });
  });

  it('a ticket that was changed, made by another server or expired opens nothing', async () => {
    const { app2, state, settings } = await directory();
    const asked = await app2('/auth/verify', { email: NEWCOMER, code: CODE });
    const ticket = String(asked.body.ticket);
    const [payload, signature] = ticket.split('.');
    const swapped = btoa(JSON.stringify({ ...JSON.parse(atob(payload!.replaceAll('-', '+').replaceAll('_', '/'))), email: 'victim@example.test' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    for (const forged of [`${swapped}.${signature}`, `${payload}.${'0'.repeat(64)}`, 'not-a-ticket-at-all-0000'])
      expect(await app2('/auth/join', { ticket: forged })).toEqual({ status: 403, body: { error: 'ticket_invalid' } });
    const later = consoleAuth(settings, (async () => { throw new Error('no directory call expected'); }) as typeof fetch, () => Date.now() + 16 * 60_000)!;
    const expired = await handleApp(new Request('https://app.fixture.invalid/app/v1/auth/join', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP, ...AUTH2 }, body: JSON.stringify({ ticket }) }),
      { ...settings, ...OPEN, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never, { ...later, throttle: async () => true });
    expect(expired!.status).toBe(403);
    expect(state.owners.has(NEWCOMER)).toBe(false);
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
  it('is on only when every precondition holds, and needs no cap', () => {
    expect(openSignupOn({ ...OPEN })).toBe(true);
    expect(openSignupOn({ ...OPEN, OPEN_SIGNUP: '0' })).toBe(false);
    expect(openSignupOn({})).toBe(false);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { expect(openSignupOn({ ...OPEN, APP_AGREEMENTS: '0' })).toBe(false); } finally { quiet.mockRestore(); }
  });
  it('an open owner\'s ceiling is the set amount, else the low fallback', () => {
    expect(openOwnerCeilingUsd({ OPEN_SIGNUP_SPEND_CEILING_USD: '7.5' })).toBe(7.5);
    for (const bad of [undefined, '', '0', '-3', 'five', 'Infinity']) expect(openOwnerCeilingUsd({ OPEN_SIGNUP_SPEND_CEILING_USD: bad })).toBe(OPEN_SIGNUP_FALLBACK_CEILING_USD);
  });
});
