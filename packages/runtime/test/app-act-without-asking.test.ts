// "Just do it" from the app's settings: the day view's act_without_asking and its act_without_asking.set action, on their own
// contract pair (act_without_asking=1) beside whatever controls revision the build reads, through the Worker and the owner's
// Durable Object on the receipt-bearing path (auth, owner check, revision, request_id). A build that does not name the pair
// sees nothing of it, and its day revision does not move when the choice does.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { APP_ACT_WITHOUT_ASKING_RECEIPTS_V1, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { ACT_WITHOUT_ASKING_KEY } from '../src/channels/act-without-asking';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-justdoit-router-secret-00000000000000', DIRECTORY = 'https://justdoit-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000023', AUTH = '20000000-0000-0000-0000-000000000023', EMAIL = 'justdoit-owner@example.test', WHATSAPP = '15550001111';

type Directory = { whatsapp: 'linked' | 'not_linked' | 'down' };
type App = (path: string, body?: unknown) => Promise<Response>;
type World = { app: App; storage: DurableObjectStorage; directory: Directory };

const fixture = async (run: (world: World) => Promise<void>, options: { contract?: string; master?: '0' | '1' } = {}) => {
  const name = `app-justdoit-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, directory: Directory = { whatsapp: 'linked' };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body ?? '{}'));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'presence_hint') {
        if (a.p_provider !== 'whatsapp') return Response.json(null);
        if (directory.whatsapp === 'down') return new Response('down', { status: 503 });
        return Response.json(directory.whatsapp === 'linked' ? '1111' : null);
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'justdoit-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging',
      WALDO_OWNER_DO_NAMESPACE: 'justdoit-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: SECRET,
      WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, AUTONOMOUS_BY_DEFAULT: options.master ?? '1' };
    // A set-up owner: the zone is confirmed, so the app's runtime arms the day's own jobs.
    state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('whatsapp_subject', WHATSAPP);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    let credential: string | undefined;
    const app: App = async (path, body) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', [APP_CONTRACT_HEADER]: options.contract ?? 'controls=13,act_without_asking=1', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      credential = ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
      await run({ app, storage: state.storage, directory });
    } finally { fetcher.mockRestore(); }
  });
};

const dayView = async (app: App) => {
  const response = await app('/controls?view=day');
  expect(response.status).toBe(200);
  return appControlProjectionV1Schema.parse(await response.json()) as { revision: string; data: { act_without_asking?: { on: boolean; available: boolean }; schedule_controls?: unknown } };
};
let requests = 0;
const set = async (app: App, value: string, revision: string, request_id = `just-do-it-${++requests}`) => {
  const response = await app('/actions', { view: 'day', action: 'act_without_asking.set', value, revision, request_id });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const receipt = (body: Record<string, unknown>) => appControlResultV1Schema.parse(body).receipt;

it('a build naming the pair at controls 13 reads the choice, on by default, and nothing from controls 14 to 22', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.act_without_asking).toEqual({ on: true, available: true });
    expect(day.data.schedule_controls).toBeUndefined();
    expect(storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBeUndefined();
  });
});

it('turns it off and on with the contract\'s receipts, where the desk reads it, against the revision the owner saw', async () => {
  await fixture(async ({ app, storage }) => {
    let day = await dayView(app);
    expect(receipt((await set(app, 'off', day.revision)).body)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.off);
    expect(storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBe(false);
    // The read before the change is stale now: the choice is in the revision of a build that names the pair.
    const stale = await set(app, 'on', day.revision);
    expect(stale.status).not.toBe(200);
    expect(storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBe(false);
    day = await dayView(app);
    expect(day.data.act_without_asking).toEqual({ on: false, available: true });
    expect(receipt((await set(app, 'off', day.revision)).body)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.already_off);
    day = await dayView(app);
    const on = await set(app, 'on', day.revision, 'just-do-it-replayed');
    expect(receipt(on.body)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.on);
    // The same request again answers with its first receipt and runs nothing twice.
    const replay = await set(app, 'on', day.revision, 'just-do-it-replayed');
    expect(appControlResultV1Schema.parse(replay.body)).toMatchObject({ duplicate: true, receipt: APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.on });
    expect((await dayView(app)).data.act_without_asking).toEqual({ on: true, available: true });
    for (const bad of ['yes', '']) expect((await set(app, bad, (await dayView(app)).revision)).status).toBe(400);
  });
});

it('a build that does not name the pair never sees the field, is refused the action, and its day revision ignores the choice', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.act_without_asking).toBeUndefined();
    const refused = await set(app, 'off', day.revision);
    expect([refused.status, refused.body]).toEqual([400, { error: 'invalid_action' }]);
    expect(storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBeUndefined();
    storage.kv.put(ACT_WITHOUT_ASKING_KEY, false);
    expect((await dayView(app)).revision).toBe(day.revision);
  }, { contract: 'controls=13' });
});

it('where the master switch is 0 the choice reads not available, and a change is saved with a receipt that says it is not active', async () => {
  await fixture(async ({ app, storage }) => {
    let day = await dayView(app);
    expect(day.data.act_without_asking).toEqual({ on: true, available: false });
    expect(receipt((await set(app, 'off', day.revision)).body)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.inactive_off);
    day = await dayView(app);
    expect(day.data.act_without_asking).toEqual({ on: false, available: false });
    expect(receipt((await set(app, 'on', day.revision)).body)).toEqual(APP_ACT_WITHOUT_ASKING_RECEIPTS_V1.inactive_on);
    expect(storage.kv.get(ACT_WITHOUT_ASKING_KEY)).toBe(true);
  }, { master: '0' });
});
