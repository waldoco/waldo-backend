// The owner DO's side of the mcp-proxy Edge Function: router-signed operations by connection id. The
// DO never receives a token, code or client secret; it gets data, a token version and expiry metadata.
import { routerSignature, hex, type OwnerDirectoryEnv } from '../identity/owner-directory';
import type { ClientPins } from './mcp-oauth';
import type { McpEra } from './mcp-protocol';
import { MCP_PROXY_FUNCTION, MCP_PROXY_SIGNATURE_TAG, parseMcpProxyReply, type CallData, type ExchangeData, type McpMethod, type McpProxyFailure, type McpProxyRequest, type RefreshData, type RegisterData, type RevokeData } from './mcp-proxy-wire';

export class McpProxyError extends Error {
  constructor(public readonly failure: McpProxyFailure) { super(failure.code); this.name = 'McpProxyError'; }
}

export type McpProxy = Readonly<{
  register(input: Readonly<{ issuer: string; registrationEndpoint: string; redirectUri: string; origin: string }>): Promise<RegisterData>;
  exchange(doName: string, pins: ClientPins, code: string, verifier: string, scope?: string): Promise<ExchangeData>;
  call(doName: string, connection: string, method: McpMethod, params: Readonly<Record<string, unknown>>, options?: Readonly<{ era?: McpEra; headers?: Readonly<Record<string, string>>; intentId?: string }>): Promise<CallData>;
  refresh(doName: string, connection: string, version?: string): Promise<RefreshData>;
  revoke(doName: string, connection: string): Promise<RevokeData>;
}>;

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const mcpProxy = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): McpProxy | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  if (!base || !key || !secret) return null;
  const send = async <T>(body: McpProxyRequest): Promise<T> => {
    const raw = JSON.stringify(body), at = Math.floor(now() / 1000);
    const write = body.op === 'call' && body.intent_id !== undefined;
    let response: Response;
    try {
      response = await fetcher(`${base}/functions/v1/${MCP_PROXY_FUNCTION}`, {
        method: 'POST', body: raw,
        headers: { apikey: key, 'content-type': 'application/json', 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `${MCP_PROXY_SIGNATURE_TAG}.${await sha256(raw)}`) },
      });
    } catch {
      // A write whose request may have reached the edge has an unknown outcome; a read is just unavailable.
      throw new McpProxyError({ code: write ? 'intent_pending' : 'unavailable' });
    }
    const reply = parseMcpProxyReply<T>(await response.json().catch(() => null));
    if (!reply) throw new McpProxyError({ code: write ? 'intent_pending' : 'unavailable' });
    if (!reply.ok) throw new McpProxyError(reply.error);
    return reply.data;
  };
  return {
    register: (input) => send({ op: 'register', issuer: input.issuer, registration_endpoint: input.registrationEndpoint, redirect_uri: input.redirectUri, origin: input.origin }),
    exchange: (doName, pins, code, verifier, scope) => send({ op: 'exchange', do_name: doName, pins, code, verifier, ...(scope ? { scope } : {}) }),
    call: (doName, connection, method, params, options = {}) => send({ op: 'call', do_name: doName, connection, method, params, ...(options.era ? { era: options.era } : {}), ...(options.headers && Object.keys(options.headers).length ? { headers: options.headers } : {}), ...(options.intentId ? { intent_id: options.intentId } : {}) }),
    refresh: (doName, connection, version) => send({ op: 'refresh', do_name: doName, connection, ...(version ? { version } : {}) }),
    revoke: (doName, connection) => send({ op: 'revoke', do_name: doName, connection }),
  };
};
