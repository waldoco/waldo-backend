// The contract between the owner's Durable Object and the oauth-proxy Edge Function, which holds the
// tokens of every provider registered to it in waldo.connection_custody: owner-connected MCP servers and
// the health providers. The DO sends a connection id and an operation; the edge holds every token.
// Parsed strictly on the edge side: an unknown key, a wrong type or an out-of-set value refuses the
// whole request.
import type { ClientPins } from './mcp-oauth.ts';
import type { McpEra } from './mcp-protocol.ts';

export const OAUTH_PROXY_FUNCTION = 'oauth-proxy';
export const OAUTH_PROXY_SIGNATURE_TAG = 'oauth';
export const MCP_METHODS = ['server/discover', 'tools/list', 'tools/call'] as const;
export type McpMethod = (typeof MCP_METHODS)[number];
// GET and DELETE are safe to repeat. A provider write that is not would need the application idempotency
// key the MCP call carries, so other methods wait for a provider that needs one.
export const FETCH_METHODS = ['GET', 'DELETE'] as const;
export type FetchMethod = (typeof FETCH_METHODS)[number];

export type OAuthProxyRequest =
  | Readonly<{ op: 'register'; issuer: string; registration_endpoint: string; redirect_uri: string; origin: string }>
  // The client the operator registered by hand at an issuer that offers no dynamic registration.
  | Readonly<{ op: 'client'; issuer: string; redirect_uri: string }>
  | Readonly<{ op: 'exchange'; do_name: string; provider: string; pins: ClientPins; code: string; verifier?: string; scope?: string }>
  | Readonly<{ op: 'call'; do_name: string; connection: string; method: McpMethod; params: Readonly<Record<string, unknown>>; era?: McpEra; headers?: Readonly<Record<string, string>>; intent_id?: string }>
  | Readonly<{ op: 'fetch'; do_name: string; connection: string; method: FetchMethod; path: string; query?: Readonly<Record<string, string>> }>
  | Readonly<{ op: 'refresh'; do_name: string; connection: string; version?: string }>
  | Readonly<{ op: 'revoke'; do_name: string; connection: string }>
  // RFC 8628 for an MCP server's public client: the device code request, then the poll that stores the grant as an exchange does.
  | Readonly<{ op: 'device_start'; pins: ClientPins; device_endpoint: string; scope?: string }>
  | Readonly<{ op: 'device_poll'; do_name: string; provider: string; pins: ClientPins; device_code: string; scope?: string }>;

export const OAUTH_PROXY_CODES = [
  'unsigned', 'unconfigured', 'invalid_request', 'connection_unavailable', 'token_expired', 'reauth_needed', 'scope_missing',
  'not_found', 'rate_limited', 'unavailable', 'protocol', 'rpc_error', 'egress_refused', 'egress_oversize',
  'intent_pending', 'intent_conflict', 'intent_unavailable', 'registration_refused', 'token_failed', 'account_linked',
  // A device-code poll's answers (RFC 8628 §3.5).
  'authorization_pending', 'slow_down', 'expired_token', 'access_denied',
] as const;
export type OAuthProxyCode = (typeof OAUTH_PROXY_CODES)[number];
export type OAuthProxyFailure = Readonly<{ code: OAuthProxyCode; retry_after?: number; scope?: string; rpc_code?: number; message?: string }>;
export type OAuthProxyReply<T> = Readonly<{ ok: true; data: T } | { ok: false; error: OAuthProxyFailure }>;

