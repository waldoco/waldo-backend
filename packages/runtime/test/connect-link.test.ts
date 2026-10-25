import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConnectTicket, newTicket, ticketHash, BEGIN_SESSION_PATH } from '../src/channels/connect-link';
import { GOOGLE_CALLBACK_PATH } from '../src/connectors/google';
import { MCP_CALLBACK_PATH } from '../src/connectors/mcp-oauth';
import { checkBrowser } from '../src/connectors/oauth-browser-binding';
import { handoffHash } from '../src/channels/connect-confirm';
import { cookieJar, setCookies } from './support/cookie-jar';
import { forgedBinding } from './support/forged-binding';

const NONCE = 'G'.repeat(43);
const TICKET = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url chars
const ORIGIN = 'https://waldo.example';
const STATE_SECRET = 'fictional-oauth-state-secret';
const LIVE = { status: 'ok', do_name: '5458446350', provider: 'google', session: 's1', begun: false, owner_hint: 'a•••@example.com' };

// The directory as the Worker sees it: one answer per function, and every call recorded.
let answers: Record<string, unknown> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, string> }> = [];
beforeEach(() => {
  answers = {}; rpcCalls.length = 0;
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const fn = String(url).split('/rpc/')[1]!;
    rpcCalls.push({ fn, args: JSON.parse(String(init?.body ?? '{}')) });
    if (fn === 'connect_session_begin' && answers[fn] === undefined) { answers[fn] = null; return Response.json({ status: 'ok', do_name: LIVE.do_name }); }
    return Response.json(answers[fn] ?? null);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const owner = (doReply: { url?: string | null; nonce?: string } = { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', nonce: NONCE }) => {
  const doCalls: Array<{ path: string; body: string }> = [];
  const env = {
    SUPABASE_PROJECT_URL: 'https://proj.example', SUPABASE_PUBLISHABLE_KEY: 'pk', WALDO_ROUTER_HMAC_SECRET: 'router-secret', WALDO_OAUTH_STATE_SECRET: STATE_SECRET,
    OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (input: string, init?: RequestInit) => { doCalls.push({ path: new URL(input).pathname, body: String(init?.body ?? '') }); return Response.json(doReply); } }) },
  };
  return { env, doCalls };
};
const open = (env: unknown, ticket = TICKET, init: RequestInit = {}, query = '') => handleConnectTicket(new Request(`${ORIGIN}/c/${ticket}${query}`, init), env as never);
const proceed = (env: unknown, origin: string | null = ORIGIN, ticket = TICKET) => open(env, ticket, { method: 'POST', headers: origin ? { origin } : {} });

describe('connect ticket helpers', () => {
  it('newTicket is 22 base64url chars and hashes deterministically', async () => {
    const ticket = newTicket();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await ticketHash(TICKET)).toBe(await ticketHash(TICKET));
    expect(await ticketHash(TICKET)).not.toBe(TICKET);
  });
});

