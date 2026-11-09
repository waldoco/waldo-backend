import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_FEATURE_SCOPES } from '../src/connectors/google';
import { MCP_CATALOGUE } from '../src/connectors/mcp-catalogue';
import { connectorsLine, googleConnectionFacts, RECONNECT_NOTE, type McpConnectionView } from '../src/connectors/mcp-connections';
import { executeMcp } from '../src/tools/live/mcp';

const view = (name: string, status: McpConnectionView['status']): McpConnectionView => ({
  id: `id-${name}`, name, host: `mcp.${name}.example`, server_url: `https://mcp.${name}.example/mcp`, auth: 'oauth', registration: 'cimd', risk: 'unreviewed', issuer: 'https://auth.example',
  scopes: ['read'], wants_scopes: [], status, tools: 3, hidden_tools: 0, tools_capped: false, runs_without_asking: 1, marked_read_only: 1, tools_changed: false, connected_at: 1,
});

describe('MCP connector entries and the per-turn host fact', () => {
  it('says what each catalogue connection holds in Waldo\'s own words, and nothing a server wrote', () => {
    const linear = MCP_CATALOGUE.find((entry) => entry.id === 'linear')!;
    const official: McpConnectionView = { ...view('Linear', 'active'), server_url: linear.url, issuer: linear.issuer };
    const line = connectorsLine([official, view('notes', 'active')]);
    expect(line).toContain(linear.about);
    expect(line).toContain('notes');
    // An owner-added server is unreviewed: only Waldo's name for it, never a description.
    for (const entry of MCP_CATALOGUE) if (entry.id !== 'linear') expect(line).not.toContain(entry.about);
  });

  it('marks a server that needs reconnecting, and drops what it holds until then', () => {
    const linear = MCP_CATALOGUE.find((entry) => entry.id === 'linear')!;
    const dead: McpConnectionView = { ...view('Linear', 'reauth_needed'), server_url: linear.url, issuer: linear.issuer };
    const line = connectorsLine([dead]);
    expect(line).toContain(RECONNECT_NOTE);
    expect(line).not.toContain(linear.about);
  });

  it('names each connected Google account with what its grant reaches, or that it needs reconnecting', () => {
    const scopes = [...GOOGLE_FEATURE_SCOPES.mail, ...GOOGLE_FEATURE_SCOPES.calendar];
    const facts = googleConnectionFacts([{ id: 'g1', email: 'me@work.example', scopes }, { id: 'g2', email: 'me@home.example', scopes }], { g2: 'invalid_grant' });
    expect(facts).toEqual([
      { email: 'me@work.example', features: expect.arrayContaining(['mail', 'calendar']), reconnect: false },
      { email: 'me@home.example', features: [], reconnect: true },
    ]);
    expect(facts[0]!.features).not.toContain('drive');
    const line = connectorsLine([], facts);
    expect(line).toContain('me@work.example');
    expect(line).toContain('mail');
    expect(line).toContain('me@home.example');
    expect(line).toContain(RECONNECT_NOTE);
  });

  it('is empty when nothing is connected', () => {
    expect(connectorsLine([])).toBe('');
    expect(connectorsLine([], [])).toBe('');
  });

  it('refuses a deploy-config server on a private address before any request', async () => {
    const fetcher = vi.fn();
    await expect(executeMcp({ name: 'internal', url: 'https://10.0.0.5/mcp' }, 'get', {}, undefined, fetcher as unknown as typeof fetch)).rejects.toThrow('has an address Waldo does not reach');
    await expect(executeMcp({ name: 'plain', url: 'http://mcp.example.com/mcp' }, 'get', {}, undefined, fetcher as unknown as typeof fetch)).rejects.toThrow('has an address Waldo does not reach');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
