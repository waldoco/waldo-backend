import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProviderCall, HEALTH_PROVIDER_PATH, callOwnerProvider, verifiedProviderCall } from '../src/health/providers/provider-route';
import { handleWhoopCallback, handleWhoopStart, handleWhoopWebhook, whoopConfig, whoopSignature, WHOOP_CALLBACK_PATH, WHOOP_START_PATH, WHOOP_WEBHOOK_PATH } from '../src/health/providers/whoop-routes';
import { WHOOP_ATTEMPT_TTL_MS } from '../src/health/providers/whoop-client';
import { bindBrowser } from '../src/connectors/oauth-browser-binding';
import { handoffHash } from '../src/channels/connect-confirm';
import { cookieJar, setCookies } from './support/cookie-jar';
import worker from '../src/index';
import { harness, newPlane, newWorld } from './helpers/whoop-fakes';
import { webhookBody } from './fixtures/whoop-synthetic';

const SECRET = 'fictional-router-secret-00000000000000000';
const CLIENT_SECRET = 'whoop-client-secret-fixture';
const ENV_BASE = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, WHOOP_CLIENT_ID: 'client-id-fixture', WHOOP_CLIENT_SECRET: CLIENT_SECRET, WHOOP_REDIRECT_URI: 'https://worker.example.invalid/oauth/whoop/callback' };

// The Worker's call to an owner's object, captured instead of sent.
type Sent = { request: Request; text: string };
const capture = (answer: () => Response | Promise<Response>) => {
  const sent: Sent[] = [];
  const owners = { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => { sent.push({ request, text: await request.clone().text() }); return answer(); } }) };
  return { owners, sent };
};
const signed = async (op: Parameters<typeof callOwnerProvider>[3] = 'status', body: Record<string, unknown> = {}, doName = 'owner-a') => {
  const { owners, sent } = capture(() => Response.json({ ok: true }));
  await callOwnerProvider(owners, SECRET, doName, op, body);
  return sent[0]!.request;
};
const resend = async (request: Request, over: { headers?: Record<string, string>; body?: string; method?: string } = {}) =>
  new Request(request.url, { method: over.method ?? request.method, headers: { ...Object.fromEntries(request.headers), ...over.headers }, ...((over.method ?? request.method) === 'POST' ? { body: over.body ?? await request.clone().text() } : {}) });
const isOwnerA = (name: string) => name === 'owner-a';

