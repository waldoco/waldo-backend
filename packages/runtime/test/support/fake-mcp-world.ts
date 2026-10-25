// A fake remote MCP server and its OAuth authorization server, answering on the network seam (fetch).
// Behaviour switches let a test turn it hostile: injected descriptions, oversized results, redirects to
// the metadata address, changed tool definitions, a server that goes away, refresh-token rotation and
// reuse detection, revocation, and scope downgrade.
export const MCP_URL = 'https://mcp.example.com/mcp';
export const ISSUER = 'https://auth.example.com';
export const WALDO_ORIGIN = 'https://waldo.example.com';

export type FakeTool = Readonly<{ name: string; description?: string; title?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }>;
export type FakeOptions = {
  era: 'modern' | 'legacy';
  auth: boolean;
  registration: 'cimd' | 'dcr' | 'none';
  issParameter: boolean;
  pkce: boolean;
  tools: FakeTool[];
  accessTtlSeconds: number;
  grantedScope?: string;
  revocation: boolean;
  results: (name: string, args: Record<string, unknown>) => unknown;
  // Where the MCP server answers; the server path stays /mcp.
  origin: string;
  // The authorization server's issuer and origin.
  issuer: string;
};

export const defaultTools: FakeTool[] = [
  { name: 'search_pages', description: 'Search the workspace pages by text.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'create_page', description: 'Create a page with a title and body.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const fakeMcpWorld = (overrides: Partial<FakeOptions> = {}) => {
  const options: FakeOptions = {
    era: 'modern', auth: true, registration: 'cimd', issParameter: true, pkce: true, tools: defaultTools, accessTtlSeconds: 3600, revocation: true,
    results: (name, args) => ({ content: [{ type: 'text', text: `${name} ran with ${JSON.stringify(args)}` }] }),
    origin: new URL(MCP_URL).origin,
    issuer: ISSUER,
    ...overrides,
  };
  const mcpUrl = `${options.origin}/mcp`, metadata = `${options.origin}/.well-known/oauth-protected-resource/mcp`;
  let now = Date.parse('2026-10-21T12:00:00Z');
  const codes = new Map<string, { verifier_challenge: string; resource: string; scope: string; client_id: string; redirect_uri: string }>();
  const access = new Map<string, { expires: number; scope: string }>();
  const refresh = new Map<string, { scope: string; family: string }>();
  const spentRefresh = new Map<string, string>();
  const revokedFamilies = new Set<string>();
  const registered: string[] = [];
  const calls: { method: string; name?: string; headers: Record<string, string>; bearer?: string; body: unknown }[] = [];
  const hits: string[] = [];
  let counter = 0;
  let gone = false;
  let rateLimited = false;
  const issue = (scope: string, family: string) => {
    counter += 1;
    const token = `at_${counter}`, rt = `rt_${counter}`;
    access.set(token, { expires: now + options.accessTtlSeconds * 1000, scope });
    refresh.set(rt, { scope, family });
    return { access_token: token, token_type: 'Bearer', expires_in: options.accessTtlSeconds, refresh_token: rt, scope };
  };
  const challenge = async (verifier: string) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const mcp = async (request: Request): Promise<Response> => {
    if (gone) return new Response('gone', { status: 404 });
    const headers = Object.fromEntries([...request.headers.entries()]);
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
    const body = await request.json() as { id?: string; method: string; params?: Record<string, unknown> };
    calls.push({ method: body.method, name: body.params?.name as string | undefined, headers, ...(bearer ? { bearer } : {}), body });
    if (options.auth) {
      const token = bearer ? access.get(bearer) : undefined;
      if (!token || token.expires <= now) return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadata}", scope="pages:read pages:write"` } });
      const toolName = body.params?.name as string | undefined;
      if (body.method === 'tools/call' && toolName === 'create_page' && !token.scope.split(' ').includes('pages:write')) {
        return new Response('forbidden', { status: 403, headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="pages:write", resource_metadata="${metadata}"` } });
      }
    }
    if (rateLimited) return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
    if (options.era === 'legacy') {
      if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }, 200, { 'mcp-session-id': 'sess-1' });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.headers.get('mcp-session-id') !== 'sess-1') return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: Server not initialized' } }, 400);
    } else if (request.headers.get('mcp-protocol-version') !== '2026-07-28' || request.headers.get('mcp-method') !== body.method) {
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32020, message: 'Header mismatch' } }, 400);
    }
    const reply = (result: unknown) => json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...(result as object) } });
    if (body.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
    if (body.method === 'tools/list') {
      const cursor = body.params?.cursor as string | undefined;
      const page = cursor === 'p2' ? options.tools.slice(50) : options.tools.slice(0, 50);
      return reply({ tools: page.map((tool) => ({ inputSchema: { type: 'object' }, ...tool })), ...(cursor !== 'p2' && options.tools.length > 50 ? { nextCursor: 'p2' } : {}), ttlMs: 300000, cacheScope: 'private' });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name as string, args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      if (!options.tools.some((tool) => tool.name === name)) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      const result = options.results(name, args);
      if (result instanceof Response) return result;
      return reply(result);
    }
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }, 404);
  };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    hits.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === options.origin) {
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return options.auth ? json({ resource: mcpUrl, authorization_servers: [options.issuer], scopes_supported: ['pages:read', 'pages:write'] }) : new Response('no', { status: 404 });
      if (url.pathname === '/mcp') return mcp(request);
      return new Response('not found', { status: 404 });
    }
    if (url.origin === options.issuer) {
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json({
          issuer: options.issuer, authorization_endpoint: `${options.issuer}/authorize`, token_endpoint: `${options.issuer}/token`,
          ...(options.registration === 'dcr' ? { registration_endpoint: `${options.issuer}/register` } : {}),
          ...(options.revocation ? { revocation_endpoint: `${options.issuer}/revoke` } : {}),
          ...(options.pkce ? { code_challenge_methods_supported: ['S256'] } : {}),
          client_id_metadata_document_supported: options.registration === 'cimd',
          authorization_response_iss_parameter_supported: options.issParameter,
          scopes_supported: ['pages:read', 'pages:write', 'offline_access'],
        });
      }
      if (url.pathname === '/register') {
        const body = await request.json() as { redirect_uris?: string[] };
        const id = `dcr-client-${registered.length + 1}`;
        registered.push(id);
        return json({ client_id: id, token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris }, 201);
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams([...(await request.formData()).entries()] as [string, string][]);
        if (form.get('resource') !== mcpUrl) return json({ error: 'invalid_target' }, 400);
        if (form.get('grant_type') === 'authorization_code') {
          const code = codes.get(form.get('code') ?? '');
          if (!code || code.client_id !== form.get('client_id') || code.redirect_uri !== form.get('redirect_uri') || code.verifier_challenge !== await challenge(form.get('code_verifier') ?? '')) return json({ error: 'invalid_grant' }, 400);
          codes.delete(form.get('code') ?? '');
          counter += 1;
          return json(issue(options.grantedScope ?? code.scope, `fam_${counter}`));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const token = form.get('refresh_token') ?? '';
          const row = refresh.get(token);
          // OAuth 2.1 §4.3.1 reuse detection: a spent rotated refresh token revokes the whole family.
          const spent = spentRefresh.get(token);
          if (spent) { revokedFamilies.add(spent); for (const [key, value] of refresh) if (value.family === spent) refresh.delete(key); return json({ error: 'invalid_grant' }, 400); }
          if (!row || revokedFamilies.has(row.family)) return json({ error: 'invalid_grant' }, 400);
          refresh.delete(token);
          spentRefresh.set(token, row.family);
          return json(issue(row.scope, row.family));
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }
      if (url.pathname === '/revoke') {
        const form = new URLSearchParams([...(await request.formData()).entries()] as [string, string][]);
        const token = form.get('token') ?? '';
        const row = refresh.get(token);
        if (row) revokedFamilies.add(row.family);
        refresh.delete(token);
        access.delete(token);
        for (const [key] of access) if (form.get('token_type_hint') === 'refresh_token') access.delete(key);
        return new Response(null, { status: 200 });
      }
    }
    return new Response('blocked in test', { status: 502 });
  };
  return {
    fetcher: fetcher as typeof fetch,
    options,
    calls,
    hits,
    registered,
    // What the owner's browser does at the authorization endpoint: consent, then redirect with code and iss.
    authorize: async (authorizeUrl: string, decision: 'allow' | 'deny' = 'allow', issOverride?: string | null) => {
      const url = new URL(authorizeUrl);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('state', url.searchParams.get('state')!);
      const iss = issOverride === undefined ? (options.issParameter ? options.issuer : null) : issOverride;
      if (iss !== null) back.searchParams.set('iss', iss);
      if (decision === 'deny') { back.searchParams.set('error', 'access_denied'); return back; }
      counter += 1;
      const code = `code_${counter}`;
      codes.set(code, { verifier_challenge: url.searchParams.get('code_challenge')!, resource: url.searchParams.get('resource')!, scope: url.searchParams.get('scope') ?? '', client_id: url.searchParams.get('client_id')!, redirect_uri: url.searchParams.get('redirect_uri')! });
      back.searchParams.set('code', code);
      return back;
    },
    advance: (ms: number) => { now += ms; },
    now: () => now,
    goAway: () => { gone = true; },
    throttle: (on: boolean) => { rateLimited = on; },
    revokedAll: () => revokedFamilies.size > 0,
    liveAccessTokens: () => [...access.entries()].filter(([, row]) => row.expires > now).map(([token]) => token),
  };
};
export type FakeMcpWorld = ReturnType<typeof fakeMcpWorld>;
