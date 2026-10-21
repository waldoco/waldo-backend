// MCP proxy for owner-connected servers: the only place their OAuth tokens are read, refreshed, used or
// revoked. The owner's Durable Object sends a router-signed operation with a connection id; tokens, client
// secrets and codes never travel back. Every request goes to an endpoint pinned when the owner connected.
import { exchangeCode, refreshTokens, registerClient, revokeToken, TokenEndpointError, type ClientPins, type TokenSet } from '../../../packages/runtime/src/connectors/mcp-oauth.ts';
import { McpChallenge, McpRpcError, McpServerError, mcpRequest, type McpEra } from '../../../packages/runtime/src/connectors/mcp-protocol.ts';
import { EgressError } from '../../../packages/runtime/src/connectors/egress.ts';
import { MCP_PROXY_SIGNATURE_TAG, parseMcpProxyRequest, type McpProxyCode, type McpProxyFailure, type McpProxyRequest } from '../../../packages/runtime/src/connectors/mcp-proxy-wire.ts';
import { proxyIntentDigest } from '../../../packages/runtime/src/connectors/proxy-intent.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };

const env = (name: string) => Deno.env.get(name) ?? '';
const url = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY'), router = env('WALDO_ROUTER_HMAC_SECRET');
// Refresh this long before the recorded expiry, so a call never leaves with a token about to lapse.
const EXPIRY_SKEW_MS = 120_000;
// Resource bounds sized for real work: a long tool run, a large document or an image in a result.
const LIMITS = { 'tools/call': { maxBytes: 16 * 1024 * 1024, timeoutMs: 120_000 }, 'tools/list': { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 }, 'server/discover': { maxBytes: 256 * 1024, timeoutMs: 15_000 } } as const;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hmac = async (message: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(router), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
};
const same = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

type Bundle = Readonly<{ access_token: string; refresh_token?: string; expires_at?: number }>;
class Refusal extends Error {
  constructor(public readonly failure: McpProxyFailure) { super(failure.code); }
}
const refuse = (code: McpProxyCode, extra: Omit<McpProxyFailure, 'code'> = {}): never => { throw new Refusal({ code, ...extra }); };

const db = async (fn: string, args: Record<string, unknown>) => {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: service, authorization: `Bearer ${service}`, 'content-profile': 'waldo', 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`db ${fn} ${response.status}`);
  return response.json();
};
const version = async (secret: string) => (await sha256(secret)).slice(0, 16);
// Scope tokens only (RFC 6749 §3.3 charset), so a server's challenge cannot carry prose to the model.
const scopeTokens = (scope: string | undefined) => scope?.split(/\s+/).filter((token) => /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(token)).slice(0, 50).join(' ') || undefined;

