import { describe, expect, it } from 'vitest';
import { callMcpToolHandler, executeMcp, mcpServers, type McpGoogleAuth } from '../src/tools/live/mcp';
import { GOOGLE_CONSENT_SCOPES, GOOGLE_FEATURE_SCOPES, googleHas, isGoogleFeature } from '../src/connectors/google';
import { connectIntentSchema } from '@waldo/contracts';

const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';
const entry = { name: 'drive', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google', requires: 'drive', allow_tools: ['list_files', 'get_file'] };
const never: McpGoogleAuth = {
  resolve: async () => { throw new Error('auth must not be consulted'); },
  proxy: async () => { throw new Error('proxy must not run'); },
};

describe('Drive read-only MCP slice (source only)', () => {
  it('drive is a read-only feature; legacy and unscoped grants never claim it', () => {
    expect(isGoogleFeature('drive')).toBe(true);
    expect(GOOGLE_FEATURE_SCOPES.drive).toEqual([DRIVE]);
    expect(googleHas([DRIVE], 'drive')).toBe(true);
    expect(googleHas(null, 'drive')).toBe(false);
    expect(googleHas(undefined, 'drive')).toBe(false);
    expect(googleHas(['https://www.googleapis.com/auth/gmail.readonly'], 'drive')).toBe(false);
    expect(googleHas(['https://www.googleapis.com/auth/drive.file'], 'drive')).toBe(false);
  });

  it('consent still does not ask for Drive: the scope change is a separate owner-approved step', () => {
    expect(GOOGLE_CONSENT_SCOPES.some((scope) => scope.includes('drive'))).toBe(false);
  });

  it('connect intent can name drive as the missing feature', () => {
    expect(connectIntentSchema.safeParse({ status: 'auth_required', service: 'google', reason: 'scope_missing', feature: 'drive' }).success).toBe(true);
  });

  it('registry keeps requires and allow_tools, and drops malformed entries', () => {
    const parsed = mcpServers(JSON.stringify([entry, { ...entry, name: 'bad', requires: 'not-a-feature' }, { ...entry, name: 'bad2', allow_tools: 'list_files' }]));
    expect(parsed.map((s) => s.name)).toEqual(['drive']);
    expect(parsed[0]).toMatchObject({ requires: 'drive', allow_tools: ['list_files', 'get_file'] });
  });

  it('a tool outside the allowlist is rejected before auth or network', async () => {
    const [server] = mcpServers(JSON.stringify([entry]));
    await expect(executeMcp(server!, 'delete_file', {}, never, (() => { throw new Error('network'); }) as unknown as typeof fetch))
      .rejects.toMatchObject({ message: expect.stringContaining('not allowed') });
  });

  it('a server that requires a feature but has no allowlist fails closed', async () => {
    const server = { name: 'drive', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'google' as const, requires: 'drive' as const };
    await expect(executeMcp(server, 'list_files', {}, never)).rejects.toMatchObject({ message: expect.stringContaining('allowlist') });
  });

  it('requires is only honoured on google-auth servers', async () => {
    const server = { name: 'x', url: 'https://x.example/mcp', token: 't', requires: 'drive' as const, allow_tools: ['list_files'] };
    await expect(executeMcp(server, 'list_files', {}, never)).rejects.toMatchObject({ message: expect.stringContaining('google') });
  });

  it('the auth resolver is told which feature the server needs', async () => {
    const [server] = mcpServers(JSON.stringify([entry]));
    const seen: unknown[] = [];
    const auth: McpGoogleAuth = {
      resolve: async (_intent, feature) => { seen.push(feature); return { mode: 'proxy', connection: 'c1' }; },
      proxy: async () => [{ text: 'ok' }],
    };
    await executeMcp(server!, 'list_files', {}, auth);
    expect(seen).toEqual(['drive']);
  });

  it('a disallowed tool through the handler is a rejected result with no connect card', async () => {
    const handler = callMcpToolHandler(JSON.stringify([entry]), undefined, never);
    const out = await handler.handle({ server: 'drive', tool: 'delete_file', args: {} }, {} as never);
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.code).toBe('rejected'); expect(out.connect).toBeUndefined(); }
  });
});
