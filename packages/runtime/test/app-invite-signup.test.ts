import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appVerifyResultV1Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { consoleAuth } from '../src/identity/console-auth';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';

const SECRET = 'fictional-app-invite-router-secret-00000000000', DIRECTORY = 'https://app-invite.fixture.invalid';
const AUTH = '30000000-0000-0000-0000-000000000003', INVITE = 'ABCDEFGHJKLMNPQRSTUV';

// A fictional directory: one live invite for the invited address, one member whose own owner already exists.
const directory = async (options: { inviteLive?: boolean; member?: string } = {}) => {
  const inviteHash = await linkCodeHash(INVITE);
  const invited = 'new.member@example.test', joined = `owner-${crypto.randomUUID()}`;
  const state = { inviteLive: options.inviteLive ?? true, owners: new Map<string, string>(options.member ? [[options.member, `owner-${crypto.randomUUID()}`]] : []), otp: [] as string[], signups: [] as Record<string, unknown>[], live: new Set<string>() };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), a = JSON.parse(String(init?.body));
    expect(url.origin).toBe(DIRECTORY);
    if (url.pathname === '/auth/v1/otp') { state.otp.push(a.email); return Response.json({}); }
    if (url.pathname === '/auth/v1/verify') return a.token === '123456' ? Response.json({ user: { id: AUTH, email: a.email, email_confirmed_at: new Date().toISOString() } }) : new Response('', { status: 403 });
    const fn = url.pathname.split('/').at(-1)!;
    const signed: Record<string, string> = {
      console_auth_throttle: `throttle.${a.p_key}.${a.p_limit}.${a.p_window_seconds}`, signin_allowed: `signin.${a.p_email}.${a.p_code_hash}`,
      owner_for_auth: `owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`, signup_owner_for_auth: `signup.owner.${a.p_auth_user}.${a.p_email}.${a.p_phone}.${a.p_code_hash}`,
      console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`, console_session_list: `consolesess.list.${a.p_do_name}`,
    };
    expect(signed[fn], `unlisted fixture RPC ${fn}`).toBeDefined();
    expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
    const inviteMatches = state.inviteLive && a.p_email === invited && a.p_code_hash === inviteHash;
    if (fn === 'console_auth_throttle') return Response.json(true);
    if (fn === 'signin_allowed') return Response.json(state.owners.has(a.p_email) || inviteMatches);
    if (fn === 'owner_for_auth') return Response.json(state.owners.get(a.p_email) ?? null);
    if (fn === 'signup_owner_for_auth') {
      state.signups.push(a);
      if (!inviteMatches || a.p_phone !== '') return Response.json(null);
      state.inviteLive = false; state.owners.set(a.p_email, joined);
      return Response.json(joined);
    }
    if (fn === 'console_session_open') { state.live.add(`${a.p_do_name}:${a.p_session_hash}`); return Response.json(true); }
    return Response.json([...state.live].filter(row => row.startsWith(`${a.p_do_name}:`)).map(row => ({ session: row.split(':')[1], created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })));
  });
  const settings = { ...env, SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const auth = consoleAuth(settings, fetcher as typeof fetch)!;
  const app = async (path: string, body: unknown) => {
    const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), settings as never, auth);
    expect(response).not.toBeNull();
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  return { app, state, invited, joined };
};

describe('an invited person joins from the app', () => {
  it('is sent a code only when the invite reaches the code request', async () => {
    const { app, state, invited } = await directory();
    expect(await app('/auth/code', { email: invited })).toEqual({ status: 200, body: { ok: true } });
    expect(state.otp).toEqual([]);
    expect(await app('/auth/code', { email: invited, invite: INVITE })).toEqual({ status: 200, body: { ok: true } });
    expect(state.otp).toEqual([invited]);
  });

  it('gets an owner and an app session from the code and the invite, spending the invite once', async () => {
    const { app, state, invited, joined } = await directory();
    const verified = await app('/auth/verify', { email: invited, code: '123456', invite: INVITE });
    expect(verified.status).toBe(200);
    expect(appVerifyResultV1Schema.safeParse(verified.body).success).toBe(true);
    expect(verified.body).toMatchObject({ state: 'active', surface: 'app', account_ref: `acct_${await linkCodeHash(joined)}` });
    expect(state.signups).toEqual([expect.objectContaining({ p_auth_user: AUTH, p_email: invited, p_phone: '', p_code_hash: await linkCodeHash(INVITE) })]);
    const again = await app('/auth/verify', { email: invited, code: '123456', invite: INVITE });
    expect(again.body).toMatchObject({ state: 'active', account_ref: `acct_${await linkCodeHash(joined)}` });
    expect(state.signups).toHaveLength(1);
  });

  it('without an invite is told it needs one and creates nothing', async () => {
    const { app, state, invited } = await directory();
    expect(await app('/auth/verify', { email: invited, code: '123456' })).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.signups).toEqual([]);
  });

  it('with a spent or revoked invite is told it needs one', async () => {
    const { app, state, invited } = await directory({ inviteLive: false });
    expect(await app('/auth/verify', { email: invited, code: '123456', invite: INVITE })).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.owners.has(invited)).toBe(false);
  });

  it('as an existing member resolves their own owner and never spends an invite', async () => {
    const { app, state } = await directory({ member: 'member@example.test' });
    const verified = await app('/auth/verify', { email: 'member@example.test', code: '123456', invite: INVITE });
    expect(verified.body).toMatchObject({ state: 'active', account_ref: `acct_${await linkCodeHash(state.owners.get('member@example.test')!)}` });
    expect(state.signups).toEqual([]);
  });

  it('with a wrong email code creates nothing', async () => {
    const { app, state, invited } = await directory();
    expect(await app('/auth/verify', { email: invited, code: '654321', invite: INVITE })).toEqual({ status: 200, body: { state: 'needs_invite' } });
    expect(state.signups).toEqual([]);
  });
});
