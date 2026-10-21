import { describe, expect, it } from 'vitest';
import { callMcp } from '../src/tools/live/mcp';
import { FIXTURE_MCP_SERVER, fixtureMcpFetch } from '../evals/fixture-mcp';

// The W7 eval gate's fixture must speak the MCP transport correctly WITHOUT any API key or
// network - this test is the Mac-run-independent proof that eval MCP cases exercise the real
// client protocol path (initialize -> session -> tools/call, isError typed rejection).
describe('eval fixture MCP server', () => {
  it('completes a test-client initialize, list and call exchange over the fixture transport', async () => {
    const requests: Array<{ method: string; session: string | null }> = [];
    const post = async (method: string, id: number | undefined, params?: object, session?: string) => {
      const body = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) };
      const response = await fixtureMcpFetch(FIXTURE_MCP_SERVER.url, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify(body),
      });
      requests.push({ method, session: session ?? null });
      return response;
    };
    const initialized = await post('initialize', 1, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-protocol-test', version: '1' } });
    expect(initialized.status).toBe(200);
    expect((await initialized.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18');
    const session = initialized.headers.get('mcp-session-id');
    expect(session).toBe('fixture-sess-1');
    expect((await post('notifications/initialized', undefined, undefined, session!)).status).toBe(202);
    const listed = await post('tools/list', 2, {}, session!);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(['pipeline_status', 'weather_today']);
    const called = await post('tools/call', 3, { name: 'pipeline_status', arguments: {} }, session!);
    expect(called.status).toBe(200);
    expect((await called.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('Deploy pipeline green');
    expect(requests).toEqual([
      { method: 'initialize', session: null },
      { method: 'notifications/initialized', session },
      { method: 'tools/list', session },
      { method: 'tools/call', session },
    ]);
  });

  it('runs the real client against the fixture for a clean tool', async () => {
    const out = (await callMcp(FIXTURE_MCP_SERVER, 'pipeline_status', {}, fixtureMcpFetch)) as { content: { text: string }[]; protocolVersion: string };
    expect(out.protocolVersion).toBe('2025-06-18');
    expect(out.content[0]!.text).toContain('Deploy pipeline green');
  });

  it('passes injected tool text through as opaque content (the case judges the reply, not the transport)', async () => {
    const out = (await callMcp(FIXTURE_MCP_SERVER, 'weather_today', {}, fixtureMcpFetch)) as { content: { text: string }[] };
    expect(out.content[0]!.text).toContain('31C');
    expect(out.content[0]!.text).toContain('evil.test');
  });

  it('maps fixture isError to the typed rejection', async () => {
    await expect(callMcp(FIXTURE_MCP_SERVER, 'nope', {}, fixtureMcpFetch)).rejects.toThrow('mcp tool error');
  });
});
