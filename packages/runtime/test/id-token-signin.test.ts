import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appIdTokenResultV1Schema, appVerifyResultV1Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { handleConsole } from '../src/channels/console-signin';
import { appleClientSecret, appleSignInKey } from '../src/identity/apple-signin';
import { consoleAuth } from '../src/identity/console-auth';
import { GOOGLE_PKCE_COOKIE, GOOGLE_PKCE_PURPOSE } from '../src/identity/google-pkce';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';
import { sealValue } from '../src/identity/sealed-value';

const SECRET = 'fictional-id-token-router-secret-000000000000', DIRECTORY = 'https://id-token.fixture.invalid', KEY = 'fictional-public-key';
const INVITE = 'ABCDEFGHJKLMNPQRSTUV', INVITED = 'new.member@example.test', MEMBER = 'member@example.test';
const NONCE = 'raw-nonce-0123456789abcdef', CODE = '123456', APPLE_CLIENT = 'com.heywaldo.app';

const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// What a provider token says, as Supabase reads it after checking the signature. sub defaults to provider:email. audience
// 'other' is a client id the provider does not list. nonce is the SHA-256 hex the app gave the SDK; it defaults to NONCE's.
// unlinked: Supabase did not link this identity to the existing user with the same email.
type Token = Readonly<{ provider: 'apple' | 'google'; email: string; sub?: string; verified?: boolean; audience?: 'web' | 'other'; nonce?: string; unlinked?: boolean }>;
type Granted = { id: string; provider: string; last_sign_in_at: string };