describe('the provider route between the Worker and an owner object', () => {
  it('carries an operation and its body for one owner, and the owner object accepts exactly that', async () => {
    const request = await signed('hint', { type: 'sleep.updated', id: 'abc', trace: 'trace-1' });
    expect(new URL(request.url).pathname).toBe(HEALTH_PROVIDER_PATH);
    expect(await verifiedProviderCall(request, SECRET, isOwnerA)).toEqual({ op: 'hint', body: { type: 'sleep.updated', id: 'abc', trace: 'trace-1' } });
  });

  it('refuses a forged, re-addressed, re-operated, re-bodied, oversize or unsigned request', async () => {
    const base = await signed('hint', { type: 'sleep.updated', id: 'abc', trace: 'trace-1' });
    const cases = {
      forged: await resend(base, { headers: { 'x-waldo-provider-sig': '0'.repeat(64) } }),
      otherOwner: await signed('hint', { type: 'sleep.updated', id: 'abc', trace: 'trace-1' }, 'owner-b'),
      reAddressed: await resend(await signed('hint', {}, 'owner-b'), { headers: { 'x-waldo-do-name': 'owner-a' } }),
      reOperated: await resend(base, { headers: { 'x-waldo-provider-op': 'disconnect' } }),
      reBodied: await resend(base, { body: JSON.stringify({ type: 'sleep.deleted', id: 'abc', trace: 'trace-1' }) }),
      unknownOp: await resend(base, { headers: { 'x-waldo-provider-op': 'delete_everything' } }),
      wrongMethod: await resend(base, { method: 'GET' }),
      oversize: await resend(base, { body: JSON.stringify({ pad: 'x'.repeat(5_000) }) }),
    };
    for (const [label, request] of Object.entries(cases)) expect([label, await verifiedProviderCall(request, SECRET, isOwnerA)]).toEqual([label, null]);
    expect(await verifiedProviderCall(await signed(), undefined, isOwnerA)).toBeNull();
    expect(await verifiedProviderCall(await signed(), 'another-secret', isOwnerA)).toBeNull();
  });

  it('answers null when the owner object is unreachable or answers something that is not an object', async () => {
    expect(await callOwnerProvider({ idFromName: n => n as never, get: () => ({ fetch: async () => { throw new Error('away'); } }) }, SECRET, 'o', 'status', {})).toBeNull();
    expect(await callOwnerProvider(capture(() => new Response('[1]')).owners, SECRET, 'o', 'status', {})).toBeNull();
  });

  it('dispatches each operation to the owner module and answers codes and ids only', async () => {
    const h = harness();
    expect(await dispatchProviderCall(h.owner, 'status', {})).toEqual({ status: 200, json: { providers: [{ provider: 'whoop', state: 'not_connected', last_sync_at: null }] } });
    const connect = await dispatchProviderCall(h.owner, 'connect', {});
    expect(connect.status).toBe(200);
    expect(Object.keys(connect.json).sort()).toEqual(['authorize_url', 'expires_at', 'provider']);
    expect(await dispatchProviderCall(h.owner, 'exchange', { code: 'good-code' })).toEqual({ status: 200, json: { outcome: 'linked' } });
    expect(await dispatchProviderCall(h.owner, 'hint', { type: 'sleep.updated', id: 'x' })).toEqual({ status: 400, json: { error: 'invalid_request' } });
    expect(await dispatchProviderCall(h.owner, 'disconnect', {})).toEqual({ status: 200, json: { provider: 'whoop', state: 'not_connected', revoked_at_provider: true } });
    const noModel = newPlane(); noModel.model = 'none';
    expect(await dispatchProviderCall(harness({ plane: noModel }).owner, 'connect', {})).toEqual({ status: 403, json: { error: 'consent_required', missing: ['model_processing'] } });
    expect(await dispatchProviderCall(harness({ configured: false }).owner, 'connect', {})).toEqual({ status: 503, json: { error: 'not_configured' } });
  });
});

