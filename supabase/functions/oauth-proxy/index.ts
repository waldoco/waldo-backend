// OAuth proxy for the owner connections it holds (waldo.connection_custody): owner-connected MCP servers
// and the health providers. The only place their tokens are read, refreshed, used or revoked. The owner's
// Durable Object sends a router-signed operation with a connection id; tokens, client secrets and codes
// never travel back. Every request goes to an endpoint pinned when the owner connected, and a provider's
// behaviour (client authentication, PKCE, rotation, refresh scope, API base) comes from those pins, never
// from a branch on its name.
import { exchangeCode, refreshTokens, registerClient, revokeToken, TokenEndpointError, type ClientPins, type TokenSet } from '../../../packages/runtime/src/connectors/mcp-oauth.ts';
import { McpChallenge, McpRpcError, McpServerError, mcpRequest, type McpEra } from '../../../packages/runtime/src/connectors/mcp-protocol.ts';
import { EgressError, guardedFetch } from '../../../packages/runtime/src/connectors/egress.ts';
import { OAUTH_PROXY_SIGNATURE_TAG, parseOAuthProxyRequest, type OAuthProxyCode, type OAuthProxyFailure, type OAuthProxyRequest } from '../../../packages/runtime/src/connectors/oauth-proxy-wire.ts';
import { proxyIntentDigest } from '../../../packages/runtime/src/connectors/proxy-intent.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };

const env = (name: string) => Deno.env.get(name) ?? '';
const url = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY'), router = env('WALDO_ROUTER_HMAC_SECRET');
// Refresh this long before the recorded expiry, so a call never leaves with a token about to lapse.
const EXPIRY_SKEW_MS = 120_000;
// Resource bounds sized for real work: a long tool run, a large document or an image in a result, a
// provider page of records.
const LIMITS = { 'tools/call': { maxBytes: 16 * 1024 * 1024, timeoutMs: 120_000 }, 'tools/list': { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 }, 'server/discover': { maxBytes: 256 * 1024, timeoutMs: 15_000 } } as const;
const FETCH_LIMIT = { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 } as const;
// A refreshed single-use token is already spent at the provider, so losing the write loses the connection.
// The write is retried on a database error before the owner is asked to reconnect.
const ROTATE_WRITE_ATTEMPTS = 3;
const RATE_HEADERS = /^(retry-after|x-ratelimit-[a-z-]+)$/;

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
  constructor(public readonly failure: OAuthProxyFailure) { super(failure.code); }
}
const refuse = (code: OAuthProxyCode, extra: Omit<OAuthProxyFailure, 'code'> = {}): never => { throw new Refusal({ code, ...extra }); };

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