// account is the provider's own id for whose tokens these are: read from pins.account_url when pinned,
// otherwise the issuer and resource of an MCP server.
// workspace: the account the provider named in its token answer, when it names one (a Slack team), as metadata only.
export type ExchangeData = Readonly<{ id: string; account: string; scopes: readonly string[]; expires_at?: number; version: string; workspace?: string }>;
export type CallData = Readonly<{ result: unknown; era: McpEra; version: string }>;
// The provider's answer, whatever its status except a 401 (reauth_needed, so the caller refreshes once).
// body is the parsed JSON, or null for an empty or non-JSON body. Only rate-limit headers cross.
export type FetchData = Readonly<{ status: number; body: unknown; headers: Readonly<Record<string, string>>; version: string }>;
export type RefreshData = Readonly<{ scopes: readonly string[]; expires_at?: number; version: string; refreshed: boolean }>;
export type RevokeData = Readonly<{ provider: 'revoked' | 'unsupported' | 'failed' }>;
export type RegisterData = Readonly<{ client_id: string; client_auth: ClientPins['client_auth'] }>;
// device_code goes back to the owner object, which keeps it with the attempt as it keeps a PKCE verifier; it is no token.
export type DeviceStartData = Readonly<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const https = (v: unknown): v is string => text(v, 2048) && v.startsWith('https://');
const optionalHttps = (v: unknown) => v === undefined || https(v);
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const HEADER_NAME = /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/;
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;
const VERSION = /^[0-9a-f]{16}$/;
const INTENT = /^[a-zA-Z0-9:_-]{1,240}$/;
const PROVIDER = /^[a-z][a-z0-9_]{1,31}$/;
// Relative to api_base: path segments only, so the request cannot climb out of it or carry its own query.
const PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const PIN_KEYS = ['server_url', 'resource', 'issuer', 'token_endpoint', 'revocation_endpoint', 'client_id', 'client_auth', 'redirect_uri', 'api_base', 'account_url', 'account_field', 'rotation', 'refresh_scope', 'token_dialect'];

const parsePins = (v: unknown): ClientPins | null => {
  if (!isObject(v) || !only(v, PIN_KEYS)) return null;
  if (!https(v.issuer) || !https(v.token_endpoint) || !https(v.redirect_uri) || !text(v.client_id, 2048)) return null;
  if (!optionalHttps(v.revocation_endpoint) || !optionalHttps(v.server_url) || !optionalHttps(v.resource) || !optionalHttps(v.api_base) || !optionalHttps(v.account_url)) return null;
  if ((v.server_url === undefined) !== (v.resource === undefined)) return null;
  if (v.api_base !== undefined && !(v.api_base as string).endsWith('/')) return null;
  if (v.account_url !== undefined && !(v.api_base !== undefined && (v.account_url as string).startsWith(v.api_base as string) && typeof v.account_field === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v.account_field))) return null;
  if (v.account_url === undefined && v.account_field !== undefined) return null;
  if (v.rotation !== undefined && v.rotation !== 'single_use') return null;
  if (v.token_dialect !== undefined && v.token_dialect !== 'ok_envelope') return null;
  if (v.refresh_scope !== undefined && !(text(v.refresh_scope, 1024) && SCOPE.test(v.refresh_scope))) return null;
  if (v.client_auth !== 'none' && v.client_auth !== 'client_secret_post' && v.client_auth !== 'client_secret_basic') return null;
  return v as unknown as ClientPins;
};

const devicePins = (pins: ClientPins) => pins.client_auth === 'none' && pins.server_url !== undefined && pins.token_dialect === undefined;

