// MCP client for owner-connected servers over Streamable HTTP, revision 2026-07-28, shared with the
// mcp-proxy Edge Function. A modern request carries its version, client info and capabilities in _meta
// and in the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers; there is no handshake and no session.
// A legacy server (2025-11-25 and earlier) is detected the way the spec's backward-compatibility section
// says: a 4xx whose body is not a recognised modern error. It then gets the initialize handshake.
// Every byte goes through the egress rail, so the server is pinned and its responses are capped.
import { guardedFetch } from './egress.ts';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
export type McpEra = 'modern' | 'legacy';
const CLIENT_INFO = { name: 'waldo', version: '1' };
// Codes the spec reserves for modern protocol errors (-32020 to -32099). One of these in a 4xx body
// identifies a modern server.
const MODERN_ERROR = (code: unknown) => typeof code === 'number' && code <= -32020 && code >= -32099;
const UNSUPPORTED_VERSION = -32022;

export type McpEndpoint = Readonly<{
  url: string;
  // Origins this server's traffic may reach: the server's own, recorded at connect.
  pinned: readonly string[];
  bearer?: string;
  era?: McpEra;
}>;
export type McpCallLimits = Readonly<{ maxBytes: number; timeoutMs: number }>;

// 401 or 403 with the server's WWW-Authenticate parameters (RFC 6750, RFC 9728).
export class McpChallenge extends Error {
  constructor(public readonly status: 401 | 403, public readonly challenge: WwwAuthenticate) { super(`mcp_${status}`); this.name = 'McpChallenge'; }
}
// The server answered, but not with a usable result: gone (404/410), throttled (429), down (5xx) or
// speaking something that is not MCP.
export class McpServerError extends Error {
  constructor(public readonly kind: 'not_found' | 'rate_limited' | 'unavailable' | 'protocol', public readonly status?: number, public readonly retryAfterSeconds?: number) { super(`mcp_${kind}`); this.name = 'McpServerError'; }
}
// A JSON-RPC error object from the server. The message is server text: callers never log it.
export class McpRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) { super(message); this.name = 'McpRpcError'; }
}

export type WwwAuthenticate = Readonly<{ resourceMetadata?: string; scope?: string; error?: string }>;
// Bearer and DPoP challenges carry the same parameters; values may be quoted or bare tokens.
export const parseWwwAuthenticate = (header: string | null): WwwAuthenticate => {
  if (!header || !/^\s*(bearer|dpop)\b/i.test(header)) return {};
  const field = (name: string) => header.match(new RegExp(`(?:^|[\\s,])${name}=(?:"([^"]*)"|([^\\s,]+))`, 'i'))?.slice(1).find((v) => v !== undefined);
  const out: { resourceMetadata?: string; scope?: string; error?: string } = {};
  const metadata = field('resource_metadata'), scope = field('scope'), error = field('error');
  if (metadata) out.resourceMetadata = metadata;
  if (scope) out.scope = scope;
  if (error) out.error = error;
  return out;
};

// RFC 9110 field values: visible ASCII, space and tab, with no leading or trailing whitespace. Anything
// else, and anything that already looks like the sentinel, is sent as =?base64?…?= (spec, Value Encoding).
export const headerValue = (value: string): string => {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !(value.startsWith('=?base64?') && value.endsWith('?='));
  if (plain) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
};

let nextId = 0;
const requestId = () => `w${Date.now().toString(36)}${(nextId += 1).toString(36)}`;

// Streamable HTTP answers a request with one JSON object or an SSE stream of notifications that ends
// with the response. Take the response whose id matches; anything else on the stream is ignored.
export const responseFor = (text: string, id: string): Record<string, unknown> | null => {
  const candidates: unknown[] = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { candidates.push(JSON.parse(trimmed)); } catch { return null; }
  } else {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { candidates.push(JSON.parse(data)); } catch { /* a non-JSON event is not the response */ }
    }
  }
  const flat = candidates.flatMap((value) => Array.isArray(value) ? value : [value]);
  const match = flat.find((value) => value !== null && typeof value === 'object' && (value as { id?: unknown }).id === id);
  return (match as Record<string, unknown> | undefined) ?? null;
};

const retryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
};

type Sent = Readonly<{ status: number; headers: Headers; body: Record<string, unknown> | null; text: string }>;

const post = async (fetcher: typeof fetch, endpoint: McpEndpoint, payload: Record<string, unknown>, headers: Record<string, string>, limits: McpCallLimits): Promise<Sent> => {
  const response = await guardedFetch(fetcher, endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(endpoint.bearer ? { authorization: `Bearer ${endpoint.bearer}` } : {}), ...headers },
    body: JSON.stringify(payload),
  }, { pinned: endpoint.pinned, maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs });
  const id = typeof payload.id === 'string' ? payload.id : '';
  return { status: response.status, headers: response.headers, text: response.text, body: id ? responseFor(response.text, id) : null };
};

