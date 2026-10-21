// The owner's MCP connections, held only by the owner's Durable Object: which servers are connected,
// the sign-in attempts in flight, each server's tool definitions with their digests, and which tools the
// owner lets run without asking. Tokens are never here: OAuth servers are called through the mcp-proxy
// Edge Function by connection id. Servers that need no sign-in are called directly, on the same rail.
import { egressTarget, EgressError } from './egress';
import { authorizationUrl, callbackUrl, clientMetadataUrl, discoverAuthorizationServer, discoverProtectedResource, McpOAuthError, pkceChallenge, pkceVerifier, readCallback, registrationMode, requestedScope, type ClientPins, type RegistrationMode } from './mcp-oauth';
import { McpChallenge, McpRpcError, McpServerError, mcpRequest, type McpEra } from './mcp-protocol';
import { McpProxyError, type McpProxy } from './mcp-proxy-client';
import type { McpMethod, McpProxyFailure } from './mcp-proxy-wire';
import { checkArgs, marksReadOnly, parseToolsPage, rankTools, toolDigest, toolHeaders, type McpToolDef } from './mcp-tools';

export const MCP_START_PATH = '/console/mcp/start/';
const ATTEMPT_TTL_MS = 15 * 60_000;
const KEEP_SETTLED_MS = 24 * 60 * 60_000;
// tools/list freshness when the server gives no ttlMs (spec: CacheableResult). A refresh also follows any
// call that names a tool the cache does not have.
const DEFAULT_TOOLS_TTL_MS = 60 * 60_000;
// Pages of tools/list followed per refresh: a bound against a server that pages forever.
const MAX_TOOL_PAGES = 50;
const SEARCH_PAGE = 20;
const DIRECT = { call: { maxBytes: 16 * 1024 * 1024, timeoutMs: 120_000 }, list: { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 } } as const;
// Refresh ahead of the recorded expiry so a call never leaves with a token about to lapse.
const EXPIRY_SKEW_MS = 120_000;

export type McpStatus = 'active' | 'reauth_needed';
export type McpConnectionView = Readonly<{
  id: string;
  name: string;
  host: string;
  server_url: string;
  auth: 'oauth' | 'none';
  registration: RegistrationMode | 'none';
  // Owner-added servers are not reviewed by Waldo: their descriptions are the server's own words.
  risk: 'unreviewed';
  issuer: string | null;
  scopes: readonly string[];
  // Scopes a tool asked for that the grant lacks; a reconnect requests them.
  wants_scopes: readonly string[];
  status: McpStatus;
  tools: number;
  // Definitions the server sent that break MCP's rules (name, schema, header annotations): never offered.
  hidden_tools: number;
  runs_without_asking: number;
  marked_read_only: number;
  tools_changed: boolean;
  connected_at: number;
}>;
export type McpToolCard = Readonly<{
  server: string;
  tool: string;
  title?: string;
  description?: string;
  input_schema: Readonly<Record<string, unknown>>;
  runs: 'without_asking' | 'asks_first';
  server_marks_read_only: boolean;
  digest: string;
}>;

type Attempt = Readonly<{
  server_url: string;
  verifier: string;
  resource: string;
  issuer: string;
  iss_supported: boolean;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  client_id: string;
  client_auth: ClientPins['client_auth'];
  registration: RegistrationMode;
  scope?: string;
}>;
export type ConnectOutcome = Readonly<{ kind: 'linked'; id: string; name: string } | { kind: 'denied' } | { kind: 'expired' } | { kind: 'invalid' } | { kind: 'failed'; reason: string }>;
export type BeginResult = Readonly<{ kind: 'redirect'; path: string } | { kind: 'connected'; id: string; name: string } | { kind: 'already'; id: string; name: string } | { kind: 'failed'; reason: string }>;

// The one shape handlers turn into a tool refusal. cause is safe to show the model; nothing here is a
// token, and server text appears only where the model needs it to correct a call.
export class McpRefusal extends Error {
  constructor(public readonly code: 'not_found' | 'auth_failed' | 'forbidden' | 'invalid_args' | 'rejected' | 'transient' | 'oversize', cause: string) { super(cause); this.name = 'McpRefusal'; }
}

export type McpConnectionsDeps = Readonly<{
  sql: SqlStorage;
  transaction: <T>(work: () => T) => T;
  proxy: McpProxy | null;
  doName: () => string | null;
  origin: () => Promise<string | null>;
  stateSecret?: string;
  fetcher: typeof fetch;
  now: () => number;
  // Server names already taken by deploy-configured MCP servers, so a model-facing name is never ambiguous.
  reserved?: () => readonly string[];
  log?: (entry: Readonly<{ hop: string; ok: boolean; code?: string; ms: number }>) => void;
}>;

