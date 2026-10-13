import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { callMcpToolHandler, executeMcp, mcpServers, readMcpToolHandler, type McpGoogleAuth } from '../src/tools/live/mcp';
import { GOOGLE_MCP_READ_ONLY, GOOGLE_MCP_SERVERS, GOOGLE_MCP_UNAVAILABLE } from '../src/connectors/google-mcp';

const GMAIL = 'https://gmailmcp.googleapis.com/mcp/v1';
const CALENDAR = 'https://calendarmcp.googleapis.com/mcp/v1';
const DRIVE = 'https://drivemcp.googleapis.com/mcp/v1';
const registry = JSON.stringify([
  { name: 'gmail', url: GMAIL, auth: 'google', requires: 'mail' },
  { name: 'calendar', url: CALENDAR, auth: 'google', requires: 'calendar' },
  { name: 'drive', url: DRIVE, auth: 'google', requires: 'drive', allow_tools: ['search_files', 'read_file_content'], read_tools: ['search_files', 'read_file_content'] },
  { name: 'chat', url: 'https://chatmcp.googleapis.com/mcp/v1', auth: 'google' },
  { name: 'docs', url: 'https://docsmcp.googleapis.com/mcp/v1', auth: 'google' },
  { name: 'sheets', url: 'https://sheetsmcp.googleapis.com/mcp/v1', auth: 'google' },
  { name: 'slides', url: 'https://slidesmcp.googleapis.com/mcp/v1', auth: 'google' },
  { name: 'workspace', url: 'https://workspacemcp.googleapis.com/mcp/v1', auth: 'google' },
  { name: 'people', url: 'https://people.googleapis.com/mcp/v1', auth: 'google' },
]);
const server = (name: string) => mcpServers(registry).find((s) => s.name === name)!;

const WRITES: ReadonlyArray<readonly [string, string]> = [
  ['gmail', 'create_draft'], ['gmail', 'label_thread'], ['gmail', 'label_message'], ['gmail', 'unlabel_thread'], ['gmail', 'unlabel_message'], ['gmail', 'send_message'],
  ['calendar', 'create_event'], ['calendar', 'update_event'], ['calendar', 'delete_event'], ['calendar', 'respond_to_event'],
  ['drive', 'read_file_content'], ['drive', 'create_file'], ['drive', 'copy_file'], ['drive', 'download_file_content'], ['chat', 'list_messages'], ['gmail', 'some_future_tool'],
  ['gmail', 'trash_thread'], ['gmail', 'mark_thread_spam'], ['gmail', 'create_label'], ['gmail', 'update_message_labels'],
  ['docs', 'update_doc'], ['sheets', 'update_values'], ['sheets', 'update_formulas'], ['sheets', 'insert_dimension'], ['sheets', 'update_spreadsheet'], ['slides', 'update_presentation'], ['slides', 'read_slide_page_thumbnail'],
  ['workspace', 'search_corpus'], ['people', 'search_contacts'],
];
const READS: ReadonlyArray<readonly [string, string]> = [
  ['gmail', 'search_threads'], ['gmail', 'get_thread'], ['gmail', 'get_message'], ['gmail', 'list_drafts'], ['gmail', 'list_labels'],
  ['calendar', 'list_events'], ['calendar', 'get_event'], ['calendar', 'list_calendars'], ['calendar', 'search_events'], ['calendar', 'suggest_time'],
  ['drive', 'search_files'], ['gmail', 'get_draft'],
  ['docs', 'read_doc'], ['sheets', 'get_spreadsheet'], ['sheets', 'get_values'], ['slides', 'read_presentation'], ['slides', 'read_slide_page'],
];

const untouchable = () => {
  const seen = { resolve: 0, proxy: 0, fetch: 0 };
  const auth: McpGoogleAuth = {
    resolve: async () => { seen.resolve += 1; return { mode: 'bearer', token: 'ya29.never' }; },
    proxy: async () => { seen.proxy += 1; return []; },
  };
  const fetcher = (async () => { seen.fetch += 1; throw new Error('network must not be reached'); }) as unknown as typeof fetch;
  return { seen, auth, fetcher };
};

