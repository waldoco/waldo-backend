import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { appRenewResultV1Schema, appSessionV1Schema, appVerifyResultV1Schema } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';

const SECRET = 'fictional-renew-router-secret-0000000000000', DIRECTORY = 'https://renew.fixture.invalid', EMAIL = 'owner@example.test';
const OWNER = '10000000-0000-0000-0000-0000000000a1', AUTH = '20000000-0000-0000-0000-0000000000a1';
const HOUR = 3_600_000, DAY = 24 * HOUR;
type Row = { created: number; expires: number; seen: number; rotatedTo?: string };
// The directory's session table as the 30-day migration defines it: each row keeps its own expiry.
const directory = vi.hoisted(() => ({ rows: new Map<string, Row>(), migrated: true, legacyList: false, calls: [] as string[], pushRevoked: [] as string[] }));
const live = (hash: string) => { const row = directory.rows.get(hash); return row && row.expires > Date.now() ? row : undefined; };
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => { directory.rows.clear(); directory.migrated = true; directory.legacyList = false; directory.calls = []; directory.pushRevoked = []; });
afterEach(() => { vi.restoreAllMocks(); });

const withOwner = (name: string, work: (app: (path: string, body?: unknown, credential?: string) => Promise<Response>, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_unused, state) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY);
      const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!; directory.calls.push(fn);
      const signed: Record<string, string> = {
        console_session_open: `consolesess.open.${a.p_do_name}.${a.p_session_hash}`, console_session_touch: `consolesess.touch.${a.p_do_name}.${a.p_session_hash}`,
        console_session_list: `consolesess.list.${a.p_do_name}`, console_session_revoke: `consolesess.revoke.${a.p_do_name}.${a.p_session_hash}`,
        app_session_rotate: `appsess.rotate.${a.p_do_name}.${a.p_session_hash}.${a.p_new_session_hash}`, app_session_authority: `app.session.${a.p_do_name}.${a.p_session_hash}`,
      };
      if (signed[fn]) expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, signed[fn]!));
      const now = Date.now();
      switch (fn) {
        case 'console_auth_throttle': case 'signin_allowed': return Response.json(true);
        case 'owner_for_auth': return Response.json(a.p_do_name ?? name);
        case 'console_session_open': directory.rows.set(a.p_session_hash, { created: now, expires: now + 12 * HOUR, seen: now }); return Response.json(true);
        case 'app_session_rotate': {
          if (!directory.migrated) return new Response('{"code":"PGRST202"}', { status: 404 });
          const old = live(a.p_session_hash); if (!old || old.rotatedTo) return Response.json(false);
          directory.rows.set(a.p_new_session_hash, { created: now, expires: now + 30 * DAY, seen: now }); old.expires = Math.min(old.expires, now + 20 * 60_000); old.rotatedTo = a.p_new_session_hash;
          return Response.json(true);
        }
        case 'console_session_touch': { const row = live(a.p_session_hash); if (row) row.seen = now; return Response.json(row !== undefined); }
        case 'console_session_list': return Response.json([...directory.rows].filter(([hash]) => live(hash)).map(([session, row]) =>
          ({ session, created_at: iso(row.created), last_seen_at: iso(row.seen), ...(directory.legacyList ? {} : { expires_at: iso(row.expires), rotated_to: row.rotatedTo ?? null }) })));
        case 'console_session_revoke': { let dropped = false; for (const [hash, row] of directory.rows) if (hash === a.p_session_hash || row.rotatedTo === a.p_session_hash) dropped = directory.rows.delete(hash) || dropped; return Response.json(dropped); }
        case 'app_session_authority': { const row = live(a.p_session_hash);
          return Response.json(row ? { owner_id: OWNER, do_name: a.p_do_name, session_hash: a.p_session_hash, state_version: 0, admission_revision: '1', expires_at: row.expires } : null); }
        case 'app_push_revoke_session': directory.pushRevoked.push(a.p_session_hash); return Response.json(0);
        case 'owner_runtime_authority': return Response.json({ owner_id: OWNER, auth_user_id: AUTH, do_name: a.p_do_name, state_version: 0, admission_revision: '1' });
        case 'health_context_read': case 'health_plane': return Response.json(null);
        default: throw Error(`Unlisted fixture RPC ${fn}`);
      }
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_TIMEZONE: 'UTC', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
      RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined };
    const owner = new TelegramOwnerDO(state, settings as never); state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://app.fixture.invalid');
    const routed = { ...settings, TELEGRAM_OWNER_DO: { idFromName: (n: string) => env.TELEGRAM_OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => owner.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string) => (await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed))!;
    try { await work(app, state); } finally { (owner as any).ownerBrowser.stop(); await (owner as any).ownerBrowser.maintain(); await state.storage.deleteAlarm(); }
  });
