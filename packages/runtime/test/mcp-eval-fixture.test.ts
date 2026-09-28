import { describe, expect, it } from 'vitest';
import { callMcp } from '../src/tools/live/mcp';
import { FIXTURE_MCP_SERVER, fixtureMcpFetch } from '../evals/fixture-mcp';

// The W7 eval gate's fixture must speak the MCP transport correctly WITHOUT any API key or
// network - this test is the Mac-run-independent proof that eval MCP cases exercise the real
// client protocol path (initialize -> session -> tools/call, isError typed rejection).
describe('eval fixture MCP server', () => {
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
