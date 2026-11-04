// Where Waldo writes first, from the app's settings: the day view's proactive_surface and its proactive_surface.set action
// (controls revision 11), through the Worker and the owner's Durable Object. The setting is the one the first run's
// channel.set writes; a chat that is not linked now cannot be chosen.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { APP_CONTROLS_AGENT_MAIL_REVISION, APP_CONTROLS_PROACTIVE_SURFACE_REVISION, APP_PROACTIVE_SURFACE_RECEIPTS_V1, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { PROACTIVE_SURFACE_KEY, proactiveSurface, setProactiveSurface } from '../src/channels/proactive-surface';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-surface-router-secret-000000000000000', DIRECTORY = 'https://surface-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000011', AUTH = '20000000-0000-0000-0000-000000000011', EMAIL = 'surface-owner@example.test', WHATSAPP = '15550001111';

type Directory = { whatsapp: 'linked' | 'not_linked' | 'down' };
type App = (path: string, body?: unknown) => Promise<Response>;
type World = { app: App; storage: DurableObjectStorage; directory: Directory };

const fixture = async (run: (world: World) => Promise<void>, options: { revision?: number; bound?: boolean } = {}) => {
  const name = `app-surface-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
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
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'surface-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging',
      WALDO_OWNER_DO_NAMESPACE: 'surface-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: SECRET,
      WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
    const instance = new OwnerDO(state, settings as never);
    if (options.bound !== false) state.storage.kv.put('whatsapp_subject', WHATSAPP);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    let credential: string | undefined;
    const app: App = async (path, body) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', [APP_CONTRACT_HEADER]: `controls=${options.revision ?? APP_CONTROLS_PROACTIVE_SURFACE_REVISION}`, ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
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
  return appControlProjectionV1Schema.parse(await response.json()) as { revision: string; data: { proactive_surface?: { value: string; choices: string[] } } };
};
let requests = 0;
const choose = async (app: App, value: string, revision: string, request_id = `surface-request-${++requests}`) => {
  const response = await app('/actions', { view: 'day', action: 'proactive_surface.set', value, revision, request_id });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const receipt = (body: Record<string, unknown>) => appControlResultV1Schema.parse(body).receipt;

it('an owner with WhatsApp linked moves Waldo there from settings, writing the setting the first run writes; a replay is the same receipt', async () => {
  await fixture(async ({ app, storage }) => {
    const before = await dayView(app);
    expect(before.data.proactive_surface).toEqual({ value: 'app', choices: ['app', 'whatsapp', 'both'] });
    const saved = await choose(app, 'whatsapp', before.revision, 'surface-replayed-0001');
    expect([saved.status, receipt(saved.body), saved.body.duplicate]).toEqual([200, APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved, false]);
    expect([storage.kv.get(PROACTIVE_SURFACE_KEY), proactiveSurface(storage.kv)]).toEqual(['whatsapp', 'whatsapp']);
    const replayed = await choose(app, 'whatsapp', before.revision, 'surface-replayed-0001');
    expect([replayed.status, receipt(replayed.body), replayed.body.duplicate]).toEqual([200, APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved, true]);
    // The setting is not part of the day's revision, so a choice never makes the day's other actions stale, and the
    // same revision takes the next choice.
    const after = await dayView(app);
    expect([after.revision, after.data.proactive_surface?.value]).toEqual([before.revision, 'whatsapp']);
    expect(receipt((await choose(app, 'whatsapp', before.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.unchanged);
    expect(receipt((await choose(app, 'both', before.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved);
    expect(receipt((await choose(app, 'app', before.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved);
    expect(proactiveSurface(storage.kv)).toBe('app');
  });
});

it('reads back what the first run chose', async () => {
  await fixture(async ({ app, storage }) => {
    expect(setProactiveSurface(storage.kv, 'both')).toBe(true);
    expect((await dayView(app)).data.proactive_surface).toEqual({ value: 'both', choices: ['app', 'whatsapp', 'both'] });
  });
});

it('refuses WhatsApp while the directory has no WhatsApp linked for this owner, and leaves the setting as it was', async () => {
  await fixture(async ({ app, storage, directory }) => {
    directory.whatsapp = 'not_linked';
    const day = await dayView(app);
    expect(day.data.proactive_surface).toEqual({ value: 'app', choices: ['app'] });
    for (const value of ['whatsapp', 'both']) {
      const refused = await choose(app, value, day.revision);
      // A refusal is 409 with its receipt, as every rejected control receipt is.
      expect([refused.status, receipt(refused.body)]).toEqual([409, APP_PROACTIVE_SURFACE_RECEIPTS_V1.whatsapp_not_linked]);
    }
    expect(storage.kv.get(PROACTIVE_SURFACE_KEY)).toBeUndefined();
  });
});

it('refuses WhatsApp when the directory links it but this owner holds no WhatsApp binding to deliver to', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.proactive_surface?.choices).toEqual(['app']);
    expect(receipt((await choose(app, 'whatsapp', day.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.whatsapp_not_linked);
    expect(storage.kv.get(PROACTIVE_SURFACE_KEY)).toBeUndefined();
  }, { bound: false });
});

it('refuses the app with iMessage while iMessage is not linked', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(receipt((await choose(app, 'app_imessage', day.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.imessage_not_linked);
    expect(storage.kv.get(PROACTIVE_SURFACE_KEY)).toBeUndefined();
  });
});

it('a directory that cannot say refuses a chat as unchecked, never as unlinked, and still lets the owner choose the app', async () => {
  await fixture(async ({ app, storage, directory }) => {
    expect(setProactiveSurface(storage.kv, 'whatsapp')).toBe(true);
    const day = await dayView(app);
    directory.whatsapp = 'down';
    expect(receipt((await choose(app, 'both', day.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.unchecked);
    expect(proactiveSurface(storage.kv)).toBe('whatsapp');
    expect((await dayView(app)).data.proactive_surface).toEqual({ value: 'whatsapp', choices: ['app'] });
    expect(receipt((await choose(app, 'app', day.revision)).body)).toEqual(APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved);
    expect(proactiveSurface(storage.kv)).toBe('app');
  });
});

it('a build below revision 11 never sees the setting and is refused the action', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.proactive_surface).toBeUndefined();
    const refused = await choose(app, 'whatsapp', day.revision);
    expect([refused.status, refused.body]).toEqual([400, { error: 'invalid_action' }]);
    expect(storage.kv.get(PROACTIVE_SURFACE_KEY)).toBeUndefined();
  }, { revision: APP_CONTROLS_AGENT_MAIL_REVISION });
});