describe('handleConnectTicket', () => {
  it('rejects a malformed ticket or another method without any RPC', async () => {
    const { env } = owner();
    expect((await open(env, 'short')).status).toBe(404);
    expect((await open(env, TICKET, { method: 'PUT' })).status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it('shows an unknown, expired or completed ticket for what it is, and mints nothing', async () => {
    const { env, doCalls } = owner();
    expect((await open(env)).status).toBe(400);
    answers.connect_session_resolve = { status: 'expired' };
    const expired = await open(env);
    expect([expired.status, await expired.text()]).toEqual([410, expect.stringContaining('expired')]);
    answers.connect_session_resolve = { status: 'completed' };
    expect((await open(env)).status).toBe(400);
    expect(doCalls).toHaveLength(0);
  });

  it('on GET shows whose Waldo the account joins, by the masked hint, and never redirects, binds or spends the ticket', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = LIVE;
    const response = await open(env);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(setCookies(response)).toEqual([]);
    const html = await response.text();
    expect(html).toContain('a•••@example.com');
    expect(html).toContain('<form method="post">');
    expect(html).toContain(`href="/c/${TICKET}?cancelled"`);
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://accounts.google.com");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(rpcCalls.map(r => r.fn)).toEqual(['connect_session_resolve']);
    expect(doCalls).toHaveLength(0);
  });

  it('never shows a full email, even if the directory sent one unmasked', async () => {
    const { env } = owner();
    answers.connect_session_resolve = { ...LIVE, owner_hint: 'alice@example.com' };
    const html = await (await open(env)).text();
    expect(html).not.toContain('alice@example.com');
    expect(html).not.toContain('alice');
    expect(html).toContain('the Waldo that sent this link');
  });

  it('on Continue from the same origin spends the ticket, mints the attempt, binds this browser and redirects to Google', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = LIVE;
    const response = await proceed(env);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(rpcCalls.map(r => r.fn)).toEqual(['connect_session_resolve', 'connect_session_begin']);
    expect(rpcCalls[1]!.args.p_ticket_hash).toBe(await ticketHash(TICKET));
    expect(doCalls).toEqual([{ path: BEGIN_SESSION_PATH, body: JSON.stringify({ ticket_hash: await ticketHash(TICKET) }) }]);
    const [set] = setCookies(response);
    expect(set).toContain(`Path=${GOOGLE_CALLBACK_PATH}`);
    expect(set).toContain('Max-Age=43200');
    expect(set).toContain('SameSite=Lax');
    const atCallback = new Request(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`, { headers: { cookie: set!.split(';')[0]! } });
    expect(await checkBrowser(atCallback, STATE_SECRET, 'google', NONCE, Date.now())).toBe('bound');
    expect(await checkBrowser(atCallback, STATE_SECRET, 'google', 'H'.repeat(43), Date.now())).toBe('missing');
  });

  it('refuses a Continue posted from another site or without an origin, and spends nothing', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = LIVE;
    for (const origin of ['https://evil.example', 'null', null]) {
      const response = await proceed(env, origin);
      expect([origin, response.status, response.headers.get('location'), setCookies(response)]).toEqual([origin, 400, null, []]);
    }
    expect(rpcCalls.map(r => r.fn)).not.toContain('connect_session_begin');
    expect(doCalls).toHaveLength(0);
  });

  it('refuses a replayed ticket after Continue, on GET and on a second Continue', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = LIVE;
    expect((await proceed(env)).status).toBe(303);
    const raced = await proceed(env);
    expect([raced.status, raced.headers.get('location'), setCookies(raced)]).toEqual([410, null, []]);
    answers.connect_session_resolve = { ...LIVE, begun: true };
    const reopened = await open(env);
    expect([reopened.status, await reopened.text()]).toEqual([410, expect.stringContaining('already used')]);
    expect(doCalls).toHaveLength(1);
  });

  it('cancel changes nothing', async () => {
    const { env, doCalls } = owner();
    const response = await open(env, TICKET, {}, '?cancelled');
    expect([response.status, await response.text()]).toEqual([200, expect.stringContaining('Nothing was connected')]);
    expect(rpcCalls).toHaveLength(0);
    expect(doCalls).toHaveLength(0);
  });

  it('never redirects to Google without a binding: a mint that names no attempt is a failure', async () => {
    const { env } = owner({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    answers.connect_session_resolve = LIVE;
    const response = await proceed(env);
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
  });

  it('runs no connect link without the OAuth state secret: nothing is resolved, bound or redirected', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = LIVE;
    const without = { ...env, WALDO_OAUTH_STATE_SECRET: undefined };
    const logs = vi.spyOn(console, 'log');
    for (const response of [await open(without), await proceed(without)]) {
      expect([response.status, response.headers.get('location'), setCookies(response), await response.text()]).toEqual([404, null, [], 'not found']);
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain('router-secret');
    logs.mockRestore();
    expect(rpcCalls).toEqual([]);
    expect(doCalls).toEqual([]);
  });

  it('DO mint failure -> failed page, never a naked 500', async () => {
    const { env } = owner({ url: null });
    answers.connect_session_resolve = LIVE;
    const response = await proceed(env);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not be connected');
  });
});

// A ticket the app holds carries a one-time handoff code; the directory redeems the code once, for that ticket only.
describe('a /c/ link handed to the app binds only the browser the app opened it in', () => {
  const CODE = 'HaNdOfFcOdE0123456789_';
  const handoffTicket = async () => {
    const expected = await handoffHash(CODE);
    let spent = false;
    answers.connect_session_resolve = { ...LIVE, handoff: true };
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const fn = String(url).split('/rpc/')[1]!, args = JSON.parse(String(init?.body ?? '{}'));
      rpcCalls.push({ fn, args });
      if (fn === 'connect_session_hand_off') { const ok = !spent && args.p_handoff_hash === expected && args.p_ticket_hash === await ticketHash(TICKET); if (ok) spent = true; return Response.json(ok); }
      if (fn === 'connect_session_begin' && answers[fn] === undefined) { answers[fn] = null; return Response.json({ status: 'ok', do_name: LIVE.do_name }); }
      return Response.json(answers[fn] ?? null);
    });
  };
  const browser = () => {
    const jar = cookieJar();
    return {
      jar,
      get: async (env: unknown, query = '') => jar.take(await open(env, TICKET, { headers: jar.size() ? { cookie: jar.header() } : {} }, query)),
      post: async (env: unknown, query = '') => jar.take(await open(env, TICKET, { method: 'POST', headers: { origin: ORIGIN, ...(jar.size() ? { cookie: jar.header() } : {}) } }, query)),
    };
  };

  it('redeems the code on the first GET, binds that browser to the hop, and shows whose Waldo it joins', async () => {
    await handoffTicket();
    const { env, doCalls } = owner();
    const app = browser();
    const page = await app.get(env, `?handoff=${CODE}`);
    expect([page.status, page.headers.get('location')]).toEqual([200, null]);
    expect(await page.text()).toContain('a•••@example.com');
    const [bound] = setCookies(page);
    expect(bound).toContain(`Path=/c/${TICKET}`);
    expect(rpcCalls.map((call) => call.fn)).toEqual(['connect_session_resolve', 'connect_session_hand_off']);
    expect(JSON.stringify(rpcCalls)).not.toContain(CODE);
    expect(doCalls).toEqual([]);
  });

  it('continues from that browser: spends the ticket, binds the callback, goes to Google and lets go of the hop', async () => {
    await handoffTicket();
    const { env } = owner();
    const app = browser();
    await app.get(env, `?handoff=${CODE}`);
    const continued = await app.post(env, `?handoff=${CODE}`);
    expect(continued.status).toBe(303);
    expect(new URL(continued.headers.get('location')!).origin).toBe('https://accounts.google.com');
    expect(rpcCalls.map((call) => call.fn)).toEqual(['connect_session_resolve', 'connect_session_hand_off', 'connect_session_resolve', 'connect_session_begin']);
    expect(await checkBrowser(new Request(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`, { headers: { cookie: app.jar.header() } }), STATE_SECRET, 'google', NONCE, Date.now())).toBe('bound');
    expect(app.jar.size()).toBe(1);
  });

  it('binds nothing and redirects nowhere for the link without its code, in a browser the app did not hand it to', async () => {
    await handoffTicket();
    const { env, doCalls } = owner();
    const other = browser();
    for (const query of ['', '?handoff=', '?handoff=short', `?handoff=${'x'.repeat(22)}`]) {
      for (const send of [other.get, other.post]) {
        const response = await send(env, query);
        expect([query, response.status, response.headers.get('location'), setCookies(response)]).toEqual([query, 403, null, []]);
        expect(await response.text()).toContain('Start the connection again');
      }
    }
    expect(rpcCalls.map((call) => call.fn)).not.toContain('connect_session_begin');
    expect(doCalls).toEqual([]);
    // The owner's app browser can still take its own link.
    expect((await browser().get(env, `?handoff=${CODE}`)).status).toBe(200);
  });

  it('refuses the code a second time in another browser, and lets the browser that redeemed it reload', async () => {
    await handoffTicket();
    const { env } = owner();
    const app = browser();
    expect((await app.get(env, `?handoff=${CODE}`)).status).toBe(200);
    const forwarded = await browser().get(env, `?handoff=${CODE}`);
    expect([forwarded.status, forwarded.headers.get('location'), setCookies(forwarded)]).toEqual([403, null, []]);
    const forwardedContinue = await browser().post(env, `?handoff=${CODE}`);
    expect([forwardedContinue.status, setCookies(forwardedContinue)]).toEqual([403, []]);
    expect((await app.get(env, `?handoff=${CODE}`)).status).toBe(200);
    expect(rpcCalls.map((call) => call.fn)).not.toContain('connect_session_begin');
  });

  it('never lets a POST redeem the code: the code stays unspent for the app\'s own GET', async () => {
    await handoffTicket();
    const { env, doCalls } = owner();
    const posted = await browser().post(env, `?handoff=${CODE}`);
    expect([posted.status, posted.headers.get('location'), setCookies(posted)]).toEqual([403, null, []]);
    expect(rpcCalls.map((call) => call.fn)).toEqual(['connect_session_resolve']);
    expect(doCalls).toEqual([]);
    expect((await browser().get(env, `?handoff=${CODE}`)).status).toBe(200);
    expect(rpcCalls.map((call) => call.fn)).toEqual(['connect_session_resolve', 'connect_session_resolve', 'connect_session_hand_off']);
  });

  it('refuses a Continue from a browser that built the hop binding from the link, after the app redeemed the code', async () => {
    await handoffTicket();
    const { env, doCalls } = owner();
    expect((await browser().get(env, `?handoff=${CODE}`)).status).toBe(200);
    const forged = await open(env, TICKET, { method: 'POST', headers: { origin: ORIGIN, cookie: await forgedBinding('handoff', await ticketHash(TICKET)) } });
    expect([forged.status, forged.headers.get('location'), setCookies(forged)]).toEqual([403, null, []]);
    expect(await forged.text()).not.toContain(STATE_SECRET);
    expect(rpcCalls.map((call) => call.fn)).not.toContain('connect_session_begin');
    expect(doCalls).toEqual([]);
  });

  it('leaves a chat link a bearer link behind the confirm step: no code asked, none redeemed', async () => {
    answers.connect_session_resolve = LIVE;
    const { env } = owner();
    expect((await open(env)).status).toBe(200);
    expect((await proceed(env)).status).toBe(303);
    expect(rpcCalls.map((call) => call.fn)).not.toContain('connect_session_hand_off');
  });
});

