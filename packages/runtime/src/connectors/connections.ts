import { routerSignature, signedRpc, hex, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { ProxyIntentError, type ProxyIntent } from './proxy-intent';
import { GOOGLE_METHODS, GoogleError, parseGoogleProfile, type GoogleClient, type GoogleProfile, type GoogleTokens } from './google';
import type { CalendarWatch, GmailWatch } from './google-push';

// Google tokens live in Supabase Vault and are used only inside the connector-proxy Edge Function.
// The runtime holds a connection id and gets data back; it never sees a bearer or refresh token.
export type GoogleLink = Readonly<{ id: string; email: string; scopes: readonly string[]; profile?: GoogleProfile }>;
export type GoogleProxy = Readonly<{
  exchange(doName: string, code: string, redirectUri: string, codeVerifier?: string): Promise<GoogleLink | null>;
  adopt(doName: string, tokens: GoogleTokens): Promise<GoogleLink | null>;
  client(doName: string, connection: string, health?: (error: string) => void, intent?: ProxyIntent): GoogleClient;
  // Google-auth MCP servers (WALDO_MCP_SERVERS entries with auth:'google') on a Vault-backed
  // grant: the edge attaches the token and runs the call; the runtime never sees a bearer.
  mcpCall(doName: string, connection: string, serverUrl: string, tool: string, args: Record<string, unknown>, intent?: ProxyIntent): Promise<unknown>;
  // Calendar push channels: the edge starts and stops them with the grant's token.
  calendarWatch(doName: string, connection: string, input: Readonly<{ channelId: string; token: string; address: string }>): Promise<CalendarWatch>;
  stopChannel(doName: string, connection: string, channel: Readonly<{ channelId: string; resourceId: string }>): Promise<void>;
  gmailWatch(doName: string, connection: string, topic: string): Promise<GmailWatch>;
  revoke(doName: string, connection: string): Promise<boolean>;
}>;

const METHODS = GOOGLE_METHODS;
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const googleProxy = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): GoogleProxy | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  const post = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    // A bounded read has no ledger row and no effect to reconcile, so edge errors keep their provider status
    // (401/403 drive the owner reconnect path) instead of collapsing into intent errors.
    const ledgered = Boolean(body.intent_id) && body.read_only !== true;
    const at = Math.floor(now() / 1000);
    let response: Response;
    try { response = await fetcher(`${base}/functions/v1/connector-proxy`, {
      method: 'POST', body: raw,
      headers: { apikey: key, 'content-type': 'application/json', 'x-waldo-at': String(at), 'x-waldo-sig': await routerSignature(secret, at, `proxy.${await sha256(raw)}`) },
    }); } catch(error) {
      if(ledgered)throw new ProxyIntentError('intent_pending');
      throw error;
    }
    const json = await response.json().catch(() => ({ error: { status: response.status, message: ledgered ? 'intent_pending' : 'connector proxy failed' } })) as { data?: unknown; id?: string; email?: string; scopes?: string[]; profile?: unknown; error?: { reason?: unknown; status: number; message: string } };
    if (ledgered && (!json || typeof json!=='object' || (!json.error && (!response.ok || !Object.hasOwn(json,'data'))))) throw new ProxyIntentError('intent_pending');
    if (json.error?.message === 'intent_pending' || json.error?.message === 'intent_conflict' || json.error?.message === 'intent_required' || json.error?.message === 'intent_unavailable') throw new ProxyIntentError(json.error.message);
    if (ledgered && json.error) throw new ProxyIntentError('intent_unavailable');
    if (json.error) throw new GoogleError(json.error.status, json.error.message, json.error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || json.error.reason === 'SERVICE_DISABLED' ? json.error.reason : undefined);
    return json;
  };
  // An edge that predates the profile sends no key, which leaves a kept profile as it is. A sent profile is parsed by the
  // same shape rules as at the edge; a malformed one reads as empty, which clears the kept one, and never fails the link.
  const link = (json: { id?: string; email?: string; scopes?: string[]; profile?: unknown }): GoogleLink | null => (json.id ? { id: json.id, email: json.email ?? 'google', scopes: json.scopes ?? [], ...(Object.hasOwn(json, 'profile') ? { profile: parseGoogleProfile(json.profile) } : {}) } : null);
  return {
    exchange: async (doName, code, redirectUri, codeVerifier) => link(await post({ do_name: doName, op: 'exchange', code, redirect_uri: redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) })),
    adopt: async (doName, tokens) => link(await post({ do_name: doName, op: 'adopt', refresh_token: tokens.refresh_token, email: tokens.email ?? 'google', scopes: tokens.scopes ?? [] })),
    client: (doName, connection, health, intent) => ({ account: { connection_id: connection, email: null }, ...Object.fromEntries(METHODS.map((method) => [method, async (...args: unknown[]) => {
      try {
        // JSON arrays cannot hold undefined: an omitted trailing optional arg (sendRaw's threadId,
        // moveEvent/cancelEvent's etag) would cross the wire as null and fail typed validation.
        const wireArgs = [...args];
        while (wireArgs.length > 0 && wireArgs[wireArgs.length - 1] === undefined) wireArgs.pop();
        const effect = ['draft','sendRaw','createEvent','moveEvent','cancelEvent','createTask','patchTask'].includes(method);
        if(effect&&!intent)throw new ProxyIntentError('intent_required');
        // This Worker reads calendar detail fields, so it asks for them; a proxy that predates them ignores the key.
        const { data } = await post({ do_name: doName, op: 'call', connection, method, args: wireArgs, calendar_details: true, ...(effect?{intent_id:intent!.id}:{}) });
        health?.('');
        return data;
      } catch (error) {
        if (error instanceof GoogleError && error.status === 401) health?.(error.message);
        throw error;
      }
    }])) }) as unknown as GoogleClient,
    mcpCall: async (doName, connection, serverUrl, tool, args, intent) => {
      if(!intent)throw new ProxyIntentError('intent_required');
      // A host-derived read intent says so on the wire. The edge must still match server and tool against its own
      // read registry before it skips the ledger; this flag alone never lets a call skip anything.
      const readOnly = intent.readOnly === true && intent.id.startsWith('mcpread:');
      return(await post({ do_name: doName, op: 'mcp_call', connection, server_url: serverUrl, tool, args: [args], intent_id:intent.id, ...(readOnly ? { read_only: true } : {}) })).data;
    },
    calendarWatch: async (doName, connection, input) => {
      const { data } = await post({ do_name: doName, op: 'calendar_watch', connection, channel_id: input.channelId, token: input.token, address: input.address }) as { data?: { channelId?: unknown; resourceId?: unknown; expiration?: unknown } };
      if (data?.channelId !== input.channelId || typeof data.resourceId !== 'string' || typeof data.expiration !== 'number' || !Number.isSafeInteger(data.expiration)) throw new Error('calendar watch reply malformed');
      return { channelId: input.channelId, resourceId: data.resourceId, expiration: data.expiration };
    },
    stopChannel: async (doName, connection, channel) => { await post({ do_name: doName, op: 'channel_stop', connection, channel_id: channel.channelId, resource_id: channel.resourceId }); },
    gmailWatch: async (doName, connection, topic) => {
      const { data } = await post({ do_name: doName, op: 'gmail_watch', connection, topic }) as { data?: { historyId?: unknown; expiration?: unknown } };
      if (typeof data?.historyId !== 'string' || !/^\d{1,30}$/.test(data.historyId) || typeof data.expiration !== 'number' || !Number.isSafeInteger(data.expiration)) throw new Error('gmail watch reply malformed');
      return { historyId: data.historyId, expiration: data.expiration };
    },
    revoke: async (doName, connection) => (await rpc('connection_revoke', `connrevoke.${doName}.${connection}`, { p_do_name: doName, p_connection: connection })) === true,
  };
};
