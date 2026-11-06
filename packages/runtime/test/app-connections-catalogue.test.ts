import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_GOOGLE_PICTURE_PATH_V1, appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const { OwnerDO } = await import('../src/channels/owner-do');

// Controls revision 17 on the app's Connections: each Google account may carry a picture Waldo serves, and the view lists the
// sources of body readings. Builds below it read what they did.
const OWNER_ID = '6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a';
const HASH = 'c'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const PICTURE = 'https://lh3.googleusercontent.com/a/ACg8oc-synthetic-fixture=s96-c';
const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const wire: { whoopRows: unknown; picture: () => Response; pictureCalls: string[] } = { whoopRows: [], picture: () => new Response(PIXEL, { headers: { 'content-type': 'image/png' } }), pictureCalls: [] };

beforeEach(() => {
  wire.whoopRows = [];
  wire.picture = () => new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
  wire.pictureCalls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://lh3.googleusercontent.com/')) { wire.pictureCalls.push(url); return wire.picture(); }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_inventory') { const at = new Date(Date.now() - 60_000).toISOString(); return Response.json([{ session: HASH, created_at: at, last_seen_at: at, expires_at: new Date(Date.now() + 3_600_000).toISOString(), rotated_to: null, signed_in_at: at }]); }
    if (fn === 'connection_list') return wire.whoopRows === 'down' ? new Response('unavailable', { status: 503 }) : Response.json(wire.whoopRows);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
type Ctx = Readonly<{ owner: Owner; state: DurableObjectState; name: string }>;
const appOwner = async (name: string, check: (ctx: Ctx) => Promise<void>, extra: Record<string, string> = {}) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const owner = new OwnerDO(state, { ...env, ...directory, ...extra, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
    await owner.setup('app').ready;
    try { await check({ owner, state, name }); } finally { await state.storage.deleteAlarm(); }
  });
};
const headers = (name: string, contract?: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, ...(contract ? { 'x-waldo-app-contract': contract } : {}) });
const connections = async ({ owner, name }: Ctx, contract?: string) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=connections', { headers: headers(name, contract) }));
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { google: { accounts: Array<Record<string, unknown>> }; wearables?: Array<Record<string, unknown>> } };
  expect(appControlProjectionV1Schema.safeParse(body).success).toBe(true);
  return body.data;
};
const picture = ({ owner, name }: Ctx, path: string, method = 'GET') => owner.fetch(new Request(`https://telegram-owner${path}`, { method, headers: headers(name) }));
// One account connected after this change, with the picture its ID token gave, and one connected before, with no picture.
const seedAccounts = async ({ state }: Ctx) => {
  await state.storage.put('google:accounts', [{ id: 'conn-new', email: 'new@example.test', scopes: [] }, { id: 'local:old@example.test', email: 'old@example.test', scopes: null, refresh_token: 'synthetic-offline-only' }]);
  await state.storage.put('google:profiles', { 'conn-new': { name: 'Ada Fixture', picture: PICTURE, at: 1 }, 'local:old@example.test': { name: 'Old Fixture', at: 1 } });
};

