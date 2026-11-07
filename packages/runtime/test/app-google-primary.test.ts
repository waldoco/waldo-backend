import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const { OwnerDO } = await import('../src/channels/owner-do');

// Controls revision 20 on the app's Connections: one Google account is primary, the one Waldo uses when nothing names an
// account, and the owner chooses it with google.set_primary. Builds below it read and do what they did.
const OWNER_ID = '6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a';
const HASH = 'c'.repeat(64);
const signinEmail: { value: string | null } = { value: null };
const SIGNED_IN = new Date(Date.now() - 60_000).toISOString(), SESSION_ENDS = new Date(Date.now() + 3_600_000).toISOString();
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const PICTURE = 'https://lh3.googleusercontent.com/a/ACg8oc-synthetic-fixture=s96-c';
const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const wire: { whoopRows: unknown; picture: () => Response; pictureCalls: string[] } = { whoopRows: [], picture: () => new Response(PIXEL, { headers: { 'content-type': 'image/png' } }), pictureCalls: [] };

beforeEach(() => {
  signinEmail.value = null;
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
    if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: SIGNED_IN, last_seen_at: SIGNED_IN, expires_at: SESSION_ENDS, rotated_to: null, signed_in_at: SIGNED_IN }]);
    if (fn === 'owner_account_email') return Response.json(signinEmail.value);
    if (fn === 'connection_list') return wire.whoopRows === 'down' ? new Response('unavailable', { status: 503 }) : Response.json(wire.whoopRows);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Client = Readonly<{ account: Readonly<{ email: string | null }> }>;
type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; google: Readonly<{ client(feature: string): Promise<Client | null> }> }; fetch(request: Request): Promise<Response> }>;
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
const accounts = [
  { id: 'local:first@example.test', email: 'first@example.test', scopes: null, refresh_token: 'synthetic-offline-only-1' },
  { id: 'local:second@example.test', email: 'second@example.test', scopes: null, refresh_token: 'synthetic-offline-only-2' },
];
const GOOGLE = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' };
const act = async ({ owner, name }: Ctx, body: Record<string, unknown>, contract = 'controls=20') => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(name, contract), 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const read = async ({ owner, name }: Ctx, contract = 'controls=20') => {
  const body = await (await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=connections', { headers: headers(name, contract) }))).json() as { revision: string; data: { google: { accounts: Array<Record<string, unknown>> } } };
  expect(appControlProjectionV1Schema.safeParse(body).success).toBe(true);
  return body;
};
const primaryOf = (body: Awaited<ReturnType<typeof read>>) => body.data.google.accounts.filter(account => account.primary === true).map(account => account.id);

describe('the primary Google account', () => {
  it('is the first connected account until the owner chooses, then the chosen one, and Waldo uses it when nothing names an account', async () => {
    await appOwner('app-google-primary', async (ctx) => {
      await ctx.state.storage.put('google:accounts', accounts);
      await ctx.state.storage.put('origin', 'https://worker.fixture.invalid');
      const first = await read(ctx);
      expect(primaryOf(first)).toEqual(['local:first@example.test']);
      expect((await ctx.owner.setup('app').google.client('calendar'))!.account.email).toBe('first@example.test');

      const chosen = await act(ctx, { view: 'connections', action: 'google.set_primary', id: 'local:second@example.test', revision: first.revision, request_id: 'primary-0001' });
      expect([chosen.status, appControlResultV1Schema.parse({ ...chosen.body }).receipt.state]).toEqual([200, 'recorded']);
      expect(primaryOf(await read(ctx))).toEqual(['local:second@example.test']);
      expect((await ctx.owner.setup('app').google.client('calendar'))!.account.email).toBe('second@example.test');
    }, GOOGLE);
  });

  it("is the account the owner signs in with, when nothing is chosen and it is connected and healthy, and Waldo uses it", async () => {
    await appOwner('app-google-primary-signin', async (ctx) => {
      await ctx.state.storage.put('google:accounts', accounts);
      await ctx.state.storage.put('origin', 'https://worker.fixture.invalid');
      signinEmail.value = 'second@example.test';
      expect(primaryOf(await read(ctx))).toEqual(['local:second@example.test']);
      expect(await ctx.state.storage.get('google:primary')).toBe('local:second@example.test');
      expect((await ctx.owner.setup('app').google.client('calendar'))!.account.email).toBe('second@example.test');
    }, GOOGLE);
  });

  it('keeps the first account when the sign-in account is not connected', async () => {
    await appOwner('app-google-primary-signin-absent', async (ctx) => {
      await ctx.state.storage.put('google:accounts', accounts);
      signinEmail.value = 'elsewhere@example.test';
      expect(primaryOf(await read(ctx))).toEqual(['local:first@example.test']);
      expect(await ctx.state.storage.get('google:primary')).toBeUndefined();
    }, GOOGLE);
  });

  it('refuses an account that is not connected, and returns to the first account once the primary is disconnected', async () => {
    await appOwner('app-google-primary-gone', async (ctx) => {
      await ctx.state.storage.put('google:accounts', accounts);
      const { revision } = await read(ctx);
      expect((await act(ctx, { view: 'connections', action: 'google.set_primary', id: 'local:nobody@example.test', revision, request_id: 'primary-0101' })).status).toBe(409);
      expect(await ctx.state.storage.get('google:primary')).toBeUndefined();
      expect((await act(ctx, { view: 'connections', action: 'google.set_primary', id: 'local:second@example.test', revision, request_id: 'primary-0102' })).status).toBe(200);
      const after = await read(ctx);
      expect((await act(ctx, { view: 'connections', action: 'google.disconnect', id: 'local:second@example.test', revision: after.revision, request_id: 'primary-0103' })).status).toBe(200);
      expect(await ctx.state.storage.get('google:primary')).toBeUndefined();
      expect(primaryOf(await read(ctx))).toEqual(['local:first@example.test']);
    }, GOOGLE);
  });

  it('is neither shown nor chosen by a build below revision 20', async () => {
    await appOwner('app-google-primary-older', async (ctx) => {
      await ctx.state.storage.put('google:accounts', accounts);
      for (const contract of ['controls=19', 'controls=17']) for (const account of (await read(ctx, contract)).data.google.accounts) expect(Object.hasOwn(account, 'primary')).toBe(false);
      const { revision } = await read(ctx, 'controls=19');
      expect((await act(ctx, { view: 'connections', action: 'google.set_primary', id: 'local:second@example.test', revision, request_id: 'primary-0201' }, 'controls=19')).status).toBe(400);
      expect(await ctx.state.storage.get('google:primary')).toBeUndefined();
    }, GOOGLE);
  });
});
