import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appVerifyResultV1Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { handleConsole } from '../src/channels/console-signin';
import { consoleAuth } from '../src/identity/console-auth';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';

const SECRET = 'fictional-id-token-router-secret-000000000000', DIRECTORY = 'https://id-token.fixture.invalid', KEY = 'fictional-public-key';
const INVITE = 'ABCDEFGHJKLMNPQRSTUV', INVITED = 'new.member@example.test', MEMBER = 'member@example.test';
const TOKEN = 'fixture-header.fixture-payload.fixture-signature', NONCE = 'raw-nonce-0123456789abcdef';

const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// What a provider token says, as Supabase would read it after checking the signature. sub defaults to the email. audience
// 'web' is a client id the provider lists; 'other' is not. unlinked: Supabase did not link this identity to the existing
// user with the same email.
type Token = Readonly<{ provider: 'apple' | 'google'; email: string; sub?: string; verified?: boolean; audience?: 'web' | 'other'; nonce?: string; unlinked?: boolean }>;

// A fictional Supabase: Auth (email codes, the id_token and PKCE grants) and the owner directory, whose owner_for_auth
// matches the Auth user and the email together, as the SQL does. Like Supabase's DetermineAccountLinking, an identity is
// found by (provider, sub) first and answers with its user's stored email, whatever email the token now carries; a new
// identity links to the user holding the same email only when the email is verified, and otherwise gets a user of its own.
const supabase = async () => {
  const inviteHash = await linkCodeHash(INVITE);
  const state = {
    inviteLive: true,
    authUsers: new Map<string, { email: string; confirmed: boolean }>(), linked: new Map<string, string>(), identities: new Map<string, string>(),
    owners: new Map<string, { auth: string; doName: string }>(),
    tokens: new Map<string, Token>(), flows: new Map<string, { challenge: string; token: Token }>(),
    grants: [] as Record<string, unknown>[], signups: [] as Record<string, unknown>[], lookups: [] as Record<string, unknown>[],
    live: new Set<string>(), outage: false,
  };
  const asUser = (id: string) => {
    const { email, confirmed } = state.authUsers.get(id)!;
    return { id, email, email_confirmed_at: confirmed ? new Date().toISOString() : null };
  };
  const userFor = (token: Token) => {
    const identity = `${token.provider}:${token.sub ?? token.email}`;
    const known = state.identities.get(identity);
    if (known) return asUser(known);
    const verified = token.verified ?? true;
    const id = (verified && !token.unlinked && token.email ? state.linked.get(token.email) : undefined) ?? crypto.randomUUID();
    if (!state.authUsers.has(id)) state.authUsers.set(id, { email: token.email, confirmed: verified && token.email !== '' });
    if (verified && !token.unlinked && token.email) state.linked.set(token.email, id);
    state.identities.set(identity, id);
    return asUser(id);
  };
  const member = async () => {
    const auth = userFor({ provider: 'google', email: MEMBER });
    state.owners.set(MEMBER, { auth: auth.id, doName: `owner-${crypto.randomUUID()}` });
    return state.owners.get(MEMBER)!.doName;
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), a = JSON.parse(String(init?.body));
    expect(url.origin).toBe(DIRECTORY);
    expect(new Headers(init?.headers).get('apikey')).toBe(KEY);
    if (url.pathname === '/auth/v1/verify') return Response.json({ user: userFor({ provider: 'email' as never, email: a.email }) });
    if (url.pathname === '/auth/v1/token') {
      state.grants.push({ grant_type: url.searchParams.get('grant_type'), ...a });
      if (state.outage) return new Response('', { status: 502 });
      let token: Token | undefined;
      if (url.searchParams.get('grant_type') === 'id_token') {
        expect(Object.keys(a).filter(k => !['provider', 'id_token', 'nonce'].includes(k))).toEqual([]);
        token = state.tokens.get(a.id_token);
        if (!token || token.provider !== a.provider) return Response.json({ code: 400, error_code: 'bad_oauth_callback', msg: 'Bad ID token' }, { status: 400 });
        // Supabase's own refusals echo the token's audience; the handler must never pass this body on.
        if (token.audience === 'other') return Response.json({ code: 400, msg: 'Unacceptable audience in id_token: [fictional-ios-client]' }, { status: 400 });
        if ((token.nonce === undefined) !== (a.nonce === undefined)) return Response.json({ code: 400, msg: 'Passed nonce and nonce in id_token should either both exist or not.' }, { status: 400 });
        if (token.nonce !== undefined && await hex(a.nonce) !== token.nonce) return Response.json({ code: 400, msg: 'Nonces mismatch' }, { status: 400 });
      } else {
        expect(url.searchParams.get('grant_type')).toBe('pkce');
        expect(Object.keys(a).sort()).toEqual(['auth_code', 'code_verifier']);
        const flow = state.flows.get(a.auth_code);
        if (!flow || base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.code_verifier))) !== flow.challenge) return Response.json({ code: 404, msg: 'invalid flow state' }, { status: 404 });
        state.flows.delete(a.auth_code);
        token = flow.token;
      }
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: userFor(token) });
    }
    const fn = url.pathname.split('/').at(-1)!;
    const signed: Record<string, string> = {
      console_auth_throttle: `throttle.${a.p_key}.${a.p_limit}.${a.p_window_seconds}`,
      owner_for_auth: `owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`, signup_owner_for_auth: `signup.owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`,
      console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`, console_session_inventory: `consolesess.inventory.${a.p_do_name}`,
      console_session_open_for: `consolesess.openfor.${a.p_do_name}.${a.p_session_hash}.${a.p_lifetime_seconds}.${a.p_idle_seconds}`,
      app_session_rotate: `appsess.rotate.${a.p_do_name}.${a.p_session_hash}.${a.p_new_session_hash}`,
    };
    expect(signed[fn], `unlisted fixture RPC ${fn}`).toBeDefined();
    expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
    if (fn === 'console_auth_throttle') return Response.json(true);
    if (fn === 'owner_for_auth') {
      state.lookups.push(a);
      const owner = state.owners.get(a.p_email);
      return Response.json(owner && owner.auth === a.p_auth_user ? owner.doName : null);
    }
    if (fn === 'signup_owner_for_auth') {
      state.signups.push(a);
      const user = state.authUsers.get(a.p_auth_user);
      if (!user?.confirmed || user.email !== a.p_email) return Response.json(null);
      const owner = state.owners.get(a.p_email);
      if (owner && owner.auth === a.p_auth_user) return Response.json(owner.doName);
      if (!(state.inviteLive && a.p_email === INVITED && a.p_code_hash === inviteHash)) return Response.json(null);
      if (owner) return Response.json({ code: '23505', message: 'owner already exists' }, { status: 409 });
      state.inviteLive = false;
      const doName = `owner-${crypto.randomUUID()}`;
      state.owners.set(a.p_email, { auth: a.p_auth_user, doName });
      return Response.json(doName);
    }
    if (fn === 'console_session_open' || fn === 'console_session_open_for') { state.live.add(`${a.p_do_name}:${a.p_session_hash}`); return Response.json(true); }
    if (fn === 'app_session_rotate') return Response.json(false);
    return Response.json([...state.live].filter(row => row.startsWith(`${a.p_do_name}:`)).map(row => ({ session: row.split(':')[1], created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date().toISOString() })));
  });
  const limited = { value: false };
  const grantFetch = vi.fn(async () => new Response('console-grant-token'));
  const settings = {
    ...env, SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: KEY, WALDO_ROUTER_HMAC_SECRET: SECRET, CONSOLE_GOOGLE_SIGNIN: '1',
    RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: !limited.value }) },
    OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: grantFetch }) } as unknown as DurableObjectNamespace,
  };
  const auth = consoleAuth(settings, fetcher as typeof fetch)!;
  const app = async (path: string, body: unknown) => {
    const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...settings, OWNER_DO: env.OWNER_DO } as never, auth);
    expect(response).not.toBeNull();
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  const console_ = async (path: string, init: RequestInit = {}) => (await handleConsole(new Request(`https://console.fixture.invalid${path}`, init), settings as never, auth))!;
  return { app, console: console_, state, fetcher, member, limited, grantFetch, settings, auth };
};