type Grant = Readonly<{ secret: string; bundle: Bundle; scopes: readonly string[]; pins: ClientPins }>;
const grant = async (doName: string, connection: string): Promise<Grant> => {
  const rows = await db('mcp_access', { p_do_name: doName, p_connection: connection }) as { secret?: unknown; scopes?: unknown; pins?: unknown }[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row.secret !== 'string' || !row.pins || typeof row.pins !== 'object') return refuse('connection_unavailable');
  let bundle: Bundle;
  try { bundle = JSON.parse(row.secret) as Bundle; } catch { return refuse('connection_unavailable'); }
  if (typeof bundle.access_token !== 'string') return refuse('connection_unavailable');
  return { secret: row.secret, bundle, scopes: Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [], pins: row.pins as ClientPins };
};
const clientSecret = async (pins: ClientPins): Promise<string | undefined> => {
  if (pins.client_auth === 'none') return undefined;
  const rows = await db('mcp_client_get', { p_issuer: pins.issuer, p_redirect_uri: pins.redirect_uri }) as { client_id?: unknown; client_secret?: unknown }[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || row.client_id !== pins.client_id || typeof row.client_secret !== 'string') return refuse('token_failed');
  return row.client_secret;
};
const health = (doName: string, connection: string, error: string) => db('proxy_health', { p_do_name: doName, p_connection: connection, p_error: error }).catch(() => undefined);
const bundleOf = (tokens: TokenSet, previous?: Bundle): Bundle => ({
  access_token: tokens.access_token,
  ...(tokens.refresh_token ?? previous?.refresh_token ? { refresh_token: tokens.refresh_token ?? previous!.refresh_token } : {}),
  ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }),
});
const tokenRefusal = (error: unknown): never => {
  if (error instanceof Refusal) throw error;
  if (error instanceof TokenEndpointError) return error.kind === 'auth' ? refuse('reauth_needed') : error.kind === 'transient' ? refuse('unavailable', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : refuse('token_failed');
  return refuse('token_failed');
};

// The MCP server's answer, reduced to codes the runtime acts on. Server text crosses only as the
// JSON-RPC error message, bounded, for the model to correct its call; it is never logged.
const mcpRefusal = (error: unknown): never => {
  if (error instanceof Refusal) throw error;
  if (error instanceof McpChallenge) return error.status === 401 ? refuse('reauth_needed') : error.challenge.error === 'insufficient_scope' ? refuse('scope_missing', scopeTokens(error.challenge.scope) ? { scope: scopeTokens(error.challenge.scope)! } : {}) : refuse('scope_missing');
  if (error instanceof McpServerError) return error.kind === 'rate_limited' ? refuse('rate_limited', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : error.kind === 'not_found' ? refuse('not_found') : error.kind === 'unavailable' ? refuse('unavailable', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : refuse('protocol');
  if (error instanceof McpRpcError) return refuse('rpc_error', { rpc_code: error.code, message: error.message.slice(0, 500) });
  if (error instanceof EgressError) return error.code === 'egress_oversize' ? refuse('egress_oversize') : error.code === 'egress_network' || error.code === 'egress_timeout' ? refuse('unavailable') : refuse('egress_refused');
  return refuse('unavailable');
};
// A write the server provably did not run: an auth challenge, a rate limit, a refused redirect or a target
// the rail refused before sending. Only then is the pending claim released for the one retry.
const notApplied = (error: unknown) => error instanceof McpChallenge || (error instanceof McpServerError && error.kind === 'rate_limited')
  || (error instanceof EgressError && !['egress_oversize', 'egress_network', 'egress_timeout'].includes(error.code));

const handle = async (body: McpProxyRequest): Promise<unknown> => {
  switch (body.op) {
    case 'register': {
      const read = async () => {
        const rows = await db('mcp_client_get', { p_issuer: body.issuer, p_redirect_uri: body.redirect_uri }) as { client_id?: unknown; client_auth?: unknown }[];
        const row = Array.isArray(rows) ? rows[0] : undefined;
        return row && typeof row.client_id === 'string' ? { client_id: row.client_id, client_auth: row.client_auth } : null;
      };
      const kept = await read();
      if (kept) return kept;
      let registration;
      try { registration = await registerClient(fetch, body.registration_endpoint, body.origin); } catch { return refuse('registration_refused'); }
      await db('mcp_client_put', { p_issuer: body.issuer, p_redirect_uri: body.redirect_uri, p_client_id: registration.client_id, p_client_auth: registration.client_auth, p_secret: registration.client_secret ?? null });
      return (await read()) ?? refuse('registration_refused');
    }
    case 'exchange': {
      const secret = await clientSecret(body.pins);
      const tokens = await exchangeCode(fetch, body.pins, { code: body.code, verifier: body.verifier, redirectUri: body.pins.redirect_uri }, secret, Date.now()).catch(tokenRefusal);
      const stored = JSON.stringify(bundleOf(tokens));
      // RFC 6749 §5.1: without a scope in the response, the grant covers what was requested.
      const scopes = (tokens.scope ?? body.scope)?.split(/\s+/).filter(Boolean) ?? [];
      const id = await db('mcp_store', { p_do_name: body.do_name, p_account: `${body.pins.issuer} ${body.pins.resource}`, p_scopes: scopes.join(' '), p_pins: body.pins, p_secret: stored }) as string | null;
      if (!id) return refuse('connection_unavailable');
      return { id, scopes, ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }), version: await version(stored) };
    }
    case 'refresh': {
      const current = await grant(body.do_name, body.connection);
      const seen = await version(current.secret);
      const fresh = current.bundle.expires_at === undefined || current.bundle.expires_at - EXPIRY_SKEW_MS > Date.now();
      // Another refresh already landed since the caller last looked: use it, never spend a rotated token twice.
      if (body.version !== undefined && body.version !== seen && fresh) return { scopes: current.scopes, ...(current.bundle.expires_at === undefined ? {} : { expires_at: current.bundle.expires_at }), version: seen, refreshed: false };
      if (!current.bundle.refresh_token) { await health(body.do_name, body.connection, 'mcp_reauth_needed'); return refuse('reauth_needed'); }
      const tokens = await refreshTokens(fetch, current.pins, current.bundle.refresh_token, await clientSecret(current.pins), Date.now()).catch(async (error: unknown) => {
        if (error instanceof TokenEndpointError && error.kind === 'auth') await health(body.do_name, body.connection, 'mcp_reauth_needed');
        return tokenRefusal(error);
      });
      const next = JSON.stringify(bundleOf(tokens, current.bundle));
      const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [...current.scopes];
      const landed = await db('mcp_rotate', { p_do_name: body.do_name, p_connection: body.connection, p_expect: await sha256(current.secret), p_secret: next, p_scopes: tokens.scope ?? '' }) === true;
      if (!landed) {
        const winner = await grant(body.do_name, body.connection);
        return { scopes: winner.scopes, ...(winner.bundle.expires_at === undefined ? {} : { expires_at: winner.bundle.expires_at }), version: await version(winner.secret), refreshed: false };
      }
      return { scopes, ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }), version: await version(next), refreshed: true };
    }
    case 'call': {
      const current = await grant(body.do_name, body.connection);
      if (current.bundle.expires_at !== undefined && current.bundle.expires_at - EXPIRY_SKEW_MS <= Date.now()) return refuse('token_expired');
      const endpoint = { url: current.pins.server_url, pinned: [new URL(current.pins.server_url).origin], bearer: current.bundle.access_token, ...(body.era ? { era: body.era } : {}) };
      const send = () => mcpRequest(fetch, endpoint, body.method, body.params as Record<string, unknown>, LIMITS[body.method], body.headers as Record<string, string> | undefined);
      const shape = async (out: { result: unknown; era: McpEra }) => ({ result: out.result, era: out.era, version: await version(current.secret) });
      if (!body.intent_id) return shape(await send().catch(mcpRefusal));
      // A write runs at most once per intent: claimed before the request, stored after it.
      const key = { p_do_name: body.do_name, p_connection: body.connection, p_key: body.intent_id };
      const claim = await db('proxy_idem_claim', { ...key, p_digest: await proxyIntentDigest({ method: body.method, params: body.params }) }) as { state?: string; result?: unknown } | null;
      if (!claim) return refuse('intent_unavailable');
      if (claim.state === 'conflict') return refuse('intent_conflict');
      if (claim.state === 'pending') return refuse('intent_pending');
      if (claim.state === 'done') return claim.result;
      let sent;
      try { sent = await send(); } catch (error) {
        if (notApplied(error)) { await db('mcp_idem_release', key).catch(() => undefined); return mcpRefusal(error); }
        return refuse('intent_pending');
      }
      const result = await shape(sent);
      if (await db('proxy_idem_store', { ...key, p_result: result }).catch(() => false) !== true) return refuse('intent_pending');
      return result;
    }
    case 'revoke': {
      const current = await grant(body.do_name, body.connection);
      const secret = await clientSecret(current.pins).catch(() => undefined);
      const provider = !current.pins.revocation_endpoint ? 'unsupported'
        : (await revokeToken(fetch, current.pins, current.bundle.refresh_token ?? current.bundle.access_token, current.bundle.refresh_token ? 'refresh_token' : 'access_token', secret)) ? 'revoked' : 'failed';
      if (current.bundle.refresh_token && provider === 'revoked') await revokeToken(fetch, current.pins, current.bundle.access_token, 'access_token', secret);
      if (await db('mcp_revoke', { p_do_name: body.do_name, p_connection: body.connection }) !== true) return refuse('connection_unavailable');
      return { provider };
    }
  }
};

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const LOGGED_OPS = new Set(['register', 'exchange', 'call', 'refresh', 'revoke']);