export const parseOAuthProxyRequest = (raw: unknown): OAuthProxyRequest | null => {
  if (!isObject(raw)) return null;
  const owner = text(raw.do_name, 200), connection = typeof raw.connection === 'string' && UUID.test(raw.connection);
  switch (raw.op) {
    case 'register':
      return only(raw, ['op', 'issuer', 'registration_endpoint', 'redirect_uri', 'origin']) && https(raw.issuer) && https(raw.registration_endpoint) && https(raw.redirect_uri) && https(raw.origin) ? raw as OAuthProxyRequest : null;
    case 'client':
      return only(raw, ['op', 'issuer', 'redirect_uri']) && https(raw.issuer) && https(raw.redirect_uri) ? raw as OAuthProxyRequest : null;
    // Only a public client polls, so no client secret ever goes to an endpoint the Worker names, and only to the token
    // endpoint's own origin.
    case 'device_start': {
      if (!only(raw, ['op', 'pins', 'device_endpoint', 'scope']) || !https(raw.device_endpoint) || (raw.scope !== undefined && !text(raw.scope, 4096))) return null;
      const pins = parsePins(raw.pins);
      return pins && devicePins(pins) && new URL(raw.device_endpoint as string).origin === new URL(pins.token_endpoint).origin ? raw as OAuthProxyRequest : null;
    }
    case 'device_poll': {
      if (!only(raw, ['op', 'do_name', 'provider', 'pins', 'device_code', 'scope']) || !owner || !(typeof raw.provider === 'string' && PROVIDER.test(raw.provider))) return null;
      const pins = parsePins(raw.pins);
      return pins && devicePins(pins) && text(raw.device_code, 4096) && (raw.scope === undefined || text(raw.scope, 4096)) ? raw as OAuthProxyRequest : null;
    }
    case 'exchange': {
      if (!only(raw, ['op', 'do_name', 'provider', 'pins', 'code', 'verifier', 'scope']) || !owner || !(typeof raw.provider === 'string' && PROVIDER.test(raw.provider))) return null;
      const pins = parsePins(raw.pins);
      if (!pins || !text(raw.code, 4096) || (raw.scope !== undefined && !text(raw.scope, 4096))) return null;
      // An exchange names its account: an MCP server by issuer and resource, any other provider by its account read.
      if (pins.server_url === undefined && pins.account_url === undefined) return null;
      const verifier = typeof raw.verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(raw.verifier);
      // MCP requires PKCE: an MCP server's exchange always carries the verifier.
      if (raw.verifier !== undefined ? !verifier : pins.server_url !== undefined) return null;
      return raw as OAuthProxyRequest;
    }
    case 'call': {
      if (!only(raw, ['op', 'do_name', 'connection', 'method', 'params', 'era', 'headers', 'intent_id']) || !owner || !connection) return null;
      if (!(MCP_METHODS as readonly unknown[]).includes(raw.method) || !isObject(raw.params)) return null;
      if (raw.era !== undefined && raw.era !== 'modern' && raw.era !== 'legacy') return null;
      if (raw.intent_id !== undefined && !(typeof raw.intent_id === 'string' && INTENT.test(raw.intent_id))) return null;
      if (raw.headers !== undefined && !(isObject(raw.headers) && Object.entries(raw.headers).every(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string' && v.length <= 4096 && HEADER_VALUE.test(v)))) return null;
      if (raw.method === 'tools/call' && !(typeof raw.params.name === 'string' && (raw.params.arguments === undefined || isObject(raw.params.arguments)))) return null;
      return raw as OAuthProxyRequest;
    }
    case 'fetch': {
      if (!only(raw, ['op', 'do_name', 'connection', 'method', 'path', 'query']) || !owner || !connection) return null;
      if (!(FETCH_METHODS as readonly unknown[]).includes(raw.method) || !(text(raw.path, 1024) && PATH.test(raw.path))) return null;
      if (raw.query !== undefined && !(isObject(raw.query) && Object.keys(raw.query).length <= 32 && Object.entries(raw.query).every(([k, v]) => text(k, 128) && typeof v === 'string' && v.length <= 2048))) return null;
      return raw as OAuthProxyRequest;
    }
    case 'refresh':
      return only(raw, ['op', 'do_name', 'connection', 'version']) && owner && connection && (raw.version === undefined || (typeof raw.version === 'string' && VERSION.test(raw.version))) ? raw as OAuthProxyRequest : null;
    case 'revoke':
      return only(raw, ['op', 'do_name', 'connection']) && owner && connection ? raw as OAuthProxyRequest : null;
    default:
      return null;
  }
};

export const parseOAuthProxyReply = <T>(raw: unknown): OAuthProxyReply<T> | null => {
  if (!isObject(raw)) return null;
  if (raw.ok === true && Object.hasOwn(raw, 'data')) return raw as OAuthProxyReply<T>;
  const error = raw.error;
  if (raw.ok === false && isObject(error) && (OAUTH_PROXY_CODES as readonly unknown[]).includes(error.code)) return raw as OAuthProxyReply<T>;
  return null;
};