describe('Google account pictures', () => {
  it('serves a picture path for an account that has one, null for an older account, and nothing below revision 17', async () => {
    await appOwner('app-catalogue-pictures', async (ctx) => {
      await seedAccounts(ctx);
      const accounts = (await connections(ctx, 'controls=17')).google.accounts;
      const fresh = accounts.find(account => account.id === 'conn-new')!, older = accounts.find(account => account.id === 'local:old@example.test')!;
      expect(fresh.picture).toMatch(new RegExp(`^${APP_GOOGLE_PICTURE_PATH_V1}/[a-f0-9]{32}$`));
      expect(JSON.stringify(accounts)).not.toContain('googleusercontent');
      expect(older.picture).toBeNull();
      for (const contract of ['controls=16', undefined]) for (const account of (await connections(ctx, contract)).google.accounts) expect(Object.hasOwn(account, 'picture')).toBe(false);
      expect(wire.pictureCalls).toEqual([]);
    });
  });

  it("fetches the image from Google's host for the app, privately cacheable", async () => {
    await appOwner('app-catalogue-picture-fetch', async (ctx) => {
      await seedAccounts(ctx);
      const path = (await connections(ctx, 'controls=17')).google.accounts.find(account => account.id === 'conn-new')!.picture as string;
      const response = await picture(ctx, path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PIXEL);
      expect(wire.pictureCalls).toEqual([PICTURE]);
    });
  });

  it('answers 404 for a key it does not hold, a changed picture, or a malformed key, without calling Google', async () => {
    await appOwner('app-catalogue-picture-unknown', async (ctx) => {
      await seedAccounts(ctx);
      const path = (await connections(ctx, 'controls=17')).google.accounts.find(account => account.id === 'conn-new')!.picture as string;
      await ctx.state.storage.put('google:profiles', { 'conn-new': { name: 'Ada Fixture', picture: `${PICTURE}-changed`, at: 2 } });
      for (const asked of [path, `${APP_GOOGLE_PICTURE_PATH_V1}/${'0'.repeat(32)}`, `${APP_GOOGLE_PICTURE_PATH_V1}/conn-new`, `${path.replace(/.$/, '')}?v=1`]) expect((await picture(ctx, asked)).status).toBe(404);
      expect((await picture(ctx, path, 'POST')).status).toBe(405);
      expect(wire.pictureCalls).toEqual([]);
    });
  });

  it("refuses what Google answers that is not an image, a redirect, or too large, and never fetches a stored address off Google's hosts", async () => {
    await appOwner('app-catalogue-picture-refusals', async (ctx) => {
      await seedAccounts(ctx);
      const path = (await connections(ctx, 'controls=17')).google.accounts.find(account => account.id === 'conn-new')!.picture as string;
      for (const answer of [() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }), () => new Response(null, { status: 302, headers: { location: 'https://evil.test/x.png' } }),
        () => new Response(PIXEL, { status: 404, headers: { 'content-type': 'image/png' } }), () => new Response(new Uint8Array(1_048_577), { headers: { 'content-type': 'image/jpeg' } }), () => { throw new TypeError('fixture network failure'); }]) {
        wire.picture = answer;
        expect((await picture(ctx, path)).status).toBe(502);
      }
      await ctx.state.storage.put('google:profiles', { 'conn-new': { picture: 'https://169.254.169.254/latest', at: 3 } });
      expect((await connections(ctx, 'controls=17')).google.accounts.find(account => account.id === 'conn-new')!.picture).toBeNull();
    });
  });
});

describe("each Google account's Workspace services", () => {
  const AUTH = 'https://www.googleapis.com/auth/';
  it('says drive, docs, sheets and slides from the saved grant, false for an older grant that never held them, and nothing below revision 17', async () => {
    await appOwner('app-catalogue-services', async (ctx) => {
      await ctx.state.storage.put('google:accounts', [
        { id: 'conn-docs', email: 'docs@example.test', scopes: [`${AUTH}drive.readonly`, `${AUTH}documents.readonly`, `${AUTH}tasks`] },
        { id: 'conn-all', email: 'all@example.test', scopes: ['drive.readonly', 'documents.readonly', 'spreadsheets.readonly', 'presentations.readonly'].map(scope => `${AUTH}${scope}`) },
        { id: 'local:legacy@example.test', email: 'legacy@example.test', scopes: null, refresh_token: 'synthetic-offline-only' },
      ]);
      const accounts = (await connections(ctx, 'controls=17')).google.accounts;
      const services = (id: string) => { const { drive, docs, sheets, slides, tasks } = accounts.find(account => account.id === id)!; return { drive, docs, sheets, slides, tasks }; };
      expect(services('conn-docs')).toEqual({ drive: true, docs: true, sheets: false, slides: false, tasks: true });
      expect(services('conn-all')).toEqual({ drive: true, docs: true, sheets: true, slides: true, tasks: false });
      expect(services('local:legacy@example.test')).toMatchObject({ drive: false, docs: false, sheets: false, slides: false });
      for (const account of (await connections(ctx, 'controls=16')).google.accounts) for (const key of ['drive', 'docs', 'sheets', 'slides']) expect(Object.hasOwn(account, key)).toBe(false);
    });
  });
});

