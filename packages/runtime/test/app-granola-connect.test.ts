import { appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { BEGIN_SESSION_PATH, ticketHash } from '../src/channels/connect-link';
import { routerSignature } from '../src/identity/owner-directory';
import { granolaConnectReceipt } from '../src/channels/dashboard-control-actions';
import { handoffHash } from '../src/channels/connect-confirm';
import { GRANOLA_AUTH_ORIGIN, GRANOLA_MCP_URL } from '../src/connectors/granola-mcp';
import { readMcpState } from '../src/connectors/mcp-connections';
import { MCP_CALLBACK_PATH } from '../src/connectors/mcp-oauth';
import { fakeMcpWorld, type FakeMcpWorld } from './support/fake-mcp-world';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-granola-app-router-secret-0000000000', STATE_SECRET = 'fictional-granola-state-secret', DIRECTORY = 'https://granola-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000003', AUTH = '20000000-0000-0000-0000-000000000003', EMAIL = 'granola-owner@example.test';
const GRANOLA_ORIGIN = new URL(GRANOLA_MCP_URL).origin;
const granolaWorld = () => fakeMcpWorld({ origin: GRANOLA_ORIGIN, issuer: GRANOLA_AUTH_ORIGIN });
type Connections = { revision: string; data: { granola?: { connectAvailable: boolean; connection: unknown } } };

const fixture = async (world: FakeMcpWorld | null, run: (app: (path: string, body?: unknown, credential?: string) => Promise<Response>, issued: Record<string, string>[], instance: OwnerDO) => Promise<void>) => {
  const name = `app-granola-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, issued: Record<string, string>[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (world && [GRANOLA_ORIGIN, GRANOLA_AUTH_ORIGIN].includes(url.origin)) return world.fetcher(input, init);
      expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
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
      if (fn === 'console_session_list') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'granola-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'granola-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined,
      WALDO_OAUTH_STATE_SECRET: STATE_SECRET, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, ...(world ? {} : { WALDO_OAUTH_STATE_SECRET: undefined }) };
    const instance = new OwnerDO(state, settings as never);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
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


it('an app owner starts Granola from Connections: a first-party ticket for Granola, whose Continue starts the MCP sign-in', async () => {
  const world = granolaWorld();
  await fixture(world, async (app, issued, instance) => {
    const credential = await signIn(app);
    const read = await app('/controls?view=connections', undefined, credential);
    const connections = appControlProjectionV1Schema.parse(await read.json()) as unknown as Connections;
    expect(connections.data.granola).toEqual({ connectAvailable: true, connection: null });
    const response = await app('/actions', { view: 'connections', action: 'granola.connect', revision: connections.revision, request_id: 'granola-request-0001' }, credential);
    expect(response.status).toBe(200);
    const { receipt } = appControlResultV1Schema.parse(await response.json());
    expect(receipt).toMatchObject({ state: 'recorded', message: 'Granola connect is ready to begin. Access has not been granted or tested.' });
    expect(receipt.navigation).toMatch(/^\/c\/[A-Za-z0-9_-]{22}\?handoff=[A-Za-z0-9_-]{22}$/);
    const link = new URL(receipt.navigation!, ORIGIN);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ p_provider: 'granola', p_channel: 'app', p_ticket_hash: await ticketHash(link.pathname.slice(3)), p_handoff_hash: await handoffHash(link.searchParams.get('handoff')!) });
    // Nothing reaches Granola until the owner presses Continue, so the sign-in attempt's 15 minutes start there.
    expect(world.hits).toEqual([]);

    const begun = await instance.fetch(new Request(`https://telegram-owner${BEGIN_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: issued[0]!.p_ticket_hash, provider: 'granola' }) }));
    const { url, nonce } = await begun.json() as { url: string; nonce: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${GRANOLA_AUTH_ORIGIN}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ resource: GRANOLA_MCP_URL, redirect_uri: `${ORIGIN}${MCP_CALLBACK_PATH}`, code_challenge_method: 'S256' });
    expect((await readMcpState(STATE_SECRET, authorize.searchParams.get('state')!))?.nonce).toBe(nonce);
    // The attempt remembers its ticket, so a linked sign-in can close it.
    expect(await (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get(`connect_mcp_ticket:${nonce}`)).toMatchObject({ ticket: issued[0]!.p_ticket_hash });
  });
});

it('the app cannot start Granola from another view, with a server address, or when sign-in to servers is not set up', async () => {
  await fixture(granolaWorld(), async (app, issued) => {
    const credential = await signIn(app);
    const day = await (await app('/controls?view=day', undefined, credential)).json() as { revision: string };
    expect((await app('/actions', { view: 'day', action: 'granola.connect', revision: day.revision, request_id: 'granola-request-0002' }, credential)).status).toBe(400);
    const connections = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect((await app('/actions', { view: 'connections', action: 'granola.connect', value: 'https://evil.example/mcp', revision: connections.revision, request_id: 'granola-request-0003' }, credential)).status).toBe(400);
    // Nothing is connected, so there is nothing to disconnect.
    expect((await app('/actions', { view: 'connections', action: 'granola.disconnect', revision: connections.revision, request_id: 'granola-request-0004' }, credential)).status).toBe(409);
    expect(issued).toHaveLength(0);
  });
  await fixture(null, async (app, issued) => {
    const credential = await signIn(app);
    const connections = await (await app('/controls?view=connections', undefined, credential)).json() as Connections;
    expect(connections.data.granola).toEqual({ connectAvailable: false, connection: null });
    expect((await app('/actions', { view: 'connections', action: 'granola.connect', revision: connections.revision, request_id: 'granola-request-0005' }, credential)).status).toBe(409);
    expect(issued).toHaveLength(0);
  });
});

it('a Granola receipt carries only this deployment\'s /c/<ticket> link with its handoff code, and says why a connect failed', () => {
  const handed = `${ORIGIN}/c/AAAAAAAAAAAAAAAAAAAAAA?handoff=BBBBBBBBBBBBBBBBBBBBBB`;
  expect(granolaConnectReceipt(handed, ORIGIN)).toEqual({ state: 'recorded', message: 'Granola connect is ready to begin. Access has not been granted or tested.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA?handoff=BBBBBBBBBBBBBBBBBBBBBB' });
  expect(granolaConnectReceipt(null, ORIGIN)).toEqual({ state: 'rejected', message: 'Granola could not be connected right now. Try again later.' });
  for (const [link, origin] of [[null, ORIGIN], [handed, undefined], [handed, 'https://other.example'], [`${ORIGIN}/c/AAAAAAAAAAAAAAAAAAAAAA`, ORIGIN], [`${handed}#x`, ORIGIN],
    [`${ORIGIN}/console/mcp/start/${'C'.repeat(43)}`, ORIGIN], [`https://mcp-auth.granola.ai/oauth2/authorize`, ORIGIN]] as const)
    expect([link, granolaConnectReceipt(link, origin).state]).toEqual([link, 'rejected']);
});
