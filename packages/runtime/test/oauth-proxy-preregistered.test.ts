import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { oauthProxy, OAuthProxyError } from '../src/connectors/oauth-proxy-client';
import { parseOAuthProxyRequest } from '../src/connectors/oauth-proxy-wire';
import { pkceVerifier, type ClientPins } from '../src/connectors/mcp-oauth';
import { fakeSlackMcp, SLACK_CLIENT, SLACK_ISSUER, SLACK_MCP_URL, SLACK_ORIGIN, SLACK_TOKEN_ENDPOINT, type FakeSlackMcp } from './support/fake-slack-mcp';
import { WALDO_ORIGIN } from './support/fake-mcp-world';
import { loadEdge, routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV, type VaultFake } from './support/oauth-edge-harness';

let serve: (request: Request) => Promise<Response>;
beforeAll(async () => { serve = await loadEdge(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => vi.unstubAllGlobals());

const REDIRECT = `${WALDO_ORIGIN}/oauth/mcp/callback`;
const pins: ClientPins = {
  server_url: SLACK_MCP_URL, resource: SLACK_ORIGIN, issuer: SLACK_ISSUER, token_endpoint: SLACK_TOKEN_ENDPOINT,
  client_id: SLACK_CLIENT.id, client_auth: 'client_secret_post', redirect_uri: REDIRECT, token_dialect: 'ok_envelope',
};
const SCOPE = 'search:read.public channels:history chat:write';
const secretOrToken = new RegExp(`${SLACK_CLIENT.secret}|xoxe`);

const seeded = (vault: VaultFake, endpoints: Readonly<{ token_endpoint?: string; revocation_endpoint?: string }> = { token_endpoint: SLACK_TOKEN_ENDPOINT }) => {
  vault.clients.set(`${SLACK_ISSUER} ${REDIRECT}`, { client_id: SLACK_CLIENT.id, client_auth: 'client_secret_post', client_secret: SLACK_CLIENT.secret, ...endpoints });
  return vault;
};
const edge = (vault: VaultFake, slack: FakeSlackMcp) => {
  routeEdgeFetch(vault, slack);
  vi.useFakeTimers({ now: slack.now(), toFake: ['Date'] });
  const calls: Record<string, unknown>[] = [];
  return { proxy: oauthProxy(WORKER_ENV, workerToEdge(serve, (body) => calls.push(body)), () => Date.now())!, calls };
};
const linked = async (slack: FakeSlackMcp = fakeSlackMcp(), vault: VaultFake = seeded(vaultFake())) => {
  const { proxy, calls } = edge(vault, slack);
  const exchanged = await proxy.exchange('owner-a', 'mcp', pins, slack.code(REDIRECT), { verifier: pkceVerifier(), scope: SCOPE });
  return { slack, vault, proxy, calls, exchanged, connection: exchanged.id };
};
const refusal = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof OAuthProxyError ? error.failure.code : String(error));

describe('wire contract, pre-registered clients', () => {
  it.each([
    ['a client lookup', { op: 'client', issuer: SLACK_ISSUER, redirect_uri: REDIRECT }],
    ['an exchange whose token endpoint answers inside an ok envelope', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins, code: 'c', verifier: 'v'.repeat(43) }],
  ])('accepts %s', (_name, body) => expect(parseOAuthProxyRequest(body)).not.toBeNull());
  it.each([
    ['a lookup that also names a secret', { op: 'client', issuer: SLACK_ISSUER, redirect_uri: REDIRECT, client_secret: 'x' }],
    ['a lookup for a plain-http issuer', { op: 'client', issuer: 'http://mcp.chat.example', redirect_uri: REDIRECT }],
    ['a lookup without a redirect address', { op: 'client', issuer: SLACK_ISSUER }],
    ['a token dialect outside the set', { op: 'exchange', do_name: 'owner-a', provider: 'mcp', pins: { ...pins, token_dialect: 'chat' }, code: 'c', verifier: 'v'.repeat(43) }],
  ])('refuses %s', (_name, body) => expect(parseOAuthProxyRequest(body)).toBeNull());
});

