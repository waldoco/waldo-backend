import { appControlResultV1Schema } from '../../contracts/src/app/controls';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { BEGIN_SESSION_PATH, ticketHash } from '../src/channels/connect-link';
import { APP_RETURN_DEEP_LINK, consentPage } from '../src/channels/google-oauth';
import { GOOGLE_CALLBACK_PATH, readConsentState } from '../src/connectors/google';
import { routerSignature } from '../src/identity/owner-directory';
import { googleConnectReceipt } from '../src/channels/dashboard-control-actions';
import { handoffHash } from '../src/channels/connect-confirm';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-connect-app-router-secret-0000000000', STATE_SECRET = 'fictional-connect-state-secret', DIRECTORY = 'https://connect-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000002', AUTH = '20000000-0000-0000-0000-000000000002', EMAIL = 'connect-owner@example.test';
const SUBJECT = '109876543210987654321';
// What the directory answers for the owner's Google sign-in identity; null for an owner who signs in another way.
const directory = vi.hoisted(() => ({ signin: null as unknown, signinStatus: 200, lookups: 0 }));

type App = (path: string, body?: unknown, credential?: string, contract?: string) => Promise<Response>;
const fixture = async (google: boolean, run: (app: App, issued: Record<string, string>[], instance: OwnerDO, state: DurableObjectState) => Promise<void>, signedInAgo = 0) => {
  const name = `app-connect-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date(Date.now() - signedInAgo).toISOString(), expires = Date.now() + 3_600_000, issued: Record<string, string>[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'connect_session_issue_handoff') {
        expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `connsess.issue_handoff.${a.p_do_name}.${a.p_provider}.${a.p_channel}.${a.p_ticket_hash}.${a.p_handoff_hash}`));
        issued.push(a); return Response.json('30000000-0000-0000-0000-000000000002');
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'connect-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      if (fn === 'owner_google_signin') {
        expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `googlesignin.${a.p_do_name}`));
        directory.lookups += 1;
        return directory.signinStatus === 200 ? Response.json(a.p_do_name === name ? directory.signin : null) : new Response('down', { status: directory.signinStatus });
      }
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'connect-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined,
      WALDO_OAUTH_STATE_SECRET: STATE_SECRET, GOOGLE_CLIENT_ID: google ? 'fictional-client.apps.googleusercontent.com' : undefined, GOOGLE_CLIENT_SECRET: google ? 'fictional-client-secret' : undefined };
    const instance = new OwnerDO(state, settings as never);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string, contract?: string) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(contract ? { 'x-waldo-app-contract': contract } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try { await run(app, issued, instance, state); } finally { fetcher.mockRestore(); directory.signin = null; directory.signinStatus = 200; directory.lookups = 0; }
  });
};

const signIn = async (app: App) => {
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
    expect(receipt.navigation).toMatch(/^\/c\/[A-Za-z0-9_-]{22}\?handoff=[A-Za-z0-9_-]{22}$/);
    const link = new URL(receipt.navigation!, ORIGIN);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ p_provider: 'google', p_channel: 'app', p_ticket_hash: await ticketHash(link.pathname.slice(3)), p_handoff_hash: await handoffHash(link.searchParams.get('handoff')!) });
    expect(JSON.stringify(issued)).not.toContain(link.searchParams.get('handoff')!);

    const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash }) }));
    const { url } = await begun.json() as { url: string };
    const consent = new URL(url);
    expect(consent.origin).toBe('https://accounts.google.com');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`);
    expect((await readConsentState(STATE_SECRET, consent.searchParams.get('state')!))?.surface).toBe('app');
    expect(await consentPage({ kind: 'denied' }, null, 'app').text()).toContain(`href="${APP_RETURN_DEEP_LINK}"`);
  });
});

const connectFrom = async (app: App, credential: string) => {
  const { revision } = await (await app('/controls?view=connections', undefined, credential)).json() as { revision: string };
  return app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', revision, request_id: 'connect-request-0002' }, credential);
};

it('a session signed in over two hours ago cannot start Google connect: it is asked to confirm and no ticket is issued', async () => {
  await fixture(true, async (app, issued) => {
    const credential = await signIn(app);
    const response = await connectFrom(app, credential);
    expect([response.status, await response.json()]).toEqual([403, { error: 'step_up_required', code: 'step_up_required' }]);
    expect(issued).toEqual([]);
    expect((await app('/actions/connect-request-0002', undefined, credential)).status).toBe(404);
  }, 3 * 60 * 60_000);
});

it('setup\'s first Google connect, ninety minutes after sign-in, still starts', async () => {
  await fixture(true, async (app, issued) => {
    const response = await connectFrom(app, await signIn(app));
    expect(response.status).toBe(200);
    expect(appControlResultV1Schema.parse(await response.json()).receipt.state).toBe('recorded');
    expect(issued).toHaveLength(1);
  }, 90 * 60_000);
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

it('a connect receipt carries only this deployment\'s own start links: the console start path, or a /c/<ticket> with its handoff code', () => {
  const handed = `${ORIGIN}/c/AAAAAAAAAAAAAAAAAAAAAA?handoff=BBBBBBBBBBBBBBBBBBBBBB`, console = `/console/google/start/${'C'.repeat(43)}`;
  expect(googleConnectReceipt(handed, ORIGIN)).toEqual({ state: 'recorded', message: 'Google connect is ready to begin. Access has not been granted or tested.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA?handoff=BBBBBBBBBBBBBBBBBBBBBB' });
  expect(googleConnectReceipt(console, ORIGIN)).toMatchObject({ state: 'recorded', navigation: console });
  expect(googleConnectReceipt(null, ORIGIN).state).toBe('rejected');
  for (const [link, origin] of [[handed, undefined], [handed, 'https://other.example'], [`${ORIGIN}/c/AAAAAAAAAAAAAAAAAAAAAA`, ORIGIN], [`${handed}&next=x`, ORIGIN], [`${handed}#x`, ORIGIN],
    [`${ORIGIN}/c/short?handoff=BBBBBBBBBBBBBBBBBBBBBB`, ORIGIN], [`${ORIGIN}/console`, ORIGIN], [`https://other.example${console}`, ORIGIN], [`${console}x`, ORIGIN]] as const)
    expect([link, googleConnectReceipt(link, origin).state]).toEqual([link, 'rejected']);
});

type Connections = { revision: string; data: { google: { connectAvailable: boolean; signin?: { email: string } } } };
const begin = async (instance: OwnerDO, ticketHashOf: string) => {
  const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: ticketHashOf }) }));
  return new URL((await begun.json() as { url: string }).url);
};
const tickets = (issued: Record<string, string>[]) => issued.filter(row => row.p_ticket_hash);

