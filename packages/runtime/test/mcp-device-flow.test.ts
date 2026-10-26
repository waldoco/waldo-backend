import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpConnections, type McpConnections } from '../src/connectors/mcp-connections';
import { DeviceFlowError, requestDeviceCode, type ClientPins } from '../src/connectors/mcp-oauth';
import { oauthProxy } from '../src/connectors/oauth-proxy-client';
import { parseOAuthProxyRequest } from '../src/connectors/oauth-proxy-wire';
import { MCP_CATALOGUE } from '../src/connectors/mcp-catalogue';
import { fakeMcpWorld, WALDO_ORIGIN, type FakeMcpWorld, type FakeOptions } from './support/fake-mcp-world';
import { loadEdge, routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV, type VaultFake } from './support/oauth-edge-harness';

// RFC 8628 for an official server whose sign-in service advertises a device code: the edge asks for the code and polls with
// it; tokens land in Vault exactly as a browser sign-in's do; authorization_pending and slow_down wait, expired_token and
// access_denied end the attempt.
const NOTION = MCP_CATALOGUE.find((entry) => entry.id === 'notion')!;
const NOTION_ORIGIN = new URL(NOTION.url).origin;
let serve: (request: Request) => Promise<Response>;
beforeAll(async () => { serve = await loadEdge(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => vi.unstubAllGlobals());

type Rig = Readonly<{ world: FakeMcpWorld; vault: VaultFake; mcp: McpConnections; sql: SqlStorage; edge: Record<string, unknown>[] }>;
const withRig = (name: string, options: Partial<FakeOptions>, run: (rig: Rig) => Promise<void>) => async () => {
  const world = fakeMcpWorld({ origin: NOTION_ORIGIN, issuer: NOTION.issuer, ...options }), vault = vaultFake(['owner-a']);
  routeEdgeFetch(vault, world);
  vi.useFakeTimers({ now: world.now(), toFake: ['Date'] });
  const edge: Record<string, unknown>[] = [];
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`mcp-device-${name}`)), async (_instance, state) => {
    const mcp = mcpConnections({
      sql: state.storage.sql, transaction: (work) => state.storage.transactionSync(work),
      proxy: oauthProxy(WORKER_ENV, workerToEdge(serve, (body) => edge.push(body)), () => Date.now()),
      doName: () => 'owner-a', stateSecret: 'fixture-state-secret', fetcher: world.fetcher, now: () => Date.now(),
    });
    await run({ world, vault, mcp, sql: state.storage.sql, edge });
  });
};
const startDevice = async (mcp: McpConnections) => {
  const begun = await mcp.begin(NOTION.url, WALDO_ORIGIN, NOTION.id, 'device');
  if (begun.kind !== 'device') throw new Error(`expected a device code, got ${JSON.stringify(begun)}`);
  return begun;
};

describe('device code sign-in through the edge', () => {
  it('waits on authorization_pending, slows by five seconds on slow_down, and links when the owner approves', withRig('approved', { device: true, deviceAnswers: ['authorization_pending', 'slow_down', 'ok'] }, async ({ world, vault, mcp, edge }) => {
    const begun = await startDevice(mcp);
    expect(begun).toMatchObject({ user_code: 'WDJB-MJHT', verification_uri: `${NOTION.issuer}/activate` });
    expect(begun.expires).toBe(Date.now() + 900_000);
    // The device request went through the edge as a public client; no browser address was ever minted.
    expect(edge.map((call) => call.op)).toEqual(['device_start']);
    expect((edge[0]!.pins as ClientPins).client_auth).toBe('none');
    expect(world.hits.filter((hit) => hit.endsWith('/authorize'))).toEqual([]);

    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'wait', at: Date.now() + 5_000 });
    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'wait', at: Date.now() + 10_000 });
    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'done', outcome: { kind: 'linked', id: expect.any(String), name: 'notion', official: 'notion' } });
    expect(world.devicePolls).toEqual(['authorization_pending', 'slow_down', 'ok']);
    // Stored exactly where a browser sign-in's grant is: one Vault row the edge holds, the server kept by its id.
    expect(vault.rows).toHaveLength(1);
    expect(vault.rows[0]).toMatchObject({ owner: 'owner-a', provider: 'mcp', account: `${NOTION.issuer} ${NOTION.url}`.toLowerCase() });
    expect(mcp.list()[0]).toMatchObject({ id: vault.rows[0]!.id, name: 'notion', status: 'active', tools: 2, runs_without_asking: 1 });
    // The edge's answers to the owner object carry no token, code or device code back.
    expect(JSON.stringify(mcp.list())).not.toMatch(/at_\d|rt_\d|dc_\d/);
    // Settled: another poll replays the outcome and asks the provider nothing.
    expect(await mcp.pollDevice(begun.nonce)).toMatchObject({ kind: 'done', outcome: { kind: 'linked' } });
    expect(world.devicePolls).toHaveLength(3);
  }));

  it.each([
    ['expired_token', { kind: 'expired' }],
    ['access_denied', { kind: 'denied' }],
  ] as const)('ends the attempt on %s and stores nothing', (answer, outcome) => withRig(`ended-${answer}`, { device: true, deviceAnswers: ['authorization_pending', answer] }, async ({ vault, mcp, world }) => {
    const begun = await startDevice(mcp);
    expect((await mcp.pollDevice(begun.nonce)).kind).toBe('wait');
    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'done', outcome });
    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'done', outcome });
    expect(world.devicePolls).toHaveLength(2);
    expect(vault.rows).toHaveLength(0);
    expect(mcp.list()).toEqual([]);
  })());

  it('ends an attempt past the code\'s lifetime without asking the provider', withRig('lapsed', { device: true, deviceAnswers: ['ok'] }, async ({ mcp, world }) => {
    const begun = await startDevice(mcp);
    vi.setSystemTime(Date.now() + 900_001);
    expect(await mcp.pollDevice(begun.nonce)).toEqual({ kind: 'done', outcome: { kind: 'expired' } });
    expect(world.devicePolls).toEqual([]);
  }));

  it('offers no code where the sign-in service advertises none, and never fakes one', withRig('unsupported', { device: false }, async ({ mcp, edge, sql }) => {
    expect(await mcp.begin(NOTION.url, WALDO_ORIGIN, NOTION.id, 'device')).toEqual({ kind: 'failed', reason: 'device_unsupported' });
    expect(edge.map((call) => call.op)).not.toContain('device_start');
    expect(sql.exec('SELECT COUNT(*) AS n FROM mcp_attempts').one().n).toBe(0);
  }));

  it('never accepts a browser callback for a device attempt', withRig('no-callback', { device: true }, async ({ mcp }) => {
    const begun = await startDevice(mcp);
    expect(await mcp.finish(begun.nonce, new URLSearchParams({ code: 'code_injected', iss: NOTION.issuer }))).toEqual({ kind: 'invalid' });
    expect(await mcp.start(begun.nonce)).toBeNull();
    expect(mcp.attemptTarget(begun.nonce)).toBeNull();
  }));
});