const signIn = async (app: (path: string, body?: unknown) => Promise<Response>) => {
  const verified = await app('/auth/verify', { email: EMAIL, code: '123456' }); expect(verified.status).toBe(200);
  const body = await verified.json();
  expect(shippedVerify.safeParse(body).success).toBe(true);
  return appVerifyResultV1Schema.parse(body) as Extract<ReturnType<typeof appVerifyResultV1Schema.parse>, { credential: string }>;
};
const renew = async (app: (path: string, body?: unknown, credential?: string) => Promise<Response>, credential: string) => {
  const renewed = await app('/auth/renew', {}, credential); expect(renewed.status).toBe(200);
  return appRenewResultV1Schema.parse(await renewed.json());
};
const hashOf = async (credential: string) => linkCodeHash(credential.split('.').at(-2)!);
// What installed apps parse GET /session and /auth/verify with: a strict object without renew_after.
const shippedSession = appSessionV1Schema.omit({ renew_after: true });
const shippedVerify = appRenewResultV1Schema.omit({ renew_after: true });
const queued = (state: DurableObjectState, id: string, owner: string, sessionHash: string, running = false) =>
  state.storage.kv.put(`app:inbox-record:${id}`, { id, updateId: 1, clientId: `${id}-client`, digest: 'd', text: 'queued', owner, sessionHash, conversationRef: 'owner:prn_fixture', admittedAt: Date.now(),
    ...(running ? { state: 'running', attempt: 'fixture-attempt', deadline: Date.now() + 15 * 60_000 } : { state: 'admitted' }) });
const stateOf = (state: DurableObjectState, id: string) => state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state;

it('signing in gives a credential that lasts 30 days, in the shape installed apps already parse', async () => {
  await withOwner('renew-sign-in', async app => {
    const before = Date.now(), auth = await signIn(app), after = Date.now();
    expect(auth.absolute_expires_at).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(auth.absolute_expires_at).toBeLessThanOrEqual(after + 30 * DAY);
    expect(auth.renew_after).toBeUndefined();
    expect(directory.calls.filter(fn => fn === 'console_session_open' || fn === 'app_session_rotate')).toEqual(['console_session_open', 'app_session_rotate']);
    const session = await app('/session', undefined, auth.credential);
    expect(session.status).toBe(200);
    expect(shippedSession.parse(await session.json())).toEqual({ state: 'active', session_ref: auth.session_ref, account_ref: auth.account_ref, surface: 'app', absolute_expires_at: auth.absolute_expires_at });
  });
});

it('before the migration, signing in still works with today\'s 12-hour credential, and renewal is unavailable', async () => {
  await withOwner('renew-unmigrated', async app => {
    directory.migrated = false; directory.legacyList = true;
    const before = Date.now(), auth = await signIn(app);
    expect(auth.absolute_expires_at - before).toBeGreaterThanOrEqual(12 * HOUR - 1_000);
    expect(auth.absolute_expires_at - before).toBeLessThanOrEqual(12 * HOUR + 1_000);
    expect((await app('/session', undefined, auth.credential)).status).toBe(200);
    expect((await app('/auth/renew', {}, auth.credential)).status).toBe(503);
    expect((await app('/session', undefined, auth.credential)).status).toBe(200);
  });
});

it('renewal gives a new credential for 30 days and says when to renew it; the old one works for 20 minutes and renews no more', async () => {
  await withOwner('renew-rotate', async app => {
    const first = await signIn(app);
    const next = await renew(app, first.credential);
    expect(next.credential).not.toBe(first.credential);
    expect(next.session_ref).not.toBe(first.session_ref);
    expect(next.absolute_expires_at).toBeGreaterThanOrEqual(Date.now() + 30 * DAY - 5_000);
    expect(next.renew_after).toBe(next.absolute_expires_at - 29 * DAY);
    const old = directory.rows.get(await hashOf(first.credential))!;
    expect(old.expires).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
    expect(shippedSession.parse(await (await app('/session', undefined, first.credential)).json()).absolute_expires_at).toBe(old.expires);
    const sessions = directory.rows.size;
    expect((await app('/auth/renew', {}, first.credential)).status).toBe(401);
    expect(directory.rows.size).toBe(sessions);
    expect((await app('/session', undefined, first.credential)).status).toBe(200);
    old.expires = Date.now() - 1;
    expect((await app('/session', undefined, first.credential)).status).toBe(401);
    expect((await app('/auth/renew', {}, first.credential)).status).toBe(401);
    expect((await app('/session', undefined, next.credential)).status).toBe(200);
  });
});

it('a list from before the migration, without expiry, still reads as a 12-hour session', async () => {
  await withOwner('renew-legacy-list', async app => {
    const auth = await signIn(app);
    directory.legacyList = true;
    const created = directory.rows.get(await hashOf(auth.credential))!.created;
    const shown = shippedSession.parse(await (await app('/session', undefined, auth.credential)).json());
    expect(shown.absolute_expires_at).toBe(Date.parse(iso(created)) + 12 * HOUR);
  });
});

