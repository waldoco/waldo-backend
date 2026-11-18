import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindBrowser } from '../src/connectors/oauth-browser-binding';
import {
  googleHealthConfig, handleGoogleHealthCallback, handleGoogleHealthStart, handleGoogleHealthWebhook, GOOGLE_HEALTH_CALLBACK_PATH, GOOGLE_HEALTH_START_PATH, GOOGLE_HEALTH_WEBHOOK_PATH,
} from '../src/health/providers/google-health-routes';
import { dispatchProviderCall } from '../src/health/providers/provider-route';
import type { GoogleHealthOwner } from '../src/health/providers/google-health-owner';
import { setCookies } from './support/cookie-jar';
import { harness } from './helpers/whoop-fakes';

// Google Health's public edges and the owner object's dispatch for them. Synthetic ids and secrets throughout.
const SECRET = 'fictional-router-secret-00000000000000000';
const STATE_SECRET = 'fictional-oauth-state-secret';
const WEBHOOK_SECRET = 'Bearer fictional-webhook-secret-0000';
const ORIGIN = 'https://worker.example.invalid';
const STATE = 'AbCdEfGh0123456789AbCdEfGh012345';
const ENV_BASE = {
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, WALDO_OAUTH_STATE_SECRET: STATE_SECRET,
  GOOGLE_HEALTH_CLIENT_ID: 'gh-client.apps.googleusercontent.com', GOOGLE_HEALTH_REDIRECT_URI: `${ORIGIN}${GOOGLE_HEALTH_CALLBACK_PATH}`, GOOGLE_HEALTH_WEBHOOK_SECRET: WEBHOOK_SECRET,
};
const ACCOUNT = 'HuId-Fixture7';

