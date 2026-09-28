import { describe, expect, it } from 'vitest';
import { callMcpToolHandler, executeMcp, McpConnectError, type McpGoogleAuth } from '../src/tools/live/mcp';
import { fixtureMcpFetch } from '../evals/fixture-mcp';

// Google-auth MCP servers (WALDO_MCP_SERVERS entries with auth:'google'): the serving account
// decides the mode - a local grant mints a bearer in the runtime; a Vault-backed grant keeps the
// token edge-side and the connector proxy executes the call with the connection id.
const GOOGLE_SERVER = JSON.stringify([{ name: 'drivemcp', url: 'https://mcp.fixture/rpc', auth: 'google' }]);

const bearerAuth = (token: string | null): McpGoogleAuth => ({
  resolve: async () => (token === null ? null : { mode: 'bearer', token }),
  proxy: async () => { throw new Error('proxy must not run in bearer mode'); },
});

describe('google-auth MCP servers', () => {
  it('bearer mode sends the resolved Google token and returns the tool content', async () => {
    let seenAuth = '';
    const fetchSpy: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization') ?? seenAuth;
      return fixtureMcpFetch('https://mcp.fixture/rpc', init);
    }) as typeof fetch;
    const out = await executeMcp({ name: 'drivemcp', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' }, 'pipeline_status', {}, bearerAuth('ya29.test-token'), fetchSpy);
    expect(seenAuth).toBe('Bearer ya29.test-token');
    expect(out.protocolVersion).toBe('2025-06-18');
  });

  it('no serving account maps to the not_connected connect intent', async () => {
    const handler = callMcpToolHandler(GOOGLE_SERVER, undefined, bearerAuth(null));
    const out = await handler.handle({ server: 'drivemcp', tool: 't', args: {} }, {} as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('auth_failed');
      expect(out.connect).toEqual({ status: 'auth_required', service: 'google', reason: 'not_connected' });
      expect(out.error).not.toContain('http');
    }
  });

  it('a 401 from the server maps to reauth_needed; a 403 to scope_missing', async () => {
    const fetch401: typeof fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(executeMcp({ name: 'g', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' }, 't', {}, bearerAuth('tok'), fetch401))
      .rejects.toMatchObject({ name: 'McpConnectError', reason: 'reauth_needed' });
    const fetch403: typeof fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    await expect(executeMcp({ name: 'g', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' }, 't', {}, bearerAuth('tok'), fetch403))
      .rejects.toMatchObject({ name: 'McpConnectError', reason: 'scope_missing' });
  });

  it('proxy mode routes server/tool/args plus the connection id edge-side; no token crosses', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const proxyAuth: McpGoogleAuth = {
      resolve: async () => ({ mode: 'proxy', connection: 'conn_123' }),
      proxy: async (serverUrl, tool, args, connection) => {
        seen.push({ serverUrl, tool, args, connection });
        return [{ text: 'edge result' }];
      },
    };
    const out = await executeMcp({ name: 'drivemcp', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' }, 'list_files', { max: 3 }, proxyAuth);
    expect(seen).toEqual([{ serverUrl: 'https://drivemcp.googleapis.com/mcp/v1', tool: 'list_files', args: { max: 3 }, connection: 'conn_123' }]);
    expect(out.content).toEqual([{ text: 'edge result' }]);
    expect(JSON.stringify(seen)).not.toContain('Bearer');
  });

  it('proxy 401/403 map to the owner-actionable connect intents', async () => {
    const failing = (status: number): McpGoogleAuth => ({
      resolve: async () => ({ mode: 'proxy', connection: 'conn_123' }),
      proxy: async () => { throw Object.assign(new Error('proxy failed'), { status }); },
    });
    await expect(executeMcp({ name: 'g', url: 'https://x', auth: 'google' }, 't', {}, failing(401)))
      .rejects.toMatchObject({ reason: 'reauth_needed' });
    await expect(executeMcp({ name: 'g', url: 'https://x', auth: 'google' }, 't', {}, failing(403)))
      .rejects.toMatchObject({ reason: 'scope_missing' });
    expect(() => new McpConnectError('not_connected', 'x')).not.toThrow();
  });

  it('a Google bearer is refused for a non-Google MCP host', async () => {
    const handler = callMcpToolHandler(JSON.stringify([{ name: 'evil', url: 'https://mcp.fixture/rpc', auth: 'google' }]), undefined, bearerAuth('ya29.test-token'));
    const out = await handler.handle({ server: 'evil', tool: 't', args: {} }, {} as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('auth_failed');
  });

  it('static-token servers are untouched by the google auth path', async () => {
    const out = await executeMcp({ name: 'buildpulse', url: 'https://mcp.fixture/rpc' }, 'pipeline_status', {}, undefined, fixtureMcpFetch);
    expect(out.protocolVersion).toBe('2025-06-18');
  });
});