it('from the connections view the owner signs another device out, never the one in hand', async () => {
  await withOwner('renew-revoke', async (app, state) => {
    const phone = await signIn(app), tablet = await signIn(app);
    const read = async () => appControlProjectionV1Schema.parse(await (await app('/controls?view=connections', undefined, phone.credential)).json());
    const view = await read();
    const items = (view.data as { sessions: { items: { current: boolean; until: string }[] } }).sessions.items;
    // Installed apps parse this row strictly, so it carries no session_ref yet; the app names a device by the ref it was given.
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['current', 'signed_in', 'until']);
    expect(items.map(item => item.current).sort()).toEqual([false, true]);
    for (const item of items) expect(Date.parse(item.until)).toBeGreaterThan(Date.now() + 29 * DAY);
    const tabletHash = (await hashOf(tablet.credential));
    state.storage.kv.put('app:inbox-record:app-tablet-queued', { id: 'app-tablet-queued', updateId: 1, clientId: 'tablet-queued-client', digest: 'd', text: 'queued', owner: 'renew-revoke', sessionHash: tabletHash, conversationRef: 'owner:prn_fixture', admittedAt: Date.now(), state: 'admitted' });
    const own = await app('/actions', { view: 'connections', action: 'session.revoke', value: phone.session_ref, revision: view.revision, request_id: 'revoke-own-0001' }, phone.credential);
    expect(own.status).toBe(409);
    expect((await app('/session', undefined, phone.credential)).status).toBe(200);
    const revoked = await app('/actions', { view: 'connections', action: 'session.revoke', value: tablet.session_ref, revision: (await read()).revision, request_id: 'revoke-tablet-0001' }, phone.credential);
    expect(revoked.status).toBe(200);
    expect(appControlResultV1Schema.parse(await revoked.json()).receipt.state).toBe('recorded');
    expect((await app('/session', undefined, tablet.credential)).status).toBe(401);
    expect(state.storage.kv.get<{ state: string }>('app:inbox-record:app-tablet-queued')?.state).toBe('revoked');
    expect((await app('/session', undefined, phone.credential)).status).toBe(200);
    const after = (await read()).data as { sessions: { items: unknown[] } };
    expect(after.sessions.items).toHaveLength(1);
  });
});

it('signing out after a renewal also closes the work admitted under the session it replaced', async () => {
  await withOwner('renew-signout-chain', async (app, state) => {
    const first = await signIn(app), before = await hashOf(first.credential);
    queued(state, 'app-before-renewal', 'renew-signout-chain', before, true);
    const next = await renew(app, first.credential), after = await hashOf(next.credential);
    const out = await app('/auth/signout', {}, next.credential);
    expect(out.status).toBe(200);
    expect(stateOf(state, 'app-before-renewal')).toBe('revoked');
    // Signing in renews at once, so the device holds three sessions here: sign-in's own, the one renewed at sign-in, and this one.
    expect(directory.pushRevoked).toEqual(expect.arrayContaining([before, after]));
    expect(directory.rows.size).toBe(0);
    for (const credential of [first.credential, next.credential]) expect((await app('/session', undefined, credential)).status).toBe(401);
  });
});

it('signing out with the credential a renewal replaced signs out the renewed session too', async () => {
  await withOwner('renew-signout-old', async (app, state) => {
    const first = await signIn(app);
    const next = await renew(app, first.credential), after = await hashOf(next.credential);
    queued(state, 'app-after-renewal', 'renew-signout-old', after);
    expect((await app('/auth/signout', {}, first.credential)).status).toBe(200);
    expect(stateOf(state, 'app-after-renewal')).toBe('revoked');
    expect(directory.pushRevoked).toContain(after);
    expect((await app('/session', undefined, next.credential)).status).toBe(401);
  });
});

it('signing another device out after it renewed closes the work admitted under its earlier session', async () => {
  await withOwner('renew-revoke-chain', async (app, state) => {
    const phone = await signIn(app), tablet = await signIn(app), before = await hashOf(tablet.credential);
    queued(state, 'app-tablet-before-renewal', 'renew-revoke-chain', before, true);
    const renewed = await renew(app, tablet.credential);
    const read = async () => appControlProjectionV1Schema.parse(await (await app('/controls?view=connections', undefined, phone.credential)).json());
    const revoked = await app('/actions', { view: 'connections', action: 'session.revoke', value: renewed.session_ref, revision: (await read()).revision, request_id: 'revoke-chain-0001' }, phone.credential);
    expect(appControlResultV1Schema.parse(await revoked.json()).receipt.state).toBe('recorded');
    expect(stateOf(state, 'app-tablet-before-renewal')).toBe('revoked');
    for (const credential of [tablet.credential, renewed.credential]) expect((await app('/session', undefined, credential)).status).toBe(401);
    expect((await app('/session', undefined, phone.credential)).status).toBe(200);
  });
});
