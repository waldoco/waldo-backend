import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { CONSOLE_ACTION_PATH, consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { routerSignature } from '../src/identity/owner-directory';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-signout-router-secret-000000000000', DIRECTORY = 'https://signout-all.fixture.invalid', ORIGIN = 'https://app.fixture.invalid', ROOT = 'https://telegram-owner';
const OWNER = '10000000-0000-0000-0000-000000000004', AUTH = '20000000-0000-0000-0000-000000000004', EMAIL = 'signout-owner@example.test';
type App = (path: string, body?: unknown, credential?: string) => Promise<Response>;
type Console = (path: string, token: string, form?: Record<string, string>) => Promise<Response>;
type Outcome = 'revoked' | 'throws' | 'unavailable';
type Seen = { signouts: number; grant: () => Promise<string> };

// console_signout_all deletes every directory session row for the owner, as the SQL function does,
// so a revoked app credential is observed through the fixture's directory rather than asserted.
const fixture = async (outcome: Outcome, run: (app: App, console: Console, seen: Seen) => Promise<void>) => {
  const name = `signout-all-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    // The model call runs on the owner's boot day plan; the pool answers it with OpenAI's own rejection.
    const strays: string[] = [], pool = globalThis.fetch;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, seen: Seen = { signouts: 0, grant: () => consoleAccess(state.storage).grant() };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); if (url.host === 'api.openai.com') return pool(input, init);
      if (url.origin !== DIRECTORY) { strays.push(url.host); throw Error(`Unlisted fixture origin ${url.host}`); } const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'console_signout_all') {
        expect(a.p_do_name).toBe(name);
        expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `consolesess.signout.${name}`));
        seen.signouts++;
        if (outcome === 'throws') throw Error('Directory unreachable');
        if (outcome === 'unavailable') return Response.json({ message: 'unavailable' }, { status: 503 });
        const count = live ? 1 : 0; live = false; return Response.json(count);
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_list') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'signout-all-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'health_log_recent') return Response.json([]);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: '123:synthetic', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'signout-all-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined };
    const instance = new OwnerDO(state, settings as never);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app: App = async (path, body, credential) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    const console: Console = (path, token, form) => instance.fetch(new Request(ROOT + path, {
      method: form ? 'POST' : 'GET',
      headers: { cookie: `waldo_console=${token}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    }));
    try { await run(app, console, seen); } finally { fetcher.mockRestore(); }
    expect(strays).toEqual([]);
  });
};

// One phone signed in to the app and one browser signed in to the console through a Telegram link:
// the console holds a single local session, which used to hide "Sign out everywhere" entirely.
const signedIn = async (app: App) => {
  expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
  const credential = ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
  expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
  return credential;
};
const connections = async (console: Console, token: string) => {
  const response = await console(`${CONTROLS_PATH}?view=connections`, token);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ csrf: string; revision: string }>;
};
const signOutAll = (read: { csrf: string; revision: string }) => ({ csrf: read.csrf, revision: read.revision, view: 'connections', action: 'session.signout.all', request_id: 'signout-all-request-01' });

it('sign out everywhere from the console dashboard also signs the app out, even with one console browser', async () => {
  await fixture('revoked', async (app, console, seen) => {
    const credential = await signedIn(app);
    const token = await seen.grant();
    const response = await console(CONTROL_ACTION_PATH, token, signOutAll(await connections(console, token)));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: false, receipt: { state: 'recorded', signed_out: true } });
    expect(seen.signouts).toBe(1);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(401);
    expect((await console(`${CONTROLS_PATH}?view=connections`, token)).status).toBe(401);
  });
});

for (const outcome of ['throws', 'unavailable'] as const) {
  it(`a directory sign-out that ${outcome === 'throws' ? 'never answers' : 'fails'} is not reported as done, and this browser stays signed in`, async () => {
    await fixture(outcome, async (app, console, seen) => {
      const credential = await signedIn(app);
      const token = await seen.grant();
      const logged = vi.spyOn(globalThis.console, 'log').mockImplementation(() => undefined);
      const response = await console(CONTROL_ACTION_PATH, token, signOutAll(await connections(console, token)));
      const events = logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes('console_signout_all')); logged.mockRestore();
      expect(events).toHaveLength(1);
      expect(Object.keys(JSON.parse(events[0]!)).sort()).toEqual(['code', 'hop', 'ok', 'trace']);
      expect(JSON.parse(events[0]!)).toMatchObject({ hop: 'console_signout_all', ok: false, code: 'directory_unconfirmed' });
      const { receipt } = await response.json() as { receipt: { state: string; signed_out?: boolean } };
      expect(response.status).toBe(503);
      expect(receipt.state).not.toBe('recorded');
      expect(receipt.signed_out).toBeUndefined();
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(seen.signouts).toBe(1);
      expect((await console(`${CONTROLS_PATH}?view=connections`, token)).status).toBe(200);
      expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
    });
  });
}

it('the classic console form signs the app out too, and keeps this browser signed in when the directory fails', async () => {
  await fixture('revoked', async (app, console, seen) => {
    const credential = await signedIn(app);
    const token = await seen.grant();
    const { csrf } = await connections(console, token);
    const response = await console(CONSOLE_ACTION_PATH, token, { csrf, action: 'session.signout.all' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(seen.signouts).toBe(1);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(401);
    expect((await console(`${CONTROLS_PATH}?view=connections`, token)).status).toBe(401);
  });
  await fixture('unavailable', async (app, console, seen) => {
    const credential = await signedIn(app);
    const token = await seen.grant();
    const { csrf } = await connections(console, token);
    const response = await console(CONSOLE_ACTION_PATH, token, { csrf, action: 'session.signout.all' });
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(seen.signouts).toBe(1);
    expect((await console(`${CONTROLS_PATH}?view=connections`, token)).status).toBe(200);
    expect((await app('/controls?view=day', undefined, credential)).status).toBe(200);
  });
});