describe('the WHOOP configuration', () => {
  it('runs only with all three values set', () => {
    expect(whoopConfig(ENV_BASE)).toEqual({ clientId: 'client-id-fixture', clientSecret: CLIENT_SECRET, redirectUri: 'https://worker.example.invalid/oauth/whoop/callback' });
    for (const missing of ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI']) expect(whoopConfig({ ...ENV_BASE, [missing]: undefined }), missing).toBeNull();
  });
});

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let routeRows: unknown = [];
let sessionAnswer: unknown = null;
let beginAnswer: unknown = null;
// The one handoff code the directory would redeem, once, for the attempt the start link names.
let handoffHashLive: string | null = null;
beforeEach(() => {
  rpcs.length = 0; routeRows = []; sessionAnswer = null; beginAnswer = { status: 'ok', do_name: 'owner-a' }; handoffHashLive = null;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    if (fn === 'connect_session_hand_off') { const ok = handoffHashLive !== null && rpcs.at(-1)!.body.p_handoff_hash === handoffHashLive; if (ok) handoffHashLive = null; return Response.json(ok); }
    if (fn === 'connect_session_begin') { const answer = beginAnswer; beginAnswer = null; return Response.json(answer); }
    return Response.json(fn === 'health_provider_route' ? routeRows : fn === 'connect_session_resolve' ? sessionAnswer : true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const webhook = async (body: unknown, over: { signature?: string; timestamp?: string; method?: string; env?: Record<string, unknown> } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = over.timestamp ?? '1790000000000';
  const { owners, sent } = capture(() => Response.json({ result: 'handled' }));
  const response = await handleWhoopWebhook(new Request(`https://w.test${WHOOP_WEBHOOK_PATH}`, {
    method: over.method ?? 'POST', headers: { 'x-whoop-signature': over.signature ?? await whoopSignature(CLIENT_SECRET, timestamp, raw), 'x-whoop-signature-timestamp': timestamp },
    ...((over.method ?? 'POST') === 'POST' ? { body: raw } : {}),
  }), { ...ENV_BASE, OWNER_DO: owners, ...over.env } as never);
  return { response, sent };
};

describe('the WHOOP webhook', () => {
  it('proves WHOOP sent it, finds the owner by WHOOP account, and tells that owner only the kind and the record id', async () => {
    routeRows = [{ do_name: 'owner-a', connection: 'c-1' }];
    const { response, sent } = await webhook(webhookBody());
    expect(response.status).toBe(200);
    expect(rpcs.map(r => r.fn)).toEqual(['health_provider_route']);
    expect(rpcs[0]!.body).toMatchObject({ p_provider: 'whoop', p_account: '70001' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.request.headers.get('x-waldo-do-name')).toBe('owner-a');
    expect(JSON.parse(sent[0]!.text)).toEqual({ type: 'sleep.updated', id: '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', trace: 'a1b2c3d4-0000-4000-8000-00000000aa01' });
    expect(sent[0]!.text).not.toContain('70001');
  });

  it('refuses a forged signature, a tampered body, a missing header or a wrong key, and calls nothing', async () => {
    const good = JSON.stringify(webhookBody());
    const cases = [
      await webhook(webhookBody(), { signature: 'AAAA' }),
      await webhook(good.replace('sleep.updated', 'sleep.deleted'), { signature: await whoopSignature(CLIENT_SECRET, '1790000000000', good) }),
      await webhook(webhookBody(), { signature: await whoopSignature('another-secret', '1790000000000', good) }),
      await webhook(webhookBody(), { timestamp: '' }),
    ];
    for (const { response, sent } of cases) expect([response.status, sent.length]).toEqual([403, 0]);
    expect(rpcs).toEqual([]);
  });

  it('acknowledges and drops a delivery for an account no live connection holds, and an unknown shape', async () => {
    routeRows = [];
    const unknownAccount = await webhook(webhookBody());
    expect([unknownAccount.response.status, unknownAccount.sent.length]).toEqual([200, 0]);
    rpcs.length = 0;
    for (const body of ['not json', { user_id: 'x', id: 1 }, { ...webhookBody(), user_id: -4 }, []]) {
      const { response } = await webhook(body);
      expect(response.status, JSON.stringify(body)).toBe(200);
    }
    expect(rpcs).toEqual([]);
  });

  it('asks WHOOP to deliver again only when an owner object could not take the hint', async () => {
    routeRows = [{ do_name: 'owner-a', connection: 'c-1' }];
    const unreachable = await handleWhoopWebhook(new Request(`https://w.test${WHOOP_WEBHOOK_PATH}`, { method: 'POST', headers: { 'x-whoop-signature': await whoopSignature(CLIENT_SECRET, '1', JSON.stringify(webhookBody())), 'x-whoop-signature-timestamp': '1' }, body: JSON.stringify(webhookBody()) }),
      { ...ENV_BASE, OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('away'); } }) } } as never);
    expect(unreachable.status).toBe(503);
    for (const [result, status] of [['failed', 503], ['rate_limited', 503], ['needs_reconnect', 200], ['consent_required', 200], ['duplicate', 200], ['handled', 200]] as const) {
      const raw = JSON.stringify(webhookBody());
      const { owners } = capture(() => Response.json({ result }));
      const response = await handleWhoopWebhook(new Request(`https://w.test${WHOOP_WEBHOOK_PATH}`, { method: 'POST', headers: { 'x-whoop-signature': await whoopSignature(CLIENT_SECRET, '1', raw), 'x-whoop-signature-timestamp': '1' }, body: raw }), { ...ENV_BASE, OWNER_DO: owners } as never);
      expect([result, response.status]).toEqual([result, status]);
    }
  });

  it('is absent without its configuration, refuses other methods, and bounds the body', async () => {
    expect((await webhook(webhookBody(), { env: { WHOOP_CLIENT_SECRET: undefined } })).response.status).toBe(404);
    expect((await webhook(webhookBody(), { method: 'GET' })).response.status).toBe(404);
    expect((await webhook({ pad: 'x'.repeat(9_000) })).response.status).toBe(403);
  });
});

// The cookie the start link leaves in the browser that followed it.
const bound = async (state = 'AbCd1234', at = Date.now()) => (await bindBrowser('whoop', state, WHOOP_CALLBACK_PATH, WHOOP_ATTEMPT_TTL_MS, at)).split(';')[0]!;
const callback = async (query: string, over: { env?: Record<string, unknown>; answer?: Response; limited?: boolean; cookie?: string | null } = {}) => {
  const { owners, sent } = capture(() => over.answer ?? Response.json({ outcome: 'linked' }));
  const state = new URLSearchParams(query).get('state') ?? '';
  const cookie = over.cookie === undefined ? await bound(state) : over.cookie;
  const response = await handleWhoopCallback(new Request(`https://w.test${WHOOP_CALLBACK_PATH}?${query}`, { headers: { 'cf-connecting-ip': '203.0.113.9', ...(cookie ? { cookie } : {}) } }),
    { ...ENV_BASE, OWNER_DO: owners, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: !over.limited }) }, ...over.env } as never);
  return { response, sent, html: await response.clone().text() };
};

