import { describe, expect, it, vi } from 'vitest';
import { googleProxy } from '../src/connectors/connections';
import { GOOGLE_REVOKE_URL, revokeGoogleGrant } from '../src/connectors/google';
import { REQUEST_TIMEOUT_MS } from '../src/identity/request-timeout';

const TOKEN = '1//synthetic-refresh-token';
const google = (status: number, body: unknown = {}) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

describe('revoking a Google grant at Google', () => {
  it('posts the token in a form body to the revocation endpoint, never in the URL, and reads 200 as revoked', async () => {
    const fetcher = google(200);
    expect(await revokeGoogleGrant(fetcher as unknown as typeof fetch, TOKEN)).toBe('revoked');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_REVOKE_URL);
    expect(GOOGLE_REVOKE_URL).toBe('https://oauth2.googleapis.com/revoke');
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(init.body)).get('token')).toBe(TOKEN);
  });

  it('reads invalid_token as a grant that was already dead, which is what a lapsed Testing-mode grant answers', async () => {
    expect(await revokeGoogleGrant(google(400, { error: 'invalid_token', error_description: 'Token expired or revoked' }) as unknown as typeof fetch, TOKEN)).toBe('already_invalid');
  });

  it.each([
    ['another 400 error', google(400, { error: 'invalid_request' })],
    ['a 400 with no JSON', google(400, 'Bad Request')],
    ['a server error', google(503, { error: 'backend_error' })],
    ['a rate limit', google(429, {})],
    ['a lost connection', vi.fn(async () => { throw new TypeError(`error sending request for url (${GOOGLE_REVOKE_URL})`); })],
  ])('reads %s as failed', async (_case, fetcher) => {
    expect(await revokeGoogleGrant(fetcher as unknown as typeof fetch, TOKEN)).toBe('failed');
  });

  // A revocation is best effort and a disconnect waits on it, so an answer that never comes is a failed one, and the request is cut.
  it('reads no answer within the request bound as failed, and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn((_url: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => undefined); });
      const outcome = revokeGoogleGrant(fetcher as unknown as typeof fetch, TOKEN);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      expect(await outcome).toBe('failed');
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('asks nothing of Google for an empty token', async () => {
    const fetcher = google(200);
    expect(await revokeGoogleGrant(fetcher as unknown as typeof fetch, '')).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the Worker side of a disconnect', () => {
  const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
  // The connector-proxy answers the revoke op; the signed RPC deletes the row's Vault secret. gmail_push_route lists every live
  // Google connection for the mailbox, across owners: by default only this one.
  const world = (edge: (body: Record<string, unknown>) => Response | Promise<Response>, deleted: unknown = true, holders: () => Response = () => Response.json([{ do_name: 'owner', connection: 'conn-1' }])) => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://db.test/rest/v1/rpc/gmail_push_route') { calls.push(`rpc:gmail_push_route:${String((JSON.parse(String(init?.body)) as { p_account?: unknown }).p_account)}`); return holders(); }
      if (url === 'https://db.test/functions/v1/connector-proxy') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(`edge:${String(body.op)}`);
        return edge(body);
      }
      if (url === 'https://db.test/rest/v1/rpc/connection_revoke') { calls.push('rpc:connection_revoke'); return deleted instanceof Response ? deleted : Response.json(deleted); }
      throw new Error(`unexpected ${url}`);
    });
    return { proxy: googleProxy(env, fetcher as unknown as typeof fetch)!, calls, fetcher };
  };

  it('asks the edge to revoke at Google first, then deletes the secret, and reports both', async () => {
    const w = world(body => Response.json(body.op === 'revoke' && body.connection === 'conn-1' && body.do_name === 'owner' ? { data: { provider: 'revoked' } } : { error: { status: 404, message: 'unknown operation' } }));
    expect(await w.proxy.revoke('owner', 'conn-1', 'Owner@Example.test')).toEqual({ removed: true, google: 'revoked' });
    expect(w.calls).toEqual(['rpc:gmail_push_route:owner@example.test', 'edge:revoke', 'rpc:connection_revoke']);
  });

  // Google's revocation ends Waldo's whole authorization for that Google user, so it would end every other owner's grant on
  // the same mailbox. While another owner holds it, or when that cannot be told, Google is not asked; the delete still runs.
  it.each([
    ['another owner holds the same mailbox', () => Response.json([{ do_name: 'owner', connection: 'conn-1' }, { do_name: 'other-owner', connection: 'conn-9' }]), 'shared'],
    ['the lookup fails', () => new Response('down', { status: 503 }), 'unavailable'],
    // A lookup that does not list this connection does not describe this grant, so it cannot say the mailbox is unshared.
    ['the lookup lists no live connection for the mailbox', () => Response.json([]), 'unavailable'],
    ['the lookup lists only another owner\'s connection', () => Response.json([{ do_name: 'other-owner', connection: 'conn-9' }]), 'unavailable'],
    ['the lookup answers something else', () => Response.json({ rows: 'unexpected' }), 'unavailable'],
  ] as const)('when %s, Google is not asked and the secret is still deleted', async (_case, holders, google) => {
    const w = world(() => Response.json({ data: { provider: 'revoked' } }), true, holders);
    expect(await w.proxy.revoke('owner', 'conn-1', 'owner@example.test')).toEqual({ removed: true, google });
    expect(w.calls).toEqual(['rpc:gmail_push_route:owner@example.test', 'rpc:connection_revoke']);
  });

  it.each([
    ['Google refused', () => Response.json({ data: { provider: 'failed' } }), 'failed'],
    ['the grant was already dead', () => Response.json({ data: { provider: 'already_invalid' } }), 'already_invalid'],
    ['the edge holds no live secret', () => Response.json({ data: { provider: 'not_held' } }), 'not_held'],
    ['an edge that predates the op', () => Response.json({ error: { status: 404, message: 'unknown operation' } }), 'unavailable'],
    ['an edge answering something else', () => Response.json({ data: { provider: 'gone, token=1//leak' } }), 'unavailable'],
    ['an edge that cannot be reached', () => { throw new TypeError('network down'); }, 'unavailable'],
    ['an edge that answers no JSON', () => new Response('<html>', { status: 502 }), 'unavailable'],
  ] as const)('when %s, the secret is still deleted and the outcome says so', async (_case, edge, google) => {
    const w = world(edge);
    expect(await w.proxy.revoke('owner', 'conn-1', 'Owner@Example.test')).toEqual({ removed: true, google });
    expect(w.calls.at(-1)).toBe('rpc:connection_revoke');
  });

  it('an edge that never answers the revoke is unavailable once the request bound passes, and the secret is still deleted', async () => {
    vi.useFakeTimers();
    try {
      const w = world(() => new Promise<Response>(() => undefined));
      const result = w.proxy.revoke('owner', 'conn-1', 'owner@example.test');
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      expect(await result).toEqual({ removed: true, google: 'unavailable' });
      expect(w.calls).toEqual(['rpc:gmail_push_route:owner@example.test', 'edge:revoke', 'rpc:connection_revoke']);
    } finally { vi.useRealTimers(); }
  });

  it('a delete the database refuses fails the disconnect, whatever Google said', async () => {
    const w = world(() => Response.json({ data: { provider: 'revoked' } }), new Response('down', { status: 503 }));
    await expect(w.proxy.revoke('owner', 'conn-1', 'Owner@Example.test')).rejects.toThrow();
    expect(w.calls).toEqual(['rpc:gmail_push_route:owner@example.test', 'edge:revoke', 'rpc:connection_revoke']);
  });

  it('a row the database had already revoked reports removed: false', async () => {
    const w = world(() => Response.json({ data: { provider: 'not_held' } }), false);
    expect(await w.proxy.revoke('owner', 'conn-1', 'Owner@Example.test')).toEqual({ removed: false, google: 'not_held' });
  });
});
