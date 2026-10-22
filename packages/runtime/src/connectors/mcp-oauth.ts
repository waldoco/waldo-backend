// OAuth 2.1 for owner-connected MCP servers, per the MCP authorization spec, revision 2026-07-28.
// Discovery and the authorize URL run in the owner's Durable Object; token, refresh, registration and
// revocation run only in the oauth-proxy Edge Function, which shares this module. Every URL goes through
// the egress rail. Discovered endpoints are recorded once, at connect, and pinned from then on.
import { egressTarget, guardedFetch } from './egress.ts';

export const MCP_CALLBACK_PATH = '/oauth/mcp/callback';
export const MCP_CLIENT_METADATA_PATH = '/oauth/mcp/client.json';
const DISCOVERY = { redirects: 2, maxBytes: 256 * 1024, timeoutMs: 15_000 } as const;
const TOKEN = { maxBytes: 64 * 1024, timeoutMs: 20_000 } as const;

export type OAuthFailure = 'no_resource_metadata' | 'resource_mismatch' | 'no_authorization_server' | 'issuer_mismatch' | 'metadata_invalid' | 'pkce_unsupported' | 'registration_unsupported' | 'registration_refused';
export class McpOAuthError extends Error {
  constructor(public readonly code: OAuthFailure) { super(code); this.name = 'McpOAuthError'; }
}

// The canonical resource for RFC 8707: the server URL without fragment or query, and without the bare
// root slash (spec, Canonical Server URI).
export const canonicalResource = (raw: string | URL): string => {
  const url = egressTarget(raw);
  url.search = '';
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
};

// A protected resource may advertise itself at an ancestor path of the endpoint (RFC 9728 §3.3 and the
// spec's path-insertion rule), never at another origin.
export const resourceCovers = (advertised: string, server: string): boolean => {
  let a: URL, s: URL;
  try { a = new URL(advertised); s = new URL(server); } catch { return false; }
  if (a.origin !== s.origin || a.search || a.hash) return false;
  const base = a.pathname.replace(/\/+$/, '');
  return base === '' || s.pathname === base || s.pathname.startsWith(`${base}/`);
};

export type ProtectedResource = Readonly<{ resource: string; authorization_servers: readonly string[]; scopes_supported?: readonly string[] }>;

const getJson = async (fetcher: typeof fetch, url: string): Promise<{ status: number; json: unknown }> => {
  const out = await guardedFetch(fetcher, url, { headers: { accept: 'application/json' } }, DISCOVERY);
  if (out.status < 200 || out.status >= 300) return { status: out.status, json: null };
  try { return { status: out.status, json: JSON.parse(out.text) }; } catch { return { status: out.status, json: null }; }
};
const strings = (value: unknown): readonly string[] | undefined => Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;

// RFC 9728: the challenge's resource_metadata first, then the path-inserted and root well-known URIs.
export const discoverProtectedResource = async (fetcher: typeof fetch, server: string, resourceMetadata?: string): Promise<ProtectedResource> => {
  const url = egressTarget(server);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const candidates = [...(resourceMetadata ? [resourceMetadata] : []), ...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []), `${url.origin}/.well-known/oauth-protected-resource`];
  for (const candidate of candidates) {
    const { json } = await getJson(fetcher, candidate);
    if (!json || typeof json !== 'object') continue;
    const doc = json as Record<string, unknown>;
    const servers = strings(doc.authorization_servers);
    if (typeof doc.resource !== 'string') throw new McpOAuthError('metadata_invalid');
    if (!resourceCovers(doc.resource, canonicalResource(server))) throw new McpOAuthError('resource_mismatch');
    if (!servers || servers.length === 0) throw new McpOAuthError('no_authorization_server');
    const scopes = strings(doc.scopes_supported);
    return { resource: doc.resource.replace(/\/$/, '') || doc.resource, authorization_servers: servers, ...(scopes ? { scopes_supported: scopes } : {}) };
  }
  throw new McpOAuthError('no_resource_metadata');
};