const google = (id_token = TOKEN, extra: Record<string, unknown> = {}) => ({ provider: 'google', id_token, request_id: 'signin-request-1', ...extra });
const apple = (id_token = TOKEN, extra: Record<string, unknown> = {}) => ({ provider: 'apple', id_token, nonce: NONCE, request_id: 'signin-request-2', ...extra });
type SetCookies = { getSetCookie(): string[] };
const captureLogs = () => {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); }));
  return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
};

describe('app sign-in with an Apple or Google identity token', () => {
  it('joins a new member with the invite, binding the email Supabase confirms, never one the app sends', async () => {
    const { app, state } = await supabase();
    state.tokens.set(TOKEN, { provider: 'google', email: INVITED });
    const signedIn = await app('/auth/id_token', google(TOKEN, { invite: INVITE, phone: '+919876543210' }));
    expect(signedIn.status).toBe(200);
    expect(appVerifyResultV1Schema.safeParse(signedIn.body).success).toBe(true);
    const owner = state.owners.get(INVITED)!;
    expect(signedIn.body).toMatchObject({ state: 'active', surface: 'app', account_ref: `acct_${await linkCodeHash(owner.doName)}` });
    expect(state.signups).toEqual([expect.objectContaining({ p_auth_user: owner.auth, p_email: INVITED, p_phone: '+919876543210', p_code_hash: await linkCodeHash(INVITE) })]);
    expect(state.lookups).toEqual([expect.objectContaining({ p_email: INVITED, p_phone: '' })]);
    expect(state.inviteLive).toBe(false);
  });

  it('resolves one owner for one email through an email code, Apple and Google, spending no invite', async () => {
    const { app, state } = await supabase();
    state.tokens.set('a.apple.token', { provider: 'apple', email: INVITED, nonce: await hex(NONCE) });
    state.tokens.set('g.google.token', { provider: 'google', email: INVITED });
    const viaApple = await app('/auth/id_token', apple('a.apple.token', { invite: INVITE }));
    const owner = state.owners.get(INVITED)!;
    expect(viaApple.body).toMatchObject({ state: 'active', account_ref: `acct_${await linkCodeHash(owner.doName)}` });
    const viaGoogle = await app('/auth/id_token', google('g.google.token', { invite: INVITE }));
    const viaCode = await app('/auth/verify', { email: INVITED, code: '123456', invite: INVITE });
    for (const signedIn of [viaGoogle, viaCode]) expect(signedIn.body).toMatchObject({ state: 'active', account_ref: (viaApple.body as { account_ref: string }).account_ref });
    expect(state.owners.size).toBe(1);
    expect(state.signups).toHaveLength(1);
  });

  it('signs an existing member in by email without their invite and never hands it their phone', async () => {
    const { app, state, member } = await supabase();
    const doName = await member();
    state.tokens.set(TOKEN, { provider: 'apple', email: MEMBER, nonce: await hex(NONCE) });
    const signedIn = await app('/auth/id_token', apple(TOKEN, { invite: INVITE, phone: '+15550001111' }));
    expect(signedIn.body).toMatchObject({ state: 'active', account_ref: `acct_${await linkCodeHash(doName)}` });
    expect(state.lookups).toEqual([expect.objectContaining({ p_email: MEMBER, p_phone: '' })]);
    expect(state.signups).toEqual([]);
    expect(state.inviteLive).toBe(true);
  });

  it('tells someone with no invite, or with another address\'s invite, that they need one, and creates nothing', async () => {
    const { app, state } = await supabase();
    state.tokens.set(TOKEN, { provider: 'google', email: INVITED });
    state.tokens.set('relay.apple.token', { provider: 'apple', email: 'abc123@privaterelay.appleid.com', nonce: await hex(NONCE) });
    expect(await app('/auth/id_token', google(TOKEN))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    // Hide My Email: the private relay address matches no member and no invite, which is bound to the invited address.
    expect(await app('/auth/id_token', apple('relay.apple.token', { invite: INVITE }))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.size).toBe(0);
    expect(state.inviteLive).toBe(true);
  });

  it('never resolves a member for the same email under an Auth user Supabase did not link', async () => {
    const { app, state, member } = await supabase();
    const doName = await member();
    state.tokens.set(TOKEN, { provider: 'google', sub: 'second-google-sub', email: MEMBER, unlinked: true });
    expect(await app('/auth/id_token', google(TOKEN))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.get(MEMBER)!.doName).toBe(doName);
    expect(state.owners.size).toBe(1);
  });

  it('answers the generic 403 when Supabase refuses the token, and logs neither the token nor Supabase\'s answer', async () => {
    const { app, state } = await supabase();
    state.tokens.set('wrong.audience.token', { provider: 'google', email: INVITED, audience: 'other' });
    state.tokens.set('apple.nonce.token', { provider: 'apple', email: INVITED, nonce: await hex('another-raw-nonce-000000') });
    state.tokens.set('google.nonce.token', { provider: 'google', email: INVITED, nonce: await hex(NONCE) });
    const logs = captureLogs();
    try {
      for (const body of [google('wrong.audience.token', { invite: INVITE }), apple('apple.nonce.token', { invite: INVITE }), google('google.nonce.token', { invite: INVITE }), google('unknown.issuer.token'), apple('g.as.apple', {})]) {
        expect({ body, answer: await app('/auth/id_token', body) }).toEqual({ body, answer: { status: 403, body: { error: 'unavailable' } } });
      }
    } finally { logs.restore(); }
    expect(state.lookups).toEqual([]);
    expect(state.signups).toEqual([]);
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const line of logs.lines) {
      expect(line).not.toMatch(/wrong\.audience|apple\.nonce|google\.nonce|unknown\.issuer|fictional-ios-client|Nonces|audience|raw-nonce/);
      expect(JSON.parse(line)).toMatchObject({ hop: 'app_id_token', ok: false, code: 'id_token_refused' });
    }
  });

  it('answers the generic 403 for a token with no email or an unconfirmed one, before any owner lookup', async () => {
    const { app, state } = await supabase();
    state.tokens.set('no.email.token', { provider: 'apple', email: '', nonce: await hex(NONCE) });
    state.tokens.set('unverified.email.token', { provider: 'google', email: INVITED, verified: false });
    const logs = captureLogs();
    try {
      expect(await app('/auth/id_token', apple('no.email.token', { invite: INVITE }))).toEqual({ status: 403, body: { error: 'unavailable' } });
      expect(await app('/auth/id_token', google('unverified.email.token', { invite: INVITE }))).toEqual({ status: 403, body: { error: 'unavailable' } });
    } finally { logs.restore(); }
    expect(logs.lines.map(line => JSON.parse(line).code)).toEqual(['id_token_no_email', 'id_token_no_email']);
    expect(state.lookups).toEqual([]);
    expect(state.signups).toEqual([]);
  });

  it('keys a returning identity on its provider subject: Apple with no email, or Google with a changed email, is the same owner', async () => {
    const { app, state, member } = await supabase();
    state.tokens.set('apple.first.token', { provider: 'apple', sub: 'apple-sub-1', email: INVITED, nonce: await hex(NONCE) });
    state.tokens.set('apple.again.token', { provider: 'apple', sub: 'apple-sub-1', email: '', nonce: await hex(NONCE) });
    const first = await app('/auth/id_token', apple('apple.first.token', { invite: INVITE }));
    const again = await app('/auth/id_token', apple('apple.again.token'));
    expect(again.body).toMatchObject({ state: 'active', account_ref: (first.body as { account_ref: string }).account_ref });
    const doName = await member();
    state.tokens.set('google.first.token', { provider: 'google', sub: 'google-sub-1', email: MEMBER });
    state.tokens.set('google.renamed.token', { provider: 'google', sub: 'google-sub-1', email: 'renamed@example.test' });
    for (const token of ['google.first.token', 'google.renamed.token'])
      expect((await app('/auth/id_token', google(token))).body).toMatchObject({ state: 'active', account_ref: `acct_${await linkCodeHash(doName)}` });
    expect(state.owners.size).toBe(2);
    expect(state.signups.filter(call => call.p_code_hash)).toHaveLength(1);
  });

  it('never attaches a token carrying a member\'s email unverified, with or without an invite', async () => {
    const { app, state, member } = await supabase();
    const doName = await member();
    const memberAuth = state.owners.get(MEMBER)!.auth;
    state.tokens.set('attacker.google.token', { provider: 'google', sub: 'attacker-sub', email: MEMBER, verified: false });
    for (const body of [google('attacker.google.token'), google('attacker.google.token', { invite: INVITE })])
      expect(await app('/auth/id_token', body)).toEqual({ status: 403, body: { error: 'unavailable' } });
    expect(state.owners.get(MEMBER)).toEqual({ auth: memberAuth, doName });
    expect(state.identities.get('google:attacker-sub')).not.toBe(memberAuth);
    expect(state.lookups).toEqual([]);
  });

  it('on a repeated request id resolves the same owner, with no second owner and no second invite spend', async () => {
    const { app, state } = await supabase();
    state.tokens.set(TOKEN, { provider: 'google', email: INVITED });
    const first = await app('/auth/id_token', google(TOKEN, { invite: INVITE }));
    const again = await app('/auth/id_token', google(TOKEN, { invite: INVITE }));
    expect(first.body).toMatchObject({ state: 'active' });
    expect(again.body).toMatchObject({ state: 'active', account_ref: (first.body as { account_ref: string }).account_ref });
    expect(state.owners.size).toBe(1);
    expect(state.inviteLive).toBe(false);
    expect(state.signups.filter(call => call.p_code_hash)).toHaveLength(1);
  });

  it('refuses an invalid body before Supabase is asked, and sends Supabase only the provider, the token and the nonce', async () => {
    const { app, state, fetcher } = await supabase();
    for (const body of [{ ...google(), email: INVITED }, { ...apple(), nonce: undefined }, google('not-a-jwt'), { ...google(), provider: 'facebook' }, { ...google(), client_id: 'web' }]) {
      expect((await app('/auth/id_token', body)).status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
    state.tokens.set(TOKEN, { provider: 'apple', email: INVITED, nonce: await hex(NONCE) });
    const logs = captureLogs();
    try { await app('/auth/id_token', apple(TOKEN, { invite: INVITE, authorization_code: 'c0ffee0123456789abcdef.0.fixture.code-value_01' })); }
    finally { logs.restore(); }
    // Apple's authorization code is accepted and unused until the Sign in with Apple key exists: never sent on, never logged.
    expect(state.grants).toEqual([{ grant_type: 'id_token', provider: 'apple', id_token: TOKEN, nonce: NONCE }]);
    expect(logs.lines.filter(line => line.includes('c0ffee'))).toEqual([]);
    await app('/auth/id_token', google('g.no.nonce'));
    expect(state.grants.at(-1)).toEqual({ grant_type: 'id_token', provider: 'google', id_token: 'g.no.nonce' });
  });

  it('is rate limited like the code routes, keyed by a digest of the token and never the token itself', async () => {
    const { app, state, limited, fetcher } = await supabase();
    state.tokens.set(TOKEN, { provider: 'google', email: INVITED });
    limited.value = true;
    const refused = await app('/auth/id_token', google(TOKEN, { invite: INVITE }));
    expect(refused.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    limited.value = false;
    await app('/auth/id_token', google(TOKEN, { invite: INVITE }));
    const keys = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).p_key).filter(Boolean);
    expect(keys).toEqual([`id_token:${await hex(TOKEN)}`, 'ip:unknown']);
  });

  it('answers 503 when Supabase is down, and 503 when the join collides with an owner already holding the email', async () => {
    const { app, state, member } = await supabase();
    state.tokens.set(TOKEN, { provider: 'google', email: INVITED });
    state.outage = true;
    expect(await app('/auth/id_token', google(TOKEN, { invite: INVITE }))).toEqual({ status: 503, body: { error: 'unavailable' } });
    state.outage = false;
    await member();
    state.owners.set(INVITED, state.owners.get(MEMBER)!);
    state.tokens.set('unlinked.google.token', { provider: 'google', sub: 'second-google-sub', email: INVITED, unlinked: true });
    expect(await app('/auth/id_token', google('unlinked.google.token', { invite: INVITE }))).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(state.inviteLive).toBe(true);
  });
});

describe('console sign-in with Google', () => {
  const start = async (sandbox: Awaited<ReturnType<typeof supabase>>, path = '/console/signin/google') => {
    const response = await sandbox.console(path, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!;
    return { location, cookie, pair: cookie.split(';')[0]! };
  };

  it('starts Supabase\'s Google flow with an S256 challenge and a short-lived verifier cookie scoped to the callback', async () => {
    const sandbox = await supabase();
    const { location, cookie } = await start(sandbox);
    expect(`${location.origin}${location.pathname}`).toBe(`${DIRECTORY}/auth/v1/authorize`);
    expect(location.searchParams.get('provider')).toBe('google');
    expect(location.searchParams.get('redirect_to')).toBe('https://console.fixture.invalid/console/signin/google/callback');
    expect(location.searchParams.get('code_challenge_method')).toBe('s256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/^waldo_google_pkce=[^;]+; Path=\/console\/signin\/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    expect(cookie).not.toContain(location.searchParams.get('code_challenge')!);
  });

  it('signs an existing member in with the same console session as an email code, then clears the verifier', async () => {
    const sandbox = await supabase();
    const doName = await sandbox.member();
    const { location, pair } = await start(sandbox, `/console/signin/google?return_to=${encodeURIComponent('/console/devices')}`);
    sandbox.state.flows.set('code-1', { challenge: location.searchParams.get('code_challenge')!, token: { provider: 'google', email: MEMBER } });
    const done = await sandbox.console('/console/signin/google/callback?code=code-1', { headers: { cookie: pair, 'sec-fetch-site': 'cross-site' } });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/console/devices');
    const cookies = (done.headers as unknown as SetCookies).getSetCookie();
    expect(cookies).toContain('waldo_google_pkce=; Path=/console/signin/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    expect(cookies.some(value => value.startsWith('waldo_console=console-grant-token;'))).toBe(true);
    expect(cookies.some(value => value.startsWith(`waldo_owner=${encodeURIComponent(doName)}.`) && value.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'))).toBe(true);
    expect(sandbox.grantFetch).toHaveBeenCalledOnce();
    expect(sandbox.state.signups).toEqual([]);
    // The code works once: a second callback with it signs nobody in.
    const replay = await sandbox.console('/console/signin/google/callback?code=code-1', { headers: { cookie: pair } });
    expect(replay.status).toBe(200);
    expect((replay.headers as unknown as SetCookies).getSetCookie().some(value => value.startsWith('waldo_owner='))).toBe(false);
  });

  it('admits members only: a Google address with no account is told to use the invited email and nothing is created', async () => {
    const sandbox = await supabase();
    const { location, pair } = await start(sandbox);
    sandbox.state.flows.set('code-2', { challenge: location.searchParams.get('code_challenge')!, token: { provider: 'google', email: INVITED } });
    const done = await sandbox.console('/console/signin/google/callback?code=code-2', { headers: { cookie: pair } });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('No Waldo account uses that Google address');
    expect(sandbox.state.signups).toEqual([]);
    expect(sandbox.grantFetch).not.toHaveBeenCalled();
  });

  it('refuses a callback without this browser\'s verifier, with a forged one, or with another browser\'s code', async () => {
    const sandbox = await supabase();
    await sandbox.member();
    const mine = await start(sandbox), theirs = await start(sandbox);
    sandbox.state.flows.set('their-code', { challenge: theirs.location.searchParams.get('code_challenge')!, token: { provider: 'google', email: MEMBER } });
    const [name, value] = mine.pair.split('=') as [string, string];
    const forged = `${name}=${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
    for (const cookie of ['', forged, mine.pair]) {
      const done = await sandbox.console('/console/signin/google/callback?code=their-code', { headers: cookie ? { cookie } : {} });
      expect(done.status).toBe(200);
      expect((done.headers as unknown as SetCookies).getSetCookie().some(header => header.startsWith('waldo_owner='))).toBe(false);
    }
    expect(sandbox.grantFetch).not.toHaveBeenCalled();
    expect(sandbox.state.grants.filter(grant => grant.grant_type === 'pkce')).toHaveLength(1);
  });

  it('does not start the flow from another site, and shows no Google button while the switch is off', async () => {
    const sandbox = await supabase();
    const crossSite = await sandbox.console('/console/signin/google', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.headers.get('location')).toBe('/console/signin');
    expect(crossSite.headers.get('set-cookie')).toBeNull();
    expect(await (await sandbox.console('/console/signin')).text()).toContain('href="/console/signin/google"');
    const off = await handleConsole(new Request('https://console.fixture.invalid/console/signin'), { ...sandbox.settings, CONSOLE_GOOGLE_SIGNIN: '0' } as never, sandbox.auth);
    expect(await off!.text()).not.toContain('/console/signin/google');
    const startOff = await handleConsole(new Request('https://console.fixture.invalid/console/signin/google'), { ...sandbox.settings, CONSOLE_GOOGLE_SIGNIN: '0' } as never, sandbox.auth);
    expect(startOff!.headers.get('location')).toBe('/console/signin');
  });

  it('turns a cancelled Google screen back into the sign-in page without asking Supabase', async () => {
    const sandbox = await supabase();
    const { pair } = await start(sandbox);
    const done = await sandbox.console('/console/signin/google/callback?error=access_denied&error_description=fixture', { headers: { cookie: pair } });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Google sign-in did not finish');
    expect(sandbox.state.grants).toEqual([]);
  });
});
