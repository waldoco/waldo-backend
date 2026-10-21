import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { oauthProxy, OAuthProxyError } from '../src/connectors/oauth-proxy-client';
import { parseOAuthProxyRequest } from '../src/connectors/oauth-proxy-wire';
import { clientMetadataDocument, pkceChallenge, pkceVerifier, type ClientPins } from '../src/connectors/mcp-oauth';
import { routerSignature } from '../src/identity/owner-directory';
import { fakeMcpWorld, ISSUER, MCP_URL, WALDO_ORIGIN, type FakeMcpWorld } from './support/fake-mcp-world';
import { fakeOAuthProvider, PROVIDER_ACCOUNT, PROVIDER_API, PROVIDER_CLIENT, PROVIDER_ORIGIN, type FakeOAuthProvider } from './support/fake-oauth-provider';
import { loadEdge, routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV, type VaultFake } from './support/oauth-edge-harness';

let serve: (request: Request) => Promise<Response>;
beforeAll(async () => { serve = await loadEdge(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => vi.unstubAllGlobals());

const REDIRECT = `${WALDO_ORIGIN}/oauth/mcp/callback`;
const pins: ClientPins = { server_url: MCP_URL, resource: MCP_URL, issuer: ISSUER, token_endpoint: `${ISSUER}/token`, revocation_endpoint: `${ISSUER}/revoke`, client_id: clientMetadataDocument(WALDO_ORIGIN).client_id, client_auth: 'none', redirect_uri: REDIRECT };

// One owner connected to the fake server through the real edge; returns the proxy client and the connection.
const connected = async (world: FakeMcpWorld = fakeMcpWorld(), vault: VaultFake = vaultFake(), pinned: ClientPins = pins) => {
  routeEdgeFetch(vault, world);
  vi.useFakeTimers({ now: world.now(), toFake: ['Date'] });
  const calls: Record<string, unknown>[] = [];
  const proxy = oauthProxy(WORKER_ENV, workerToEdge(serve, (body) => calls.push(body)), () => Date.now())!;
  const verifier = pkceVerifier();
  const authorize = new URL(`${ISSUER}/authorize`);
  for (const [k, v] of Object.entries({ client_id: pins.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: await pkceChallenge(verifier), resource: MCP_URL, scope: 'pages:read pages:write' })) authorize.searchParams.set(k, v);
  const back = await world.authorize(authorize.toString());
  const exchanged = await proxy.exchange('owner-a', 'mcp', pinned, back.searchParams.get('code')!, { verifier, scope: 'pages:read pages:write' });
  return { world, vault, proxy, calls, exchanged, connection: exchanged.id };
};

const signed = async (body: unknown, secret = WORKER_ENV.WALDO_ROUTER_HMAC_SECRET, at = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(body);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://edge.invalid/functions/v1/oauth-proxy', { method: 'POST', body: raw, headers: { 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `oauth.${digest}`) } });
};

describe('wire contract', () => {
  const call = { op: 'call', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'tools/list', params: {} };
  it.each([
    ['a read call', call],
    ['a write call with its intent and mirrored headers', { ...call, method: 'tools/call', params: { name: 'create_page', arguments: { title: 'x' } }, intent_id: 'approval:ab12:apply', headers: { 'mcp-param-region': 'eu' } }],
    ['a refresh with a version', { op: 'refresh', do_name: 'owner-a', connection: call.connection, version: '0123456789abcdef' }],
    ['an exchange', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins, code: 'c', verifier: 'v'.repeat(43) }],
  ])('accepts %s', (_name, body) => expect(parseOAuthProxyRequest(body)).not.toBeNull());
  it.each([
    ['an unknown key (a URL smuggled next to the connection id)', { ...call, server_url: 'https://evil.example.net/mcp' }],
    ['a method outside the set', { ...call, method: 'sampling/createMessage' }],
    ['a connection that is not a uuid', { ...call, connection: '../other' }],
    ['a header that is not Mcp-Param', { ...call, headers: { authorization: 'Bearer x' } }],
    ['a header value with a newline', { ...call, headers: { 'mcp-param-x': 'a\nb' } }],
    ['plain-http pins', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins: { ...pins, token_endpoint: 'http://auth.example.com/token' }, code: 'c', verifier: 'v'.repeat(43) }],
    ['a short PKCE verifier', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins, code: 'c', verifier: 'short' }],
    ['an unknown operation', { op: 'mint', do_name: 'owner-a' }],
  ])('refuses %s', (_name, body) => expect(parseOAuthProxyRequest(body)).toBeNull());
});

