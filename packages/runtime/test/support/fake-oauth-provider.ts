// A synthetic OAuth provider with an HTTP API, shaped like the health providers the oauth-proxy holds:
// a pre-issued confidential client (client_secret_post), no PKCE, single-use rotating refresh tokens, a
// refresh that must name a scope, an account read, paged records and an access-revoke endpoint. Every
// value is synthetic.
export const PROVIDER_ORIGIN = 'https://api.fixture-health.example';
export const PROVIDER_API = `${PROVIDER_ORIGIN}/developer/v2/`;
export const PROVIDER_CLIENT = { id: 'fixture-client', secret: 'fixture-client-secret' } as const;
export const PROVIDER_ACCOUNT = 1001;

type Options = Readonly<{ omitRefreshOnRotate?: boolean }>;

export const fakeOAuthProvider = (options: Options = {}) => {
  let clock = Date.UTC(2026, 9, 21, 9, 0, 0);
  let serial = 0;
  let access: { token: string; expires: number } | null = null;
  const refresh = { current: null as string | null, spent: new Set<string>() };
  const hits: string[] = [];
  const forms: URLSearchParams[] = [];
  let throttled = false;
  let revoked = false;

  const issue = (withRefresh: boolean) => {
    serial += 1;
    access = { token: `pat_${serial}`, expires: clock + 3_600_000 };
    if (refresh.current) refresh.spent.add(refresh.current);
    refresh.current = withRefresh ? `prt_${serial}` : null;
    return Response.json({ access_token: access.token, token_type: 'bearer', expires_in: 3600, scope: 'offline read:sleep', ...(refresh.current ? { refresh_token: refresh.current } : {}) });
  };
  const authorized = (request: Request) => access !== null && !revoked && request.headers.get('authorization') === `Bearer ${access.token}` && access.expires > clock;

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    hits.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin !== PROVIDER_ORIGIN) return new Response('unknown host', { status: 404 });
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
      forms.push(form);
      if (form.get('client_id') !== PROVIDER_CLIENT.id || form.get('client_secret') !== PROVIDER_CLIENT.secret) return Response.json({ error: 'invalid_client' }, { status: 401 });
      if (form.get('grant_type') === 'authorization_code') return form.get('code') === 'fixture-code' ? issue(true) : Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (form.get('grant_type') === 'refresh_token') {
        const presented = form.get('refresh_token');
        if (form.get('scope') !== 'offline' || !presented || presented !== refresh.current || refresh.spent.has(presented)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return issue(!options.omitRefreshOnRotate);
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    if (!url.pathname.startsWith('/developer/v2/')) return new Response(null, { status: 404 });
    if (throttled) return new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '42', 'x-private-detail': 'not for the DO' } });
    if (!authorized(request)) return new Response(null, { status: 401 });
    const path = url.pathname.slice('/developer/v2/'.length);
    if (path === 'user/profile/basic' && request.method === 'GET') return Response.json({ user_id: PROVIDER_ACCOUNT });
    if (path === 'activity/sleep' && request.method === 'GET') {
      const next = url.searchParams.get('nextToken');
      return Response.json(next ? { records: [{ id: 'sleep-2' }], next_token: null } : { records: [{ id: 'sleep-1' }], next_token: 'page-2' });
    }
    if (path === 'user/access' && request.method === 'DELETE') { revoked = true; return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return {
    fetcher, hits, forms,
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    throttle: (on: boolean) => { throttled = on; },
    // A refresh landed elsewhere: the stored token is now stale at the provider.
    spentRefreshTokens: () => [...refresh.spent],
    currentRefreshToken: () => refresh.current,
    revoked: () => revoked,
  };
};
export type FakeOAuthProvider = ReturnType<typeof fakeOAuthProvider>;