describe('the WHOOP callback', () => {
  it('settles the attempt its state names, has the owner\'s object exchange the code, completes the attempt once, and shows a page that holds neither code nor state', async () => {
    sessionAnswer = { status: 'ok', do_name: 'owner-a', provider: 'whoop' };
    const { response, sent, html } = await callback('code=auth-code-1&state=AbCd1234');
    expect(response.status).toBe(200);
    expect(html).toContain('WHOOP is connected');
    expect(html).not.toContain('auth-code-1');
    expect(html).not.toContain('AbCd1234');
    expect(JSON.parse(sent[0]!.text)).toEqual({ code: 'auth-code-1', denied: false });
    expect(sent[0]!.request.headers.get('x-waldo-provider-op')).toBe('exchange');
    expect(rpcs.map(r => r.fn)).toEqual(['connect_session_resolve', 'connect_session_complete']);
    expect(String(rpcs[0]!.body.p_ticket_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rpcs)).not.toContain('AbCd1234');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('tells the owner to give both consents when the owner object left the code unused for want of them, and does not complete the attempt', async () => {
    sessionAnswer = { status: 'ok', do_name: 'owner-a', provider: 'whoop' };
    const { response, html } = await callback('code=auth-code-1&state=AbCd1234', { answer: Response.json({ outcome: 'consent_required' }) });
    expect(response.status).toBe(403);
    expect(html).toContain('consent to store your WHOOP data and use it with AI');
    expect(rpcs.map(r => r.fn)).toEqual(['connect_session_resolve']);
  });

  it('shows what happened and exchanges nothing for a bad, unknown, expired or spent attempt, or a denial', async () => {
    for (const query of ['code=x&state=short', 'code=x', 'error=access_denied&state=bad']) {
      const { response, sent } = await callback(query);
      expect([query, response.status >= 400, sent.length]).toEqual([query, true, 0]);
    }
    sessionAnswer = null;
    expect((await callback('code=x&state=AbCd1234')).response.status).toBe(400);
    for (const [status, code] of [['expired', 410], ['completed', 400], ['revoked', 400]] as const) {
      sessionAnswer = { status };
      const { response, sent } = await callback('code=x&state=AbCd1234');
      expect([status, response.status, sent.length]).toEqual([status, code, 0]);
    }
    sessionAnswer = { status: 'ok', do_name: 'owner-a' };
    const denied = await callback('error=access_denied&state=AbCd1234', { answer: Response.json({ outcome: 'denied' }) });
    expect(denied.response.status).toBe(400);
    expect(JSON.parse(denied.sent[0]!.text)).toEqual({ code: null, denied: true });
    expect(rpcs.map(r => r.fn)).not.toContain('connect_session_complete');
  });

  it('says so when the owner\'s object cannot link, or the account belongs to another Waldo, and never completes the attempt', async () => {
    sessionAnswer = { status: 'ok', do_name: 'owner-a' };
    expect((await callback('code=x&state=AbCd1234', { answer: Response.json({ outcome: 'already_linked' }) })).response.status).toBe(409);
    expect((await callback('code=x&state=AbCd1234', { answer: Response.json({ outcome: 'failed' }) })).response.status).toBe(502);
    expect((await callback('code=x&state=AbCd1234', { answer: new Response('boom', { status: 500 }) })).response.status).toBe(502);
    expect(rpcs.map(r => r.fn)).not.toContain('connect_session_complete');
  });

  it('is absent without its configuration, throttles per address, and takes only GET', async () => {
    expect((await callback('code=x&state=AbCd1234', { env: { WHOOP_REDIRECT_URI: undefined } })).response.status).toBe(404);
    const limited = await callback('code=x&state=AbCd1234', { limited: true });
    expect([limited.response.status, rpcs.length]).toEqual([429, 0]);
    const post = await handleWhoopCallback(new Request(`https://w.test${WHOOP_CALLBACK_PATH}?code=x&state=AbCd1234`, { method: 'POST' }), { ...ENV_BASE, OWNER_DO: capture(() => Response.json({})).owners } as never);
    expect(post.status).toBe(404);
  });
});

const ORIGIN = 'https://worker.example.invalid';
const start = async (path: string, over: { env?: Record<string, unknown>; limited?: boolean; method?: string; origin?: string | null } = {}) => {
  const method = over.method ?? 'GET', origin = over.origin === undefined ? ORIGIN : over.origin;
  return handleWhoopStart(new Request(`${ORIGIN}${path}`, { method, headers: { 'cf-connecting-ip': '203.0.113.9', ...(method === 'POST' && origin ? { origin } : {}) } }),
    { ...ENV_BASE, OWNER_DO: capture(() => Response.json({})).owners, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: !over.limited }) }, ...over.env } as never);
};
const LIVE = { status: 'ok', do_name: 'owner-a', provider: 'whoop', begun: false, owner_hint: 'a•••@example.com' };