type Grant = Readonly<{ provider: string; secret: string; bundle: Bundle; scopes: readonly string[]; pins: ClientPins }>;
const grant = async (doName: string, connection: string): Promise<Grant> => {
  const rows = await db('oauth_access', { p_do_name: doName, p_connection: connection }) as { provider?: unknown; secret?: unknown; scopes?: unknown; pins?: unknown }[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row.provider !== 'string' || typeof row.secret !== 'string' || !row.pins || typeof row.pins !== 'object') return refuse('connection_unavailable');
  let bundle: Bundle;
  try { bundle = JSON.parse(row.secret) as Bundle; } catch { return refuse('connection_unavailable'); }
  if (typeof bundle.access_token !== 'string') return refuse('connection_unavailable');
  return { provider: row.provider, secret: row.secret, bundle, scopes: Array.isArray(row.scopes) ? row.scopes.filter((s): s is string => typeof s === 'string') : [], pins: row.pins as ClientPins };
};
const clientSecret = async (pins: ClientPins): Promise<string | undefined> => {
  if (pins.client_auth === 'none') return undefined;
  const rows = await db('oauth_client_get', { p_issuer: pins.issuer, p_redirect_uri: pins.redirect_uri }) as { client_id?: unknown; client_secret?: unknown }[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || row.client_id !== pins.client_id || typeof row.client_secret !== 'string') return refuse('token_failed');
  return row.client_secret;
};
const health = (doName: string, connection: string, error: string) => db('proxy_health', { p_do_name: doName, p_connection: connection, p_error: error }).catch(() => undefined);
const bundleOf = (tokens: TokenSet, pins: ClientPins, previous?: Bundle): Bundle => {
  const refresh = tokens.refresh_token ?? (pins.rotation === 'single_use' ? undefined : previous?.refresh_token);
  return { access_token: tokens.access_token, ...(refresh ? { refresh_token: refresh } : {}), ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }) };
};
const tokenRefusal = (error: unknown): never => {
  if (error instanceof Refusal) throw error;
  if (error instanceof TokenEndpointError) return error.kind === 'auth' ? refuse('reauth_needed') : error.kind === 'transient' ? refuse('unavailable', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : refuse('token_failed');
  return refuse('token_failed');
};
const expiring = (bundle: Bundle) => bundle.expires_at !== undefined && bundle.expires_at - EXPIRY_SKEW_MS <= Date.now();
const settled = async (current: Grant, refreshed: boolean) => ({ scopes: current.scopes, ...(current.bundle.expires_at === undefined ? {} : { expires_at: current.bundle.expires_at }), version: await version(current.secret), refreshed });

// The MCP server's answer, reduced to codes the runtime acts on. Server text crosses only as the
// JSON-RPC error message, bounded, for the model to correct its call; it is never logged.
const mcpRefusal = (error: unknown): never => {
  if (error instanceof Refusal) throw error;
  if (error instanceof McpChallenge) return error.status === 401 ? refuse('reauth_needed') : error.challenge.error === 'insufficient_scope' ? refuse('scope_missing', scopeTokens(error.challenge.scope) ? { scope: scopeTokens(error.challenge.scope)! } : {}) : refuse('scope_missing');
  if (error instanceof McpServerError) return error.kind === 'rate_limited' ? refuse('rate_limited', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : error.kind === 'not_found' ? refuse('not_found') : error.kind === 'unavailable' ? refuse('unavailable', error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) : refuse('protocol');
  if (error instanceof McpRpcError) return refuse('rpc_error', { rpc_code: error.code, message: error.message.slice(0, 500) });
  if (error instanceof EgressError) return egressRefusal(error);
  return refuse('unavailable');
};
const egressRefusal = (error: EgressError): never => error.code === 'egress_oversize' ? refuse('egress_oversize') : error.code === 'egress_network' || error.code === 'egress_timeout' ? refuse('unavailable') : refuse('egress_refused');
// A write the server provably did not run: an auth challenge, a rate limit, a refused redirect or a target
// the rail refused before sending. Only then is the pending claim released for the one retry.
const notApplied = (error: unknown) => error instanceof McpChallenge || (error instanceof McpServerError && error.kind === 'rate_limited')
  || (error instanceof EgressError && !['egress_oversize', 'egress_network', 'egress_timeout'].includes(error.code));

// A GET under the pinned API base with the access token. Redirects are never followed with a token.
const providerGet = (pins: ClientPins, target: URL, bearer: string, method = 'GET') =>
  guardedFetch(fetch, target, { method, headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' } }, { pinned: [new URL(pins.api_base!).origin], ...FETCH_LIMIT });
const underBase = (pins: ClientPins, target: URL) => pins.api_base !== undefined && target.href.startsWith(pins.api_base);
const parsed = (text: string): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

// The id the provider gives the account these tokens belong to: an MCP server by issuer and resource, any
// other provider by the field its pinned account URL returns.
const accountOf = async (pins: ClientPins, accessToken: string): Promise<string> => {
  if (pins.server_url !== undefined) return `${pins.issuer} ${pins.resource}`;
  const target = new URL(pins.account_url!);
  if (!underBase(pins, target)) return refuse('invalid_request');
  const out = await providerGet(pins, target, accessToken).catch((error: unknown) => error instanceof EgressError ? egressRefusal(error) : refuse('unavailable'));
  if (out.status === 401 || out.status === 403) return refuse('reauth_needed');
  if (out.status < 200 || out.status >= 300) return refuse(out.status === 429 || out.status >= 500 ? 'unavailable' : 'token_failed');
  const id = (parsed(out.text) as Record<string, unknown> | null)?.[pins.account_field!];
  if ((typeof id !== 'string' || !id || id.length > 200) && !(typeof id === 'number' && Number.isSafeInteger(id))) return refuse('token_failed');
  return String(id);
};

// Writes a refreshed bundle with compare-and-set on the secret it was refreshed from. A database error is
// retried; a lost compare-and-set is not an error (another refresh won and the caller reads it).
const rotate = async (args: Record<string, unknown>): Promise<boolean> => {
  for (let attempt = 1; ; attempt += 1) {
    try { return await db('oauth_rotate', args) === true; } catch (error) { if (attempt >= ROTATE_WRITE_ATTEMPTS) throw error; }
  }
};

const handle = async (body: OAuthProxyRequest): Promise<unknown> => {
  switch (body.op) {
    case 'register': {
      const read = async () => {
        const rows = await db('oauth_client_get', { p_issuer: body.issuer, p_redirect_uri: body.redirect_uri }) as { client_id?: unknown; client_auth?: unknown }[];
        const row = Array.isArray(rows) ? rows[0] : undefined;
        return row && typeof row.client_id === 'string' ? { client_id: row.client_id, client_auth: row.client_auth } : null;
      };
      const kept = await read();
      if (kept) return kept;
      let registration;
      try { registration = await registerClient(fetch, body.registration_endpoint, body.origin); } catch { return refuse('registration_refused'); }
      await db('oauth_client_put', { p_issuer: body.issuer, p_redirect_uri: body.redirect_uri, p_client_id: registration.client_id, p_client_auth: registration.client_auth, p_secret: registration.client_secret ?? null });
      return (await read()) ?? refuse('registration_refused');
    }
    case 'exchange': {
      const secret = await clientSecret(body.pins);
      const tokens = await exchangeCode(fetch, body.pins, { code: body.code, ...(body.verifier ? { verifier: body.verifier } : {}), redirectUri: body.pins.redirect_uri }, secret, Date.now()).catch(tokenRefusal);
      const account = await accountOf(body.pins, tokens.access_token);
      const stored = JSON.stringify(bundleOf(tokens, body.pins));
      // RFC 6749 §5.1: without a scope in the response, the grant covers what was requested.
      const scopes = (tokens.scope ?? body.scope)?.split(/\s+/).filter(Boolean) ?? [];
      const out = await db('oauth_store', { p_do_name: body.do_name, p_provider: body.provider, p_account: account, p_scopes: scopes.join(' '), p_pins: body.pins, p_secret: stored }) as { id?: unknown; error?: unknown } | null;
      if (out?.error === 'account_linked') return refuse('account_linked');
      if (typeof out?.id !== 'string') return refuse('connection_unavailable');
      return { id: out.id, account: account.toLowerCase(), scopes, ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }), version: await version(stored) };
    }
    case 'refresh': {
      const current = await grant(body.do_name, body.connection);
      const seen = await version(current.secret);
      // Another refresh already landed since the caller last looked: use it, never spend a rotated token twice.
      if (body.version !== undefined && body.version !== seen && !expiring(current.bundle)) return settled(current, false);
      if (!current.bundle.refresh_token) { await health(body.do_name, body.connection, 'oauth_reauth_needed'); return refuse('reauth_needed'); }
      let tokens: TokenSet;
      try {
        tokens = await refreshTokens(fetch, current.pins, current.bundle.refresh_token, await clientSecret(current.pins), Date.now());
      } catch (error) {
        // A single-use refresh token refused as invalid may just have been spent by a refresh that won the
        // race and has since written its tokens: the winner is the answer, not a reconnect.
        if (error instanceof TokenEndpointError && error.kind === 'auth') {
          const after = await grant(body.do_name, body.connection);
          if (after.secret !== current.secret) return settled(after, false);
          await health(body.do_name, body.connection, 'oauth_reauth_needed');
        }
        return tokenRefusal(error);
      }
      const next = JSON.stringify(bundleOf(tokens, current.pins, current.bundle));
      const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [...current.scopes];
      if (!await rotate({ p_do_name: body.do_name, p_connection: body.connection, p_expect: await sha256(current.secret), p_secret: next, p_scopes: tokens.scope ?? '' })) return settled(await grant(body.do_name, body.connection), false);
      return { scopes, ...(tokens.expires_at === undefined ? {} : { expires_at: tokens.expires_at }), version: await version(next), refreshed: true };
    }
    case 'call': {
      const current = await grant(body.do_name, body.connection);
      if (current.pins.server_url === undefined) return refuse('invalid_request');
      if (expiring(current.bundle)) return refuse('token_expired');
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
        if (notApplied(error)) { await db('oauth_idem_release', key).catch(() => undefined); return mcpRefusal(error); }
        return refuse('intent_pending');
      }
      const result = await shape(sent);
      if (await db('proxy_idem_store', { ...key, p_result: result }).catch(() => false) !== true) return refuse('intent_pending');
      return result;
    }
    case 'fetch': {
      const current = await grant(body.do_name, body.connection);
      if (current.pins.api_base === undefined) return refuse('invalid_request');
      const target = new URL(body.path, current.pins.api_base);
      for (const [name, value] of Object.entries(body.query ?? {})) target.searchParams.set(name, value);
      // The resolved URL, not the request's text, decides: an encoded dot segment cannot climb out of the base.
      if (!underBase(current.pins, target)) return refuse('invalid_request');
      if (expiring(current.bundle)) return refuse('token_expired');
      const out = await providerGet(current.pins, target, current.bundle.access_token, body.method).catch((error: unknown) => error instanceof EgressError ? egressRefusal(error) : refuse('unavailable'));
      if (out.status === 401) return refuse('reauth_needed');
      const headers = Object.fromEntries([...out.headers].filter(([name]) => RATE_HEADERS.test(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value.slice(0, 200)]));
      return { status: out.status, body: parsed(out.text), headers, version: await version(current.secret) };
    }
    case 'revoke': {
      const current = await grant(body.do_name, body.connection);
      const secret = await clientSecret(current.pins).catch(() => undefined);
      const provider = !current.pins.revocation_endpoint ? 'unsupported'
        : (await revokeToken(fetch, current.pins, current.bundle.refresh_token ?? current.bundle.access_token, current.bundle.refresh_token ? 'refresh_token' : 'access_token', secret)) ? 'revoked' : 'failed';
      if (current.bundle.refresh_token && provider === 'revoked') await revokeToken(fetch, current.pins, current.bundle.access_token, 'access_token', secret);
      if (await db('oauth_revoke', { p_do_name: body.do_name, p_connection: body.connection }) !== true) return refuse('connection_unavailable');
      return { provider };
    }
  }
};

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const LOGGED_OPS = new Set(['register', 'exchange', 'call', 'fetch', 'refresh', 'revoke']);

Deno.serve(async (request) => {
  const started = Date.now();
  const log = (op: unknown, method: unknown, outcome: OAuthProxyFailure | null) => console.log(JSON.stringify({ hop: 'oauth_proxy', op: LOGGED_OPS.has(op as string) ? op : 'unknown', ...(typeof method === 'string' ? { method } : {}), ok: outcome === null, ms: Date.now() - started, ...(outcome ? { error: outcome.code } : {}) }));
  if (request.method !== 'POST' || !router || !service || !url) { log('unconfigured', undefined, { code: 'unconfigured' }); return new Response(JSON.stringify({ ok: false, error: { code: 'unconfigured' } }), { status: 404 }); }
  const raw = await request.text();
  const at = Number(request.headers.get('x-waldo-at'));
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300 || !same(request.headers.get('x-waldo-sig') ?? '', await hmac(`${at}.${OAUTH_PROXY_SIGNATURE_TAG}.${await sha256(raw)}`))) {
    log('unsigned', undefined, { code: 'unsigned' });
    return new Response(JSON.stringify({ ok: false, error: { code: 'unsigned' } }), { status: 401 });
  }
  let body: OAuthProxyRequest | null = null;
  try { body = parseOAuthProxyRequest(JSON.parse(raw)); } catch { body = null; }
  if (!body) { log('invalid', undefined, { code: 'invalid_request' }); return reply({ ok: false, error: { code: 'invalid_request' } }); }
  // The method is a fixed MCP or HTTP verb, never a path or argument, so it is safe to log.
  const method = body.op === 'call' || body.op === 'fetch' ? body.method : undefined;
  try {
    const data = await handle(body);
    log(body.op, method, null);
    return reply({ ok: true, data });
  } catch (error) {
    const failure: OAuthProxyFailure = error instanceof Refusal ? error.failure : { code: 'unavailable' };
    log(body.op, method, failure);
    return reply({ ok: false, error: failure });
  }
});