const failFor = (sent: Sent): never => {
  if (sent.status === 401 || sent.status === 403) throw new McpChallenge(sent.status, parseWwwAuthenticate(sent.headers.get('www-authenticate')));
  if (sent.status === 404 || sent.status === 410) throw new McpServerError('not_found', sent.status);
  if (sent.status === 429) throw new McpServerError('rate_limited', 429, retryAfter(sent.headers));
  if (sent.status >= 500) throw new McpServerError('unavailable', sent.status, retryAfter(sent.headers));
  throw new McpServerError('protocol', sent.status);
};

const resultOf = (sent: Sent): unknown => {
  const error = sent.body?.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
  if (error && typeof error === 'object') throw new McpRpcError(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'error', error.data);
  if (sent.status < 200 || sent.status >= 300) failFor(sent);
  if (!sent.body || !('result' in sent.body)) throw new McpServerError('protocol', sent.status);
  return sent.body.result;
};

// Form questions for the owner only (multi round-trip requests). No sampling, roots or URL-mode
// elicitation, so a compliant server never asks Waldo for those.
const CLIENT_CAPABILITIES = { elicitation: { form: {} } };
const modernMeta = { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': CLIENT_CAPABILITIES };

const modern = async (fetcher: typeof fetch, endpoint: McpEndpoint, method: string, params: Record<string, unknown>, extra: Record<string, string>, limits: McpCallLimits): Promise<Sent> => {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
  return post(fetcher, endpoint, { jsonrpc: '2.0', id: requestId(), method, params: { ...params, _meta: { ...(params._meta as object | undefined), ...modernMeta } } },
    { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...(name === undefined ? {} : { 'mcp-name': headerValue(name) }), ...extra }, limits);
};

// Legacy: initialize, capture the optional session id, notify, then the request, all on one session.
const legacy = async (fetcher: typeof fetch, endpoint: McpEndpoint, method: string, params: Record<string, unknown>, limits: McpCallLimits): Promise<Sent> => {
  const init = await post(fetcher, endpoint, { jsonrpc: '2.0', id: requestId(), method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, {}, limits);
  const initResult = resultOf(init) as { protocolVersion?: unknown } | undefined;
  const version = typeof initResult?.protocolVersion === 'string' ? initResult.protocolVersion : LEGACY_VERSION;
  const session = init.headers.get('mcp-session-id');
  const sessionHeaders: Record<string, string> = { 'mcp-protocol-version': version, ...(session ? { 'mcp-session-id': session } : {}) };
  const notified = await post(fetcher, endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders, limits);
  if (notified.status >= 400) failFor(notified);
  return post(fetcher, endpoint, { jsonrpc: '2.0', id: requestId(), method, params }, sessionHeaders, limits);
};

const isModernBody = (sent: Sent): boolean => MODERN_ERROR((sent.body?.error as { code?: unknown } | undefined)?.code);

// One request, in the era the caller recorded or, when none is recorded yet, the era the server shows.
// Returns the era so the caller can record it for the connection.
export const mcpRequest = async (fetcher: typeof fetch, endpoint: McpEndpoint, method: string, params: Record<string, unknown>, limits: McpCallLimits, headers: Record<string, string> = {}): Promise<Readonly<{ result: unknown; era: McpEra }>> => {
  if (endpoint.era === 'legacy') return { result: resultOf(await legacy(fetcher, endpoint, method, params, limits)), era: 'legacy' };
  const sent = await modern(fetcher, endpoint, method, params, headers, limits);
  const code = (sent.body?.error as { code?: unknown } | undefined)?.code;
  if (code === UNSUPPORTED_VERSION) {
    // A modern server that does not speak 2026-07-28 but still lists a legacy revision serves it through initialize.
    const supported = (sent.body?.error as { data?: { supported?: unknown } }).data?.supported;
    if (Array.isArray(supported) && supported.some((v) => typeof v === 'string' && v <= LEGACY_VERSION)) return { result: resultOf(await legacy(fetcher, endpoint, method, params, limits)), era: 'legacy' };
    throw new McpServerError('protocol', sent.status);
  }
  const legacyShape = endpoint.era === undefined && sent.status >= 400 && sent.status < 500 && sent.status !== 401 && sent.status !== 403 && sent.status !== 429 && !isModernBody(sent);
  if (legacyShape) return { result: resultOf(await legacy(fetcher, endpoint, method, params, limits)), era: 'legacy' };
  return { result: resultOf(sent), era: 'modern' };
};