type Sent = { request: Request; text: string };
const capture = (answer: () => Response) => {
  const sent: Sent[] = [];
  const owners = { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => { sent.push({ request, text: await request.clone().text() }); return answer(); } }) };
  return { owners, sent };
};
const rpcs: { fn: string; body: Record<string, unknown> }[] = [];
let routeRows: unknown = [];
let sessionAnswer: unknown = null;
beforeEach(() => {
  rpcs.length = 0; routeRows = []; sessionAnswer = null;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    if (fn === 'connect_session_begin') return Response.json({ status: 'ok', do_name: 'owner-a' });
    return Response.json(fn === 'health_provider_route' ? routeRows : fn === 'connect_session_resolve' ? sessionAnswer : true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const notification = (start: string, over: Record<string, unknown> = {}) => ({ data: {
  version: '1', healthUserId: ACCOUNT, operation: 'UPSERT', dataType: 'steps',
  intervals: [{ physicalTimeInterval: { startTime: start, endTime: '2026-11-07T09:05:00Z' } }], ...over,
} });
const webhook = async (body: unknown, over: { authorization?: string | null; answer?: () => Response; env?: Record<string, unknown>; method?: string } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const { owners, sent } = capture(over.answer ?? (() => Response.json({ result: 'handled' })));
  const authorization = over.authorization === undefined ? WEBHOOK_SECRET : over.authorization;
  const method = over.method ?? 'POST';
  const response = await handleGoogleHealthWebhook(new Request(`${ORIGIN}${GOOGLE_HEALTH_WEBHOOK_PATH}`, {
    method, headers: { 'content-type': 'application/json', ...(authorization !== null ? { authorization } : {}) }, ...(method === 'POST' ? { body: raw } : {}),
  }), { ...ENV_BASE, OWNER_DO: owners, ...over.env } as never);
  return { response, sent };
};

describe('the Google Health configuration', () => {
  it('runs with both the client id and the redirect, and never holds the client secret', () => {
    expect(googleHealthConfig(ENV_BASE)).toEqual({ clientId: ENV_BASE.GOOGLE_HEALTH_CLIENT_ID, redirectUri: ENV_BASE.GOOGLE_HEALTH_REDIRECT_URI });
    for (const missing of ['GOOGLE_HEALTH_CLIENT_ID', 'GOOGLE_HEALTH_REDIRECT_URI']) expect(googleHealthConfig({ ...ENV_BASE, [missing]: undefined }), missing).toBeNull();
  });
});

describe('the Google Health webhook', () => {
  it('passes Google\'s endpoint check: success with the secret, a refusal without it', async () => {
    expect((await webhook({ type: 'verification' })).response.status).toBe(200);
    expect((await webhook({ type: 'verification' }, { authorization: null })).response.status).toBe(401);
    expect(rpcs).toEqual([]);
  });

  it('refuses a wrong or missing secret before reading anything, and calls nothing', async () => {
    for (const authorization of [null, 'Bearer wrong', WEBHOOK_SECRET.toLowerCase(), WEBHOOK_SECRET.slice(0, -1)]) {
      const { response, sent } = await webhook([notification('2026-11-07T09:00:00Z')], { authorization });
      expect([authorization, response.status, sent.length]).toEqual([authorization, 401, 0]);
    }
    expect(rpcs).toEqual([]);
  });

  it('routes a batch by Google Health user, and tells each owner only the type and the earliest changed instant, once per type', async () => {
    routeRows = [{ do_name: 'owner-a', connection: 'c-1' }];
    const batch = [notification('2026-11-07T09:00:00Z'), notification('2026-11-06T23:00:00Z'), notification('2026-11-05T22:00:00Z', { dataType: 'sleep' })];
    const { response, sent } = await webhook(batch);
    expect(response.status).toBe(200);
    expect(rpcs.map(r => [r.fn, r.body.p_provider, r.body.p_account])).toEqual([['health_provider_route', 'google_health', ACCOUNT], ['health_provider_route', 'google_health', ACCOUNT]]);
    const hints = sent.map(s => JSON.parse(s.text)).sort((a, b) => a.type.localeCompare(b.type));
    expect(hints).toEqual([
      { provider: 'google_health', type: 'sleep', from: '2026-11-05T22:00:00.000Z', trace: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { provider: 'google_health', type: 'steps', from: '2026-11-06T23:00:00.000Z', trace: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    expect(sent.every(s => s.request.headers.get('x-waldo-provider-op') === 'hint' && !s.text.includes(ACCOUNT))).toBe(true);
    const again = await webhook(batch.slice(0, 2));
    expect(JSON.parse(again.sent[0]!.text).trace).toBe(hints[1].trace);
  });

  it('acknowledges and drops an account no live connection holds, and a shape it does not know', async () => {
    for (const body of [[notification('2026-11-07T09:00:00Z')], 'not json', { data: { healthUserId: ACCOUNT } }, [notification('yesterday')]]) {
      const { response, sent } = await webhook(body);
      expect([response.status, sent.length]).toEqual([200, 0]);
    }
  });

  it('asks Google to deliver again only when an owner object could not take the hint', async () => {
    routeRows = [{ do_name: 'owner-a', connection: 'c-1' }];
    expect((await webhook([notification('2026-11-07T09:00:00Z')], { answer: () => new Response('down', { status: 500 }) })).response.status).toBe(503);
    expect((await webhook([notification('2026-11-07T09:00:00Z')], { answer: () => Response.json({ result: 'failed' }) })).response.status).toBe(503);
    expect((await webhook([notification('2026-11-07T09:00:00Z')], { answer: () => Response.json({ result: 'ignored' }) })).response.status).toBe(200);
  });

  it('is absent without its configuration or secret, takes only POST, and bounds the body', async () => {
    expect((await webhook([], { env: { GOOGLE_HEALTH_WEBHOOK_SECRET: undefined } })).response.status).toBe(404);
    expect((await webhook([], { env: { GOOGLE_HEALTH_CLIENT_ID: undefined } })).response.status).toBe(404);
    expect((await webhook([], { method: 'GET' })).response.status).toBe(404);
    expect((await webhook(`[${'"x",'.repeat(20_000)}"x"]`)).response.status).toBe(413);
  });
});

const bound = async (state = STATE) => (await bindBrowser(STATE_SECRET, 'google_health', state, GOOGLE_HEALTH_CALLBACK_PATH, 30 * 60_000, Date.now())).split(';')[0]!;
const LIVE = { status: 'ok', do_name: 'owner-a', provider: 'google_health', begun: false, owner_hint: 'a•••@example.com' };

describe('the Google Health start link and callback', () => {
  it('on Continue spends the attempt, binds this browser and sends it to Google\'s consent page for the three read-only scopes', async () => {
    sessionAnswer = LIVE;
    const confirm = await handleGoogleHealthStart(new Request(`${ORIGIN}${GOOGLE_HEALTH_START_PATH}${STATE}`), ENV_BASE as never);
    expect([confirm.status, (await confirm.text()).includes('Google Health')]).toEqual([200, true]);
    const response = await handleGoogleHealthStart(new Request(`${ORIGIN}${GOOGLE_HEALTH_START_PATH}${STATE}`, { method: 'POST', headers: { origin: ORIGIN } }), ENV_BASE as never);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect([location.origin + location.pathname, location.searchParams.get('state'), location.searchParams.get('access_type')]).toEqual(['https://accounts.google.com/o/oauth2/v2/auth', STATE, 'offline']);
    expect(setCookies(response)[0]!.split('=')[0]).toBe((await bound()).split('=')[0]);
    expect((await handleGoogleHealthStart(new Request(`${ORIGIN}${GOOGLE_HEALTH_START_PATH}AbCd1234`), ENV_BASE as never)).status).toBe(400);
  });

  it('has the owner\'s object exchange the code for Google Health, and says what to do when Google has no Google Health account yet', async () => {
    sessionAnswer = LIVE;
    const run = async (answer: Response) => {
      const { owners, sent } = capture(() => answer);
      const response = await handleGoogleHealthCallback(new Request(`${ORIGIN}${GOOGLE_HEALTH_CALLBACK_PATH}?code=auth-code-1&state=${STATE}`, { headers: { cookie: await bound() } }), { ...ENV_BASE, OWNER_DO: owners } as never);
      return { response, sent, html: await response.text() };
    };
    const linked = await run(Response.json({ outcome: 'linked' }));
    expect([linked.response.status, linked.html.includes('Google Health is connected'), linked.html.includes('auth-code-1')]).toEqual([200, true, false]);
    expect(JSON.parse(linked.sent[0]!.text)).toEqual({ provider: 'google_health', code: 'auth-code-1', denied: false });
    const failed = await run(Response.json({ outcome: 'failed' }));
    expect([failed.response.status, failed.html.includes('Open the Google Health app once')]).toEqual([502, true]);
  });
});

describe('the owner object\'s dispatch for Google Health', () => {
  const fakeGoogle = (configured: boolean, state: 'not_connected' | 'connected' = 'not_connected') => {
    const calls: string[] = [];
    const owner = {
      configured: () => configured,
      status: async () => ({ provider: 'google_health' as const, state, last_sync_at: null }),
      connect: async () => { calls.push('connect'); return { authorize_url: `${ORIGIN}${GOOGLE_HEALTH_START_PATH}${STATE}`, expires_at: 1 }; },
      exchange: async () => { calls.push('exchange'); return 'linked' as const; },
      disconnect: async () => { calls.push('disconnect'); return { revoked_at_provider: false }; },
      hint: async (input: { type: string; from: string; trace: string }) => { calls.push(`hint:${input.type}:${input.from}`); return 'handled' as const; },
    } as unknown as GoogleHealthOwner;
    return { owner, calls };
  };

  it('sends a call that names Google Health to its owner, and one that names nothing to WHOOP as before', async () => {
    const whoop = harness().owner, google = fakeGoogle(true);
    expect(await dispatchProviderCall(whoop, 'connect', { provider: 'google_health' }, google.owner)).toEqual({ status: 200, json: { provider: 'google_health', authorize_url: `${ORIGIN}${GOOGLE_HEALTH_START_PATH}${STATE}`, expires_at: 1 } });
    expect(await dispatchProviderCall(whoop, 'exchange', { provider: 'google_health', code: 'c' }, google.owner)).toEqual({ status: 200, json: { outcome: 'linked' } });
    expect(await dispatchProviderCall(whoop, 'hint', { provider: 'google_health', type: 'steps', from: '2026-11-07T09:00:00.000Z', trace: 't-1' }, google.owner)).toEqual({ status: 200, json: { result: 'handled' } });
    expect(await dispatchProviderCall(whoop, 'disconnect', { provider: 'google_health' }, google.owner)).toEqual({ status: 200, json: { provider: 'google_health', state: 'not_connected', revoked_at_provider: false } });
    expect(google.calls).toEqual(['connect', 'exchange', 'hint:steps:2026-11-07T09:00:00.000Z', 'disconnect']);
    expect((await dispatchProviderCall(whoop, 'connect', {}, google.owner)).json.provider).toBe('whoop');
  });

  it('refuses a provider it does not know, a Google hint without its fields, and a Google call where no owner is wired', async () => {
    const whoop = harness().owner, google = fakeGoogle(true);
    expect(await dispatchProviderCall(whoop, 'connect', { provider: 'fitbit' }, google.owner)).toEqual({ status: 400, json: { error: 'invalid_request' } });
    expect(await dispatchProviderCall(whoop, 'hint', { provider: 'google_health', type: 'steps', trace: 't-1' }, google.owner)).toEqual({ status: 400, json: { error: 'invalid_request' } });
    expect(await dispatchProviderCall(whoop, 'connect', { provider: 'google_health' })).toEqual({ status: 503, json: { error: 'not_configured' } });
    expect(await dispatchProviderCall(whoop, 'exchange', { provider: 'google_health', code: 'c' })).toEqual({ status: 200, json: { outcome: 'failed' } });
    expect(google.calls).toEqual([]);
  });

  it('lists Google Health where this Worker can connect it, or where the owner still holds a connection', async () => {
    const whoop = harness().owner;
    const providers = async (owner: GoogleHealthOwner) => ((await dispatchProviderCall(whoop, 'status', {}, owner)).json.providers as { provider: string }[]).map(row => row.provider);
    expect(await providers(fakeGoogle(true).owner)).toEqual(['whoop', 'google_health']);
    expect(await providers(fakeGoogle(false).owner)).toEqual(['whoop']);
    expect(await providers(fakeGoogle(false, 'connected').owner)).toEqual(['whoop', 'google_health']);
  });
});