// Speaks the Streamable HTTP handshake for any Google MCP host and records what each request carried.
const googleFake = (status = 200) => {
  const calls: Array<{ url: string; authorization: string | null; method?: string; tool?: string; args?: Record<string, unknown> }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), method: body.method, tool: body.params?.name, args: body.params?.arguments });
    if (status !== 200) return new Response('{}', { status });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'synthetic' }] } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe('Google MCP servers are read-only by construction', () => {
  it.each(WRITES)('%s.%s is refused before auth, network or the approval desk', async (name, tool) => {
    const { seen, auth, fetcher } = untouchable();
    await expect(executeMcp(server(name), tool, {}, auth, fetcher)).rejects.toMatchObject({ message: expect.stringContaining(GOOGLE_MCP_READ_ONLY) });
    const desk = { proposeMcpCall: vi.fn(async () => 'card') };
    const out = await callMcpToolHandler(registry, desk, auth).handle({ server: name, tool, args: {} }, {} as never);
    expect(out).toMatchObject({ ok: false, code: 'forbidden', source_taint: 'external' });
    if (!out.ok) { expect(out.error).toContain(GOOGLE_MCP_READ_ONLY); expect(out.connect).toBeUndefined(); }
    expect(desk.proposeMcpCall).not.toHaveBeenCalled();
    expect(seen).toEqual({ resolve: 0, proxy: 0, fetch: 0 });
  });

  it('a raw config entry that was never parsed is still refused on a Google host', async () => {
    const { seen, auth, fetcher } = untouchable();
    await expect(executeMcp({ name: 'g', url: GMAIL, auth: 'google', allow_tools: ['create_draft'] }, 'create_draft', {}, auth, fetcher)).rejects.toMatchObject({ message: expect.stringContaining(GOOGLE_MCP_READ_ONLY) });
    await expect(executeMcp({ name: 'g', url: 'https://x.googleapis.com/mcp', token: 'static' }, 'anything', {}, auth, fetcher)).rejects.toMatchObject({ message: expect.stringContaining(GOOGLE_MCP_READ_ONLY) });
    expect(seen).toEqual({ resolve: 0, proxy: 0, fetch: 0 });
  });

  it('deploy config can narrow a Google server but never widen it or change its grant feature', () => {
    const parsed = mcpServers(JSON.stringify([{ name: 'gmail', url: GMAIL, auth: 'google', requires: 'drive', allow_tools: ['search_threads', 'create_draft'], read_tools: ['search_threads', 'create_draft'] }]));
    expect(parsed[0]).toMatchObject({ auth: 'google', requires: 'mail', allow_tools: ['search_threads'], read_tools: ['search_threads'] });
    expect(server('gmail')).toMatchObject({ requires: 'mail', allow_tools: GOOGLE_MCP_SERVERS[0]!.read_tools });
  });

  it.each(READS)('%s.%s runs with a bearer minted for that call', async (name, tool) => {
    const { calls, fetcher } = googleFake();
    const minted: unknown[] = [];
    let n = 0;
    const auth: McpGoogleAuth = { resolve: async (_intent, feature) => { minted.push(feature); n += 1; return { mode: 'bearer', token: `ya29.call-${n}` }; }, proxy: async () => { throw new Error('bearer mode'); } };
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    try {
      await executeMcp(server(name), tool, { q: 'x' }, auth, fetcher);
      await executeMcp(server(name), tool, { q: 'x' }, auth, fetcher);
      expect(minted).toEqual([server(name).requires, server(name).requires]);
      expect(calls.filter((c) => c.method === 'tools/call').map((c) => [c.url, c.tool, c.authorization])).toEqual([[server(name).url, tool, 'Bearer ya29.call-1'], [server(name).url, tool, 'Bearer ya29.call-2']]);
      for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain('ya29.');
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });

  it('a read goes owner-button-free on read_mcp_tool, and only Drive gets its fixed arguments', async () => {
    const sent: Array<{ url: string; tool: string; args: Record<string, unknown>; intent?: { id: string; readOnly?: boolean } }> = [];
    const auth: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async (url, tool, args, _c, intent) => { sent.push({ url, tool, args, ...(intent ? { intent } : {}) }); return [{ type: 'text', text: 'ok' }]; } };
    const handler = readMcpToolHandler(registry, auth, true);
    expect(handler.eligible?.()).toEqual({ ok: true });
    expect(handler.description).toContain('server "gmail": search_threads, get_thread, get_message, list_drafts, get_draft, list_labels');
    expect(handler.description).toContain('server "sheets": get_spreadsheet, get_values');
    expect(handler.description).toContain('server "calendar": list_events, get_event, list_calendars, search_events, suggest_time');
    expect(handler.description).toContain('server "drive": search_files');
    expect(handler.description).not.toContain('read_file_content');
    expect(handler.description).not.toContain('chat');
    expect(handler.description).not.toContain('search_corpus');
    const ctx = { authenticatedUserId: 'owner', turnId: 't1', toolCallId: 'c1' } as never;
    expect(await handler.handle({ server: 'gmail', tool: 'get_thread', args: { id: 'th' } }, ctx)).toMatchObject({ ok: true, source_taint: 'external' });
    expect(await handler.handle({ server: 'drive', tool: 'search_files', args: { query: 'q', excludeContentSnippets: false } }, ctx)).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ url: GMAIL, tool: 'get_thread', args: { id: 'th' }, intent: { readOnly: true } });
    expect(sent[0]!.args).not.toHaveProperty('excludeContentSnippets');
    expect(sent[0]!.intent!.id).toMatch(/^mcpread:[0-9a-f]{64}$/);
    expect(sent[1]!.args).toEqual({ query: 'q', excludeContentSnippets: true });
    expect(await handler.handle({ server: 'gmail', tool: 'create_draft', args: {} }, ctx)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(sent).toHaveLength(2);
  });

  it('the fixed arguments land on the effect rail too, so an approved call cannot drop them', async () => {
    const sent: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const auth: McpGoogleAuth = { resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async (_url, tool, args) => { sent.push({ tool, args }); return [{ type: 'text', text: 'ok' }]; } };
    await executeMcp(server('drive'), 'search_files', { query: 'q', excludeContentSnippets: false }, auth, fetch, { id: 'approval:mcp' });
    await executeMcp(server('gmail'), 'get_thread', { id: 'th' }, auth, fetch, { id: 'approval:mcp' });
    expect(sent).toEqual([{ tool: 'search_files', args: { query: 'q', excludeContentSnippets: true } }, { tool: 'get_thread', args: { id: 'th' } }]);
  });
});

