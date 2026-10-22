import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleMcpCallback, handleMcpClientMetadata } from '../src/channels/mcp-oauth-routes';
import { consoleAccess } from '../src/channels/console';
import { mcpConnectReceipt, mcpDisconnectReceipt, mcpRunsReceipt } from '../src/channels/dashboard-control-actions';
import { MCP_ATTEMPT_TTL_MS, mcpState } from '../src/connectors/mcp-connections';
import { MCP_CALLBACK_PATH } from '../src/connectors/mcp-oauth';
import { bindBrowser } from '../src/connectors/oauth-browser-binding';
import { cookieJar, setCookies } from './support/cookie-jar';

const SECRET = 'fixture-webhook-secret';
const routeEnv = () => ({ WALDO_OAUTH_STATE_SECRET: SECRET, OWNER_DO: env.OWNER_DO }) as unknown as Parameters<typeof handleMcpCallback>[1];

describe('MCP OAuth routes', () => {
  it('serves a client metadata document whose client_id is its own URL', async () => {
    const response = handleMcpClientMetadata(new Request('https://waldo.example/oauth/mcp/client.json'));
    expect(await response.json()).toMatchObject({ client_id: 'https://waldo.example/oauth/mcp/client.json', redirect_uris: ['https://waldo.example/oauth/mcp/callback'], token_endpoint_auth_method: 'none', application_type: 'web' });
  });

  it('verifies state only with its own key: the Telegram webhook secret alone signs nothing and the callback is absent', async () => {
    const owner = { idFromName: (name: string) => name, get: () => ({ fetch: async () => { throw new Error('must not wake'); } }) };
    const state = await mcpState(SECRET, 'mcp-route-owner', 'A'.repeat(43));
    const cookie = (await bindBrowser('mcp', 'A'.repeat(43), MCP_ATTEMPT_TTL_MS, Date.now())).split(';')[0]!;
    const response = await handleMcpCallback(new Request(`https://waldo.example/oauth/mcp/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie } }), { TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_DO: owner } as unknown as Parameters<typeof handleMcpCallback>[1]);
    expect(response.status).toBe(404);
  });

  it('drops a forged state before any owner object wakes, and shows an unknown attempt as invalid', async () => {
    const forged = await handleMcpCallback(new Request('https://waldo.example/oauth/mcp/callback?code=c&state=owner.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.bad'), routeEnv());
    expect(forged.status).toBe(400);
    expect(forged.headers.get('cache-control')).toBe('no-store');
    const state = await mcpState(SECRET, 'mcp-route-owner', 'A'.repeat(43));
    const cookie = (await bindBrowser('mcp', 'A'.repeat(43), MCP_ATTEMPT_TTL_MS, Date.now())).split(';')[0]!;
    const unknown = await handleMcpCallback(new Request(`https://waldo.example/oauth/mcp/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie } }), routeEnv());
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('This link is not valid');
  });

  it('allows a tool to run without asking only at the digest the console showed, and refuses a value without one', async () => {
    const calls: unknown[][] = [];
    const setRuns = async (...args: unknown[]) => { calls.push(args); return args[3] === 'b'.repeat(64) ? 'changed' as const : true; };
    const digest = 'a'.repeat(64);
    expect(await mcpRunsReceipt('c1', `search_pages|on|${digest}`, setRuns)).toEqual({ state: 'recorded', message: 'search_pages runs without asking.' });
    expect(await mcpRunsReceipt('c1', `*read_only_hint|on|${digest}`, setRuns)).toEqual({ state: 'recorded', message: 'The tools labelled read-only run without asking.' });
    expect(await mcpRunsReceipt('c1', 'search_pages|off', setRuns)).toEqual({ state: 'recorded', message: 'search_pages asks you first.' });
    expect(await mcpRunsReceipt('c1', `search_pages|on|${'b'.repeat(64)}`, setRuns)).toEqual({ state: 'rejected', message: 'That server changed its tools since this page loaded, so nothing was allowed. Refresh Connections and choose again.' });
    expect(calls).toEqual([['c1', 'search_pages', true, digest], ['c1', '*read_only_hint', true, digest], ['c1', 'search_pages', false, undefined], ['c1', 'search_pages', true, 'b'.repeat(64)]]);
    for (const value of ['search_pages|on', 'search_pages|on|short', 'search_pages|maybe', '|on|' + digest, 'search_pages']) {
      expect([value, (await mcpRunsReceipt('c1', value, setRuns)).state]).toEqual([value, 'rejected']);
    }
    expect(calls).toHaveLength(4);
  });

  it('turns connect and disconnect outcomes into receipts with only a first-party start link', () => {
    expect(mcpConnectReceipt({ kind: 'redirect', path: `/console/mcp/start/${'A'.repeat(43)}` })).toMatchObject({ state: 'recorded', navigation: `/console/mcp/start/${'A'.repeat(43)}` });
    expect(mcpConnectReceipt({ kind: 'redirect', path: 'https://evil.example/authorize' })).toMatchObject({ state: 'rejected' });
    expect(mcpConnectReceipt({ kind: 'failed', reason: 'egress_host' })).toEqual({ state: 'rejected', message: 'That address points at a private or internal network, which Waldo does not reach.' });
    expect(mcpDisconnectReceipt({ ok: true, provider: 'unsupported' }).message).toContain('did not confirm it revoked access');
    expect(mcpDisconnectReceipt({ ok: false, provider: 'failed' }).state).toBe('rejected');
    expect(mcpDisconnectReceipt({ ok: false, provider: 'not_needed' })).toEqual({ state: 'rejected', message: 'That server is no longer connected. Refresh the records.' });
  });
});

describe('the MCP callback is bound to the browser that started the connect', () => {
  const OWNER = 'mcp-bind-owner';
  const callbackFor = (query: string, cookie?: string) => new Request(`https://waldo.example${MCP_CALLBACK_PATH}?${query}`, cookie ? { headers: { cookie } } : {});
  const fakeOwner = () => {
    const calls: unknown[] = [];
    return { calls, env: { WALDO_OAUTH_STATE_SECRET: SECRET, OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({ kind: 'linked', id: 'c1', name: 'notion' }); } }) } } as unknown as Parameters<typeof handleMcpCallback>[1] };
  };
  const bound = async (nonce: string, at = Date.now()) => (await bindBrowser('mcp', nonce, MCP_ATTEMPT_TTL_MS, at)).split(';')[0]!;

  it('wakes no owner object for a browser with no binding, another attempt\'s, or one past the attempt lifetime', async () => {
    const nonce = 'C'.repeat(43), query = `code=attacker-code&state=${encodeURIComponent(await mcpState(SECRET, OWNER, nonce))}`;
    const owner = fakeOwner();
    for (const cookie of [undefined, await bound('D'.repeat(43)), await bound(nonce, Date.now() - MCP_ATTEMPT_TTL_MS - 1)]) {
      const response = await handleMcpCallback(callbackFor(query, cookie), owner.env);
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain('Start the connection again');
      expect(html).not.toContain('attacker-code');
    }
    expect(owner.calls).toEqual([]);
    const linked = await handleMcpCallback(callbackFor(query.replace('attacker-code', 'c'), await bound(nonce)), owner.env);
    expect(linked.status).toBe(200);
    expect(owner.calls).toHaveLength(1);
  });

  it('sets the binding on the console start link, leaves the attempt to that browser, and refuses a replay once it is spent', async () => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(OWNER));
    const nonce = 'B'.repeat(43);
    const settled = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ settled: string | null }>('SELECT settled FROM mcp_attempts WHERE nonce = ?', nonce).toArray()[0]?.settled ?? null);
    const token = await runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { WALDO_OAUTH_STATE_SECRET: SECRET, TELEGRAM_BOT_TOKEN: 'synthetic', OPENAI_API_KEY: 'synthetic' });
      state.storage.kv.put('do_name', OWNER);
      (instance as unknown as { mcp(): unknown }).mcp();
      const attempt = { origin: 'https://waldo.example', server_url: 'https://mcp.example.com/mcp', verifier: 'v'.repeat(43), resource: 'https://mcp.example.com/mcp', issuer: 'https://auth.example.com', iss_supported: false,
        authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', client_id: 'https://waldo.example/oauth/mcp/client.json', client_auth: 'none', registration: 'cimd' };
      state.storage.sql.exec('INSERT INTO mcp_attempts (nonce, record, expires) VALUES (?, ?, ?)', nonce, JSON.stringify(attempt), Date.now() + MCP_ATTEMPT_TTL_MS);
      return consoleAccess(state.storage).grant();
    });
    const jar = cookieJar();
    const start = jar.take(await stub.fetch(`https://telegram-owner/console/mcp/start/${nonce}`, { headers: { cookie: `waldo_console=${token}` }, redirect: 'manual' }));
    expect(start.status).toBe(303);
    expect(setCookies(start)[0]).toContain('Path=/;');
    const query = `code=c&state=${encodeURIComponent(new URL(start.headers.get('location')!).searchParams.get('state')!)}`;
    const routeEnvFor = { WALDO_OAUTH_STATE_SECRET: SECRET, OWNER_DO: env.OWNER_DO } as unknown as Parameters<typeof handleMcpCallback>[1];

    expect((await handleMcpCallback(callbackFor(query), routeEnvFor)).status).toBe(403);
    expect(await settled()).toBeNull();

    // No token edge in the test pool: the owner object settles the attempt as failed, which proves the bound browser reached it.
    const finished = jar.take(await handleMcpCallback(callbackFor(query, jar.header()), routeEnvFor));
    expect(finished.status).toBe(502);
    expect(JSON.parse((await settled())!)).toMatchObject({ kind: 'failed', reason: 'oauth_unavailable' });
    expect(jar.size()).toBe(0);
    expect((await handleMcpCallback(callbackFor(query, jar.header()), routeEnvFor)).status).toBe(403);
  });
});
