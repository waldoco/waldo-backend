import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { handleMcpCallback, handleMcpClientMetadata } from '../src/channels/mcp-oauth-routes';
import { mcpConnectReceipt, mcpDisconnectReceipt } from '../src/channels/dashboard-control-actions';
import { mcpState } from '../src/connectors/mcp-connections';

const SECRET = 'fixture-webhook-secret';
const routeEnv = () => ({ TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_DO: env.OWNER_DO }) as unknown as Parameters<typeof handleMcpCallback>[1];

describe('MCP OAuth routes', () => {
  it('serves a client metadata document whose client_id is its own URL', async () => {
    const response = handleMcpClientMetadata(new Request('https://waldo.example/oauth/mcp/client.json'));
    expect(await response.json()).toMatchObject({ client_id: 'https://waldo.example/oauth/mcp/client.json', redirect_uris: ['https://waldo.example/oauth/mcp/callback'], token_endpoint_auth_method: 'none', application_type: 'web' });
  });

  it('drops a forged state before any owner object wakes, and shows an unknown attempt as invalid', async () => {
    const forged = await handleMcpCallback(new Request('https://waldo.example/oauth/mcp/callback?code=c&state=owner.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.bad'), routeEnv());
    expect(forged.status).toBe(400);
    expect(forged.headers.get('cache-control')).toBe('no-store');
    const state = await mcpState(SECRET, 'mcp-route-owner', 'A'.repeat(43));
    const unknown = await handleMcpCallback(new Request(`https://waldo.example/oauth/mcp/callback?code=c&state=${encodeURIComponent(state)}`), routeEnv());
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('This link is not valid');
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
