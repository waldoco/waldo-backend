import { routerSignature, signedRpc, hex, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { GoogleError, type GoogleClient, type GoogleTokens } from './google';
import { PROXY_METHODS, validCorrelationTrace } from './proxy-methods';

// Google tokens live in Supabase Vault and are used only inside the connector-proxy Edge Function.
// The runtime holds a connection id and gets data back; it never sees a bearer or refresh token.
export type GoogleLink = Readonly<{ id: string; email: string; scopes: readonly string[] }>;
export type GoogleProxy = Readonly<{
  exchange(doName: string, code: string, redirectUri: string, codeVerifier?: string): Promise<GoogleLink | null>;
  adopt(doName: string, tokens: GoogleTokens): Promise<GoogleLink | null>;
  // sendIntent is the unique immutable approval-intent id for the sendRaw idempotency gate;
  // it rides only on sendRaw calls and is required for them at the proxy.
  client(doName: string, connection: string, health?: (error: string) => void, sendIntent?: string, correlation?: string): GoogleClient;
  revoke(doName: string, connection: string): Promise<boolean>;
}>;

// The allowlist lives once in proxy-methods.ts, shared with the Edge Function: a method must
// pass both sides. tasks/sendRaw/findSentByMessageId ride the same owner-bound signed call.
const METHODS = PROXY_METHODS;
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const googleProxy = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): GoogleProxy | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  const post = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    const at = Math.floor(now() / 1000);
    const response = await fetcher(`${base}/functions/v1/connector-proxy`, {
      method: 'POST', body: raw,
      headers: { apikey: key, 'content-type': 'application/json', 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `proxy.${await sha256(raw)}`) },
    });
    const json = await response.json().catch(() => ({ error: { status: response.status, message: 'connector proxy failed' } })) as { data?: unknown; id?: string; email?: string; scopes?: string[]; error?: { status: number; message: string } };
    if (json.error) throw new GoogleError(json.error.status, json.error.message);
    return json;
  };
  const link = (json: { id?: string; email?: string; scopes?: string[] }) => (json.id ? { id: json.id, email: json.email ?? 'google', scopes: json.scopes ?? [] } : null);
  return {
    exchange: async (doName, code, redirectUri, codeVerifier) => link(await post({ do_name: doName, op: 'exchange', code, redirect_uri: redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) })),
    adopt: async (doName, tokens) => link(await post({ do_name: doName, op: 'adopt', refresh_token: tokens.refresh_token, email: tokens.email ?? 'google', scopes: tokens.scopes ?? [] })),
    client: (doName, connection, health, sendIntent, correlation) => Object.fromEntries(METHODS.map((method) => [method, async (...args: unknown[]) => {
      try {
        // Opaque turn/trace correlation rides the signed body so the EF's structured log joins
        // the exact Telegram/Langfuse turn; invalid shapes are dropped here and rejected there.
        const trace = validCorrelationTrace(correlation);
        const { data } = await post({ do_name: doName, op: 'call', connection, method, args, ...(method === 'sendRaw' ? { intent: sendIntent ?? '' } : {}), ...(trace ? { trace } : {}) });
        health?.('');
        return data;
      } catch (error) {
        if (error instanceof GoogleError && error.status === 401) health?.(error.message);
        throw error;
      }
    }])) as unknown as GoogleClient,
    revoke: async (doName, connection) => (await rpc('connection_revoke', `connrevoke.${doName}.${connection}`, { p_do_name: doName, p_connection: connection })) === true,
  };
};
