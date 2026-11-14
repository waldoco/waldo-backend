import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { APP_GOOGLE_PICTURE_PATH_V1 } from '../../contracts/src/app/controls';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';

// The picture route as the app reaches it: through the worker's router, the session check and the owner object.
it('serves a Google account picture through the router only to a signed-in session, and only on GET', async () => {
  const name = `picture-app-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const SECRET = 'fictional-picture-router-secret-00000000000', DIRECTORY = 'https://picture.fixture.invalid', OWNER = '10000000-0000-0000-0000-0000000000b2', AUTH = '20000000-0000-0000-0000-0000000000b2', EMAIL = 'owner@example.test';
    const PICTURE = 'https://lh3.googleusercontent.com/a/ACg8oc-route-fixture=s96-c', PIXEL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    let hash: string | undefined, live = false; const created = new Date().toISOString(), expires = Date.now() + 3_600_000;
    const pictureCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://lh3.googleusercontent.com') { pictureCalls.push(url.href); return new Response(PIXEL, { headers: { 'content-type': 'image/jpeg' } }); }
      expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(expires).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
      if (fn === 'health_plane') return Response.json(null);
      if (fn === 'assert_channel_presence') return Response.json(false);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_TIMEZONE: 'UTC',
      SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name);
    await state.storage.put('google:accounts', [{ id: 'conn-route', email: EMAIL, scopes: [] }]);
    await state.storage.put('google:profiles', { 'conn-route': { picture: PICTURE, at: 1 } });
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const call = async (method: 'GET' | 'POST', path: string, credential?: string, contract?: string) => (await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, {
      method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(contract ? { 'x-waldo-app-contract': contract } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) }), routed))!;
    try {
      expect((await handleApp(new Request('https://app.fixture.invalid/app/v1/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) }), routed))!.status).toBe(200);
      const credential = (await (await handleApp(new Request('https://app.fixture.invalid/app/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: '123456' }) }), routed))!.json() as { credential: string }).credential;
      const read = await call('GET', '/controls?view=connections', credential, 'controls=17');
      expect(read.status).toBe(200);
      const path = ((await read.json()) as { data: { google: { accounts: Array<{ picture?: string | null }> } } }).data.google.accounts[0]!.picture!;
      expect(path).toMatch(new RegExp(`^${APP_GOOGLE_PICTURE_PATH_V1}/[a-f0-9]{32}$`));
      const sub = path.slice('/app/v1'.length);
      expect((await call('GET', sub)).status).toBe(401);
      expect(pictureCalls).toEqual([]);
      const served = await call('GET', sub, credential);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/jpeg');
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(PIXEL);
      expect((await call('POST', sub, credential)).status).toBe(405);
      expect(pictureCalls).toEqual([PICTURE]);
    } finally { vi.restoreAllMocks(); await state.storage.deleteAlarm(); }
  });
});