// A fictional Supabase, modelled on GoTrue (internal/models/linking.go DetermineAccountLinking, internal/api/external.go
// createAccountFromExternalIdentity): an identity is found by (provider, sub) first and answers with its user's stored
// email; a new identity links to the user holding the same verified email, else gets a user of its own; and an identity
// linked to an existing user in this very grant is missing from the response's identities. The owner directory matches
// the Auth user and the email together, as the SQL does, and trusts only a subject Supabase links to that Auth user.
const supabase = async (extra: Record<string, string> = {}) => {
  const inviteHash = await linkCodeHash(INVITE);
  let minted = 0, clock = Date.parse('2026-10-26T12:00:00Z');
  const state = {
    inviteLive: true,
    authUsers: new Map<string, { email: string; confirmed: boolean }>(), linked: new Map<string, string>(),
    identities: new Map<string, { user: string; provider: string; sub: string; at: number }>(),
    owners: new Map<string, { auth: string; doName: string }>(), trusted: new Set<string>(),
    tokens: new Map<string, Token>(), flows: new Map<string, { challenge: string; user: string; sub: string }>(), googleTokens: new Map<string, string>(),
    grants: [] as Record<string, unknown>[], signups: [] as Record<string, unknown>[], lookups: [] as Record<string, unknown>[],
    otp: [] as string[], denySend: false, live: new Set<string>(), outage: false, google: 'ok' as 'ok' | 'refuses' | 'down',
    // Runs inside the next join, before it reads the owners: another sign-in committing first.
    beforeSignup: undefined as ((a: Record<string, string>) => void) | undefined,
    // Apple's token and revoke endpoints: what each request carried, and how Apple answers.
    apple: [] as { path: string; form: Record<string, string> }[], appleToken: 'ok' as 'ok' | 'refuses' | 'down' | 'other_subject', appleRevoke: 'ok' as 'ok' | 'refuses',
    appleGrants: new Map<string, { doName: string; subject: string; client: string; token: string }>(), calls: [] as string[], heldDown: false,
  };
  const token = (t: Token) => {
    const jwt = `fixture.${base64url(new TextEncoder().encode(JSON.stringify({ sub: t.sub ?? `${t.provider}:${t.email}`, aud: t.provider === 'apple' ? APPLE_CLIENT : 'fictional-web-client', n: minted += 1 })))}.signature`;
    state.tokens.set(jwt, t);
    return jwt;
  };
  const identitiesOf = (user: string, leaveOut?: string): Granted[] => [...state.identities.entries()].filter(([key, row]) => row.user === user && key !== leaveOut)
    .map(([, row]) => ({ id: row.sub, provider: row.provider, last_sign_in_at: new Date(row.at).toISOString() }));
  const asUser = (id: string, leaveOut?: string) => {
    const { email, confirmed } = state.authUsers.get(id)!;
    return { id, email, email_confirmed_at: confirmed ? new Date().toISOString() : null, identities: identitiesOf(id, leaveOut) };
  };
  const signIn = (provider: string, sub: string, email: string, verified: boolean, unlinked = false, sameSecond = false) => {
    const key = `${provider}:${sub}`, known = state.identities.get(key);
    if (!sameSecond) clock += 1000;
    if (known) { known.at = clock; return { user: known.user, linkedNow: false, key }; }
    const holder = verified && !unlinked && email ? state.linked.get(email) : undefined;
    const id = holder ?? crypto.randomUUID();
    if (!holder) state.authUsers.set(id, { email, confirmed: verified && email !== '' });
    if (verified && !unlinked && email) state.linked.set(email, id);
    state.identities.set(key, { user: id, provider, sub, at: clock });
    return { user: id, linkedNow: holder !== undefined, key };
  };
  // Supabase's Google callback: it signs the identity in when the browser comes back, and keeps the flow for the code.
  const authorize = (code: string, challenge: string, t: Token, sameSecond = false) => {
    const sub = t.sub ?? `${t.provider}:${t.email}`;
    state.flows.set(code, { challenge, user: signIn(t.provider, sub, t.email, t.verified ?? true, t.unlinked, sameSecond).user, sub });
  };
  const member = async (email = MEMBER) => {
    const { user } = signIn('email', email, email, true);
    state.owners.set(email, { auth: user, doName: `owner-${crypto.randomUUID()}` });
    return state.owners.get(email)!.doName;
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://appleid.apple.com') {
      const fields = Object.fromEntries(new URLSearchParams(String(init?.body)));
      state.apple.push({ path: url.pathname, form: fields });
      state.calls.push(`apple${url.pathname}`);
      if (url.pathname === '/auth/revoke') return new Response('', { status: state.appleRevoke === 'ok' ? 200 : 400 });
      expect(url.pathname).toBe('/auth/token');
      if (state.appleToken === 'down') return new Response('', { status: 503 });
      if (state.appleToken === 'refuses' || !fields.code?.startsWith('apple-code-for.')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const subject = state.appleToken === 'other_subject' ? 'apple:someone-else' : fields.code.slice('apple-code-for.'.length);
      return Response.json({ access_token: 'apple-access', token_type: 'Bearer', expires_in: 3600, refresh_token: `apple-refresh-${crypto.randomUUID()}`,
        id_token: `apple.${base64url(new TextEncoder().encode(JSON.stringify({ sub: subject, aud: fields.client_id })))}.signature` });
    }
    if (url.origin === 'https://www.googleapis.com') {
      expect(url.pathname).toBe('/userinfo/v2/me');
      if (state.google === 'down') return new Response('', { status: 503 });
      const sub = state.google === 'ok' ? state.googleTokens.get((new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '')) : undefined;
      return sub ? Response.json({ id: sub, email: 'kept@example.test', verified_email: true }) : new Response('', { status: 401 });
    }
    const a = JSON.parse(String(init?.body));
    expect(url.origin).toBe(DIRECTORY);
    expect(new Headers(init?.headers).get('apikey')).toBe(KEY);
    if (url.pathname === '/auth/v1/otp') { state.otp.push(a.email); return Response.json({}); }
    if (url.pathname === '/auth/v1/verify') {
      if (a.token !== CODE) return new Response('', { status: 403 });
      return Response.json({ user: asUser(signIn('email', a.email, a.email, true).user) });
    }
    if (url.pathname === '/auth/v1/token') {
      state.grants.push({ grant_type: url.searchParams.get('grant_type'), ...a });
      if (state.outage) return new Response('', { status: 502 });
      if (url.searchParams.get('grant_type') === 'id_token') {
        expect(Object.keys(a).filter(k => !['provider', 'id_token', 'nonce'].includes(k))).toEqual([]);
        const t = state.tokens.get(a.id_token);
        if (!t || t.provider !== a.provider) return Response.json({ code: 400, msg: 'Bad ID token' }, { status: 400 });
        // Supabase's own refusals echo the token's audience; the handler must never pass this body on.
        if (t.audience === 'other') return Response.json({ code: 400, msg: 'Unacceptable audience in id_token: [fictional-ios-client]' }, { status: 400 });
        if (await hex(a.nonce ?? '') !== (t.nonce ?? await hex(NONCE))) return Response.json({ code: 400, msg: 'Nonces mismatch' }, { status: 400 });
        const sub = (JSON.parse(atob(a.id_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: string }).sub ?? t.sub!;
        const { user, linkedNow, key } = signIn(t.provider, sub, t.email, t.verified ?? true, t.unlinked);
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: asUser(user, linkedNow ? key : undefined) });
      }
      expect(url.searchParams.get('grant_type')).toBe('pkce');
      expect(Object.keys(a).sort()).toEqual(['auth_code', 'code_verifier']);
      const flow = state.flows.get(a.auth_code);
      if (!flow || base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.code_verifier))) !== flow.challenge) return Response.json({ code: 404, msg: 'invalid flow state' }, { status: 404 });
      state.flows.delete(a.auth_code);
      // The exchange loads the user afresh and hands back the Google access token kept from this flow.
      const providerToken = `google-access-${crypto.randomUUID()}`;
      state.googleTokens.set(providerToken, flow.sub);
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', provider_token: providerToken, user: asUser(flow.user) });
    }
    const fn = url.pathname.split('/').at(-1)!;
    const signed: Record<string, string> = {
      console_auth_throttle: `throttle.${a.p_key}.${a.p_limit}.${a.p_window_seconds}`, signin_allowed: `signin.${a.p_email}.${a.p_code_hash}`,
      owner_for_auth: `owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`, signup_owner_for_auth: `signup.owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`,
      signin_identity_trusted: `signinid.trusted.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}`, trust_signin_identity: `signinid.trust.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}`,
      signup_owner_with_signin_identity: `signinid.signup.${a.p_auth_user}.${a.p_email}.${a.p_provider}.${a.p_subject}.${a.p_phone}.${a.p_code_hash}`,
      console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`, console_session_inventory: `consolesess.inventory.${a.p_do_name}`,
      console_session_open_for: `consolesess.openfor.${a.p_do_name}.${a.p_session_hash}.${a.p_lifetime_seconds}.${a.p_idle_seconds}`,
      app_session_rotate: `appsess.rotate.${a.p_do_name}.${a.p_session_hash}.${a.p_new_session_hash}`,
      apple_grant_keep: `applegrant.keep.${a.p_do_name}.${a.p_subject}.${a.p_client_id}.${await hex(a.p_token ?? '')}`,
      apple_grants_held: `applegrant.held.${a.p_do_name}`, delete_owner: `delown.${a.p_do_name}`,
    };
    expect(signed[fn], `unlisted fixture RPC ${fn}`).toBeDefined();
    expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
    const ownerOf = (auth: string, email: string) => { const owner = state.owners.get(email); return owner && owner.auth === auth ? owner : null; };
    if (fn === 'console_auth_throttle') return Response.json(!(state.denySend && String(a.p_key).startsWith('send:')));
    // As the SQL does: a token is kept only for an Apple identity this owner trusts, one row per subject and client.
    if (fn === 'apple_grant_keep') {
      if (!state.trusted.has(`${a.p_do_name}|apple|${a.p_subject}`)) return Response.json(false);
      state.appleGrants.set(`${a.p_do_name}|${a.p_subject}|${a.p_client_id}`, { doName: a.p_do_name, subject: a.p_subject, client: a.p_client_id, token: a.p_token });
      return Response.json(true);
    }
    if (fn === 'apple_grants_held') {
      if (state.heldDown) return new Response('', { status: 503 });
      return Response.json([...state.appleGrants.values()].filter(g => g.doName === a.p_do_name).map(g => ({ client_id: g.client, token: g.token })));
    }
    if (fn === 'delete_owner') {
      state.calls.push('delete_owner');
      for (const [key, grant] of state.appleGrants) if (grant.doName === a.p_do_name) state.appleGrants.delete(key);
      return Response.json(true);
    }
    if (fn === 'signin_allowed') return Response.json(state.owners.has(a.p_email));
    if (fn === 'owner_for_auth') { state.lookups.push(a); return Response.json(ownerOf(a.p_auth_user, a.p_email)?.doName ?? null); }
    if (fn === 'signin_identity_trusted') { const owner = ownerOf(a.p_auth_user, a.p_email); return Response.json(Boolean(owner && state.trusted.has(`${owner.doName}|${a.p_provider}|${a.p_subject}`))); }
    if (fn === 'trust_signin_identity') {
      const owner = ownerOf(a.p_auth_user, a.p_email), identity = state.identities.get(`${a.p_provider}:${a.p_subject}`);
      if (!owner || identity?.user !== a.p_auth_user) return Response.json(false);
      state.trusted.add(`${owner.doName}|${a.p_provider}|${a.p_subject}`);
      return Response.json(true);
    }
    if (fn === 'signup_owner_for_auth' || fn === 'signup_owner_with_signin_identity') {
      state.signups.push(a);
      state.beforeSignup?.(a);
      state.beforeSignup = undefined;
      const answer = (doName: string, created: boolean) => {
        if (fn === 'signup_owner_for_auth') return Response.json(doName);
        // The database trusts the identity that created the owner in the same transaction, and only that one.
        if (created && state.identities.get(`${a.p_provider}:${a.p_subject}`)?.user === a.p_auth_user) state.trusted.add(`${doName}|${a.p_provider}|${a.p_subject}`);
        return Response.json({ do_name: doName, created });
      };
      const user = state.authUsers.get(a.p_auth_user);
      if (!user?.confirmed || user.email !== a.p_email) return Response.json(null);
      const owner = state.owners.get(a.p_email);
      if (owner && owner.auth === a.p_auth_user) return answer(owner.doName, false);
      if (!(state.inviteLive && a.p_email === INVITED && a.p_code_hash === inviteHash)) return Response.json(null);
      if (owner) return Response.json({ code: '23505', message: 'owner already exists' }, { status: 409 });
      state.inviteLive = false;
      const doName = `owner-${crypto.randomUUID()}`;
      state.owners.set(a.p_email, { auth: a.p_auth_user, doName });
      return answer(doName, true);
    }
    if (fn === 'console_session_open' || fn === 'console_session_open_for') { state.live.add(`${a.p_do_name}:${a.p_session_hash}`); return Response.json(true); }
    if (fn === 'app_session_rotate') return Response.json(false);
    return Response.json([...state.live].filter(row => row.startsWith(`${a.p_do_name}:`)).map(row => ({ session: row.split(':')[1], created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date().toISOString() })));
  });
  const limited = { value: false }, now = { offset: 0 };
  const grantFetch = vi.fn(async () => new Response('console-grant-token'));
  const settings = {
    ...env, SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: KEY, WALDO_ROUTER_HMAC_SECRET: SECRET, CONSOLE_GOOGLE_SIGNIN: '1', APP_ID_TOKEN_SIGNIN: '1',
    RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: !limited.value }) },
    OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: grantFetch }) } as unknown as DurableObjectNamespace,
    ...extra,
  };
  const auth = consoleAuth(settings, fetcher as typeof fetch, () => Date.now() + now.offset)!;
  const app = async (path: string, body: unknown, overrides: Record<string, unknown> = {}) => {
    const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...settings, OWNER_DO: env.OWNER_DO, ...overrides } as never, auth);
    expect(response).not.toBeNull();
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  const console_ = async (path: string, init: RequestInit = {}) => (await handleConsole(new Request(`https://console.fixture.invalid${path}`, init), settings as never, auth))!;
  return { app, console: console_, state, fetcher, member, token, authorize, limited, now, grantFetch, settings, auth };
};