Deno.serve(async (request) => {
  const started = Date.now();
  const log = (op: unknown, method: unknown, outcome: McpProxyFailure | null) => console.log(JSON.stringify({ hop: 'mcp_proxy', op: LOGGED_OPS.has(op as string) ? op : 'unknown', ...(typeof method === 'string' ? { method } : {}), ok: outcome === null, ms: Date.now() - started, ...(outcome ? { error: outcome.code } : {}) }));
  if (request.method !== 'POST' || !router || !service || !url) { log('unconfigured', undefined, { code: 'unconfigured' }); return new Response(JSON.stringify({ ok: false, error: { code: 'unconfigured' } }), { status: 404 }); }
  const raw = await request.text();
  const at = Number(request.headers.get('x-waldo-at'));
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300 || !same(request.headers.get('x-waldo-sig') ?? '', await hmac(`${at}.${MCP_PROXY_SIGNATURE_TAG}.${await sha256(raw)}`))) {
    log('unsigned', undefined, { code: 'unsigned' });
    return new Response(JSON.stringify({ ok: false, error: { code: 'unsigned' } }), { status: 401 });
  }
  let body: McpProxyRequest | null = null;
  try { body = parseMcpProxyRequest(JSON.parse(raw)); } catch { body = null; }
  if (!body) { log('invalid', undefined, { code: 'invalid_request' }); return reply({ ok: false, error: { code: 'invalid_request' } }); }
  const method = body.op === 'call' ? body.method : undefined;
  try {
    const data = await handle(body);
    log(body.op, method, null);
    return reply({ ok: true, data });
  } catch (error) {
    const failure: McpProxyFailure = error instanceof Refusal ? error.failure : { code: 'unavailable' };
    log(body.op, method, failure);
    return reply({ ok: false, error: failure });
  }
});
