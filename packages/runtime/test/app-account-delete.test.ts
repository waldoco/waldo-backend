import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { handleApp } from '../src/channels/app-api';
import { routerSignature } from '../src/identity/owner-directory';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-delete-app-router-secret-00000000000', DIRECTORY = 'https://delete-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000003', AUTH = '20000000-0000-0000-0000-000000000003', EMAIL = 'delete-owner@example.test';
type App = (path: string, body?: unknown, credential?: string) => Promise<Response>;
type Outcome = 'deleted' | 'refused' | 'throws';
type Seen = { deletes: number; state: DurableObjectState; name: string };

// delete_owner revokes every session and the owner's authority, as the SQL function does, so the
// signed-out assertions observe the fixture's directory rather than a constant.
const fixture = async (outcome: Outcome, run: (app: App, seen: Seen) => Promise<void>) => {
  const name = `app-delete-owner-${crypto.randomUUID()}`, stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false, owned = true;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, seen: Seen = { deletes: 0, state, name };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'delete_owner') {
        expect(a.p_do_name).toBe(name);
        expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `delown.${name}`));
        seen.deletes++;
        if (outcome === 'throws') throw Error('Directory unreachable');
        if (outcome === 'refused') return Response.json(false);
        live = false; owned = false; return Response.json(true);
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(owned && a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_list') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(owned && a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json(owned ? { owner_id: OWNER, environment: 'staging', namespace: 'delete-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 } : null);
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'delete-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined };
    const instance = new TelegramOwnerDO(state, settings as never);
    const routed = { ...settings, TELEGRAM_OWNER_DO: { idFromName: (n: string) => env.TELEGRAM_OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app: App = async (path, body, credential) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try { await run(app, seen); } finally { fetcher.mockRestore(); }
  });
};

const signIn = async (app: App) => {
  expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
  return ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
};
const account = async (app: App, credential: string) => {
  const response = await app('/controls?view=account', undefined, credential);
  expect(response.status).toBe(200);
  return appControlProjectionV1Schema.parse(await response.json());
};
const remove = (revision: string, request_id = 'delete-request-0001') => ({ view: 'account', action: 'account.delete', confirmation: 'DELETE', revision, request_id });
const stored = (state: DurableObjectState) => [...state.storage.kv.list()].length
  + state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").one().count;

it('an app-only owner deletes their account from the app: the directory removes them once, owner storage is erased, and the old credential is refused', async () => {
  await fixture('deleted', async (app, seen) => {
    const credential = await signIn(app);
    const view = await account(app, credential);
    expect(view).toMatchObject({ view: 'account', data: { deletion_available: true } });
    expect(JSON.stringify(view)).not.toContain('csrf');
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
    await seen.state.storage.setAlarm(Date.now() + 3_600_000);
    expect(stored(seen.state)).toBeGreaterThan(0);
    const response = await app('/actions', remove(view.revision), credential);
    expect(response.status).toBe(200);
    expect(appControlResultV1Schema.parse(await response.json())).toMatchObject({ request_id: 'delete-request-0001', duplicate: false, receipt: { state: 'recorded', signed_out: true } });
    expect(seen.deletes).toBe(1);
    expect(stored(seen.state)).toBe(0);
    expect(await seen.state.storage.getAlarm()).toBeNull();
    // Falsifier: the old credential reads, replays and chats nothing, and writes nothing back.
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(401);
    expect((await app('/actions/delete-request-0001', undefined, credential)).status).toBe(401);
    expect((await app('/chat/main/messages', { client_message_id: 'after-delete-0001', text: 'hello' }, credential)).status).toBe(401);
    expect(seen.deletes).toBe(1);
    expect(stored(seen.state)).toBe(0);
  });
});

it('a deletion without the typed confirmation, or against a stale read, never reaches the directory', async () => {
  await fixture('deleted', async (app, seen) => {
    const credential = await signIn(app);
    const { revision } = await account(app, credential);
    const { confirmation: _confirmation, ...unconfirmed } = remove(revision);
    expect((await app('/actions', unconfirmed, credential)).status).toBe(400);
    expect((await app('/actions', { ...remove(revision), confirmation: 'delete' }, credential)).status).toBe(400);
    expect((await app('/actions', remove('0'.repeat(64)), credential)).status).toBe(409);
    expect(seen.deletes).toBe(0);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
  });
});

it('a deletion the directory refuses is rejected and leaves the owner signed in with storage intact', async () => {
  await fixture('refused', async (app, seen) => {
    const credential = await signIn(app);
    const response = await app('/actions', remove((await account(app, credential)).revision), credential);
    expect(response.status).toBe(409);
    expect(appControlResultV1Schema.parse(await response.json()).receipt.state).toBe('rejected');
    expect(seen.deletes).toBe(1);
    expect(seen.state.storage.kv.get('do_name')).toBe(seen.name);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
  });
});

it('an unconfirmed deletion can be read back, and resending the same request never runs a second deletion', async () => {
  await fixture('throws', async (app, seen) => {
    const credential = await signIn(app);
    const body = remove((await account(app, credential)).revision);
    const first = await app('/actions', body, credential);
    expect(first.status).toBe(503);
    expect(appControlResultV1Schema.parse(await first.json())).toMatchObject({ duplicate: false, receipt: { state: 'unconfirmed' } });
    const again = await app('/actions', body, credential);
    expect(appControlResultV1Schema.parse(await again.json())).toMatchObject({ duplicate: true, receipt: { state: 'unconfirmed' } });
    const read = await app('/actions/delete-request-0001', undefined, credential);
    expect(read.status).toBe(200);
    expect(appControlResultV1Schema.parse(await read.json())).toMatchObject({ request_id: 'delete-request-0001', duplicate: true, receipt: { state: 'unconfirmed' } });
    expect(seen.deletes).toBe(1);
  });
});

it('a directory deletion whose local erase fails is reported incomplete and still signed out', async () => {
  await fixture('deleted', async (app, seen) => {
    const credential = await signIn(app);
    const { revision } = await account(app, credential);
    vi.spyOn(seen.state.storage, 'deleteAll').mockRejectedValueOnce(Error('Storage unavailable'));
    const response = await app('/actions', remove(revision), credential);
    expect(response.status).toBe(503);
    expect(appControlResultV1Schema.parse(await response.json()).receipt).toMatchObject({ state: 'incomplete', signed_out: true });
    expect(seen.deletes).toBe(1);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(401);
  });
});
