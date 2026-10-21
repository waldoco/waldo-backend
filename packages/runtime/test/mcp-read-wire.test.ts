import { describe, expect, it } from 'vitest';
import { googleProxy } from '../src/connectors/connections';

// What crosses to the edge for MCP calls. SOURCE only: the edge decides what to do with read_only.
const sent: Record<string, unknown>[] = [];
const fetcher = (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: 'ok' }), { status: 200 }); }) as unknown as typeof fetch;
const proxy = () => googleProxy({ SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k', WALDO_ROUTER_HMAC_SECRET: 's' } as never, fetcher)!;
const call = (intent: { id: string; readOnly?: boolean }) => proxy().mcpCall('owner', 'conn', 'https://drivemcp.googleapis.com/mcp/v1', 'search_files', {}, intent);

describe('mcp_call wire body', () => {
  it('a host-derived read intent sends read_only: true', async () => {
    sent.length = 0;
    await call({ id: `mcpread:${'a'.repeat(64)}`, readOnly: true });
    expect(sent[0]).toMatchObject({ op: 'mcp_call', tool: 'search_files', read_only: true });
  });
  it('an effect intent, or a readOnly flag on a non-mcpread id, never sends read_only', async () => {
    sent.length = 0;
    await call({ id: 'approval:mcp' });
    await call({ id: 'approval:mcp', readOnly: true });
    await call({ id: `mcpread:${'b'.repeat(64)}` });
    expect(sent).toHaveLength(3);
    for (const body of sent) expect(body).not.toHaveProperty('read_only');
  });
});

describe('provider auth errors on bounded reads', () => {
  const failing = (status: number) => googleProxy({ SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k', WALDO_ROUTER_HMAC_SECRET: 's' } as never,
    (async () => new Response(JSON.stringify({ error: { status, message: 'provider said no' } }), { status })) as unknown as typeof fetch)!;
  const read = { id: `mcpread:${'c'.repeat(64)}`, readOnly: true };
  it('a read keeps the provider 401 and 403 status so the reconnect path can fire', async () => {
    for (const status of [401, 403]) await expect(failing(status).mcpCall('owner', 'conn', 'https://drivemcp.googleapis.com/mcp/v1', 'search_files', {}, read)).rejects.toMatchObject({ status });
  });
  it('an effect intent still collapses any edge error to intent_unavailable', async () => {
    await expect(failing(403).mcpCall('owner', 'conn', 'https://x.googleapis.com/mcp', 'synthetic_write', {}, { id: 'approval:mcp' })).rejects.toMatchObject({ code: 'intent_unavailable' });
  });
  it('a read that loses the network reports a plain failure, not a pending effect', async () => {
    const lost = googleProxy({ SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k', WALDO_ROUTER_HMAC_SECRET: 's' } as never, (async () => { throw new Error('network down'); }) as unknown as typeof fetch)!;
    await expect(lost.mcpCall('owner', 'conn', 'https://drivemcp.googleapis.com/mcp/v1', 'search_files', {}, read)).rejects.toThrow('network down');
  });
});