describe('the WHOOP start link', () => {
  it('on GET shows whose Waldo the WHOOP account joins, by the masked hint, and never redirects, binds or spends the attempt', async () => {
    sessionAnswer = LIVE;
    const response = await start(`${WHOOP_START_PATH}AbCd1234`);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(setCookies(response)).toEqual([]);
    const html = await response.text();
    expect(html).toContain('a•••@example.com');
    expect(html).toContain('<form method="post">');
    expect(html).not.toContain(CLIENT_SECRET);
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://api.prod.whoop.com");
    expect(rpcs.map(r => r.fn)).toEqual(['connect_session_resolve']);
    expect(JSON.stringify(rpcs)).not.toContain('AbCd1234');
  });

  it('never shows a full email, even if the directory sent one unmasked', async () => {
    sessionAnswer = { ...LIVE, owner_hint: 'alice@example.com' };
    const html = await (await start(`${WHOOP_START_PATH}AbCd1234`)).text();
    expect(html).not.toContain('alice');
    expect(html).toContain('the Waldo that sent this link');
  });

  it('on Continue from the same origin spends the attempt, binds this browser and sends it to WHOOP\'s own page', async () => {
    sessionAnswer = LIVE;
    const response = await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'POST' });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!), query = location.searchParams;
    expect([location.origin + location.pathname, query.get('client_id'), query.get('response_type'), query.get('redirect_uri'), query.get('state')]).toEqual(['https://api.prod.whoop.com/oauth/oauth2/auth', 'client-id-fixture', 'code', 'https://worker.example.invalid/oauth/whoop/callback', 'AbCd1234']);
    expect(query.get('scope')).toBe('offline read:profile read:sleep read:recovery read:workout');
    expect(response.headers.get('location')).not.toContain(CLIENT_SECRET);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const [set] = setCookies(response);
    expect(set!.split('=')[0]).toBe((await bound('AbCd1234')).split('=')[0]);
    expect(set).toContain(`Path=${WHOOP_CALLBACK_PATH}`);
    expect(set).toContain('Max-Age=1800');
    expect(rpcs.map(r => r.fn)).toEqual(['connect_session_resolve', 'connect_session_begin']);
    expect(JSON.stringify(rpcs)).not.toContain('AbCd1234');
  });

  it('refuses a Continue posted from another site or without an origin, and spends nothing', async () => {
    sessionAnswer = LIVE;
    for (const origin of ['https://evil.example', 'null', null]) {
      const response = await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'POST', origin });
      expect([origin, response.status, response.headers.get('location'), setCookies(response)]).toEqual([origin, 400, null, []]);
    }
    expect(rpcs.map(r => r.fn)).not.toContain('connect_session_begin');
  });

  it('refuses a replayed attempt after Continue, on a second Continue and on GET', async () => {
    sessionAnswer = LIVE;
    expect((await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'POST' })).status).toBe(303);
    const raced = await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'POST' });
    expect([raced.status, raced.headers.get('location'), setCookies(raced)]).toEqual([410, null, []]);
    sessionAnswer = { ...LIVE, begun: true };
    const reopened = await start(`${WHOOP_START_PATH}AbCd1234`);
    expect([reopened.status, await reopened.text()]).toEqual([410, expect.stringContaining('already used')]);
  });

  it('binds nothing and sends nowhere for a malformed, unknown, expired or spent attempt, or a cancel', async () => {
    for (const path of [`${WHOOP_START_PATH}short`, `${WHOOP_START_PATH}AbCd1234/x`, WHOOP_START_PATH, `${WHOOP_START_PATH}AbCd1234?cancelled`]) {
      for (const method of ['GET', 'POST']) {
        const response = await start(path, { method });
        expect([path, method, response.headers.get('location'), setCookies(response)]).toEqual([path, method, null, []]);
      }
    }
    for (const [answer, code] of [[null, 400], [{ status: 'expired' }, 410], [{ status: 'completed' }, 400], [{ status: 'revoked' }, 400]] as const) {
      sessionAnswer = answer;
      for (const method of ['GET', 'POST']) {
        const response = await start(`${WHOOP_START_PATH}AbCd1234`, { method });
        expect([response.status, response.headers.get('location'), setCookies(response)]).toEqual([code, null, []]);
      }
    }
    expect(rpcs.map(r => r.fn)).not.toContain('connect_session_begin');
  });

  it('is served by the Worker at the start path', async () => {
    sessionAnswer = LIVE;
    const response = await worker.fetch(new Request(`${ORIGIN}${WHOOP_START_PATH}AbCd1234`), { ...ENV_BASE, OWNER_DO: capture(() => Response.json({})).owners } as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post">');
  });

  it('is absent without its configuration, throttles per address, and takes only GET and POST', async () => {
    sessionAnswer = LIVE;
    expect((await start(`${WHOOP_START_PATH}AbCd1234`, { env: { WHOOP_REDIRECT_URI: undefined } })).status).toBe(404);
    expect((await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'PUT' })).status).toBe(404);
    const limited = await start(`${WHOOP_START_PATH}AbCd1234`, { limited: true, method: 'POST' });
    expect([limited.status, setCookies(limited), rpcs.length]).toEqual([429, [], 0]);
  });
});