describe('a preview that is not available reads as not available, never an error that degrades the turn', () => {
  const unavailable = (out: Awaited<ReturnType<ReturnType<typeof callMcpToolHandler>['handle']>>) => {
    expect(out).toMatchObject({ ok: false, code: 'not_found', source_taint: 'external' });
    if (!out.ok) { expect(out.error).toContain(GOOGLE_MCP_UNAVAILABLE); expect(out.connect).toBeUndefined(); }
  };
  const bearer: McpGoogleAuth = { resolve: async () => ({ mode: 'bearer', token: 'ya29.t' }), proxy: async () => { throw new Error('bearer mode'); } };
  const proxyFailing = (status: number, message: string): McpGoogleAuth => ({ resolve: async () => ({ mode: 'proxy', connection: 'c1' }), proxy: async () => { throw Object.assign(new Error(message), { status }); } });
  const ctx = { authenticatedUserId: 'owner', turnId: 't1', toolCallId: 'c1' } as never;

  it.each([403, 404])('a Google %i on a direct call', async (status) => {
    const { fetcher } = googleFake(status);
    await expect(executeMcp(server('gmail'), 'search_threads', {}, bearer, fetcher)).rejects.toMatchObject({ message: expect.stringContaining(GOOGLE_MCP_UNAVAILABLE) });
  });

  it.each([[403, 'google_scope_missing'], [404, 'mcp_read_unavailable']])('a Google %i through the edge (%s)', async (status, message) => {
    unavailable(await readMcpToolHandler(registry, proxyFailing(status, message), true).handle({ server: 'calendar', tool: 'suggest_time', args: {} }, ctx));
  });

  it('the edge finding the grant without the scope is still a scope gap with a connect card', async () => {
    const out = await readMcpToolHandler(registry, proxyFailing(403, 'insufficient scopes'), true).handle({ server: 'gmail', tool: 'search_threads', args: {} }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'scope_missing', feature: 'mail' } });
  });

  it('a 401 still asks the owner to reconnect', async () => {
    const out = await readMcpToolHandler(registry, proxyFailing(401, 'google_reauth_needed'), true).handle({ server: 'gmail', tool: 'search_threads', args: {} }, ctx);
    expect(out).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'reauth_needed' } });
  });
});

describe('staging only', () => {
  // The test pool loads the top-level (production) block of wrangler.jsonc; staging lives under env.staging.
  it('production config names no MCP server and keeps button-free reads off', () => {
    const production = env as { WALDO_ENVIRONMENT?: string; WALDO_MCP_SERVERS?: string; MCP_READ_INTENTS?: string };
    expect(production.WALDO_ENVIRONMENT).toBe('production');
    expect(production.WALDO_MCP_SERVERS).toBeUndefined();
    expect(production.MCP_READ_INTENTS).toBe('0');
  });
});