export type AuthorizationServer = Readonly<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: readonly string[];
  token_endpoint_auth_methods_supported?: readonly string[];
  client_id_metadata_document_supported: boolean;
  iss_parameter_supported: boolean;
}>;

// RFC 8414 §3.1 and OIDC Discovery in the spec's priority order. The document's issuer must be
// identical to the identifier the URL was built from, or it is not used (RFC 8414 §3.3).
export const authorizationServerUrls = (issuer: string): readonly string[] => {
  const url = egressTarget(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return path
    ? [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`]
    : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
};

export const discoverAuthorizationServer = async (fetcher: typeof fetch, issuer: string): Promise<AuthorizationServer> => {
  for (const candidate of authorizationServerUrls(issuer)) {
    const { json } = await getJson(fetcher, candidate);
    if (!json || typeof json !== 'object') continue;
    const doc = json as Record<string, unknown>;
    if (doc.issuer !== issuer) throw new McpOAuthError('issuer_mismatch');
    const endpoint = (key: string, required: boolean): string | undefined => {
      const value = doc[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string') throw new McpOAuthError('metadata_invalid');
      return egressTarget(value).toString();
    };
    const methods = strings(doc.code_challenge_methods_supported);
    // PKCE support is read from metadata only; absent or without S256 means the flow must not proceed.
    if (!methods?.includes('S256')) throw new McpOAuthError('pkce_unsupported');
    const registration = endpoint('registration_endpoint', false), revocation = endpoint('revocation_endpoint', false);
    const scopes = strings(doc.scopes_supported), auth = strings(doc.token_endpoint_auth_methods_supported);
    return {
      issuer, authorization_endpoint: endpoint('authorization_endpoint', true)!, token_endpoint: endpoint('token_endpoint', true)!,
      ...(registration ? { registration_endpoint: registration } : {}), ...(revocation ? { revocation_endpoint: revocation } : {}),
      ...(scopes ? { scopes_supported: scopes } : {}), ...(auth ? { token_endpoint_auth_methods_supported: auth } : {}),
      client_id_metadata_document_supported: doc.client_id_metadata_document_supported === true,
      iss_parameter_supported: doc.authorization_response_iss_parameter_supported === true,
    };
  }
  throw new McpOAuthError('no_authorization_server');
};

export type RegistrationMode = 'pre_registered' | 'cimd' | 'dcr';
// Spec priority: pre-registered, then a Client ID Metadata Document, then Dynamic Client Registration.
export const registrationMode = (server: AuthorizationServer, preRegistered: boolean): RegistrationMode => {
  if (preRegistered) return 'pre_registered';
  if (server.client_id_metadata_document_supported) return 'cimd';
  if (server.registration_endpoint) return 'dcr';
  throw new McpOAuthError('registration_unsupported');
};

export const clientMetadataUrl = (origin: string) => `${origin}${MCP_CLIENT_METADATA_PATH}`;
export const callbackUrl = (origin: string) => `${origin}${MCP_CALLBACK_PATH}`;
// The CIMD document (draft-ietf-oauth-client-id-metadata-document-00): client_id is exactly its own URL.
export const clientMetadataDocument = (origin: string) => ({
  client_id: clientMetadataUrl(origin),
  client_name: 'Waldo',
  client_uri: origin,
  redirect_uris: [callbackUrl(origin)],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
});

// Challenge scopes are authoritative for the operation; otherwise every advertised resource scope.
// offline_access only when the authorization server lists it, so a refresh token can be issued.
export const requestedScope = (challenge: string | undefined, resource: ProtectedResource, server: AuthorizationServer, previous: readonly string[] = []): string | undefined => {
  const base = challenge ? challenge.split(/\s+/) : resource.scopes_supported ?? [];
  const scopes = new Set([...previous, ...base].filter(Boolean));
  if (scopes.size > 0 && server.scopes_supported?.includes('offline_access')) scopes.add('offline_access');
  return scopes.size ? [...scopes].join(' ') : undefined;
};

const b64url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const pkceVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const pkceChallenge = async (verifier: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

export const authorizationUrl = (server: AuthorizationServer, input: Readonly<{ clientId: string; redirectUri: string; state: string; challenge: string; resource: string; scope?: string }>): string => {
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', input.resource);
  if (input.scope) url.searchParams.set('scope', input.scope);
  return url.toString();
};

export type CallbackResult = Readonly<{ ok: true; code: string } | { ok: false; reason: 'iss_mismatch' | 'iss_missing' | 'denied' | 'malformed' }>;
// RFC 9207 §2.4 as the spec tabulates it: a present iss must equal the recorded issuer by simple string
// comparison, with no normalisation; a server that advertises iss must send it. On mismatch the error
// fields are not read at all.
export const readCallback = (params: URLSearchParams, expectedIssuer: string, issSupported: boolean): CallbackResult => {
  const iss = params.get('iss');
  if (iss !== null && iss !== expectedIssuer) return { ok: false, reason: 'iss_mismatch' };
  if (iss === null && issSupported) return { ok: false, reason: 'iss_missing' };
  if (params.get('error') !== null) return { ok: false, reason: 'denied' };
  const code = params.get('code');
  return code ? { ok: true, code } : { ok: false, reason: 'malformed' };
};

// Endpoints and client identity fixed when the owner connected, for an MCP server or any other provider
// the oauth-proxy holds. The edge refuses to send a token, code or client secret anywhere else.
export type ClientPins = Readonly<{
  issuer: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  client_id: string;
  client_auth: 'none' | 'client_secret_post' | 'client_secret_basic';
  redirect_uri: string;
  // An MCP connection: the endpoint the owner connected, and the RFC 8707 resource its tokens are bound to.
  server_url?: string;
  resource?: string;
  // A provider's HTTP API: the only URL prefix the fetch operation sends the access token to.
  api_base?: string;
  // Where the provider names whose tokens these are: a GET under api_base, and the field holding the id.
  account_url?: string;
  account_field?: string;
  // single_use: the provider retires a refresh token when it issues the next one, so an answer without a
  // new one leaves no refresh token rather than the spent one. Unset: an answer without a refresh token
  // means the old one stays valid (RFC 6749 section 6).
  rotation?: 'single_use';
  // Sent as the scope of a refresh request, for a provider that requires one.
  refresh_scope?: string;
}>;
export type McpPins = ClientPins & Readonly<{ server_url: string; resource: string }>;

export type TokenSet = Readonly<{ access_token: string; refresh_token?: string; expires_at?: number; scope?: string }>;
export class TokenEndpointError extends Error {
  constructor(public readonly kind: 'auth' | 'transient' | 'configuration' | 'protocol', public readonly status?: number, public readonly retryAfterSeconds?: number) { super(`token_${kind}`); this.name = 'TokenEndpointError'; }
}

const tokenCall = async (fetcher: typeof fetch, pins: ClientPins, body: Record<string, string>, secret: string | undefined, now: number): Promise<TokenSet> => {
  const form = new URLSearchParams({ ...body, ...(pins.resource ? { resource: pins.resource } : {}) });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (pins.client_auth === 'client_secret_basic' && secret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(pins.client_id)}:${encodeURIComponent(secret)}`)}`;
  else { form.set('client_id', pins.client_id); if (pins.client_auth === 'client_secret_post' && secret) form.set('client_secret', secret); }
  let out;
  try {
    out = await guardedFetch(fetcher, pins.token_endpoint, { method: 'POST', headers, body: form.toString() }, { pinned: [new URL(pins.token_endpoint).origin], ...TOKEN });
  } catch {
    throw new TokenEndpointError('transient');
  }
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(out.text) as Record<string, unknown>; } catch { /* classified by status below */ }
  if (out.status < 200 || out.status >= 300) {
    const code = json.error;
    const wait = Number(out.headers.get('retry-after'));
    if (out.status === 429 || out.status >= 500 || code === 'temporarily_unavailable' || code === 'server_error') throw new TokenEndpointError('transient', out.status, Number.isFinite(wait) ? wait : undefined);
    if (code === 'invalid_grant') throw new TokenEndpointError('auth', out.status);
    if (code === 'invalid_client' || code === 'unauthorized_client') throw new TokenEndpointError('configuration', out.status);
    throw new TokenEndpointError('protocol', out.status);
  }
  if (typeof json.access_token !== 'string' || !json.access_token || (typeof json.token_type === 'string' && json.token_type.toLowerCase() !== 'bearer')) throw new TokenEndpointError('protocol', out.status);
  const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : undefined;
  return {
    access_token: json.access_token,
    ...(typeof json.refresh_token === 'string' && json.refresh_token ? { refresh_token: json.refresh_token } : {}),
    ...(expiresIn === undefined ? {} : { expires_at: now + expiresIn * 1000 }),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
  };
};

// The verifier is absent only for a provider that documents no PKCE; an MCP exchange always carries one.
export const exchangeCode = (fetcher: typeof fetch, pins: ClientPins, input: Readonly<{ code: string; verifier?: string; redirectUri: string }>, secret: string | undefined, now: number) =>
  tokenCall(fetcher, pins, { grant_type: 'authorization_code', code: input.code, ...(input.verifier ? { code_verifier: input.verifier } : {}), redirect_uri: input.redirectUri }, secret, now);

export const refreshTokens = (fetcher: typeof fetch, pins: ClientPins, refreshToken: string, secret: string | undefined, now: number) =>
  tokenCall(fetcher, pins, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(pins.refresh_scope ? { scope: pins.refresh_scope } : {}) }, secret, now);

// RFC 7009. 200 means the token is gone or was never valid; anything else is not a confirmed revoke.
export const revokeToken = async (fetcher: typeof fetch, pins: ClientPins, token: string, hint: 'refresh_token' | 'access_token', secret: string | undefined): Promise<boolean> => {
  if (!pins.revocation_endpoint) return false;
  const form = new URLSearchParams({ token, token_type_hint: hint });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (pins.client_auth === 'client_secret_basic' && secret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(pins.client_id)}:${encodeURIComponent(secret)}`)}`;
  else { form.set('client_id', pins.client_id); if (pins.client_auth === 'client_secret_post' && secret) form.set('client_secret', secret); }
  try {
    const out = await guardedFetch(fetcher, pins.revocation_endpoint, { method: 'POST', headers, body: form.toString() }, { pinned: [new URL(pins.revocation_endpoint).origin], ...TOKEN });
    return out.status === 200;
  } catch {
    return false;
  }
};

export type Registration = Readonly<{ client_id: string; client_auth: ClientPins['client_auth']; client_secret?: string }>;
// RFC 7591, kept by the spec for authorization servers without CIMD. Asks for a public client; takes
// whatever authentication method the server assigns, and returns any secret only to the edge caller.
export const registerClient = async (fetcher: typeof fetch, registrationEndpoint: string, origin: string): Promise<Registration> => {
  const { client_id: _unused, ...metadata } = clientMetadataDocument(origin);
  let out;
  try {
    out = await guardedFetch(fetcher, registrationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(metadata) }, { pinned: [new URL(registrationEndpoint).origin], ...TOKEN });
  } catch {
    throw new McpOAuthError('registration_refused');
  }
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(out.text) as Record<string, unknown>; } catch { /* refused below */ }
  if (out.status < 200 || out.status >= 300 || typeof json.client_id !== 'string' || !json.client_id) throw new McpOAuthError('registration_refused');
  const method = typeof json.token_endpoint_auth_method === 'string' ? json.token_endpoint_auth_method : json.client_secret ? 'client_secret_basic' : 'none';
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') throw new McpOAuthError('registration_refused');
  if (method !== 'none' && typeof json.client_secret !== 'string') throw new McpOAuthError('registration_refused');
  return { client_id: json.client_id, client_auth: method, ...(method !== 'none' ? { client_secret: json.client_secret as string } : {}) };
};