it('a Google signer-in is offered their sign-in account, and connecting it sends Google there with consent still asked', async () => {
  directory.signin = { subject: SUBJECT, email: EMAIL };
  await fixture(true, async (app, issued, instance, state) => {
    const logs = vi.spyOn(console, 'log'), errors = vi.spyOn(console, 'error');
    const credential = await signIn(app);
    const offered = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect(offered.data.google.signin).toEqual({ email: EMAIL });
    // Outside the view's revision: an action read before or after the offer appears is not stale.
    directory.signin = null;
    const without = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect('signin' in without.data.google).toBe(false);
    expect(without.revision).toBe(offered.revision);
    directory.signin = { subject: SUBJECT, email: EMAIL };
    const response = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', account: 'signin', revision: offered.revision, request_id: 'connect-request-0101' }, credential);
    expect(appControlResultV1Schema.parse(await response.json()).receipt.state).toBe('recorded');
    const [ticket] = tickets(issued);
    expect([...state.storage.kv.list({ prefix: 'connect_hint:' })]).toHaveLength(1);
    const consent = await begin(instance, ticket!.p_ticket_hash!);
    expect(consent.searchParams.get('login_hint')).toBe(SUBJECT);
    expect(consent.searchParams.get('prompt')).toBe('consent');
    expect(consent.searchParams.get('include_granted_scopes')).toBe('true');
    expect([...state.storage.kv.list({ prefix: 'connect_hint:' })]).toEqual([]);
    const logged = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
    expect(logged).not.toContain(SUBJECT);
    expect(logged).not.toContain(EMAIL);
    logs.mockRestore(); errors.mockRestore();
  });
});

it('a different account, an owner with no Google sign-in, or a directory that cannot answer gets Google\'s chooser', async () => {
  directory.signin = { subject: SUBJECT, email: EMAIL };
  await fixture(true, async (app, issued, instance) => {
    const credential = await signIn(app);
    const { revision } = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    const lookups = directory.lookups;
    await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', revision, request_id: 'connect-request-0102' }, credential);
    expect(directory.lookups).toBe(lookups);
    const consent = await begin(instance, tickets(issued)[0]!.p_ticket_hash!);
    expect(consent.searchParams.has('login_hint')).toBe(false);
    expect(consent.searchParams.get('prompt')).toBe('consent select_account');
  });
  for (const [signin, status] of [[null, 200], [{ subject: 'has space', email: EMAIL }, 200], [{ subject: SUBJECT, email: EMAIL }, 503]] as const) {
    directory.signin = signin; directory.signinStatus = status;
    await fixture(true, async (app, issued, instance) => {
      const credential = await signIn(app);
      const read = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
      expect('signin' in read.data.google).toBe(false);
      const response = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', account: 'signin', revision: read.revision, request_id: 'connect-request-0103' }, credential);
      expect(appControlResultV1Schema.parse(await response.json()).receipt.state).toBe('recorded');
      const consent = await begin(instance, tickets(issued)[0]!.p_ticket_hash!);
      expect(consent.searchParams.has('login_hint')).toBe(false);
      expect(consent.searchParams.get('prompt')).toBe('consent select_account');
    });
  }
});

it('the sign-in account is not offered once it is connected, nor while Google cannot be connected', async () => {
  directory.signin = { subject: SUBJECT, email: EMAIL };
  await fixture(true, async (app, _issued, _instance, state) => {
    await state.storage.put('google:accounts', [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const credential = await signIn(app);
    const read = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect('signin' in read.data.google).toBe(false);
  });
  await fixture(false, async (app, issued) => {
    const credential = await signIn(app);
    const read = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect(read.data.google.connectAvailable).toBe(false);
    expect('signin' in read.data.google).toBe(false);
    expect(directory.lookups).toBe(0);
  });
});

it('account belongs to google.connect alone, and is part of what a request id stands for', async () => {
  directory.signin = { subject: SUBJECT, email: EMAIL };
  await fixture(true, async (app, issued) => {
    const credential = await signIn(app);
    const { revision } = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect((await app('/actions', { view: 'connections', action: 'granola.connect', account: 'signin', revision, request_id: 'connect-request-0104' }, credential)).status).toBe(400);
    const first = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', account: 'signin', revision, request_id: 'connect-request-0105' }, credential);
    expect(first.status).toBe(200);
    const again = await app('/actions', { view: 'connections', action: 'google.connect', value: 'calendar', revision, request_id: 'connect-request-0105' }, credential);
    expect([again.status, (await again.json() as { error: string }).error]).toEqual([409, 'request_reused']);
    expect(tickets(issued)).toHaveLength(1);
  });
});
