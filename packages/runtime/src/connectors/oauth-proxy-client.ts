// The owner DO's side of the oauth-proxy Edge Function: router-signed operations by connection id. The
// DO never receives a token, code or client secret; it gets data, a token version and expiry metadata.
// The DO is the one retry owner per connection: on token_expired or reauth_needed it calls refresh once
// with the version its failing call reported, then retries once.
import { routerSignature, hex, type OwnerDirectoryEnv } from '../identity/owner-directory';
import type { ClientPins } from './mcp-oauth';
import type { McpEra } from './mcp-protocol';
import { OAUTH_PROXY_FUNCTION, OAUTH_PROXY_SIGNATURE_TAG, parseOAuthProxyReply, type CallData, type ExchangeData, type FetchData, type FetchMethod, type McpMethod, type OAuthProxyFailure, type OAuthProxyRequest, type RefreshData, type RegisterData, type RevokeData } from './oauth-proxy-wire';

export class OAuthProxyError extends Error {
  constructor(public readonly failure: OAuthProxyFailure) { super(failure.code); this.name = 'OAuthProxyError'; }
}

export type OAuthProxy = Readonly<{
  register(input: Readonly<{ issuer: string; registrationEndpoint: string; redirectUri: string; origin: string }>): Promise<RegisterData>;
  client(input: Readonly<{ issuer: string; redirectUri: string }>): Promise<RegisterData>;
  exchange(doName: string, provider: string, pins: ClientPins, code: string, options?: Readonly<{ verifier?: string; scope?: string }>): Promise<ExchangeData>;
  call(doName: string, connection: string, method: McpMethod, params: Readonly<Record<string, unknown>>, options?: Readonly<{ era?: McpEra; headers?: Readonly<Record<string, string>>; intentId?: string }>): Promise<CallData>;
  fetch(doName: string, connection: string, method: FetchMethod, path: string, query?: Readonly<Record<string, string>>): Promise<FetchData>;
  refresh(doName: string, connection: string, version?: string): Promise<RefreshData>;
  revoke(doName: string, connection: string): Promise<RevokeData>;
}>;

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const oauthProxy = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): OAuthProxy | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  if (!base || !key || !secret) return null;
  const send = async <T>(body: OAuthProxyRequest): Promise<T> => {
    const raw = JSON.stringify(body), at = Math.floor(now() / 1000);
    const write = body.op === 'call' && body.intent_id !== undefined;
    let response: Response;
    try {
      response = await fetcher(`${base}/functions/v1/${OAUTH_PROXY_FUNCTION}`, {
        method: 'POST', body: raw,
        headers: { apikey: key, 'content-type': 'application/json', 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `${OAUTH_PROXY_SIGNATURE_TAG}.${await sha256(raw)}`) },
      });
    } catch {
      // A write whose request may have reached the edge has an unknown outcome; a read is just unavailable.
      throw new OAuthProxyError({ code: write ? 'intent_pending' : 'unavailable' });
    }
    const reply = parseOAuthProxyReply<T>(await response.json().catch(() => null));
    if (!reply) throw new OAuthProxyError({ code: write ? 'intent_pending' : 'unavailable' });
    if (!reply.ok) throw new OAuthProxyError(reply.error);
    return reply.data;
  };
  return {
    register: (input) => send({ op: 'register', issuer: input.issuer, registration_endpoint: input.registrationEndpoint, redirect_uri: input.redirectUri, origin: input.origin }),
    client: (input) => send({ op: 'client', issuer: input.issuer, redirect_uri: input.redirectUri }),
    exchange: (doName, provider, pins, code, options = {}) => send({ op: 'exchange', do_name: doName, provider, pins, code, ...(options.verifier ? { verifier: options.verifier } : {}), ...(options.scope ? { scope: options.scope } : {}) }),
    call: (doName, connection, method, params, options = {}) => send({ op: 'call', do_name: doName, connection, method, params, ...(options.era ? { era: options.era } : {}), ...(options.headers && Object.keys(options.headers).length ? { headers: options.headers } : {}), ...(options.intentId ? { intent_id: options.intentId } : {}) }),
    fetch: (doName, connection, method, path, query) => send({ op: 'fetch', do_name: doName, connection, method, path, ...(query && Object.keys(query).length ? { query } : {}) }),
    refresh: (doName, connection, version) => send({ op: 'refresh', do_name: doName, connection, ...(version ? { version } : {}) }),
    revoke: (doName, connection) => send({ op: 'revoke', do_name: doName, connection }),
  };
};
