import { buildSessionState } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { readMcpToolHandler, mcpServers, type McpGoogleAuth } from '../src/tools/live/mcp';

// The Drive registry value main relayed for staging (non-secret).
const DRIVE_ENTRY = { name: 'drive', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google', requires: 'drive', allow_tools: ['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content', 'delete_file'], read_tools: ['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content'] };
const SERVERS = JSON.stringify([DRIVE_ENTRY, { name: 'mail', url: 'https://x.googleapis.com/mcp', auth: 'google', requires: 'mail', allow_tools: ['search'], read_tools: ['search'] }, { name: 'plain', url: 'https://mcp.test/rpc', allow_tools: ['get'], read_tools: ['get'] }, { name: 'noallow', url: 'https://mcp.test/rpc2', auth: 'google', requires: 'docs', allow_tools: ['read'] }]);
// No approval is available: the read tool must not need the owner button.
const context = () => ({
  authenticatedUserId: 'owner',
  trigger: 'user_message' as const,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => false,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});
const seen: Array<{ tool: string }> = [];
const auth: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async (_url, tool) => { seen.push({ tool }); return [{ text: 'ok' }]; } };
const run = (server: string, tool: string) => dispatchTool({ id: `r-${server}-${tool}`, name: 'read_mcp_tool', args: { server, tool, args: {} } }, context(), { handlers: [readMcpToolHandler(SERVERS, auth)] });

describe('read_mcp_tool through the real dispatcher', () => {
  it('an allowlisted Drive read runs with no approval and no desk', async () => {
    seen.length = 0;
    expect(await run('drive', 'search_files')).toMatchObject({ ok: true, source_taint: 'external' });
    expect(seen).toEqual([{ tool: 'search_files' }]);
  });

  it('a tool on allow_tools but not on read_tools is refused before any call', async () => {
    seen.length = 0;
    expect(await run('drive', 'delete_file')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(seen).toEqual([]);
  });

  it('a tool off both lists is refused before any call', async () => {
    seen.length = 0;
    expect(await run('drive', 'delete_file')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(seen).toEqual([]);
  });

  it('fails closed for servers that are not read-only Google workspace servers or lack read_tools', async () => {
    seen.length = 0;
    for (const server of ['mail', 'plain', 'noallow']) expect(await run(server, 'search')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(seen).toEqual([]);
  });

  it('unknown server is a typed not_found; a provider failure keeps its real code', async () => {
    expect(await run('nope', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    const boom: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async () => { throw new Error('upstream boom'); } };
    const out = await dispatchTool({ id: 'boom', name: 'read_mcp_tool', args: { server: 'drive', tool: 'search_files', args: {} } }, context(), { handlers: [readMcpToolHandler(SERVERS, boom)] });
    expect(out).toMatchObject({ ok: false, code: 'transient', error: 'upstream boom' });
  });

  it('the staging Drive entry declares exactly the four read tools in read_tools', () => {
    const drive = mcpServers(SERVERS).find((s) => s.name === 'drive');
    expect(drive?.read_tools).toEqual(['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content']);
  });
});
