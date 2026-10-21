import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpProxy, McpProxyError } from '../src/connectors/mcp-proxy-client';
import { parseMcpProxyRequest } from '../src/connectors/mcp-proxy-wire';
import { clientMetadataDocument, pkceChallenge, pkceVerifier, type ClientPins } from '../src/connectors/mcp-oauth';
import { routerSignature } from '../src/identity/owner-directory';
import { fakeMcpWorld, ISSUER, MCP_URL, WALDO_ORIGIN, type FakeMcpWorld } from './support/fake-mcp-world';
import { loadEdge, routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV, type VaultFake } from './support/mcp-edge-harness';

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
  const proxy = mcpProxy(WORKER_ENV, workerToEdge(serve, (body) => calls.push(body)), () => Date.now())!;
  const verifier = pkceVerifier();
  const authorize = new URL(`${ISSUER}/authorize`);
  for (const [k, v] of Object.entries({ client_id: pins.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: await pkceChallenge(verifier), resource: MCP_URL, scope: 'pages:read pages:write' })) authorize.searchParams.set(k, v);
  const back = await world.authorize(authorize.toString());
  const exchanged = await proxy.exchange('owner-a', pinned, back.searchParams.get('code')!, verifier, 'pages:read pages:write');
  return { world, vault, proxy, calls, exchanged, connection: exchanged.id };
};

const signed = async (body: unknown, secret = WORKER_ENV.WALDO_ROUTER_HMAC_SECRET, at = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(body);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://edge.invalid/functions/v1/mcp-proxy', { method: 'POST', body: raw, headers: { 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `mcp.${digest}`) } });
};

describe('wire contract', () => {
  const call = { op: 'call', do_name: 'owner-a', connection: '00000000-0000-4000-8000-000000000001', method: 'tools/list', params: {} };
  it.each([
    ['a read call', call],
    ['a write call with its intent and mirrored headers', { ...call, method: 'tools/call', params: { name: 'create_page', arguments: { title: 'x' } }, intent_id: 'approval:ab12:apply', headers: { 'mcp-param-region': 'eu' } }],
    ['a refresh with a version', { op: 'refresh', do_name: 'owner-a', connection: call.connection, version: '0123456789abcdef' }],
    ['an exchange', { op: 'exchange', do_name: 'owner-a', pins, code: 'c', verifier: 'v'.repeat(43) }],
  ])('accepts %s', (_name, body) => expect(parseMcpProxyRequest(body)).not.toBeNull());
  it.each([
    ['an unknown key (a URL smuggled next to the connection id)', { ...call, server_url: 'https://evil.example.net/mcp' }],
    ['a method outside the set', { ...call, method: 'sampling/createMessage' }],
    ['a connection that is not a uuid', { ...call, connection: '../other' }],
    ['a header that is not Mcp-Param', { ...call, headers: { authorization: 'Bearer x' } }],
    ['a header value with a newline', { ...call, headers: { 'mcp-param-x': 'a\nb' } }],
    ['plain-http pins', { op: 'exchange', do_name: 'owner-a', pins: { ...pins, token_endpoint: 'http://auth.example.com/token' }, code: 'c', verifier: 'v'.repeat(43) }],
    ['a short PKCE verifier', { op: 'exchange', do_name: 'owner-a', pins, code: 'c', verifier: 'short' }],
    ['an unknown operation', { op: 'mint', do_name: 'owner-a' }],
  ])('refuses %s', (_name, body) => expect(parseMcpProxyRequest(body)).toBeNull());
});

describe('mcp-proxy edge', () => {
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
    expect(exchanged).toEqual({ id: expect.stringMatching(/^0{8}-/), scopes: ['pages:read', 'pages:write'], expires_at: expect.any(Number), version: expect.stringMatching(/^[0-9a-f]{16}$/) });
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
    expect(logged).toContain('"hop":"mcp_proxy"');
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
    await expect(proxy.call('owner-a', '00000000-0000-4000-8000-0000000000aa', 'tools/list', {})).rejects.toBeInstanceOf(McpProxyError);
    await expect(proxy.call('owner-b', connection, 'tools/list', {})).rejects.toMatchObject({ failure: { code: 'connection_unavailable' } });
  });

  it('registers once per issuer and redirect, then reuses the stored client', async () => {
    const world = fakeMcpWorld({ registration: 'dcr' }), vault = vaultFake();
    routeEdgeFetch(vault, world);
    const proxy = mcpProxy(WORKER_ENV, workerToEdge(serve))!;
    const input = { issuer: ISSUER, registrationEndpoint: `${ISSUER}/register`, redirectUri: REDIRECT, origin: WALDO_ORIGIN };
    await expect(proxy.register(input)).resolves.toEqual({ client_id: 'dcr-client-1', client_auth: 'none' });
    await expect(proxy.register(input)).resolves.toEqual({ client_id: 'dcr-client-1', client_auth: 'none' });
    expect(world.registered).toEqual(['dcr-client-1']);
  });
});
