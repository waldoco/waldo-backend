// Runs the real mcp-proxy Edge Function in-process: Deno is stubbed, the Supabase RPCs it calls are an
// in-memory stand-in with the migration's semantics (owner gate, provider filter, compare-and-set,
// claim/release), and every other request goes to the fake MCP world.
import { vi } from 'vitest';
import type { FakeMcpWorld } from './fake-mcp-world';

export const EDGE_ENV = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', WALDO_ROUTER_HMAC_SECRET: 'fixture-router' };
export const WORKER_ENV = { SUPABASE_PROJECT_URL: 'https://edge.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable', WALDO_ROUTER_HMAC_SECRET: 'fixture-router' };

type Row = { id: string; owner: string; provider: 'google' | 'mcp'; account: string; scopes: string[]; secret: string; pins: unknown; status: 'active' | 'failing' | 'revoked'; last_error: string | null };
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const vaultFake = (owners: readonly string[] = ['owner-a', 'owner-b']) => {
  const rows: Row[] = [];
  const clients = new Map<string, { client_id: string; client_auth: string; client_secret: string | null }>();
  const intents = new Map<string, { digest: string; status: 'pending' | 'done'; result?: unknown }>();
  const rpcs: string[] = [];
  let ids = 0;
  const live = (owner: string, id: string, provider: 'mcp' | 'google' = 'mcp') => rows.find((r) => r.id === id && r.owner === owner && r.status !== 'revoked' && r.provider === provider && owners.includes(owner));
  const handlers: Record<string, (a: Record<string, any>) => Promise<unknown> | unknown> = {
    mcp_store: (a) => {
      if (!owners.includes(a.p_do_name) || !a.p_secret || !a.p_pins) return null;
      const account = String(a.p_account).toLowerCase();
      const existing = rows.find((r) => r.owner === a.p_do_name && r.provider === 'mcp' && r.account === account && r.status !== 'revoked');
      if (existing) { Object.assign(existing, { secret: a.p_secret, pins: a.p_pins, scopes: String(a.p_scopes).split(' ').filter(Boolean), status: 'active', last_error: null }); return existing.id; }
      ids += 1;
      const id = `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
      rows.push({ id, owner: a.p_do_name, provider: 'mcp', account, scopes: String(a.p_scopes).split(' ').filter(Boolean), secret: a.p_secret, pins: a.p_pins, status: 'active', last_error: null });
      return id;
    },
    mcp_access: (a) => { const r = live(a.p_do_name, a.p_connection); return r ? [{ secret: r.secret, scopes: r.scopes, pins: r.pins }] : []; },
    mcp_rotate: async (a) => {
      const r = live(a.p_do_name, a.p_connection);
      if (!r || await sha256(r.secret) !== a.p_expect) return false;
      r.secret = a.p_secret; if (a.p_scopes) r.scopes = String(a.p_scopes).split(' ').filter(Boolean); r.status = 'active'; r.last_error = null;
      return true;
    },
    mcp_revoke: (a) => { const r = live(a.p_do_name, a.p_connection); if (!r) return false; r.status = 'revoked'; r.secret = ''; return true; },
    mcp_client_get: (a) => { const c = clients.get(`${a.p_issuer} ${a.p_redirect_uri}`); return c ? [c] : []; },
    mcp_client_put: (a) => { const key = `${a.p_issuer} ${a.p_redirect_uri}`; if (clients.has(key)) return false; clients.set(key, { client_id: a.p_client_id, client_auth: a.p_client_auth, client_secret: a.p_secret ?? null }); return true; },
    proxy_health: (a) => { const r = rows.find((x) => x.id === a.p_connection && x.owner === a.p_do_name && x.status !== 'revoked'); if (!r) return false; r.status = a.p_error ? 'failing' : 'active'; r.last_error = a.p_error || null; return true; },
    proxy_idem_claim: (a) => {
      if (!rows.some((r) => r.id === a.p_connection && r.owner === a.p_do_name && r.status !== 'revoked')) return null;
      const key = `${a.p_do_name}|${a.p_connection}|${a.p_key}`, row = intents.get(key);
      if (!row) { intents.set(key, { digest: a.p_digest, status: 'pending' }); return { state: 'new' }; }
      if (row.digest !== a.p_digest) return { state: 'conflict' };
      return row.status === 'done' ? { state: 'done', result: row.result } : { state: 'pending' };
    },
    proxy_idem_store: (a) => { const row = intents.get(`${a.p_do_name}|${a.p_connection}|${a.p_key}`); if (!row || row.status !== 'pending') return false; row.status = 'done'; row.result = a.p_result; return true; },
    mcp_idem_release: (a) => { const key = `${a.p_do_name}|${a.p_connection}|${a.p_key}`; const row = intents.get(key); if (!row || row.status !== 'pending') return false; intents.delete(key); return true; },
  };
  const answer = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push(fn);
    const handler = handlers[fn];
    if (!handler) throw new Error(`unexpected RPC ${fn}`);
    return Response.json(await handler(args));
  };
  return { rows, clients, intents, rpcs, answer };
};
export type VaultFake = ReturnType<typeof vaultFake>;

let serve: ((request: Request) => Promise<Response>) | undefined;
// Imports the Edge Function once per test file; the module registers its handler through Deno.serve.
export const loadEdge = async () => {
  if (serve) return serve;
  vi.stubGlobal('Deno', { env: { get: (name: string) => (EDGE_ENV as Record<string, string>)[name] }, serve: (handler: typeof serve) => { serve = handler; } });
  await import('../../../../supabase/functions/mcp-proxy/index.ts');
  return serve!;
};

// The global fetch the edge sees: Supabase RPCs go to the Vault fake, everything else to the MCP world.
export const routeEdgeFetch = (vault: VaultFake, world: FakeMcpWorld) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${EDGE_ENV.SUPABASE_URL}/rest/v1/rpc/`)) return vault.answer(url.split('/').at(-1)!, JSON.parse(String(init?.body ?? '{}')));
    return world.fetcher(input, init);
  }));
};

// The fetcher the Worker-side proxy client uses: requests for the function land on the edge handler.
export const workerToEdge = (handler: (request: Request) => Promise<Response>, onCall?: (body: Record<string, unknown>) => void): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url !== `${WORKER_ENV.SUPABASE_PROJECT_URL}/functions/v1/mcp-proxy`) throw new Error(`unexpected worker egress ${request.url}`);
  const body = await request.clone().text();
  onCall?.(JSON.parse(body) as Record<string, unknown>);
  return handler(request);
}) as typeof fetch;
