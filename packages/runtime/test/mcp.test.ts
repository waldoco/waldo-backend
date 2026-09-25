import { describe, expect, it, vi } from 'vitest';
import { callMcpToolHandler, mcpServers } from '../src/tools/live/mcp';

const handler = callMcpToolHandler(JSON.stringify([{ name: 'github', url: 'https://mcp.test/rpc', token: 'tok' }]));

const rpcFetch = (capture: { url: string; init?: RequestInit }[], toolsResult: object) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture.push({ url: String(input), init });
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    if (method === 'initialize') return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-session-id': 'sess1' } });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: 3, result: toolsResult });
  }) as typeof fetch;

describe('mcp server registry', () => {
  it('parses deploy config, tolerates garbage, defaults to none', () => {
    expect(mcpServers(undefined)).toEqual([]);
    expect(mcpServers('not json')).toEqual([]);
    expect(mcpServers('[{"name":"a","url":"https://x"},{"name":"b"}]')).toEqual([{ name: 'a', url: 'https://x' }]);
  });
});

describe('call_mcp_tool handler', () => {
  it('unknown server names the configured set; empty registry says so honestly', async () => {
    const miss = await handler.handle({ server: 'nope', tool: 't', args: {} }, {} as never);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain('github');
    const empty = await callMcpToolHandler(undefined).handle({ server: 'x', tool: 't', args: {} }, {} as never);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('No MCP servers');
  });

  it('runs initialize -> initialized -> tools/call, replays the session id, stamps external taint', async () => {
    const capture: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', rpcFetch(capture, { content: [{ type: 'text', text: 'answer' }] }));
    const out = await handler.handle({ server: 'github', tool: 'get_issue', args: { n: 1 } }, {} as never);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toMatchObject({ output: [{ type: 'text', text: 'answer' }], source_taint: 'external' });
    }
    expect(capture.map((c) => (JSON.parse(String(c.init!.body)) as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    const callHeaders = capture[2]!.init!.headers as Record<string, string>;
    expect(callHeaders['mcp-session-id']).toBe('sess1');
    expect(callHeaders.authorization).toBe('Bearer tok');
    expect(JSON.stringify(capture[2]!.init!.body)).not.toContain('tok');
    vi.unstubAllGlobals();
  });

  it('server-side errors surface as transient, never thrown through', async () => {
    vi.stubGlobal('fetch', (async () => new Response('down', { status: 503 })) as typeof fetch);
    const out = await handler.handle({ server: 'github', tool: 't', args: {} }, {} as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('transient');
    vi.unstubAllGlobals();
  });
});