describe('device code wire and answers', () => {
  const pins: ClientPins = { issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token', client_id: 'https://waldo.example.com/oauth/mcp/client.json', client_auth: 'none', redirect_uri: 'https://waldo.example.com/oauth/mcp/callback', server_url: 'https://mcp.example.com/mcp', resource: 'https://mcp.example.com/mcp' };
  it('accepts a public MCP client asking at its token endpoint\'s own origin', () => {
    expect(parseOAuthProxyRequest({ op: 'device_start', pins, device_endpoint: 'https://auth.example.com/device' })).not.toBeNull();
    expect(parseOAuthProxyRequest({ op: 'device_poll', do_name: 'owner-a', provider: 'mcp', pins, device_code: 'dc_1' })).not.toBeNull();
  });
  it.each([
    ['a confidential client (its secret would go out)', { op: 'device_start', pins: { ...pins, client_auth: 'client_secret_post' }, device_endpoint: 'https://auth.example.com/device' }],
    ['a device endpoint on another origin', { op: 'device_start', pins, device_endpoint: 'https://evil.example/device' }],
    ['a provider that is not an MCP server', { op: 'device_start', pins: { ...pins, server_url: undefined, resource: undefined }, device_endpoint: 'https://auth.example.com/device' }],
    ['a plain-http device endpoint', { op: 'device_start', pins, device_endpoint: 'http://auth.example.com/device' }],
    ['a poll by a confidential client', { op: 'device_poll', do_name: 'owner-a', provider: 'mcp', pins: { ...pins, client_auth: 'client_secret_basic' }, device_code: 'dc_1' }],
    ['a poll with no device code', { op: 'device_poll', do_name: 'owner-a', provider: 'mcp', pins, device_code: '' }],
    ['a poll with an extra field', { op: 'device_poll', do_name: 'owner-a', provider: 'mcp', pins, device_code: 'dc_1', client_secret: 's' }],
  ])('refuses %s', (_label, request) => {
    expect(parseOAuthProxyRequest(request)).toBeNull();
  });

  const answering = (body: Record<string, unknown>) => (async () => Response.json(body)) as unknown as typeof fetch;
  const good = { device_code: 'dc_1', user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example.com/activate', expires_in: 900 };
  it('reads a good answer, defaulting the interval to five seconds', async () => {
    expect(await requestDeviceCode(answering(good), pins, 'https://auth.example.com/device', undefined)).toEqual({ ...good, interval: 5 });
  });
  it.each([
    ['a user code with markup', { ...good, user_code: '<b>WDJB</b>' }],
    ['a user code with a space', { ...good, user_code: 'WDJB MJHT' }],
    ['a plain-http verification address', { ...good, verification_uri: 'http://auth.example.com/activate' }],
    ['a verification address to a private network', { ...good, verification_uri: 'https://127.0.0.1/activate' }],
    ['no device code', { ...good, device_code: undefined }],
    ['no lifetime', { ...good, expires_in: undefined }],
    ['a negative interval', { ...good, interval: -1 }],
  ])('refuses an answer with %s', async (_label, body) => {
    await expect(requestDeviceCode(answering(body), pins, 'https://auth.example.com/device', undefined)).rejects.toBeInstanceOf(DeviceFlowError);
  });
});
