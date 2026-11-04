// A remote MCP server whose authorization server only knows pre-registered confidential clients, shaped
// like Slack's as its public metadata reads: the resource is the origin, no client metadata documents or
// dynamic registration, client_secret_post only, no revocation endpoint, and a token endpoint that answers
// HTTP 200 with an ok flag, a "user" token type and comma-separated scopes under authed_user. Every value
// is synthetic.
export const SLACK_ORIGIN = 'https://mcp.chat.example';
export const SLACK_MCP_URL = `${SLACK_ORIGIN}/mcp`;
export const SLACK_ISSUER = SLACK_ORIGIN;
export const SLACK_TOKEN_ENDPOINT = 'https://chat.example/api/oauth.v2.user.access';
export const SLACK_CLIENT = { id: 'fixture-slack-client', secret: 'fixture-slack-client-secret' } as const;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const fakeSlackMcp = () => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  let serial = 0;
  const codes = new Map<string, string>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const forms: URLSearchParams[] = [];
  const hits: string[] = [];
  const bearers: string[] = [];

  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    forms.push(form);
    if (form.get('client_id') !== SLACK_CLIENT.id) return json({ ok: false, error: 'invalid_client_id' });
    if (form.get('client_secret') !== SLACK_CLIENT.secret) return json({ ok: false, error: 'bad_client_secret' });
    const issue = () => {
      serial += 1;
      access.set(`xoxe.xoxp-${serial}`, clock + 43_200_000);
      refresh.add(`xoxe-1-${serial}`);
      return json({ ok: true, access_token: `xoxe.xoxp-${serial}`, token_type: 'user', expires_in: 43_200, refresh_token: `xoxe-1-${serial}`, authed_user: { id: 'U0FIXTURE', scope: 'search:read.public,channels:history,chat:write' }, team: { id: 'T0FIXTURE' } });
    };
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') ?? '';
      if (!codes.has(code) || codes.get(code) !== form.get('redirect_uri')) return json({ ok: false, error: 'invalid_code' });
      codes.delete(code);
      return issue();
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (!refresh.delete(presented)) return json({ ok: false, error: 'invalid_refresh_token' });
      return issue();
    }
    return json({ ok: false, error: 'invalid_grant_type' });
  };

  const mcp = async (request: Request) => {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const expires = access.get(bearer);
    if (expires === undefined || expires <= clock) return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${SLACK_ORIGIN}/.well-known/oauth-protected-resource"` } });
    bearers.push(bearer);
    const body = await request.json() as { id?: string; method: string; params?: Record<string, unknown> };
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-chat', version: '1' } } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `${String(body.params?.name)} ran` }] } });
    return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search_messages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } });
  };

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    hits.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.href === SLACK_TOKEN_ENDPOINT && request.method === 'POST') return token(request);
    if (url.href === SLACK_MCP_URL && request.method === 'POST') return mcp(request);
    return new Response('blocked in test', { status: 502 });
  }) as typeof fetch;

  return {
    fetcher, forms, hits, bearers,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    // What the owner's browser brings back from the authorization page.
    code: (redirectUri: string) => { serial += 1; const code = `code-${serial}`; codes.set(code, redirectUri); return code; },
    liveRefreshTokens: () => [...refresh],
    // The owner removed the app in the workspace: every refresh token stops working.
    forgetRefreshTokens: () => refresh.clear(),
  };
};
export type FakeSlackMcp = ReturnType<typeof fakeSlackMcp>;