const google = (id_token: string, extra: Record<string, unknown> = {}) => ({ provider: 'google', id_token, nonce: NONCE, request_id: 'signin-request-1', ...extra });
const apple = (id_token: string, extra: Record<string, unknown> = {}) => ({ provider: 'apple', id_token, nonce: NONCE, request_id: 'signin-request-2', ...extra });
type SetCookies = { getSetCookie(): string[] };
const captureLogs = () => {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); }));
  return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
};
const accountRef = async (doName: string) => `acct_${await linkCodeHash(doName)}`;

describe('app sign-in with an Apple or Google identity token', () => {
  it('joins a new member with the invite, binding the email Supabase confirms, and trusts the identity that joined', async () => {
    const { app, state, token } = await supabase();
    const signedIn = await app('/auth/id_token', google(token({ provider: 'google', email: INVITED }), { invite: INVITE, phone: '+919876543210' }));
    expect(signedIn.status).toBe(200);
    expect(appVerifyResultV1Schema.safeParse(signedIn.body).success).toBe(true);
    const owner = state.owners.get(INVITED)!;
    expect(signedIn.body).toMatchObject({ state: 'active', surface: 'app', account_ref: await accountRef(owner.doName) });
    expect(state.signups).toEqual([expect.objectContaining({ p_auth_user: owner.auth, p_email: INVITED, p_phone: '+919876543210', p_code_hash: await linkCodeHash(INVITE) })]);
    expect(state.trusted).toEqual(new Set([`${owner.doName}|google|google:${INVITED}`]));
    expect(state.otp).toEqual([]);
  });

  it('asks an existing owner to confirm a new identity by email code, and signs it in directly once confirmed', async () => {
    const { app, state, member, token } = await supabase();
    const doName = await member();
    const appleToken = token({ provider: 'apple', email: MEMBER, sub: 'apple-member' });
    const first = await app('/auth/id_token', apple(appleToken));
    expect(first.status).toBe(200);
    expect(appIdTokenResultV1Schema.safeParse(first.body).success).toBe(true);
    expect(first.body).toEqual({ state: 'confirm_with_email_code', email: MEMBER, link: expect.any(String) });
    expect(state.otp).toEqual([MEMBER]);
    // A retry is not a way around it: the identity Supabase linked on the first try is still not trusted.
    expect((await app('/auth/id_token', apple(appleToken))).body).toMatchObject({ state: 'confirm_with_email_code' });
    const confirmed = await app('/auth/verify', { email: MEMBER, code: CODE, link: first.body.link });
    expect(confirmed.body).toMatchObject({ state: 'active', account_ref: await accountRef(doName) });
    expect(state.trusted).toEqual(new Set([`${doName}|apple|apple-member`]));
    expect((await app('/auth/id_token', apple(appleToken))).body).toMatchObject({ state: 'active', account_ref: await accountRef(doName) });
    expect(state.otp).toHaveLength(2);
    expect(state.signups).toEqual([]);
  });

  it('trusts nothing from a code entered without the link, with another owner\'s link, or with an expired one', async () => {
    const { app, state, member, token, now } = await supabase();
    await member();
    const other = await member('other@example.test');
    const memberToken = token({ provider: 'google', email: MEMBER, sub: 'google-member' });
    const { link } = (await app('/auth/id_token', google(memberToken))).body as { link: string };
    expect((await app('/auth/verify', { email: MEMBER, code: CODE })).body).toMatchObject({ state: 'active' });
    expect((await app('/auth/verify', { email: 'other@example.test', code: CODE, link })).body).toMatchObject({ state: 'active', account_ref: await accountRef(other) });
    now.offset = 16 * 60_000;
    expect((await app('/auth/verify', { email: MEMBER, code: CODE, link })).body).toMatchObject({ state: 'active' });
    expect(state.trusted).toEqual(new Set());
    now.offset = 0;
    expect((await app('/auth/id_token', google(memberToken))).body).toMatchObject({ state: 'confirm_with_email_code' });
  });

  it('trusts only a link sealed for this code\'s user, email and provider, under the link\'s own purpose', async () => {
    const { app, state, member, token, fetcher } = await supabase();
    const doName = await member();
    const memberUser = state.owners.get(MEMBER)!.auth;
    await app('/auth/id_token', google(token({ provider: 'google', email: MEMBER, sub: 'google-member' })));
    const expires = Math.floor(Date.now() / 1000) + 600;
    const ticket = { user: memberUser, email: MEMBER, provider: 'google', subject: 'google-member', expires };
    const trustCalls = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith('/rpc/trust_signin_identity')).length;
    for (const link of [
      await sealValue(SECRET, 'signinlink', { ...ticket, user: crypto.randomUUID() }),
      await sealValue(SECRET, 'signinlink', { ...ticket, email: 'other@example.test' }),
      await sealValue(SECRET, 'signinlink', { ...ticket, provider: 'github' }),
      await sealValue(SECRET, GOOGLE_PKCE_PURPOSE, ticket),
    ]) expect((await app('/auth/verify', { email: MEMBER, code: CODE, link })).body).toMatchObject({ state: 'active', account_ref: await accountRef(doName) });
    expect(trustCalls()).toBe(0);
    expect(state.trusted).toEqual(new Set());
    await app('/auth/verify', { email: MEMBER, code: CODE, link: await sealValue(SECRET, 'signinlink', ticket) });
    expect(state.trusted).toEqual(new Set([`${doName}|google|google-member`]));
  });

  it('does not trust an identity whose join finds an owner the member\'s own sign-in created a moment before', async () => {
    const { app, state, token } = await supabase();
    // owner_for_auth found no owner; the member's email-code join commits before this join reads the owners.
    state.beforeSignup = a => state.owners.set(INVITED, { auth: a.p_auth_user!, doName: 'owner-made-first' });
    const raced = await app('/auth/id_token', google(token({ provider: 'google', email: INVITED, sub: 'google-second' }), { invite: INVITE }));
    expect(raced.body).toEqual({ state: 'confirm_with_email_code', email: INVITED, link: expect.any(String) });
    expect(state.trusted).toEqual(new Set());
    expect(state.inviteLive).toBe(true);
  });

  it('resolves one owner across an invite join by Apple, a confirmed Google identity and an email code', async () => {
    const { app, state, token } = await supabase();
    const viaApple = await app('/auth/id_token', apple(token({ provider: 'apple', email: INVITED, sub: 'apple-1' }), { invite: INVITE }));
    const owner = state.owners.get(INVITED)!;
    expect(viaApple.body).toMatchObject({ state: 'active', account_ref: await accountRef(owner.doName) });
    const googleToken = token({ provider: 'google', email: INVITED, sub: 'google-1' });
    const asked = await app('/auth/id_token', google(googleToken, { invite: INVITE }));
    expect(asked.body).toMatchObject({ state: 'confirm_with_email_code', email: INVITED });
    expect((await app('/auth/verify', { email: INVITED, code: CODE, invite: INVITE, link: asked.body.link })).body).toMatchObject({ account_ref: await accountRef(owner.doName) });
    expect((await app('/auth/id_token', google(googleToken))).body).toMatchObject({ state: 'active', account_ref: await accountRef(owner.doName) });
    expect(state.owners.size).toBe(1);
    expect(state.signups).toHaveLength(1);
  });

  it('keys a returning identity on its provider subject: Apple with no email, or Google with a changed email, is the same owner', async () => {
    const { app, state, member, token } = await supabase();
    const first = await app('/auth/id_token', apple(token({ provider: 'apple', sub: 'apple-sub-1', email: INVITED }), { invite: INVITE }));
    const again = await app('/auth/id_token', apple(token({ provider: 'apple', sub: 'apple-sub-1', email: '' })));
    expect(again.body).toMatchObject({ state: 'active', account_ref: first.body.account_ref });
    const doName = await member();
    const asked = await app('/auth/id_token', google(token({ provider: 'google', sub: 'google-sub-1', email: MEMBER })));
    await app('/auth/verify', { email: MEMBER, code: CODE, link: asked.body.link });
    expect((await app('/auth/id_token', google(token({ provider: 'google', sub: 'google-sub-1', email: 'renamed@example.test' })))).body)
      .toMatchObject({ state: 'active', account_ref: await accountRef(doName) });
    expect(state.owners.size).toBe(2);
  });

  it('tells someone with no invite, or with another address\'s invite, that they need one, and creates nothing', async () => {
    const { app, state, token } = await supabase();
    expect(await app('/auth/id_token', google(token({ provider: 'google', email: INVITED })))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    // Hide My Email: the private relay address matches no member and no invite, which is bound to the invited address.
    expect(await app('/auth/id_token', apple(token({ provider: 'apple', email: 'abc123@privaterelay.appleid.com' }), { invite: INVITE }))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.size).toBe(0);
    expect(state.inviteLive).toBe(true);
  });

  it('never resolves a member for the same email under an Auth user Supabase did not link', async () => {
    const { app, state, member, token } = await supabase();
    const doName = await member();
    expect(await app('/auth/id_token', google(token({ provider: 'google', sub: 'second-google-sub', email: MEMBER, unlinked: true })))).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.get(MEMBER)!.doName).toBe(doName);
    expect(state.otp).toEqual([]);
  });

  it('never attaches a token carrying a member\'s email unverified, with or without an invite', async () => {
    const { app, state, member, token } = await supabase();
    const doName = await member();
    const memberAuth = state.owners.get(MEMBER)!.auth;
    const attacker = token({ provider: 'google', sub: 'attacker-sub', email: MEMBER, verified: false });
    for (const body of [google(attacker), google(attacker, { invite: INVITE })])
      expect(await app('/auth/id_token', body)).toEqual({ status: 403, body: { error: 'unavailable' } });
    expect(state.owners.get(MEMBER)).toEqual({ auth: memberAuth, doName });
    expect(state.identities.get('google:attacker-sub')?.user).not.toBe(memberAuth);
    expect(state.lookups).toEqual([]);
    expect(state.otp).toEqual([]);
  });

  it('answers the generic 403 when Supabase refuses the token, and logs neither the token nor Supabase\'s answer', async () => {
    const { app, state, token } = await supabase();
    const wrongAudience = token({ provider: 'google', email: INVITED, audience: 'other' });
    const otherNonce = token({ provider: 'apple', email: INVITED, nonce: await hex('another-raw-nonce-000000') });
    const logs = captureLogs();
    try {
      for (const body of [google(wrongAudience, { invite: INVITE }), apple(otherNonce, { invite: INVITE }), google('unknown.issuer.token'), apple(token({ provider: 'google', email: INVITED }))]) {
        expect({ body, answer: await app('/auth/id_token', body) }).toEqual({ body, answer: { status: 403, body: { error: 'unavailable' } } });
      }
    } finally { logs.restore(); }
    expect(state.lookups).toEqual([]);
    expect(logs.lines.length).toBe(4);
    for (const line of logs.lines) {
      expect(line).not.toMatch(/fixture\.|signature|fictional-ios-client|Nonces|audience|raw-nonce/);
      expect(JSON.parse(line)).toMatchObject({ hop: 'app_id_token', ok: false, code: 'id_token_refused' });
    }
  });

  it('answers the generic 403 for a token with no email, an unconfirmed one, or no usable subject, before any owner lookup', async () => {
    const { app, state, token } = await supabase();
    const noSubject = `fixture.${base64url(new TextEncoder().encode('{"n":0}'))}.signature`;
    state.tokens.set(noSubject, { provider: 'google', email: INVITED, sub: 'kept-by-supabase' });
    const logs = captureLogs();
    try {
      expect(await app('/auth/id_token', apple(token({ provider: 'apple', email: '' }), { invite: INVITE }))).toEqual({ status: 403, body: { error: 'unavailable' } });
      expect(await app('/auth/id_token', google(token({ provider: 'google', email: INVITED, verified: false }), { invite: INVITE }))).toEqual({ status: 403, body: { error: 'unavailable' } });
      expect(await app('/auth/id_token', google(noSubject, { invite: INVITE }))).toEqual({ status: 403, body: { error: 'unavailable' } });
    } finally { logs.restore(); }
    expect(logs.lines.map(line => JSON.parse(line).code)).toEqual(['id_token_no_email', 'id_token_no_email', 'id_token_refused']);
    expect(state.lookups).toEqual([]);
  });

  it('on a repeated request id resolves the same owner, with no second owner and no second invite spend', async () => {
    const { app, state, token } = await supabase();
    const jwt = token({ provider: 'google', email: INVITED });
    const first = await app('/auth/id_token', google(jwt, { invite: INVITE }));
    const again = await app('/auth/id_token', google(jwt, { invite: INVITE }));
    expect(first.body).toMatchObject({ state: 'active' });
    expect(again.body).toMatchObject({ state: 'active', account_ref: first.body.account_ref });
    expect(state.owners.size).toBe(1);
    expect(state.inviteLive).toBe(false);
    expect(state.signups.filter(call => call.p_code_hash)).toHaveLength(1);
  });

  it('refuses an invalid body before Supabase is asked, and sends Supabase only the provider, the token and the nonce', async () => {
    const { app, state, fetcher, token } = await supabase();
    const jwt = token({ provider: 'apple', email: INVITED });
    for (const body of [{ ...google(jwt), email: INVITED }, { ...apple(jwt), nonce: undefined }, { ...google(jwt), nonce: undefined }, google('not-a-jwt'), { ...google(jwt), provider: 'facebook' }, { ...google(jwt), client_id: 'web' }])
      expect((await app('/auth/id_token', body)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const logs = captureLogs();
    try { await app('/auth/id_token', apple(jwt, { invite: INVITE, authorization_code: 'c0ffee0123456789abcdef.0.fixture.code-value_01' })); }
    finally { logs.restore(); }
    // Apple's authorization code is accepted and unused until the Sign in with Apple key exists: never sent on, never logged.
    expect(state.grants).toEqual([{ grant_type: 'id_token', provider: 'apple', id_token: jwt, nonce: NONCE }]);
    expect(logs.lines.filter(line => line.includes('c0ffee'))).toEqual([]);
  });

  it('is served only while APP_ID_TOKEN_SIGNIN is "1": otherwise 404, asking Supabase nothing', async () => {
    const { app, fetcher, token } = await supabase();
    const body = google(token({ provider: 'google', email: INVITED }), { invite: INVITE });
    for (const value of ['0', '', undefined, 'true']) expect(await app('/auth/id_token', body, { APP_ID_TOKEN_SIGNIN: value })).toEqual({ status: 404, body: { error: 'unavailable' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await app('/auth/id_token', body, { APP_ID_TOKEN_SIGNIN: '1' })).body).toMatchObject({ state: 'active' });
  });

  it('is rate limited like the code routes, keyed by a digest of the token, and spends the owner\'s send budget on a confirm', async () => {
    const { app, state, limited, fetcher, member, token } = await supabase();
    const jwt = token({ provider: 'google', email: INVITED });
    limited.value = true;
    expect((await app('/auth/id_token', google(jwt, { invite: INVITE }))).status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    limited.value = false;
    await app('/auth/id_token', google(jwt, { invite: INVITE }));
    const keys = () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).p_key).filter(Boolean);
    expect(keys()).toEqual([`id_token:${await hex(jwt)}`, 'ip:unknown']);
    await member();
    state.denySend = true;
    expect((await app('/auth/id_token', google(token({ provider: 'google', email: MEMBER })))).status).toBe(429);
    expect(keys()).toContain(`send:${MEMBER}`);
    expect(state.otp).toEqual([]);
  });

  it('answers 503 when Supabase is down, and 503 when the join collides with an owner already holding the email', async () => {
    const { app, state, member, token } = await supabase();
    state.outage = true;
    expect(await app('/auth/id_token', google(token({ provider: 'google', email: INVITED }), { invite: INVITE }))).toEqual({ status: 503, body: { error: 'unavailable' } });
    state.outage = false;
    await member();
    state.owners.set(INVITED, state.owners.get(MEMBER)!);
    expect(await app('/auth/id_token', google(token({ provider: 'google', sub: 'second-google-sub', email: INVITED, unlinked: true }), { invite: INVITE }))).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(state.inviteLive).toBe(true);
  });
});

describe('console sign-in with Google', () => {
  type Sandbox = Awaited<ReturnType<typeof supabase>>;
  const start = async (sandbox: Sandbox, path = '/console/signin/google') => {
    const response = await sandbox.console(path, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!;
    return { location, cookie, pair: cookie.split(';')[0]! };
  };
  const callback = async (sandbox: Sandbox, token: Token, path = '/console/signin/google') => {
    const { location, pair } = await start(sandbox, path);
    const code = `code-${crypto.randomUUID()}`;
    sandbox.authorize(code, location.searchParams.get('code_challenge')!, token);
    return sandbox.console(`/console/signin/google/callback?code=${code}`, { headers: { cookie: pair, 'sec-fetch-site': 'cross-site' } });
  };
  const cookiesOf = (response: Response) => (response.headers as unknown as SetCookies).getSetCookie();
  const signedIn = (response: Response) => cookiesOf(response).some(value => value.startsWith('waldo_owner='));

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

  it('confirms a member\'s new Google account with an email code, then signs it in with the same console session as a code', async () => {
    const sandbox = await supabase();
    const doName = await sandbox.member();
    const asked = await callback(sandbox, { provider: 'google', email: MEMBER, sub: 'google-member' }, `/console/signin/google?return_to=${encodeURIComponent('/console/devices')}`);
    expect(asked.status).toBe(200);
    expect(signedIn(asked)).toBe(false);
    expect(cookiesOf(asked)).toContain('waldo_google_pkce=; Path=/console/signin/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    const page = await asked.text();
    expect(page).toContain('first time this Google account signs in');
    expect(sandbox.state.otp).toEqual([MEMBER]);
    expect(page.match(/name="link"/g)).toHaveLength(2);
    const link = /name="link" value="([^"]+)"/.exec(page)![1]!.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    const body = new URLSearchParams({ email: MEMBER, code: CODE, link, return_to: '/console/devices' });
    const verified = await sandbox.console('/console/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toBe('/console/devices');
    expect(sandbox.state.trusted).toEqual(new Set([`${doName}|google|google-member`]));
    const direct = await callback(sandbox, { provider: 'google', email: MEMBER, sub: 'google-member' });
    expect(direct.status).toBe(303);
    expect(direct.headers.get('location')).toBe('/console');
    expect(cookiesOf(direct)).toContain('waldo_google_pkce=; Path=/console/signin/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    expect(cookiesOf(direct).some(value => value.startsWith('waldo_console=console-grant-token;'))).toBe(true);
    expect(cookiesOf(direct).some(value => value.startsWith(`waldo_owner=${encodeURIComponent(doName)}.`) && value.includes('HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'))).toBe(true);
    expect(sandbox.state.signups).toEqual([]);
    expect(sandbox.state.otp).toHaveLength(1);
  });

  it('signs in the Google account behind this flow\'s token, not the one that signed in last, even within the same second', async () => {
    const sandbox = await supabase();
    const doName = await sandbox.member();
    // The owner's own Google account is trusted; a second Google account with the same verified address is not.
    const ownerFlow = await start(sandbox);
    sandbox.authorize('owner-1', ownerFlow.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER, sub: 'google-owner' });
    sandbox.state.trusted.add(`${doName}|google|google-owner`);
    // The other account comes back from Google first and holds its code; the owner signs in after it, in the same second.
    const held = await start(sandbox);
    sandbox.authorize('held', held.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER, sub: 'google-other' });
    const later = await start(sandbox);
    sandbox.authorize('owner-2', later.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER, sub: 'google-owner' }, true);
    const owner = await sandbox.console('/console/signin/google/callback?code=owner-2', { headers: { cookie: later.pair } });
    expect(signedIn(owner)).toBe(true);
    const other = await sandbox.console('/console/signin/google/callback?code=held', { headers: { cookie: held.pair } });
    expect(signedIn(other)).toBe(false);
    expect(await other.text()).toContain('first time this Google account signs in');
    expect(sandbox.state.trusted).toEqual(new Set([`${doName}|google|google-owner`]));
  });

  it('signs no one in when Google will not name the account behind the token, or is down', async () => {
    const sandbox = await supabase();
    const doName = await sandbox.member();
    sandbox.state.trusted.add(`${doName}|google|google-x`);
    const logs = captureLogs();
    const attempt = async (code: string) => {
      const flow = await start(sandbox);
      sandbox.authorize(code, flow.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER, sub: 'google-x' });
      return sandbox.console(`/console/signin/google/callback?code=${code}`, { headers: { cookie: flow.pair } });
    };
    expect(signedIn(await attempt('code-ok'))).toBe(true);
    // A token naming a Google account that is not one of this user's identities signs no one in.
    const stray = await start(sandbox);
    sandbox.authorize('code-stray', stray.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER, sub: 'google-x' });
    sandbox.state.flows.get('code-stray')!.sub = 'google-not-linked';
    const strayDone = await sandbox.console('/console/signin/google/callback?code=code-stray', { headers: { cookie: stray.pair } });
    expect(signedIn(strayDone)).toBe(false);
    expect(await strayDone.text()).toContain('Google did not confirm that sign-in');
    sandbox.state.google = 'refuses';
    const refused = await attempt('code-refused');
    expect(signedIn(refused)).toBe(false);
    expect(await refused.text()).toContain('Google did not confirm that sign-in');
    sandbox.state.google = 'down';
    const down = await attempt('code-down');
    expect(signedIn(down)).toBe(false);
    expect(await down.text()).toContain('temporarily unavailable');
    expect(sandbox.state.otp).toEqual([]);
    logs.restore();
    // Google's access token is a credential: it never reaches a log line.
    expect(logs.lines.join('\n')).not.toMatch(/google-access-/);
  });

  it('admits members only: a Google address with no account is told to use the invited email and nothing is created', async () => {
    const sandbox = await supabase();
    const done = await callback(sandbox, { provider: 'google', email: INVITED });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('No Waldo account uses that Google address');
    expect(sandbox.state.signups).toEqual([]);
    expect(sandbox.grantFetch).not.toHaveBeenCalled();
  });

  it('refuses a callback without this browser\'s verifier, with a forged one, or with another browser\'s code', async () => {
    const sandbox = await supabase();
    await sandbox.member();
    const mine = await start(sandbox), theirs = await start(sandbox);
    sandbox.authorize('their-code', theirs.location.searchParams.get('code_challenge')!, { provider: 'google', email: MEMBER });
    const [name, value] = mine.pair.split('=') as [string, string];
    const forged = `${name}=${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
    for (const cookie of ['', forged, mine.pair]) {
      const done = await sandbox.console('/console/signin/google/callback?code=their-code', { headers: cookie ? { cookie } : {} });
      expect(done.status).toBe(200);
      expect(signedIn(done)).toBe(false);
    }
    expect(sandbox.state.grants.filter(grant => grant.grant_type === 'pkce')).toHaveLength(1);
  });

  it('refuses an expired verifier, and one sealed to outlive the flow, without asking Supabase', async () => {
    const sandbox = await supabase();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const seconds = Math.floor(Date.now() / 1000);
    for (const expires of [seconds - 1, seconds + 3600]) {
      const sealed = await sealValue(SECRET, GOOGLE_PKCE_PURPOSE, { verifier, target: null, expires });
      const done = await sandbox.console('/console/signin/google/callback?code=any-code', { headers: { cookie: `${GOOGLE_PKCE_COOKIE}=${sealed}` } });
      expect(await done.text()).toContain('timed out or began in another browser');
    }
    expect(sandbox.state.grants).toEqual([]);
    const fresh = await sealValue(SECRET, GOOGLE_PKCE_PURPOSE, { verifier, target: null, expires: seconds + 60 });
    await sandbox.console('/console/signin/google/callback?code=any-code', { headers: { cookie: `${GOOGLE_PKCE_COOKIE}=${fresh}` } });
    expect(sandbox.state.grants.map(grant => grant.code_verifier)).toEqual([verifier]);
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

// A Sign in with Apple key made for the test: the .p8 Apple downloads is a PKCS #8 P-256 key in PEM.
const appleKeyPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const body = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey, env: { APPLE_SIGNIN_P8: pem, APPLE_KEY_ID: 'FIXTUREKID', APPLE_TEAM_ID: 'FIXTURETEAM' } };
};
const decodePart = (part: string) => JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (part.length % 4)) % 4))) as Record<string, unknown>;
const verifiesUnder = async (jwt: string, publicKey: CryptoKey) => {
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  const raw = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (signature.length % 4)) % 4)), c => c.charCodeAt(0));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, raw, new TextEncoder().encode(`${header}.${payload}`));
};

describe('Apple grants kept at sign-in and revoked at account deletion', () => {
  it('reads the .p8 with its newlines, with them escaped, or with none, and signs a client secret Apple can verify', async () => {
    const { pem, publicKey, env: keyEnv } = await appleKeyPair();
    for (const variant of [pem, pem.replaceAll('\n', '\\n'), pem.replace(/-----[A-Z ]+-----/g, '').replaceAll('\n', '')]) {
      const key = await appleSignInKey({ ...keyEnv, APPLE_SIGNIN_P8: variant });
      expect(key).not.toBeNull();
      const secret = await appleClientSecret(key!, APPLE_CLIENT, Date.parse('2026-10-27T06:00:00Z'));
      expect(decodePart(secret.split('.')[0]!)).toEqual({ alg: 'ES256', kid: 'FIXTUREKID' });
      expect(decodePart(secret.split('.')[1]!)).toEqual({ iss: 'FIXTURETEAM', iat: 1793080800, exp: 1793081100, aud: 'https://appleid.apple.com', sub: APPLE_CLIENT });
      expect(await verifiesUnder(secret, publicKey)).toBe(true);
    }
    for (const missing of ['APPLE_SIGNIN_P8', 'APPLE_KEY_ID', 'APPLE_TEAM_ID']) expect(await appleSignInKey({ ...keyEnv, [missing]: '' })).toBeNull();
    const logs = captureLogs();
    try { expect(await appleSignInKey({ ...keyEnv, APPLE_SIGNIN_P8: 'not-a-key' })).toBeNull(); } finally { logs.restore(); }
    expect(logs.lines).toEqual([JSON.stringify({ hop: 'apple_signin_key', ok: false, code: 'key_unreadable' })]);
  });

  it('exchanges a joining Apple member\'s code under the token\'s client and keeps the refresh token for that identity, logging no token', async () => {
    const { publicKey, env: keyEnv } = await appleKeyPair();
    const { app, state, token } = await supabase(keyEnv);
    const sub = 'apple-sub-joiner';
    const logs = captureLogs();
    let signedIn;
    try { signedIn = await app('/auth/id_token', apple(token({ provider: 'apple', email: INVITED, sub }), { invite: INVITE, authorization_code: `apple-code-for.${sub}` })); } finally { logs.restore(); }
    expect(signedIn.body).toMatchObject({ state: 'active' });
    const exchange = state.apple.find(call => call.path === '/auth/token')!;
    expect(Object.keys(exchange.form).sort()).toEqual(['client_id', 'client_secret', 'code', 'grant_type']);
    expect(exchange.form).toMatchObject({ client_id: APPLE_CLIENT, code: `apple-code-for.${sub}`, grant_type: 'authorization_code' });
    expect(decodePart(exchange.form.client_secret!.split('.')[1]!)).toMatchObject({ iss: 'FIXTURETEAM', sub: APPLE_CLIENT });
    expect(await verifiesUnder(exchange.form.client_secret!, publicKey)).toBe(true);
    const owner = state.owners.get(INVITED)!;
    const kept = [...state.appleGrants.values()];
    expect(kept).toEqual([{ doName: owner.doName, subject: sub, client: APPLE_CLIENT, token: expect.stringMatching(/^apple-refresh-/) }]);
    expect(logs.lines.filter(line => line.includes('apple_grant'))).toEqual([JSON.stringify({ hop: 'apple_grant', ok: true, code: 'kept' })]);
    expect(logs.lines.join('\n')).not.toContain(kept[0]!.token);
    expect(logs.lines.join('\n')).not.toContain('apple-code-for');
  });

  it('signs the owner in whatever Apple does with the code, and keeps nothing when Apple refuses it, is down, or names another account', async () => {
    const { env: keyEnv } = await appleKeyPair();
    for (const answer of ['refuses', 'down', 'other_subject'] as const) {
      const { app, state, token } = await supabase(keyEnv);
      state.appleToken = answer;
      const sub = `apple-sub-${answer}`;
      const logs = captureLogs();
      let signedIn;
      try { signedIn = await app('/auth/id_token', apple(token({ provider: 'apple', email: INVITED, sub }), { invite: INVITE, authorization_code: `apple-code-for.${sub}` })); } finally { logs.restore(); }
      expect(signedIn.body, answer).toMatchObject({ state: 'active' });
      expect(state.appleGrants.size, answer).toBe(0);
      expect(logs.lines.filter(line => line.includes('apple_grant')), answer).toEqual([JSON.stringify({ hop: 'apple_grant', ok: false,
        code: { refuses: 'code_refused', down: 'unavailable', other_subject: 'subject_mismatch' }[answer] })]);
    }
  });

  it('asks Apple nothing without the key, without a code, or before the owner confirms a new Apple identity', async () => {
    const { env: keyEnv } = await appleKeyPair();
    const unkeyed = await supabase();
    const logs = captureLogs();
    try {
      expect((await unkeyed.app('/auth/id_token', apple(unkeyed.token({ provider: 'apple', email: INVITED, sub: 'apple-a' }), { invite: INVITE, authorization_code: 'apple-code-for.apple-a' }))).body).toMatchObject({ state: 'active' });
    } finally { logs.restore(); }
    expect(unkeyed.state.apple).toEqual([]);
    expect(logs.lines.filter(line => line.includes('apple_grant'))).toEqual([JSON.stringify({ hop: 'apple_grant', ok: false, code: 'not_configured' })]);

    const keyed = await supabase(keyEnv);
    expect((await keyed.app('/auth/id_token', apple(keyed.token({ provider: 'apple', email: INVITED, sub: 'apple-b' }), { invite: INVITE }))).body).toMatchObject({ state: 'active' });
    await keyed.member();
    expect((await keyed.app('/auth/id_token', apple(keyed.token({ provider: 'apple', email: MEMBER, sub: 'apple-c' }), { authorization_code: 'apple-code-for.apple-c' }))).body).toMatchObject({ state: 'confirm_with_email_code' });
    expect(keyed.state.apple).toEqual([]);
    expect(keyed.state.appleGrants.size).toBe(0);
  });

  it('revokes every Apple grant held for the owner with Apple, each under its own client, before the owner is deleted', async () => {
    const { env: keyEnv } = await appleKeyPair();
    const { app, state, token, auth } = await supabase(keyEnv);
    await app('/auth/id_token', apple(token({ provider: 'apple', email: INVITED, sub: 'apple-d' }), { invite: INVITE, authorization_code: 'apple-code-for.apple-d' }));
    const owner = state.owners.get(INVITED)!;
    state.appleGrants.set(`${owner.doName}|apple-d|in.heywaldo.console`, { doName: owner.doName, subject: 'apple-d', client: 'in.heywaldo.console', token: 'apple-refresh-web-0000000001' });
    const held = [...state.appleGrants.values()].map(grant => ({ client_id: grant.client, token: grant.token }));
    state.calls.length = 0;
    const logs = captureLogs();
    try { expect(await auth.deleteOwner(owner.doName)).toBe(true); } finally { logs.restore(); }
    expect(state.calls).toEqual(['apple/auth/revoke', 'apple/auth/revoke', 'delete_owner']);
    const revoked = state.apple.filter(call => call.path === '/auth/revoke').map(call => call.form);
    expect(revoked.map(form => ({ client_id: form.client_id, token: form.token, token_type_hint: form.token_type_hint })).sort((x, y) => x.client_id!.localeCompare(y.client_id!)))
      .toEqual(held.map(grant => ({ ...grant, token_type_hint: 'refresh_token' })).sort((x, y) => x.client_id.localeCompare(y.client_id)));
    for (const form of revoked) expect(decodePart(form.client_secret!.split('.')[1]!)).toMatchObject({ sub: form.client_id });
    expect(state.appleGrants.size).toBe(0);
    expect(logs.lines).toEqual([JSON.stringify({ hop: 'apple_revoke', ok: true, code: 'revoked' })]);
  });

  it('deletes the owner even when Apple refuses the revocation, the key is gone or the directory cannot list the grants, and logs which', async () => {
    const { env: keyEnv } = await appleKeyPair();
    for (const failure of ['refuses', 'unkeyed', 'held_down'] as const) {
      const signIn = await supabase(keyEnv);
      await signIn.app('/auth/id_token', apple(signIn.token({ provider: 'apple', email: INVITED, sub: 'apple-e' }), { invite: INVITE, authorization_code: 'apple-code-for.apple-e' }));
      const doName = signIn.state.owners.get(INVITED)!.doName;
      const deleting = failure === 'unkeyed' ? consoleAuth({ ...signIn.settings, APPLE_SIGNIN_P8: '' }, signIn.fetcher as typeof fetch)! : signIn.auth;
      if (failure === 'refuses') signIn.state.appleRevoke = 'refuses';
      if (failure === 'held_down') signIn.state.heldDown = true;
      signIn.state.calls.length = 0;
      const logs = captureLogs();
      try { expect(await deleting.deleteOwner(doName), failure).toBe(true); } finally { logs.restore(); }
      expect(signIn.state.calls.at(-1), failure).toBe('delete_owner');
      expect(signIn.state.calls.filter(call => call.startsWith('apple')).length, failure).toBe(failure === 'refuses' ? 1 : 0);
      expect(logs.lines, failure).toEqual([JSON.stringify({ hop: 'apple_revoke', ok: false, code: { refuses: 'failed', unkeyed: 'not_configured', held_down: 'unavailable' }[failure] })]);
    }
  });

  it('asks Apple nothing at deletion for an owner with no Apple grant', async () => {
    const { env: keyEnv } = await appleKeyPair();
    const { state, auth, member } = await supabase(keyEnv);
    const doName = await member();
    const logs = captureLogs();
    try { expect(await auth.deleteOwner(doName)).toBe(true); } finally { logs.restore(); }
    expect(state.calls).toEqual(['delete_owner']);
    expect(logs.lines).toEqual([]);
  });
});
