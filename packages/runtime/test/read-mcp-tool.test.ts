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
  turnId: 'turn-1',
  trigger: 'user_message' as const,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => false,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});
const seen: Array<{ tool: string }> = [];
const intents: Array<string | undefined> = [];
const auth: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async (_url, tool, _args, _conn, intent) => { seen.push({ tool }); intents.push(intent?.id); return [{ text: 'ok' }]; } };
const run = (server: string, tool: string) => dispatchTool({ id: `r-${server}-${tool}`, name: 'read_mcp_tool', args: { server, tool, args: {} } }, context(), { handlers: [readMcpToolHandler(SERVERS, auth)] });

describe('read_mcp_tool through the real dispatcher', () => {
  it('passes a host-derived intent for metadata reads and never one from model args', async () => {
    seen.length = 0; intents.length = 0;
    for (const tool of ['list_recent_files', 'search_files', 'get_file_metadata']) expect(await run('drive', tool)).toMatchObject({ ok: true });
    expect(intents).toHaveLength(3);
    for (const id of intents) expect(id).toMatch(/^mcpread:[0-9a-f]{64}$/);
    expect(new Set(intents).size).toBe(3);
    const withArgIntent = await dispatchTool({ id: 'x', name: 'read_mcp_tool', args: { server: 'drive', tool: 'search_files', args: { intent: { id: 'model-chosen' } } } }, context(), { handlers: [readMcpToolHandler(SERVERS, auth)] });
    expect(withArgIntent).toMatchObject({ ok: true });
    expect(intents[3]).toMatch(/^mcpread:/);
  });

  it('read_file_content stays held and fails closed before any call', async () => {
    seen.length = 0;
    expect(await run('drive', 'read_file_content')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(seen).toEqual([]);
  });

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

  it('the tool description names each read-only server and its exact read tools, and nothing from other servers', () => {
    const handler = readMcpToolHandler(SERVERS, auth);
    expect(handler.description).toContain('"drive"');
    for (const tool of ['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content']) expect(handler.description).toContain(tool);
    expect(handler.description).not.toContain('"mail"');
    expect(handler.description).not.toContain('delete_file');
    expect(readMcpToolHandler(undefined, auth).description).toContain('No read-only MCP servers');
  });

  it('a missing Drive grant yields a fixed, typed reconnect message naming the feature and reason, with no link text', async () => {
    const expired: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } };
    const out = await dispatchTool({ id: 'scope', name: 'read_mcp_tool', args: { server: 'drive', tool: 'list_recent_files', args: {} } }, context(), { handlers: [readMcpToolHandler(SERVERS, expired)] });
    expect(out).toMatchObject({ ok: false, code: 'auth_failed', connect: { status: 'auth_required', service: 'google', reason: 'scope_missing', feature: 'drive' } });
    const error = (out as { error: string }).error;
    expect(error).toContain('drive');
    expect(error).toMatch(/not authorized/);
    expect(error).toMatch(/reconnect/i);
    expect(error).not.toMatch(/https?:/);
    const notConnected = await dispatchTool({ id: 'nc', name: 'read_mcp_tool', args: { server: 'drive', tool: 'list_recent_files', args: {} } }, context(), { handlers: [readMcpToolHandler(SERVERS, { resolve: async () => null, proxy: async () => [] })] });
    expect((notConnected as { error: string }).error).toMatch(/not connected/);
  });
});