describe('the WHOOP callback is bound to the browser that followed the start link', () => {
  it('links nothing for a browser with no binding, another attempt\'s, or one past the attempt lifetime, and asks nothing of the database or the owner', async () => {
    sessionAnswer = { status: 'ok', do_name: 'owner-a' };
    for (const cookie of [null, await bound('ZzZz9999'), await bound('AbCd1234', Date.now() - WHOOP_ATTEMPT_TTL_MS - 1)]) {
      const { response, sent, html } = await callback('code=attacker-code&state=AbCd1234', { cookie });
      expect([response.status, sent.length]).toEqual([403, 0]);
      expect(html).toContain('Start the connection again');
      expect(html).not.toContain('attacker-code');
    }
    expect(rpcs).toEqual([]);
  });

  it('completes for the browser that pressed Continue, from start link to callback, and refuses the same callback replayed', async () => {
    sessionAnswer = LIVE;
    const jar = cookieJar();
    const begun = jar.take(await start(`${WHOOP_START_PATH}AbCd1234`, { method: 'POST' }));
    const state = new URL(begun.headers.get('location')!).searchParams.get('state')!;
    const first = await callback(`code=auth-code-1&state=${state}`, { cookie: jar.header() });
    jar.take(first.response);
    expect([first.response.status, first.sent.length, jar.size()]).toEqual([200, 1, 0]);
    const replay = await callback(`code=auth-code-1&state=${state}`, { cookie: jar.header() || null });
    expect([replay.response.status, replay.sent.length]).toEqual([403, 0]);
  });
});

