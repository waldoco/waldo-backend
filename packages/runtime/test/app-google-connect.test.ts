import { appControlResultV1Schema } from '../../contracts/src/app/controls';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { handleApp } from '../src/channels/app-api';
import { BEGIN_SESSION_PATH, ticketHash } from '../src/channels/connect-link';
import { APP_RETURN_DEEP_LINK, consentPage } from '../src/channels/google-oauth';
import { GOOGLE_CALLBACK_PATH, readConsentState } from '../src/connectors/google';
import { routerSignature } from '../src/identity/owner-directory';
import { googleConnectReceipt } from '../src/channels/dashboard-control-actions';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-connect-app-router-secret-0000000000', STATE_SECRET = 'fictional-connect-state-secret', DIRECTORY = 'https://connect-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000002', AUTH = '20000000-0000-0000-0000-000000000002', EMAIL = 'connect-owner@example.test';

const fixture = async (google: boolean, run: (app: (path: string, body?: unknown, credential?: string) => Promise<Response>, issued: Record<string, string>[], instance: TelegramOwnerDO) => Promise<void>) => {
  const name = `app-connect-owner-${crypto.randomUUID()}`, stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, issued: Record<string, string>[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'connect_session_issue') {
        expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `connsess.issue.${a.p_do_name}.${a.p_provider}.${a.p_channel}.${a.p_ticket_hash}`));
        issued.push(a); return Response.json('30000000-0000-0000-0000-000000000002');
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_list') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'connect-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'connect-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined,
      TELEGRAM_WEBHOOK_SECRET: STATE_SECRET, GOOGLE_CLIENT_ID: google ? 'fictional-client.apps.googleusercontent.com' : undefined, GOOGLE_CLIENT_SECRET: google ? 'fictional-client-secret' : undefined };
    const instance = new TelegramOwnerDO(state, settings as never);
    const routed = { ...settings, TELEGRAM_OWNER_DO: { idFromName: (n: string) => env.TELEGRAM_OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try { await run(app, issued, instance); } finally { fetcher.mockRestore(); }
  });
};

const signIn = async (app: (path: string, body?: unknown, credential?: string) => Promise<Response>) => {
  expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
  return ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
};

it('an app-only owner starts Google connect from the app: a first-party ticket issued for the app, consent that returns to the app', async () => {
  await fixture(true, async (app, issued, instance) => {
    const credential = await signIn(app);
    const connections = await (await app('/controls?view=connections', undefined, credential)).json() as { revision: string; data: { google: { connectAvailable: boolean } } };
    expect(connections.data.google.connectAvailable).toBe(true);
    const response = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', revision: connections.revision, request_id: 'connect-request-0001' }, credential);
    expect(response.status).toBe(200);
    const { receipt } = appControlResultV1Schema.parse(await response.json());
    expect(receipt.state).toBe('recorded');
    expect(receipt.navigation).toMatch(/^\/c\/[A-Za-z0-9_-]{22}$/);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ p_provider: 'google', p_channel: 'app', p_ticket_hash: await ticketHash(receipt.navigation!.slice(3)) });

    const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash }) }));
    const { url } = await begun.json() as { url: string };
    const consent = new URL(url);
    expect(consent.origin).toBe('https://accounts.google.com');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`);
    expect((await readConsentState(STATE_SECRET, consent.searchParams.get('state')!))?.surface).toBe('app');
    expect(await consentPage({ kind: 'denied' }, null, 'app').text()).toContain(`href="${APP_RETURN_DEEP_LINK}"`);
  });
});

it('the app cannot start Google connect from another view, with an unknown feature, or when Google is not configured', async () => {
  await fixture(true, async (app, issued) => {
    const credential = await signIn(app);
    const day = await (await app('/controls?view=day', undefined, credential)).json() as { revision: string };
    expect((await app('/actions', { view: 'day', action: 'google.connect', value: 'calendar', revision: day.revision, request_id: 'connect-request-0002' }, credential)).status).toBe(400);
    const connections = await (await app('/controls?view=connections', undefined, credential)).json() as { revision: string };
    const unknown = await app('/actions', { view: 'connections', action: 'google.connect', value: 'photos', revision: connections.revision, request_id: 'connect-request-0003' }, credential);
    expect(appControlResultV1Schema.parse(await unknown.json()).receipt.state).toBe('rejected');
    expect(issued).toHaveLength(0);
  });
  await fixture(false, async (app, issued) => {
    const credential = await signIn(app);
    const connections = await (await app('/controls?view=connections', undefined, credential)).json() as { revision: string; data: { google: { connectAvailable: boolean } } };
    expect(connections.data.google.connectAvailable).toBe(false);
    const response = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', revision: connections.revision, request_id: 'connect-request-0004' }, credential);
    expect(response.status).toBe(409);
    expect(issued).toHaveLength(0);
  });
});

it('a connect receipt carries only this deployment\'s own /c/<ticket> path, for the console and the app alike', () => {
  const ticket = `${ORIGIN}/c/AAAAAAAAAAAAAAAAAAAAAA`;
  expect(googleConnectReceipt(ticket, ORIGIN)).toEqual({ state: 'recorded', message: 'Google connect is ready to begin. Access has not been granted or tested.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA' });
  expect(googleConnectReceipt(null, ORIGIN).state).toBe('rejected');
  for (const [link, origin] of [[ticket, undefined], [ticket, 'https://other.example'], [`${ticket}?next=x`, ORIGIN], [`${ticket}#x`, ORIGIN], [`${ORIGIN}/c/short`, ORIGIN], [`${ORIGIN}/console`, ORIGIN]] as const)
    expect(googleConnectReceipt(link, origin)).toMatchObject({ state: 'rejected' });
});