describe('a Granola ticket', () => {
  const GRANOLA = { ...LIVE, provider: 'granola' };
  const AUTHORIZE = 'https://mcp-auth.granola.ai/oauth2/authorize?client_id=x';

  it('names Granola on the confirm page and lets the form go only to Granola\'s sign-in', async () => {
    const { env } = owner({ url: AUTHORIZE, nonce: NONCE });
    answers.connect_session_resolve = GRANOLA;
    const response = await open(env);
    const html = await response.text();
    expect(html).toContain('Connect Granola?');
    expect(html).toContain('Continue to Granola');
    expect(html).not.toContain('Google');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://mcp-auth.granola.ai");
    expect(response.headers.get('content-security-policy')).not.toContain('accounts.google.com');
  });

  it('on Continue redirects to Granola and binds this browser to the MCP callback, not Google\'s', async () => {
    const { env } = owner({ url: AUTHORIZE, nonce: NONCE });
    answers.connect_session_resolve = GRANOLA;
    const response = await proceed(env);
    expect([response.status, response.headers.get('location')]).toEqual([303, AUTHORIZE]);
    const [set] = setCookies(response);
    expect(set).toContain(`Path=${MCP_CALLBACK_PATH}`);
    const atCallback = new Request(`${ORIGIN}${MCP_CALLBACK_PATH}`, { headers: { cookie: set!.split(';')[0]! } });
    expect(await checkBrowser(atCallback, STATE_SECRET, 'mcp', NONCE, Date.now())).toBe('bound');
    expect(await checkBrowser(atCallback, STATE_SECRET, 'google', NONCE, Date.now())).not.toBe('bound');
  });

  it('refuses a consent address off the provider the page named, and binds nothing', async () => {
    const { env } = owner({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', nonce: NONCE });
    answers.connect_session_resolve = GRANOLA;
    const response = await proceed(env);
    expect([response.headers.get('location'), setCookies(response)]).toEqual([null, []]);
    expect(response.status).not.toBe(303);
  });

  it('treats a provider it does not know as an invalid link', async () => {
    const { env, doCalls } = owner();
    answers.connect_session_resolve = { ...LIVE, provider: 'notion' };
    expect((await open(env)).status).toBe(400);
    expect(doCalls).toHaveLength(0);
  });
});