describe('the WHOOP start link the app opens with its one-time code', () => {
  const CODE = 'WhOoPhAnDoFf0123456789';
  const HANDED = { ...LIVE, handoff: true };
  const browser = () => {
    const jar = cookieJar();
    const send = async (query: string, method = 'GET') => jar.take(await handleWhoopStart(new Request(`${ORIGIN}${WHOOP_START_PATH}AbCd1234${query}`, { method, headers: {
      'cf-connecting-ip': '203.0.113.9', ...(method === 'POST' ? { origin: ORIGIN } : {}), ...(jar.size() ? { cookie: jar.header() } : {}),
    } }), { ...ENV_BASE, OWNER_DO: capture(() => Response.json({})).owners, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never));
    return { jar, send };
  };

  it('binds the app\'s browser on the code, then continues to WHOOP from it and on to a linked callback, once', async () => {
    sessionAnswer = HANDED; handoffHashLive = await handoffHash(CODE);
    const app = browser();
    const page = await app.send(`?handoff=${CODE}`);
    expect([page.status, page.headers.get('location')]).toEqual([200, null]);
    expect(setCookies(page)[0]).toContain(`Path=${WHOOP_START_PATH}AbCd1234`);
    expect(JSON.stringify(rpcs)).not.toContain(CODE);
    const begun = await app.send(`?handoff=${CODE}`, 'POST');
    expect(begun.status).toBe(303);
    expect(new URL(begun.headers.get('location')!).origin).toBe('https://api.prod.whoop.com');
    expect(app.jar.size()).toBe(1);
    sessionAnswer = { status: 'ok', do_name: 'owner-a' };
    const first = await callback('code=auth-code-1&state=AbCd1234', { cookie: app.jar.header() });
    app.jar.take(first.response);
    expect([first.response.status, first.sent.length]).toEqual([200, 1]);
    const replay = await callback('code=auth-code-1&state=AbCd1234', { cookie: app.jar.header() || null });
    expect([replay.response.status, replay.sent.length]).toEqual([403, 0]);
  });

  it('binds nothing and redirects nowhere for the start link without the code, or with it spent, in another browser', async () => {
    sessionAnswer = HANDED; handoffHashLive = await handoffHash(CODE);
    for (const query of ['', '?handoff=', `?handoff=${'y'.repeat(22)}`]) {
      for (const method of ['GET', 'POST']) {
        const response = await browser().send(query, method);
        expect([query, method, response.status, response.headers.get('location'), setCookies(response)]).toEqual([query, method, 403, null, []]);
      }
    }
    const app = browser();
    expect((await app.send(`?handoff=${CODE}`)).status).toBe(200);
    for (const method of ['GET', 'POST']) {
      const forwarded = await browser().send(`?handoff=${CODE}`, method);
      expect([method, forwarded.status, forwarded.headers.get('location'), setCookies(forwarded)]).toEqual([method, 403, null, []]);
    }
    expect(rpcs.map(r => r.fn)).not.toContain('connect_session_begin');
    // A reload in the browser that redeemed it still shows the confirm step.
    expect((await app.send(`?handoff=${CODE}`)).status).toBe(200);
  });
});