type Row = { id: string; name: string; server_url: string; auth: string; registration: string; issuer: string | null; scopes: string; step_up: string; status: string; era: string | null; version: string | null; expires_at: number | null; tools_fetched_at: number | null; tools_ttl_ms: number | null; hidden_tools: number; connected_at: number };

const b64url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const sign = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`mcp-oauth-state:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
};
// The state names the owner object (to route the callback) and a single-use nonce; the MAC lets the
// Worker drop a forged callback before any owner object wakes. The owner name may hold dots.
export const mcpState = async (secret: string, owner: string, nonce: string) => `${owner}.${nonce}.${await sign(secret, `${owner}.${nonce}`)}`;
export const readMcpState = async (secret: string, state: string): Promise<Readonly<{ owner: string; nonce: string }> | null> => {
  const parts = state.split('.');
  if (parts.length < 3) return null;
  const mac = parts.at(-1)!, nonce = parts.at(-2)!, owner = parts.slice(0, -2).join('.');
  if (!owner || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
  return (await sign(secret, `${owner}.${nonce}`)) === mac ? { owner, nonce } : null;
};

// A short name the model uses for the server, from its host: mcp.notion.com becomes notion.
const nameFor = (host: string, taken: ReadonlySet<string>) => {
  const labels = host.split('.').filter(Boolean);
  const meaningful = labels.slice(0, -1).filter((label) => !['mcp', 'api', 'www', 'server', 'servers'].includes(label));
  const base = (meaningful.at(-1) ?? labels[0] ?? 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32) || 'server';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
};

const proxyCause = (failure: McpProxyFailure, server: string): McpRefusal => {
  switch (failure.code) {
    case 'reauth_needed': case 'token_failed': return new McpRefusal('auth_failed', `The sign-in for ${server} is no longer valid. Ask the owner to reconnect ${server} in Connections on their Waldo console (send_console_link sends it).`);
    case 'scope_missing': return new McpRefusal('auth_failed', `${server} needs more access for this tool${failure.scope ? ` (${failure.scope})` : ''}. Ask the owner to reconnect ${server} in Connections on their Waldo console and grant it.`);
    case 'connection_unavailable': return new McpRefusal('not_found', `${server} is no longer connected.`);
    case 'not_found': return new McpRefusal('not_found', `${server} did not answer at its address: the server may have moved or shut down. The owner can reconnect it in Connections.`);
    case 'rate_limited': return new McpRefusal('transient', `${server} is rate limiting requests${failure.retry_after === undefined ? '' : `; it asked to wait ${failure.retry_after} s`}.`);
    case 'unavailable': return new McpRefusal('transient', `${server} could not be reached or failed for a passing reason${failure.retry_after === undefined ? '' : `; it asked to wait ${failure.retry_after} s`}.`);
    case 'egress_oversize': return new McpRefusal('oversize', `${server} returned more data than Waldo reads in one call. Narrow the request (smaller page, fewer items) and call again.`);
    case 'rpc_error': return new McpRefusal('rejected', `${server} refused the call${failure.rpc_code === undefined ? '' : ` (error ${failure.rpc_code})`}: ${failure.message ?? 'no detail'}`);
    case 'intent_pending': case 'intent_unavailable': return new McpRefusal('transient', `The outcome of this ${server} call is unknown; nothing was run again.`);
    case 'intent_conflict': return new McpRefusal('rejected', `This approval was already used for a different ${server} call.`);
    case 'egress_refused': return new McpRefusal('forbidden', `${server} pointed Waldo at an address it does not reach.`);
    default: return new McpRefusal('transient', `${server} could not be used right now.`);
  }
};
const directCause = (error: unknown, server: string): McpRefusal => {
  if (error instanceof McpRefusal) return error;
  if (error instanceof McpChallenge) return proxyCause({ code: error.status === 401 ? 'reauth_needed' : 'scope_missing' }, server);
  if (error instanceof McpServerError) return proxyCause({ code: error.kind === 'rate_limited' ? 'rate_limited' : error.kind === 'not_found' ? 'not_found' : error.kind === 'unavailable' ? 'unavailable' : 'unavailable', ...(error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) }, server);
  if (error instanceof McpRpcError) return proxyCause({ code: 'rpc_error', rpc_code: error.code, message: error.message.slice(0, 500) }, server);
  if (error instanceof EgressError) return proxyCause({ code: error.code === 'egress_oversize' ? 'egress_oversize' : error.code === 'egress_network' || error.code === 'egress_timeout' ? 'unavailable' : 'egress_refused' }, server);
  if (error instanceof McpProxyError) return proxyCause(error.failure, server);
  return new McpRefusal('transient', `${server} could not be used right now.`);
};

// One refresh per connection at a time inside this owner object, the one retry owner for its tokens.
const REFRESHING = new WeakMap<object, Map<string, Promise<void>>>();

export const mcpConnections = (deps: McpConnectionsDeps) => {
  const { sql } = deps;
  sql.exec(`CREATE TABLE IF NOT EXISTS mcp_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, server_url TEXT NOT NULL, auth TEXT NOT NULL, registration TEXT NOT NULL,
    issuer TEXT, scopes TEXT NOT NULL DEFAULT '', step_up TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, era TEXT, version TEXT, expires_at INTEGER, tools_fetched_at INTEGER, tools_ttl_ms INTEGER,
    hidden_tools INTEGER NOT NULL DEFAULT 0, connected_at INTEGER NOT NULL)`);
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_tools (connection TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, digest TEXT NOT NULL, def TEXT NOT NULL, PRIMARY KEY (connection, name))');
  // A permission is for one tool definition: a changed definition no longer matches and asks again.
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_tool_reads (connection TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (connection, name))');
  sql.exec('CREATE TABLE IF NOT EXISTS mcp_attempts (nonce TEXT PRIMARY KEY, record TEXT NOT NULL, expires INTEGER NOT NULL, started INTEGER NOT NULL DEFAULT 0, settled TEXT, settled_at INTEGER)');
  const refreshing = REFRESHING.get(sql) ?? new Map<string, Promise<void>>();
  REFRESHING.set(sql, refreshing);
  const log = (hop: string, started: number, code?: string) => deps.log?.({ hop, ok: code === undefined, ...(code === undefined ? {} : { code }), ms: deps.now() - started });

  const rows = () => sql.exec<Row>('SELECT * FROM mcp_connections ORDER BY connected_at, id').toArray();
  const row = (id: string) => sql.exec<Row>('SELECT * FROM mcp_connections WHERE id = ?', id).toArray()[0];
  const byName = (name: string) => sql.exec<Row>('SELECT * FROM mcp_connections WHERE name = ?', name).toArray()[0];
  const toolRows = (connection: string) => sql.exec<{ name: string; digest: string; def: string }>('SELECT name, digest, def FROM mcp_tools WHERE connection = ? ORDER BY position', connection).toArray();
  const reads = (connection: string) => new Map(sql.exec<{ name: string; digest: string }>('SELECT name, digest FROM mcp_tool_reads WHERE connection = ?', connection).toArray().map((r) => [r.name, r.digest]));
  const update = (id: string, fields: Partial<Row>) => {
    const keys = Object.keys(fields);
    if (keys.length) sql.exec(`UPDATE mcp_connections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (fields as Record<string, unknown>)[k] as string | number | null), id);
  };

  const view = (r: Row): McpConnectionView => {
    const tools = toolRows(r.id), granted = reads(r.id);
    const defs = tools.map((t) => ({ ...t, def: JSON.parse(t.def) as McpToolDef }));
    return {
      id: r.id, name: r.name, host: new URL(r.server_url).hostname, server_url: r.server_url, auth: r.auth as 'oauth' | 'none', registration: r.registration as RegistrationMode | 'none',
      risk: 'unreviewed', issuer: r.issuer, scopes: r.scopes.split(' ').filter(Boolean), wants_scopes: r.step_up.split(' ').filter(Boolean), status: r.status as McpStatus,
      tools: tools.length, hidden_tools: r.hidden_tools, runs_without_asking: defs.filter((t) => granted.get(t.name) === t.digest).length, marked_read_only: defs.filter((t) => marksReadOnly(t.def)).length,
      tools_changed: [...granted].some(([name, digest]) => !tools.some((t) => t.name === name && t.digest === digest)), connected_at: r.connected_at,
    };
  };

  // OAuth servers go through the edge; a refresh runs once per connection however many calls need it.
  // seen is the token version the failing call used: when another call already replaced it, the edge
  // returns the newer token instead of spending the refresh token again.
  const refresh = async (r: Row, seen: string | null): Promise<void> => {
    const pending = refreshing.get(r.id);
    if (pending) return pending;
    const run = (async () => {
      const started = deps.now(), doName = deps.doName();
      if (!deps.proxy || !doName) throw new McpRefusal('transient', 'Connected servers are not reachable on this Waldo right now.');
      try {
        const out = await deps.proxy.refresh(doName, r.id, seen ?? undefined);
        update(r.id, { version: out.version, expires_at: out.expires_at ?? null, scopes: out.scopes.join(' '), status: 'active' });
        log('mcp_refresh', started);
      } catch (error) {
        const code = error instanceof McpProxyError ? error.failure.code : 'unavailable';
        if (code === 'reauth_needed' || code === 'connection_unavailable') update(r.id, { status: 'reauth_needed' });
        log('mcp_refresh', started, code);
        throw directCause(error, r.name);
      }
    })().finally(() => refreshing.delete(r.id));
    refreshing.set(r.id, run);
    return run;
  };

  const send = async (r: Row, method: McpMethod, params: Record<string, unknown>, options: Readonly<{ headers?: Record<string, string>; intentId?: string }> = {}): Promise<unknown> => {
    if (r.auth === 'none') {
      const out = await mcpRequest(deps.fetcher, { url: r.server_url, pinned: [new URL(r.server_url).origin], ...(r.era ? { era: r.era as McpEra } : {}) }, method, params, method === 'tools/call' ? DIRECT.call : DIRECT.list, options.headers).catch((error: unknown) => { throw directCause(error, r.name); });
      if (out.era !== r.era) update(r.id, { era: out.era });
      return out.result;
    }
    const doName = deps.doName();
    if (!deps.proxy || !doName) throw new McpRefusal('transient', 'Connected servers are not reachable on this Waldo right now.');
    const current = () => {
      const now = row(r.id);
      if (!now) throw new McpRefusal('not_found', `${r.name} is no longer connected, so nothing ran.`);
      return now;
    };
    const attempt = async (at: Row) => {
      const out = await deps.proxy!.call(doName, at.id, method, params, { ...(at.era ? { era: at.era as McpEra } : {}), ...(options.headers ? { headers: options.headers } : {}), ...(options.intentId ? { intentId: options.intentId } : {}) });
      update(at.id, { era: out.era, version: out.version, status: 'active' });
      return out.result;
    };
    const failed = (error: unknown) => {
      // The server asked for scopes the grant lacks: kept so the owner's reconnect asks for them too.
      if (error instanceof McpProxyError && error.failure.code === 'scope_missing' && error.failure.scope) {
        const now = row(r.id);
        if (now) update(r.id, { step_up: [...new Set([...now.step_up.split(' '), ...error.failure.scope.split(' ')].filter(Boolean))].join(' ') });
      }
      return directCause(error, r.name);
    };
    if (r.expires_at !== null && r.expires_at - EXPIRY_SKEW_MS <= deps.now()) await refresh(r, r.version);
    const first = current();
    try {
      return await attempt(first);
    } catch (error) {
      const code = error instanceof McpProxyError ? error.failure.code : undefined;
      // An expired or refused access token gets one refresh and one retry; anything else is the answer.
      if (code !== 'token_expired' && code !== 'reauth_needed') throw failed(error);
      await refresh(first, first.version);
      return attempt(current()).catch((retry: unknown) => {
        if (retry instanceof McpProxyError && retry.failure.code === 'reauth_needed') update(r.id, { status: 'reauth_needed' });
        throw failed(retry);
      });
    }
  };

  // Reads the whole tool list and keeps every valid definition with its digest; definitions that break
  // the spec's rules are counted, never offered.
  const refreshTools = async (r: Row): Promise<void> => {
    const started = deps.now();
    const tools: McpToolDef[] = [], seen = new Set<string>();
    let cursor: string | undefined, ttl: number | undefined, hidden = 0;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      let parsed: ReturnType<typeof parseToolsPage>;
      try { parsed = parseToolsPage(await send(r, 'tools/list', cursor ? { cursor } : {})); } catch (error) {
        log('mcp_tools', started, error instanceof McpRefusal ? error.code : 'malformed');
        throw error instanceof McpRefusal ? error : new McpRefusal('rejected', `${r.name} sent a tool list Waldo cannot read.`);
      }
      ttl ??= parsed.ttlMs;
      hidden += parsed.dropped.length;
      for (const tool of parsed.tools) if (seen.has(tool.name)) hidden += 1; else { seen.add(tool.name); tools.push(tool); }
      if (!parsed.nextCursor || parsed.nextCursor === cursor) break;
      cursor = parsed.nextCursor;
    }
    const digests = await Promise.all(tools.map(toolDigest));
    deps.transaction(() => {
      sql.exec('DELETE FROM mcp_tools WHERE connection = ?', r.id);
      tools.forEach((tool, index) => sql.exec('INSERT INTO mcp_tools (connection, name, position, digest, def) VALUES (?, ?, ?, ?, ?)', r.id, tool.name, index, digests[index]!, JSON.stringify(tool)));
      update(r.id, { tools_fetched_at: deps.now(), tools_ttl_ms: ttl ?? DEFAULT_TOOLS_TTL_MS, hidden_tools: hidden });
    });
    log('mcp_tools', started);
  };
  const freshTools = async (r: Row) => {
    if (r.tools_fetched_at === null || deps.now() - r.tools_fetched_at > (r.tools_ttl_ms ?? DEFAULT_TOOLS_TTL_MS)) await refreshTools(r);
  };
  const toolOf = (r: Row, name: string) => {
    const t = toolRows(r.id).find((tool) => tool.name === name);
    return t ? { def: JSON.parse(t.def) as McpToolDef, digest: t.digest } : undefined;
  };

  const live = (name: string): Row => {
    const r = byName(name);
    if (!r) {
      const names = rows().map((x) => x.name);
      throw new McpRefusal('not_found', names.length ? `No connected MCP server is named "${name}". Connected: ${names.join(', ')}.` : 'The owner has no MCP servers connected. They connect one in Connections on their Waldo console (send_console_link sends it).');
    }
    if (r.status === 'reauth_needed') throw proxyCause({ code: 'reauth_needed' }, r.name);
    return r;
  };

  const settle = (nonce: string, outcome: ConnectOutcome) => sql.exec('UPDATE mcp_attempts SET settled = ?, settled_at = ? WHERE nonce = ?', JSON.stringify(outcome), deps.now(), nonce);
  const sweep = () => sql.exec('DELETE FROM mcp_attempts WHERE (settled IS NULL AND expires < ?) OR (settled_at IS NOT NULL AND settled_at < ?)', deps.now() - KEEP_SETTLED_MS, deps.now() - KEEP_SETTLED_MS);

  const store = (input: Readonly<{ id: string; server_url: string; auth: 'oauth' | 'none'; registration: RegistrationMode | 'none'; issuer: string | null; scopes: readonly string[]; expires_at?: number; version?: string; era?: McpEra }>): Row => {
    const existing = row(input.id) ?? rows().find((r) => r.server_url === input.server_url);
    if (existing && existing.id !== input.id) deps.transaction(() => {
      // Reconnecting the same server under a new grant keeps its name and the owner's choices.
      sql.exec('UPDATE mcp_tools SET connection = ? WHERE connection = ?', input.id, existing.id);
      sql.exec('UPDATE mcp_tool_reads SET connection = ? WHERE connection = ?', input.id, existing.id);
      sql.exec('UPDATE mcp_connections SET id = ? WHERE id = ?', input.id, existing.id);
    });
    const name = existing?.name ?? nameFor(new URL(input.server_url).hostname, new Set([...rows().map((r) => r.name), ...(deps.reserved?.() ?? [])]));
    sql.exec(`INSERT INTO mcp_connections (id, name, server_url, auth, registration, issuer, scopes, status, era, version, expires_at, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET server_url = excluded.server_url, auth = excluded.auth, registration = excluded.registration, issuer = excluded.issuer, scopes = excluded.scopes, step_up = '', status = 'active', version = excluded.version, expires_at = excluded.expires_at`,
    input.id, name, input.server_url, input.auth, input.registration, input.issuer, input.scopes.join(' '), input.era ?? null, input.version ?? null, input.expires_at ?? null, existing?.connected_at ?? deps.now());
    return row(input.id)!;
  };

  const forget = (id: string) => deps.transaction(() => {
    sql.exec('DELETE FROM mcp_tools WHERE connection = ?', id);
    sql.exec('DELETE FROM mcp_tool_reads WHERE connection = ?', id);
    sql.exec('DELETE FROM mcp_connections WHERE id = ?', id);
  });

  return {
    list: (): readonly McpConnectionView[] => rows().map(view),
    hasActive: (): boolean => rows().some((r) => r.status === 'active'),

    // Discovery for a server URL the owner typed on the connect page. Nothing here holds a secret.
    async begin(raw: string): Promise<BeginResult> {
      const started = deps.now();
      let url: URL;
      try { url = egressTarget(raw.trim()); } catch (error) { return { kind: 'failed', reason: error instanceof EgressError ? error.code : 'egress_malformed' }; }
      if (url.search) return { kind: 'failed', reason: 'query_string' };
      const serverUrl = url.toString();
      const kept = rows().find((r) => r.server_url === serverUrl && r.status === 'active' && !r.step_up);
      if (kept) return { kind: 'already', id: kept.id, name: kept.name };
      const origin = await deps.origin();
      if (!origin) return { kind: 'failed', reason: 'origin_unknown' };
      let challenge: McpChallenge['challenge'];
      try {
        const probe = await mcpRequest(deps.fetcher, { url: serverUrl, pinned: [url.origin] }, 'tools/list', {}, DIRECT.list);
        // No sign-in needed: the server answered a tools/list without credentials.
        const r = store({ id: crypto.randomUUID(), server_url: serverUrl, auth: 'none', registration: 'none', issuer: null, scopes: [], era: probe.era });
        await refreshTools(r).catch(() => undefined);
        log('mcp_connect', started);
        return { kind: 'connected', id: r.id, name: r.name };
      } catch (error) {
        if (!(error instanceof McpChallenge) || error.status !== 401) { log('mcp_connect', started, 'probe_failed'); return { kind: 'failed', reason: error instanceof EgressError ? error.code : error instanceof McpServerError ? `server_${error.kind}` : 'probe_failed' }; }
        challenge = error.challenge;
      }
      if (!deps.proxy || !deps.stateSecret || !deps.doName()) return { kind: 'failed', reason: 'oauth_unavailable' };
      try {
        const resource = await discoverProtectedResource(deps.fetcher, serverUrl, challenge.resourceMetadata);
        const issuer = resource.authorization_servers[0]!;
        const server = await discoverAuthorizationServer(deps.fetcher, issuer);
        const mode = registrationMode(server, false);
        const client = mode === 'cimd' ? { client_id: clientMetadataUrl(origin), client_auth: 'none' as const }
          : await deps.proxy.register({ issuer, registrationEndpoint: server.registration_endpoint!, redirectUri: callbackUrl(origin), origin });
        const previous = rows().find((r) => r.server_url === serverUrl);
        const scope = requestedScope(challenge.scope, resource, server, previous ? [...previous.scopes.split(' '), ...previous.step_up.split(' ')].filter(Boolean) : []);
        const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const attempt: Attempt = {
          server_url: serverUrl, verifier: pkceVerifier(), resource: resource.resource, issuer, iss_supported: server.iss_parameter_supported,
          authorization_endpoint: server.authorization_endpoint, token_endpoint: server.token_endpoint, ...(server.revocation_endpoint ? { revocation_endpoint: server.revocation_endpoint } : {}),
          client_id: client.client_id, client_auth: client.client_auth, registration: mode, ...(scope ? { scope } : {}),
        };
        sweep();
        sql.exec('INSERT INTO mcp_attempts (nonce, record, expires) VALUES (?, ?, ?)', nonce, JSON.stringify(attempt), deps.now() + ATTEMPT_TTL_MS);
        log('mcp_connect', started);
        return { kind: 'redirect', path: `${MCP_START_PATH}${nonce}` };
      } catch (error) {
        const reason = error instanceof McpOAuthError ? error.code : error instanceof EgressError ? error.code : error instanceof McpProxyError ? error.failure.code : 'discovery_failed';
        log('mcp_connect', started, reason);
        return { kind: 'failed', reason };
      }
    },

    // The owner, signed in to the console, follows the start link once; it redirects to the provider.
    async start(nonce: string): Promise<string | null> {
      const doName = deps.doName();
      if (!deps.stateSecret || !doName || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
      const found = sql.exec<{ record: string; expires: number; started: number; settled: string | null }>('SELECT record, expires, started, settled FROM mcp_attempts WHERE nonce = ?', nonce).toArray()[0];
      if (!found || found.started || found.settled || found.expires < deps.now()) return null;
      sql.exec('UPDATE mcp_attempts SET started = 1 WHERE nonce = ?', nonce);
      const attempt = JSON.parse(found.record) as Attempt, origin = await deps.origin();
      if (!origin) return null;
      const server = { issuer: attempt.issuer, authorization_endpoint: attempt.authorization_endpoint, token_endpoint: attempt.token_endpoint, client_id_metadata_document_supported: attempt.registration === 'cimd', iss_parameter_supported: attempt.iss_supported };
      return authorizationUrl(server, { clientId: attempt.client_id, redirectUri: callbackUrl(origin), state: await mcpState(deps.stateSecret, doName, nonce), challenge: await pkceChallenge(attempt.verifier), resource: attempt.resource, ...(attempt.scope ? { scope: attempt.scope } : {}) });
    },

    // The provider's redirect back. Settles the attempt once; a reload replays the recorded outcome.
    async finish(nonce: string, params: URLSearchParams): Promise<ConnectOutcome> {
      const started = deps.now();
      const found = sql.exec<{ record: string; expires: number; started: number; settled: string | null }>('SELECT record, expires, started, settled FROM mcp_attempts WHERE nonce = ?', nonce).toArray()[0];
      if (!found || !found.started) return { kind: 'invalid' };
      if (found.settled) return JSON.parse(found.settled) as ConnectOutcome;
      if (found.expires < deps.now()) { settle(nonce, { kind: 'expired' }); return { kind: 'expired' }; }
      const attempt = JSON.parse(found.record) as Attempt;
      const callback = readCallback(params, attempt.issuer, attempt.iss_supported);
      if (!callback.ok) { const outcome: ConnectOutcome = callback.reason === 'denied' ? { kind: 'denied' } : { kind: 'failed', reason: callback.reason }; settle(nonce, outcome); log('mcp_consent', started, callback.reason); return outcome; }
      const doName = deps.doName(), origin = await deps.origin();
      if (!deps.proxy || !doName || !origin) { const outcome: ConnectOutcome = { kind: 'failed', reason: 'oauth_unavailable' }; settle(nonce, outcome); return outcome; }
      // Settled before the exchange: the code is single-use, so a second callback must never redeem it.
      settle(nonce, { kind: 'failed', reason: 'exchange_unconfirmed' });
      const pins: ClientPins = { server_url: attempt.server_url, resource: attempt.resource, issuer: attempt.issuer, token_endpoint: attempt.token_endpoint, ...(attempt.revocation_endpoint ? { revocation_endpoint: attempt.revocation_endpoint } : {}), client_id: attempt.client_id, client_auth: attempt.client_auth, redirect_uri: callbackUrl(origin) };
      try {
        const exchanged = await deps.proxy.exchange(doName, pins, callback.code, attempt.verifier, attempt.scope);
        const r = store({ id: exchanged.id, server_url: attempt.server_url, auth: 'oauth', registration: attempt.registration, issuer: attempt.issuer, scopes: exchanged.scopes, version: exchanged.version, ...(exchanged.expires_at === undefined ? {} : { expires_at: exchanged.expires_at }) });
        await refreshTools(r).catch(() => undefined);
        const outcome: ConnectOutcome = { kind: 'linked', id: r.id, name: r.name };
        settle(nonce, outcome);
        log('mcp_consent', started);
        return outcome;
      } catch (error) {
        const outcome: ConnectOutcome = { kind: 'failed', reason: error instanceof McpProxyError ? error.failure.code : 'exchange_failed' };
        settle(nonce, outcome);
        log('mcp_consent', started, outcome.reason);
        return outcome;
      }
    },

    // Revokes at the provider through the edge, then forgets the server. When the edge cannot be
    // reached nothing changes, so the owner can try again; a grant the edge no longer holds is just forgotten.
    async disconnect(id: string): Promise<Readonly<{ ok: boolean; provider: 'revoked' | 'unsupported' | 'failed' | 'not_needed' }>> {
      const r = row(id);
      if (!r) return { ok: false, provider: 'not_needed' };
      if (r.auth === 'none') { forget(id); return { ok: true, provider: 'not_needed' }; }
      const doName = deps.doName();
      if (!deps.proxy || !doName) return { ok: false, provider: 'failed' };
      try {
        const out = await deps.proxy.revoke(doName, id);
        forget(id);
        return { ok: true, provider: out.provider };
      } catch (error) {
        if (error instanceof McpProxyError && error.failure.code === 'connection_unavailable') { forget(id); return { ok: true, provider: 'not_needed' }; }
        return { ok: false, provider: 'failed' };
      }
    },

    // The owner's choice, for the tool definitions as they are now.
    async setRuns(id: string, tool: string | 'marked_read_only', withoutAsking: boolean): Promise<boolean> {
      const r = row(id);
      if (!r) return false;
      const tools = toolRows(r.id).map((t) => ({ ...t, def: JSON.parse(t.def) as McpToolDef }));
      const targets = tool === 'marked_read_only' ? tools.filter((t) => marksReadOnly(t.def)) : tools.filter((t) => t.name === tool);
      if (!targets.length && tool !== 'marked_read_only') return false;
      deps.transaction(() => {
        for (const t of targets) {
          if (withoutAsking) sql.exec('INSERT INTO mcp_tool_reads (connection, name, digest, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT (connection, name) DO UPDATE SET digest = excluded.digest, granted_at = excluded.granted_at', r.id, t.name, t.digest, deps.now());
          else sql.exec('DELETE FROM mcp_tool_reads WHERE connection = ? AND name = ?', r.id, t.name);
        }
        if (!withoutAsking && tool === 'marked_read_only') sql.exec('DELETE FROM mcp_tool_reads WHERE connection = ?', r.id);
      });
      return true;
    },

    toolsOf(id: string): readonly McpToolCard[] {
      const r = row(id);
      if (!r) return [];
      const granted = reads(r.id);
      return toolRows(r.id).map((t) => { const def = JSON.parse(t.def) as McpToolDef; return card(r, def, t.digest, granted); });
    },

    // The model's search over the owner's tools: words, or one server's full list, a page at a time.
    async search(input: Readonly<{ query?: string; server?: string; cursor?: string }>): Promise<Readonly<{ tools: readonly McpToolCard[]; next_cursor?: string; servers: readonly Readonly<{ name: string; status: McpStatus; tools: number }>[]; unmatched?: true; failures: readonly string[] }>> {
      const targets = input.server ? [live(input.server)] : rows().filter((r) => r.status === 'active');
      const failures: string[] = [];
      await Promise.all(targets.map((r) => freshTools(r).catch((error: unknown) => { failures.push(`${r.name}: ${directCause(error, r.name).message}`); })));
      const items = targets.flatMap((r) => { const granted = reads(r.id); return toolRows(r.id).map((t) => ({ def: JSON.parse(t.def) as McpToolDef, r, digest: t.digest, granted })); });
      const ranked = rankTools(items, input.query);
      const pool = ranked.length || !input.query ? ranked : items;
      const offset = input.cursor && /^\d{1,6}$/.test(input.cursor) ? Number(input.cursor) : 0;
      const page = pool.slice(offset, offset + SEARCH_PAGE);
      return {
        tools: page.map((item) => card(item.r, item.def, item.digest, item.granted)),
        ...(offset + SEARCH_PAGE < pool.length ? { next_cursor: String(offset + SEARCH_PAGE) } : {}),
        servers: rows().map((r) => ({ name: r.name, status: r.status as McpStatus, tools: toolRows(r.id).length })),
        ...(input.query && !ranked.length && items.length ? { unmatched: true as const } : {}),
        failures,
      };
    },

    // The definition a card freezes: its digest, and whether the owner lets it run without asking.
    async describe(server: string, tool: string): Promise<Readonly<{ connection: string; def: McpToolDef; digest: string; runs: 'without_asking' | 'asks_first' }>> {
      const r = live(server);
      await freshTools(r).catch(() => undefined);
      let found = toolOf(r, tool);
      if (!found) { await refreshTools(r).catch(() => undefined); found = toolOf(r, tool); }
      if (!found) throw new McpRefusal('not_found', `${r.name} has no tool named "${tool}". Use search_mcp_tools to find the right name.`);
      return { connection: r.id, def: found.def, digest: found.digest, runs: reads(r.id).get(tool) === found.digest ? 'without_asking' : 'asks_first' };
    },

    // Runs one tool. read: only a tool the owner lets run without asking, at the definition they allowed.
    // approved: a card the owner approved, at the definition the card froze, once per intent.
    async invoke(input: Readonly<{ server: string; tool: string; args: Readonly<Record<string, unknown>>; mode: 'read' } | { connection: string; tool: string; args: Readonly<Record<string, unknown>>; mode: 'approved'; digest: string; intentId: string }>): Promise<Readonly<{ server: string; result: unknown }>> {
      const started = deps.now();
      const r = input.mode === 'read' ? live(input.server) : row(input.connection);
      if (!r) throw new McpRefusal('not_found', 'That server is no longer connected, so nothing ran.');
      if (r.status === 'reauth_needed') throw proxyCause({ code: 'reauth_needed' }, r.name);
      try {
        let found = toolOf(r, input.tool);
        if (!found && input.mode === 'read') { await refreshTools(r).catch(() => undefined); found = toolOf(r, input.tool); }
        if (!found) throw new McpRefusal('not_found', `${r.name} has no tool named "${input.tool}" now. Use search_mcp_tools to find the right name.`);
        if (input.mode === 'read' && reads(r.id).get(input.tool) !== found.digest) {
          throw new McpRefusal('forbidden', `${r.name}'s ${input.tool} asks the owner first${reads(r.id).has(input.tool) ? ' (its definition changed since the owner allowed it)' : ''}. Call call_mcp_tool with the same server, tool and args; the owner gets a card.`);
        }
        if (input.mode === 'approved' && found.digest !== input.digest) throw new McpRefusal('rejected', `${r.name} changed ${input.tool} after the owner approved it, so nothing ran. Look at the tool again and propose it anew.`);
        const problem = checkArgs(found.def, input.args);
        if (problem) throw new McpRefusal('invalid_args', `${input.tool}: ${problem}.`);
        const result = await send(r, 'tools/call', { name: input.tool, arguments: input.args }, { headers: toolHeaders(found.def, input.args), ...(input.mode === 'approved' ? { intentId: input.intentId } : {}) });
        log('mcp_call', started);
        return { server: r.name, result };
      } catch (error) {
        const refusal = directCause(error, r.name);
        log('mcp_call', started, refusal.code);
        throw refusal;
      }
    },
  };
};
export type McpConnections = ReturnType<typeof mcpConnections>;

const card = (r: Readonly<{ name: string }>, def: McpToolDef, digest: string, granted: ReadonlyMap<string, string>): McpToolCard => ({
  server: r.name, tool: def.name, ...(def.title ? { title: def.title } : {}), ...(def.description ? { description: def.description } : {}),
  input_schema: def.inputSchema, runs: granted.get(def.name) === digest ? 'without_asking' : 'asks_first', server_marks_read_only: marksReadOnly(def), digest,
});