describe('oauth-proxy edge, MCP servers', () => {
  it('refuses unsigned, stale or mis-tagged calls before any database or network work', async () => {
    const vault = vaultFake(), world = fakeMcpWorld();
    routeEdgeFetch(vault, world);
    expect((await serve(await signed({ op: 'revoke', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001' }, 'wrong'))).status).toBe(401);
    expect((await serve(await signed({ op: 'revoke', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001' }, undefined, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    expect(vault.rpcs).toEqual([]);
    expect(world.hits).toEqual([]);
  });

  it('stores tokens in Vault on exchange and returns only an id, scopes, expiry and a version', async () => {
    const { vault, exchanged, calls } = await connected();
    expect(exchanged).toEqual({ id: expect.stringMatching(/^0{8}-/), account: `${ISSUER} ${MCP_URL}`.toLowerCase(), scopes: ['pages:read', 'pages:write'], expires_at: expect.any(Number), version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(exchanged)).not.toMatch(/at_|rt_/);
    expect(vault.rows[0]).toMatchObject({ provider: 'mcp', account: `${ISSUER} ${MCP_URL}`.toLowerCase() });
    expect(JSON.parse(vault.rows[0]!.secret)).toMatchObject({ access_token: expect.stringMatching(/^at_/), refresh_token: expect.stringMatching(/^rt_/) });
    expect(JSON.stringify(calls)).not.toMatch(/at_\d|rt_\d/);
  });

  it('calls the pinned server with the stored token, and nothing token-shaped comes back or is logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { world, proxy, connection } = await connected();
    const out = await proxy.call('owner-a', connection, 'tools/call', { name: 'search_pages', arguments: { query: 'PRIVATE_QUERY' } });
    expect(out).toMatchObject({ era: 'modern', result: { content: [{ text: expect.stringContaining('search_pages ran') }] } });
    expect(world.calls.at(-1)).toMatchObject({ method: 'tools/call', bearer: expect.stringMatching(/^at_/) });
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('"hop":"oauth_proxy"');
    expect(logged).not.toMatch(/at_\d|rt_\d|PRIVATE_QUERY|mcp\.example\.com/);
  });

  it('reports an expired access token without touching the server, and a refresh rotates it', async () => {
    const { world, proxy, connection, vault } = await connected();
    world.advance(3_600_000);
    vi.setSystemTime(world.now());
    await expect(proxy.call('owner-a', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'token_expired' } });
    expect(world.calls).toHaveLength(0);
    const before = vault.rows[0]!.secret;
    const refreshed = await proxy.refresh('owner-a', connection);
    expect(refreshed).toMatchObject({ refreshed: true, scopes: ['pages:read', 'pages:write'] });
    expect(vault.rows[0]!.secret).not.toBe(before);
    await expect(proxy.call('owner-a', connection, 'tools/list', {})).resolves.toMatchObject({ era: 'modern' });
  });

  it('never spends a rotated refresh token twice: a stale refresh reads the winner instead', async () => {
    const { world, proxy, connection, exchanged } = await connected();
    world.advance(3_590_000);
    vi.setSystemTime(world.now());
    const seen = exchanged.version;
    const first = await proxy.refresh('owner-a', connection, seen);
    const second = await proxy.refresh('owner-a', connection, seen);
    expect(first.refreshed).toBe(true);
    expect(second).toMatchObject({ refreshed: false, version: first.version });
    expect(world.revokedAll()).toBe(false);
  });

  it('keeps the winner when its compare-and-set loses to a refresh that landed mid-flight', async () => {
    const world = fakeMcpWorld(), vault = vaultFake();
    const { proxy, connection } = await connected(world, vault);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init);
      if (String(input).endsWith('/token')) vault.rows[0]!.secret = JSON.stringify({ access_token: 'at_winner', refresh_token: 'rt_winner', expires_at: world.now() + 3_600_000 });
      return response;
    }));
    const out = await proxy.refresh('owner-a', connection);
    expect(out.refreshed).toBe(false);
    expect(JSON.parse(vault.rows[0]!.secret)).toMatchObject({ access_token: 'at_winner' });
  });

  it('revokes at the provider, deletes the grant, and a later call never reaches the server', async () => {
    const { world, proxy, connection, vault } = await connected();
    await expect(proxy.revoke('owner-a', connection)).resolves.toEqual({ provider: 'revoked' });
    expect(world.hits).toContain(`POST ${ISSUER}/revoke`);
    expect(vault.rows[0]!.status).toBe('revoked');
    const before = world.calls.length;
    await expect(proxy.call('owner-a', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'connection_unavailable' } });
    expect(world.calls.length).toBe(before);
  });

  it('says so when the provider cannot revoke, and still deletes the grant', async () => {
    const { revocation_endpoint: _none, ...withoutRevocation } = pins;
    const { proxy, connection, vault } = await connected(fakeMcpWorld({ revocation: false }), vaultFake(), withoutRevocation);
    await expect(proxy.revoke('owner-a', connection)).resolves.toEqual({ provider: 'unsupported' });
    expect(vault.rows[0]!.status).toBe('revoked');
  });

  it('turns a scope downgrade into scope_missing with the challenge scope, and releases the write claim', async () => {
    const { proxy, connection, vault } = await connected(fakeMcpWorld({ grantedScope: 'pages:read' }));
    expect(vault.rows[0]!.scopes).toEqual(['pages:read']);
    await expect(proxy.call('owner-a', connection, 'tools/call', { name: 'create_page', arguments: { title: 'x' } }, { intentId: 'approval:1:apply' })).rejects.toMatchObject({ failure: { code: 'scope_missing', scope: 'pages:write' } });
    expect(vault.intents.size).toBe(0);
  });

  it('runs a write once per intent, replays its result, and refuses a reused intent with other arguments', async () => {
    const { world, proxy, connection } = await connected();
    const args = { name: 'create_page', arguments: { title: 'Plan' } };
    const first = await proxy.call('owner-a', connection, 'tools/call', args, { intentId: 'approval:7:apply' });
    const again = await proxy.call('owner-a', connection, 'tools/call', args, { intentId: 'approval:7:apply' });
    expect(again).toEqual(first);
    expect(world.calls.filter((c) => c.method === 'tools/call')).toHaveLength(1);
    await expect(proxy.call('owner-a', connection, 'tools/call', { name: 'create_page', arguments: { title: 'Other' } }, { intentId: 'approval:7:apply' })).rejects.toMatchObject({ failure: { code: 'intent_conflict' } });
  });

  it('leaves a write pending (outcome unknown) when the server fails after receiving it', async () => {
    const { proxy, connection, vault } = await connected(fakeMcpWorld({ results: () => new Response('boom', { status: 502 }) }));
    await expect(proxy.call('owner-a', connection, 'tools/call', { name: 'create_page', arguments: { title: 'x' } }, { intentId: 'approval:9:apply' })).rejects.toMatchObject({ failure: { code: 'intent_pending' } });
    expect([...vault.intents.values()]).toEqual([expect.objectContaining({ status: 'pending' })]);
  });

  it('types a server that went away and a rate limit with Retry-After', async () => {
    const { world, proxy, connection } = await connected();
    world.throttle(true);
    await expect(proxy.call('owner-a', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'rate_limited', retry_after: 30 } });
    world.throttle(false);
    world.goAway();
    await expect(proxy.call('owner-a', connection, 'tools/list', {}, { era: 'modern' })).rejects.toMatchObject({ failure: { code: 'not_found' } });
  });

  it('never reads a Google grant or another owner\'s grant', async () => {
    const { proxy, connection, vault } = await connected();
    vault.rows.push({ ...vault.rows[0]!, id: '00000000-0000-4000-8000-0000000000aa', provider: 'google', secret: 'google-refresh' });
    await expect(proxy.call('owner-a', '00000000-0000-4000-8000-0000000000aa', 'tools/list', {})).rejects.toBeInstanceOf(OAuthProxyError);
    await expect(proxy.call('owner-b', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'connection_unavailable' } });
  });

  it('registers once per issuer and redirect, then reuses the stored client', async () => {
    const world = fakeMcpWorld({ registration: 'dcr' }), vault = vaultFake();
    routeEdgeFetch(vault, world);
    const proxy = oauthProxy(WORKER_ENV, workerToEdge(serve))!;
    const input = { issuer: ISSUER, registrationEndpoint: `${ISSUER}/register`, redirectUri: REDIRECT, origin: WALDO_ORIGIN };
    await expect(proxy.register(input)).resolves.toEqual({ client_id: 'dcr-client-1', client_auth: 'none' });
    await expect(proxy.register(input)).resolves.toEqual({ client_id: 'dcr-client-1', client_auth: 'none' });
    expect(world.registered).toEqual(['dcr-client-1']);
  });
});

// A provider other than MCP, registered to the oauth-proxy by one custody row, with its pins recorded at
// connect: the health providers' path.
describe('oauth-proxy edge, any registered provider', () => {
  const REDIRECT_H = `${WALDO_ORIGIN}/oauth/fixture/callback`;
  const healthPins: ClientPins = {
    issuer: PROVIDER_ORIGIN, token_endpoint: `${PROVIDER_ORIGIN}/oauth/token`, client_id: PROVIDER_CLIENT.id, client_auth: 'client_secret_post', redirect_uri: REDIRECT_H,
    api_base: PROVIDER_API, account_url: `${PROVIDER_API}user/profile/basic`, account_field: 'user_id', rotation: 'single_use', refresh_scope: 'offline',
  };
  const custody = { google: 'connector-proxy', mcp: 'oauth-proxy', fixture_health: 'oauth-proxy' };

  const linked = async (provider: FakeOAuthProvider = fakeOAuthProvider(), vault: VaultFake = vaultFake(['owner-a', 'owner-b'], { custody, uniqueAccounts: ['fixture_health'] })) => {
    vault.clients.set(`${PROVIDER_ORIGIN} ${REDIRECT_H}`, { client_id: PROVIDER_CLIENT.id, client_auth: 'client_secret_post', client_secret: PROVIDER_CLIENT.secret });
    routeEdgeFetch(vault, provider);
    vi.useFakeTimers({ now: provider.now(), toFake: ['Date'] });
    const calls: Record<string, unknown>[] = [];
    const proxy = oauthProxy(WORKER_ENV, workerToEdge(serve, (body) => calls.push(body)), () => Date.now())!;
    const exchanged = await proxy.exchange('owner-a', 'fixture_health', healthPins, 'fixture-code', { scope: 'offline read:sleep' });
    return { provider, vault, proxy, calls, exchanged, connection: exchanged.id };
  };
  const later = (provider: FakeOAuthProvider, ms: number) => { provider.advance(ms); vi.setSystemTime(provider.now()); };

  it.each([
    ['a provider exchange without a verifier', { op: 'exchange', do_name: 'owner-a', provider: 'fixture_health', pins: healthPins, code: 'c' }],
    ['a provider fetch with a query', { op: 'fetch', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'GET', path: 'activity/sleep', query: { limit: '25' } }],
  ])('accepts %s', (_name, body) => expect(parseOAuthProxyRequest(body)).not.toBeNull());
  it.each([
    ['an MCP exchange without its PKCE verifier', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins, code: 'c' }],
    ['an exchange that cannot name its account', { op: 'exchange', do_name: 'owner-a', provider: 'fixture_health', pins: (({ account_url: _u, account_field: _f, ...rest }) => rest)(healthPins), code: 'c' }],
    ['an account URL outside the API base', { op: 'exchange', do_name: 'owner-a', provider: 'fixture_health', pins: { ...healthPins, account_url: 'https://elsewhere.example/me' }, code: 'c' }],
    ['a rotation rule outside the set', { op: 'exchange', do_name: 'owner-a', provider: 'fixture_health', pins: { ...healthPins, rotation: 'never' }, code: 'c' }],
    ['a provider name that is not an identifier', { op: 'exchange', do_name: 'owner-a', provider: 'Fixture Health', pins: healthPins, code: 'c' }],
    ['a fetch that climbs out of the API base', { op: 'fetch', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'GET', path: '../../oauth/token' }],
    ['a fetch with an absolute URL', { op: 'fetch', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'GET', path: 'https://evil.example/x' }],
    ['a fetch that writes without an idempotency key', { op: 'fetch', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'POST', path: 'activity/sleep' }],
  ])('refuses %s', (_name, body) => expect(parseOAuthProxyRequest(body)).toBeNull());

  it('exchanges with the pinned client secret and no PKCE, reads the account, and returns no token', async () => {
    const { provider, vault, exchanged, calls } = await linked();
    expect(exchanged).toEqual({ id: expect.stringMatching(/^0{8}-/), account: String(PROVIDER_ACCOUNT), scopes: ['offline', 'read:sleep'], expires_at: expect.any(Number), version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(provider.forms[0]!.get('client_secret')).toBe(PROVIDER_CLIENT.secret);
    expect(provider.forms[0]!.has('code_verifier')).toBe(false);
    expect(provider.forms[0]!.has('resource')).toBe(false);
    expect(vault.rows[0]).toMatchObject({ provider: 'fixture_health', account: String(PROVIDER_ACCOUNT), pins: healthPins });
    expect(JSON.stringify([exchanged, calls])).not.toMatch(/pat_|prt_|fixture-client-secret/);
  });

  it('fetches under the pinned API base with the stored token, returning status, body and rate headers only', async () => {
    const { provider, proxy, connection } = await linked();
    const first = await proxy.fetch('owner-a', connection, 'GET', 'activity/sleep', { start: '2026-10-01T00:00:00Z' });
    expect(first).toEqual({ status: 200, body: { records: [{ id: 'sleep-1' }], next_token: 'page-2' }, headers: {}, version: expect.any(String) });
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/sleep', { nextToken: 'page-2' })).resolves.toMatchObject({ body: { records: [{ id: 'sleep-2' }] } });
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/nothing-here')).resolves.toMatchObject({ status: 404, body: null });
    provider.throttle(true);
    const limited = await proxy.fetch('owner-a', connection, 'GET', 'activity/sleep');
    expect(limited).toMatchObject({ status: 429, headers: { 'x-ratelimit-reset': '42' } });
    expect(JSON.stringify(limited)).not.toContain('x-private-detail');
  });

  it('refuses a fetch whose encoded dot segments resolve outside the API base, before sending the token', async () => {
    const { provider, proxy, connection } = await linked();
    const before = provider.hits.length;
    await expect(proxy.fetch('owner-a', connection, 'GET', '%2e%2e/%2e%2e/oauth/token')).rejects.toMatchObject({ failure: { code: 'invalid_request' } });
    expect(provider.hits.length).toBe(before);
  });

  it('reports an expired token without a request, then one refresh rotates the single-use token and the retry succeeds', async () => {
    const { provider, proxy, connection, exchanged } = await linked();
    later(provider, 3_600_000);
    const before = provider.hits.length;
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/sleep')).rejects.toMatchObject({ failure: { code: 'token_expired' } });
    expect(provider.hits.length).toBe(before);
    const refreshed = await proxy.refresh('owner-a', connection, exchanged.version);
    expect(refreshed).toMatchObject({ refreshed: true, scopes: ['offline', 'read:sleep'] });
    expect(provider.forms.at(-1)!.get('scope')).toBe('offline');
    expect(provider.spentRefreshTokens()).toEqual(['prt_1']);
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/sleep')).resolves.toMatchObject({ status: 200 });
  });

  it('maps a refused access token to reauth_needed so the caller refreshes once', async () => {
    const { provider, proxy, connection } = await linked();
    await expect(proxy.fetch('owner-a', connection, 'DELETE', 'user/access')).resolves.toMatchObject({ status: 204 });
    expect(provider.revoked()).toBe(true);
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/sleep')).rejects.toMatchObject({ failure: { code: 'reauth_needed' } });
  });

  it('never spends a single-use refresh token twice: a caller with a stale version reads the winner', async () => {
    const { provider, proxy, connection, exchanged } = await linked();
    later(provider, 3_590_000);
    const first = await proxy.refresh('owner-a', connection, exchanged.version);
    const tokenCalls = provider.forms.length;
    const second = await proxy.refresh('owner-a', connection, exchanged.version);
    expect(second).toEqual({ ...first, refreshed: false });
    expect(provider.forms.length).toBe(tokenCalls);
  });

  it('takes the winner, not a reconnect, when two refreshes race and the provider refuses the second as spent', async () => {
    const { provider, proxy, connection, vault } = await linked();
    later(provider, 3_590_000);
    const real = globalThis.fetch;
    let raced = false;
    // This refresh has read the stored bundle; another refresh lands before this one reaches the provider.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!raced && String(input).endsWith('/oauth/token')) { raced = true; await proxy.refresh('owner-a', connection); }
      return real(input, init);
    }));
    const out = await proxy.refresh('owner-a', connection);
    expect(out.refreshed).toBe(false);
    expect(JSON.parse(vault.rows[0]!.secret)).toMatchObject({ refresh_token: provider.currentRefreshToken() });
    expect(vault.rows[0]).toMatchObject({ status: 'active', last_error: null });
  });

  it('keeps no spent refresh token when a single-use provider answers a refresh without a new one', async () => {
    const { provider, proxy, connection, vault } = await linked(fakeOAuthProvider({ omitRefreshOnRotate: true }));
    later(provider, 3_590_000);
    await expect(proxy.refresh('owner-a', connection)).resolves.toMatchObject({ refreshed: true });
    expect(JSON.parse(vault.rows[0]!.secret)).not.toHaveProperty('refresh_token');
    const tokenCalls = provider.forms.length;
    await expect(proxy.refresh('owner-a', connection)).rejects.toMatchObject({ failure: { code: 'reauth_needed' } });
    expect(provider.forms.length).toBe(tokenCalls);
  });

  it('retries the rotated-token write on a database error instead of losing the spent refresh token', async () => {
    const { provider, proxy, connection, vault } = await linked();
    later(provider, 3_590_000);
    vault.faults.rotate = 2;
    await expect(proxy.refresh('owner-a', connection)).resolves.toMatchObject({ refreshed: true });
    expect(JSON.parse(vault.rows[0]!.secret)).toMatchObject({ refresh_token: provider.currentRefreshToken() });
  });

  it('refuses a second owner linking an account another owner already holds', async () => {
    const { proxy } = await linked();
    await expect(proxy.exchange('owner-b', 'fixture_health', healthPins, 'fixture-code')).rejects.toMatchObject({ failure: { code: 'account_linked' } });
  });

  it('holds only registered providers, and runs MCP calls only on MCP connections', async () => {
    const unregistered = vaultFake(['owner-a'], { custody: { google: 'connector-proxy', mcp: 'oauth-proxy' } });
    await expect(linked(fakeOAuthProvider(), unregistered)).rejects.toMatchObject({ failure: { code: 'connection_unavailable' } });
    expect(unregistered.rows).toEqual([]);
    const { proxy, connection } = await linked();
    await expect(proxy.call('owner-a', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'invalid_request' } });
  });

  it('says the provider has no token revocation, and still deletes the grant', async () => {
    const { proxy, connection, vault } = await linked();
    await expect(proxy.revoke('owner-a', connection)).resolves.toEqual({ provider: 'unsupported' });
    expect(vault.rows[0]!.status).toBe('revoked');
    await expect(proxy.fetch('owner-a', connection, 'GET', 'activity/sleep')).rejects.toMatchObject({ failure: { code: 'connection_unavailable' } });
  });
});