describe('the wearables catalogue', () => {
  const WHOOP = { WHOOP_CLIENT_ID: 'synthetic-client', WHOOP_CLIENT_SECRET: 'synthetic-secret', WHOOP_REDIRECT_URI: 'https://worker.fixture.invalid/oauth/whoop/callback' };

  it('lists phone permissions by platform and cloud accounts by what this Worker can connect, and nothing below revision 17', async () => {
    await appOwner('app-catalogue-wearables', async (ctx) => {
      const { wearables } = await connections(ctx, 'controls=17');
      expect(wearables).toEqual([
        { id: 'apple', kind: 'device', label: 'Apple Watch', access: 'healthkit', platform: 'ios', available: true, connection: null },
        { id: 'samsung', kind: 'device', label: 'Samsung Galaxy Watch', access: 'samsung-health', platform: 'android', available: true, connection: null },
        { id: 'whoop', kind: 'device', label: 'WHOOP', access: 'oauth', platform: null, available: false, connection: null },
        { id: 'garmin', kind: 'device', label: 'Garmin', access: 'oauth', platform: null, available: false, connection: null },
        { id: 'oura', kind: 'device', label: 'Oura Ring', access: 'oauth', platform: null, available: false, connection: null },
      ]);
      expect(Object.hasOwn(await connections(ctx, 'controls=16'), 'wearables')).toBe(false);
    });
  });

  it("carries WHOOP's state and when the owner connected it, and null for a connection made before Waldo recorded that", async () => {
    await appOwner('app-catalogue-whoop', async (ctx) => {
      ctx.state.storage.kv.put('whoop:conn', { id: 'whoop-conn', account: '1001', version: 'v1', expires_at: null, linked_at: 1_762_400_000_000 });
      wire.whoopRows = [{ id: 'whoop-conn', status: 'failing' }];
      const whoop = (await connections(ctx, 'controls=17')).wearables!.find(wearable => wearable.id === 'whoop');
      expect(whoop).toMatchObject({ available: true, connection: { status: 'reauth_needed', connected_at: 1_762_400_000_000 } });
      ctx.state.storage.kv.put('whoop:conn', { id: 'whoop-conn', account: '1001', version: 'v1', expires_at: null });
      expect((await connections(ctx, 'controls=17')).wearables!.find(wearable => wearable.id === 'whoop')!.connection).toEqual({ status: 'reauth_needed', connected_at: null });
      wire.whoopRows = [];
      expect((await connections(ctx, 'controls=17')).wearables!.find(wearable => wearable.id === 'whoop')!.connection).toBeNull();
    }, WHOOP);
  });

  it("leaves the catalogue out when Waldo cannot check WHOOP's connection, rather than calling it connected", async () => {
    await appOwner('app-catalogue-whoop-down', async (ctx) => {
      ctx.state.storage.kv.put('whoop:conn', { id: 'whoop-conn', account: '1001', version: 'v1', expires_at: null, linked_at: 1_762_400_000_000 });
      wire.whoopRows = 'down';
      const data = await connections(ctx, 'controls=17');
      expect(Object.hasOwn(data, 'wearables')).toBe(false);
      expect(data.google).toBeDefined();
    }, WHOOP);
  });
});

describe('the WHOOP entry follows its provider state', () => {
  it.each([['connected', 'active'], ['needs_reconnect', 'reauth_needed'], ['consent_required', 'consent_required']] as const)('%s reads %s', async (state, status) => {
    const { wearablesCatalogue } = await import('../src/health/wearables');
    const whoop = (await wearablesCatalogue({ whoopConfigured: true, whoop: async () => ({ state, connected_at: 5 }) })).find(wearable => wearable.id === 'whoop');
    expect(whoop).toMatchObject({ available: true, connection: { status, connected_at: 5 } });
  });
});