describe('oauth-proxy edge, pre-registered clients', () => {
  it('names the seeded client and its authentication, never its secret, and registers nothing', async () => {
    const slack = fakeSlackMcp(), vault = seeded(vaultFake());
    const { proxy } = edge(vault, slack);
    const client = await proxy.client({ issuer: SLACK_ISSUER, redirectUri: REDIRECT });
    expect(client).toEqual({ client_id: SLACK_CLIENT.id, client_auth: 'client_secret_post' });
    expect(vault.rpcs).toEqual(['oauth_client_registered']);
    expect(slack.hits).toEqual([]);
  });

  it('refuses the lookup for an issuer nobody seeded, and for a dynamic registration', async () => {
    const slack = fakeSlackMcp(), vault = vaultFake();
    const { proxy } = edge(vault, slack);
    await expect(refusal(proxy.client({ issuer: SLACK_ISSUER, redirectUri: REDIRECT }))).resolves.toBe('registration_refused');
    vault.clients.set(`${SLACK_ISSUER} ${REDIRECT}`, { client_id: 'dcr-client-1', client_auth: 'none', client_secret: null });
    await expect(refusal(proxy.client({ issuer: SLACK_ISSUER, redirectUri: REDIRECT }))).resolves.toBe('registration_refused');
    await expect(refusal(proxy.client({ issuer: SLACK_ISSUER, redirectUri: `${WALDO_ORIGIN}/elsewhere` }))).resolves.toBe('registration_refused');
    expect(slack.hits).toEqual([]);
  });

  it('exchanges with the seeded secret at the pinned endpoint, reads the user token and its scopes, and returns neither', async () => {
    const { slack, vault, exchanged, calls } = await linked();
    expect(exchanged).toEqual({ id: expect.stringMatching(/^0{8}-/), account: `${SLACK_ISSUER} ${SLACK_ORIGIN}`, scopes: ['search:read.public', 'channels:history', 'chat:write'], expires_at: expect.any(Number), version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(slack.hits).toEqual([`POST ${SLACK_TOKEN_ENDPOINT}`]);
    expect(slack.forms[0]!.get('client_secret')).toBe(SLACK_CLIENT.secret);
    expect(JSON.parse(vault.rows[0]!.secret)).toMatchObject({ access_token: 'xoxe.xoxp-2', refresh_token: 'xoxe-1-2' });
    expect(JSON.stringify([exchanged, calls])).not.toMatch(secretOrToken);
  });

  it('never sends the seeded secret to a token endpoint the seed did not pin', async () => {
    const slack = fakeSlackMcp(), vault = seeded(vaultFake());
    const { proxy } = edge(vault, slack);
    const elsewhere = { ...pins, token_endpoint: 'https://collector.example/token' };
    await expect(refusal(proxy.exchange('owner-a', 'mcp', elsewhere, slack.code(REDIRECT), { verifier: pkceVerifier() }))).resolves.toBe('token_failed');
    expect(slack.hits).toEqual([]);
    expect(vault.rows).toEqual([]);
  });

  it('never sends the secret, or the token, to a revocation endpoint the seed did not pin', async () => {
    const slack = fakeSlackMcp(), vault = seeded(vaultFake());
    const { proxy } = edge(vault, slack);
    const exchanged = await proxy.exchange('owner-a', 'mcp', { ...pins, revocation_endpoint: 'https://collector.example/revoke' }, slack.code(REDIRECT), { verifier: pkceVerifier() });
    await expect(proxy.revoke('owner-a', exchanged.id)).resolves.toEqual({ provider: 'failed' });
    expect(slack.hits.filter((hit) => hit.includes('collector'))).toEqual([]);
    expect(vault.rows[0]!.status).toBe('revoked');
  });

  it('calls the server with the user token as a bearer, and logs neither secret nor token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { slack, proxy, connection } = await linked();
    const out = await proxy.call('owner-a', connection, 'tools/call', { name: 'search_messages', arguments: { query: 'PRIVATE_QUERY' } }, { era: 'legacy' });
    expect(out.result).toEqual({ content: [{ type: 'text', text: 'search_messages ran' }] });
    expect(slack.bearers.every((bearer) => bearer === 'xoxe.xoxp-2')).toBe(true);
    const logged = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toMatch(/"op":"exchange"/);
    expect(logged).not.toMatch(secretOrToken);
    expect(logged).not.toMatch(/PRIVATE_QUERY/);
  });

  it('refreshes an expiring user token through the ok envelope, and asks for a reconnect when the refresh token is dead', async () => {
    const { slack, vault, proxy, connection } = await linked();
    slack.advance(43_200_000); vi.setSystemTime(slack.now());
    await expect(refusal(proxy.call('owner-a', connection, 'tools/list', {}, { era: 'legacy' }))).resolves.toBe('token_expired');
    await expect(proxy.refresh('owner-a', connection)).resolves.toMatchObject({ refreshed: true, scopes: ['search:read.public', 'channels:history', 'chat:write'] });
    await expect(proxy.call('owner-a', connection, 'tools/list', {}, { era: 'legacy' })).resolves.toMatchObject({ era: 'legacy' });
    slack.forgetRefreshTokens();
    slack.advance(43_200_000); vi.setSystemTime(slack.now());
    await expect(refusal(proxy.refresh('owner-a', connection))).resolves.toBe('reauth_needed');
    expect(vault.rows[0]).toMatchObject({ status: 'failing', last_error: 'oauth_reauth_needed' });
  });

  it('keeps one owner\'s connection out of another owner\'s reach', async () => {
    const { slack, vault, proxy, connection } = await linked();
    const before = slack.hits.length;
    await expect(refusal(proxy.call('owner-b', connection, 'tools/list', {}, { era: 'legacy' }))).resolves.toBe('connection_unavailable');
    await expect(refusal(proxy.refresh('owner-b', connection))).resolves.toBe('connection_unavailable');
    await expect(refusal(proxy.revoke('owner-b', connection))).resolves.toBe('connection_unavailable');
    expect(slack.hits.length).toBe(before);
    expect(vault.rows[0]!.status).toBe('active');
  });

  it('says the provider has no revocation endpoint, deletes the grant without reading the secret, and a later call never reaches the server', async () => {
    const { slack, vault, proxy, connection } = await linked();
    const before = slack.hits.length;
    vault.rpcs.length = 0;
    await expect(proxy.revoke('owner-a', connection)).resolves.toEqual({ provider: 'unsupported' });
    expect(vault.rpcs).not.toContain('oauth_client_secret');
    expect(vault.rows[0]!.status).toBe('revoked');
    await expect(refusal(proxy.call('owner-a', connection, 'tools/list', {}, { era: 'legacy' }))).resolves.toBe('connection_unavailable');
    expect(slack.hits.length).toBe(before);
  });
});
