// The contract between the owner's Durable Object and the mcp-proxy Edge Function. The DO sends a
// connection id and an operation; the edge holds every token. Parsed strictly on the edge side: an
// unknown key, a wrong type or an out-of-set value refuses the whole request.
import type { ClientPins } from './mcp-oauth.ts';
import type { McpEra } from './mcp-protocol.ts';

export const MCP_PROXY_FUNCTION = 'mcp-proxy';
export const MCP_PROXY_SIGNATURE_TAG = 'mcp';
export const MCP_METHODS = ['server/discover', 'tools/list', 'tools/call'] as const;
export type McpMethod = (typeof MCP_METHODS)[number];

export type McpProxyRequest =
  | Readonly<{ op: 'register'; issuer: string; registration_endpoint: string; redirect_uri: string; origin: string }>
  | Readonly<{ op: 'exchange'; do_name: string; pins: ClientPins; code: string; verifier: string; scope?: string }>
  | Readonly<{ op: 'call'; do_name: string; connection: string; method: McpMethod; params: Readonly<Record<string, unknown>>; era?: McpEra; headers?: Readonly<Record<string, string>>; intent_id?: string }>
  | Readonly<{ op: 'refresh'; do_name: string; connection: string; version?: string }>
  | Readonly<{ op: 'revoke'; do_name: string; connection: string }>;

export const MCP_PROXY_CODES = [
  'unsigned', 'unconfigured', 'invalid_request', 'connection_unavailable', 'token_expired', 'reauth_needed', 'scope_missing',
  'not_found', 'rate_limited', 'unavailable', 'protocol', 'rpc_error', 'egress_refused', 'egress_oversize',
  'intent_pending', 'intent_conflict', 'intent_unavailable', 'registration_refused', 'token_failed',
] as const;
export type McpProxyCode = (typeof MCP_PROXY_CODES)[number];
export type McpProxyFailure = Readonly<{ code: McpProxyCode; retry_after?: number; scope?: string; rpc_code?: number; message?: string }>;
export type McpProxyReply<T> = Readonly<{ ok: true; data: T } | { ok: false; error: McpProxyFailure }>;

export type ExchangeData = Readonly<{ id: string; scopes: readonly string[]; expires_at?: number; version: string }>;
export type CallData = Readonly<{ result: unknown; era: McpEra; version: string }>;
export type RefreshData = Readonly<{ scopes: readonly string[]; expires_at?: number; version: string; refreshed: boolean }>;
export type RevokeData = Readonly<{ provider: 'revoked' | 'unsupported' | 'failed' }>;
export type RegisterData = Readonly<{ client_id: string; client_auth: ClientPins['client_auth'] }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const https = (v: unknown): v is string => text(v, 2048) && v.startsWith('https://');
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const HEADER_NAME = /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/;
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;
const VERSION = /^[0-9a-f]{16}$/;
const INTENT = /^[a-zA-Z0-9:_-]{1,240}$/;

const parsePins = (v: unknown): ClientPins | null => {
  if (!isObject(v) || !only(v, ['server_url', 'resource', 'issuer', 'token_endpoint', 'revocation_endpoint', 'client_id', 'client_auth', 'redirect_uri'])) return null;
  if (!https(v.server_url) || !https(v.resource) || !https(v.issuer) || !https(v.token_endpoint) || !https(v.redirect_uri) || !text(v.client_id, 2048)) return null;
  if (v.revocation_endpoint !== undefined && !https(v.revocation_endpoint)) return null;
  if (v.client_auth !== 'none' && v.client_auth !== 'client_secret_post' && v.client_auth !== 'client_secret_basic') return null;
  return v as unknown as ClientPins;
};

export const parseMcpProxyRequest = (raw: unknown): McpProxyRequest | null => {
  if (!isObject(raw)) return null;
  const owner = text(raw.do_name, 200), connection = typeof raw.connection === 'string' && UUID.test(raw.connection);
  switch (raw.op) {
    case 'register':
      return only(raw, ['op', 'issuer', 'registration_endpoint', 'redirect_uri', 'origin']) && https(raw.issuer) && https(raw.registration_endpoint) && https(raw.redirect_uri) && https(raw.origin) ? raw as McpProxyRequest : null;
    case 'exchange':
      return only(raw, ['op', 'do_name', 'pins', 'code', 'verifier', 'scope']) && owner && parsePins(raw.pins) && text(raw.code, 4096) && typeof raw.verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(raw.verifier) && (raw.scope === undefined || text(raw.scope, 4096)) ? raw as McpProxyRequest : null;
    case 'call': {
      if (!only(raw, ['op', 'do_name', 'connection', 'method', 'params', 'era', 'headers', 'intent_id']) || !owner || !connection) return null;
      if (!(MCP_METHODS as readonly unknown[]).includes(raw.method) || !isObject(raw.params)) return null;
      if (raw.era !== undefined && raw.era !== 'modern' && raw.era !== 'legacy') return null;
      if (raw.intent_id !== undefined && !(typeof raw.intent_id === 'string' && INTENT.test(raw.intent_id))) return null;
      if (raw.headers !== undefined && !(isObject(raw.headers) && Object.entries(raw.headers).every(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string' && v.length <= 4096 && HEADER_VALUE.test(v)))) return null;
      if (raw.method === 'tools/call' && !(typeof raw.params.name === 'string' && (raw.params.arguments === undefined || isObject(raw.params.arguments)))) return null;
      return raw as McpProxyRequest;
    }
    case 'refresh':
      return only(raw, ['op', 'do_name', 'connection', 'version']) && owner && connection && (raw.version === undefined || (typeof raw.version === 'string' && VERSION.test(raw.version))) ? raw as McpProxyRequest : null;
    case 'revoke':
      return only(raw, ['op', 'do_name', 'connection']) && owner && connection ? raw as McpProxyRequest : null;
    default:
      return null;
  }
};

export const parseMcpProxyReply = <T>(raw: unknown): McpProxyReply<T> | null => {
  if (!isObject(raw)) return null;
  if (raw.ok === true && Object.hasOwn(raw, 'data')) return raw as McpProxyReply<T>;
  const error = raw.error;
  if (raw.ok === false && isObject(error) && (MCP_PROXY_CODES as readonly unknown[]).includes(error.code)) return raw as McpProxyReply<T>;
  return null;
};
