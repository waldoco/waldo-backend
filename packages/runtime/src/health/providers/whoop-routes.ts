import { constantTimeEqual } from '../../connectors/constant-time';
import { signedRpc } from '../../identity/owner-directory';
import { connectRoutes, type ConnectRoutesEnv } from './provider-connect-routes';
import { callOwnerProvider } from './provider-route';
import { whoopAuthorizeUrl, WHOOP_ATTEMPT_TTL_MS, WHOOP_CALLBACK_PATH, WHOOP_START_PATH, type WhoopConfig } from './whoop-client';

// WHOOP's public edges: the start link and callback shared with every provider, and the webhook WHOOP calls, proved by
// WHOOP's signature over the exact bytes it sent.
export { WHOOP_CALLBACK_PATH, WHOOP_START_PATH };
export const WHOOP_WEBHOOK_PATH = '/events/whoop';
const MAX_WEBHOOK_BYTES = 8_192;

type OwnerNamespace = Parameters<typeof callOwnerProvider>[0];
export type WhoopRoutesEnv = ConnectRoutesEnv & Readonly<{ WHOOP_CLIENT_ID?: string; WHOOP_CLIENT_SECRET?: string; WHOOP_REDIRECT_URI?: string; OWNER_DO?: OwnerNamespace }>;
// All three or none: a deploy that sets only some of them runs no WHOOP at all. The Worker keeps the client secret only to
// verify WHOOP's webhook signature; the token exchange and refresh use the copy the edge holds in Vault.
export const whoopConfig = (env: Readonly<{ WHOOP_CLIENT_ID?: string; WHOOP_CLIENT_SECRET?: string; WHOOP_REDIRECT_URI?: string }>): (WhoopConfig & Readonly<{ clientSecret: string }>) | null =>
  env.WHOOP_CLIENT_ID && env.WHOOP_CLIENT_SECRET && env.WHOOP_REDIRECT_URI ? { clientId: env.WHOOP_CLIENT_ID, clientSecret: env.WHOOP_CLIENT_SECRET, redirectUri: env.WHOOP_REDIRECT_URI } : null;

const whoop = connectRoutes<WhoopRoutesEnv, WhoopConfig>({
  provider: 'whoop', label: 'WHOOP', slug: 'whoop', startPath: WHOOP_START_PATH, callbackPath: WHOOP_CALLBACK_PATH, state: /^[A-Za-z0-9]{8}$/,
  attemptTtlMs: WHOOP_ATTEMPT_TTL_MS, config: whoopConfig, authorizeUrl: whoopAuthorizeUrl,
  linked: 'Waldo can now read your WHOOP sleep, recovery and workouts. Your first days arrive in a few minutes. You can close this tab.',
  failed: 'WHOOP approved access but saving it failed. Start the connection again from Waldo.',
});
export const whoopPage = whoop.page;
export const handleWhoopStart = whoop.start;
export const handleWhoopCallback = whoop.callback;
const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
const log = (code: string, ok = false) => console.log(JSON.stringify({ trace: 'whoop', hop: 'whoop_edge', ok, code }));

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
// WHOOP's signature: base64 of HMAC-SHA256, keyed by the app's client secret, over the timestamp header and the raw body.
export const whoopSignature = async (clientSecret: string, timestamp: string, rawBody: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(clientSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + rawBody)));
};

// A webhook is a hint, never data: after its signature checks, only the kind of change and the record id go to the owner's
// object, which fetches the record with the owner's own token. A delivery for an account no live connection holds is
// acknowledged and dropped, so WHOOP does not retry it. Only a delivery that could not reach an owner's object asks for a retry.
export const handleWhoopWebhook = async (request: Request, env: WhoopRoutesEnv): Promise<Response> => {
  const config = whoopConfig(env), secret = env.WALDO_ROUTER_HMAC_SECRET, owners = env.OWNER_DO, call = signedRpc(env);
  if (request.method !== 'POST' || !config || !secret || !owners || !call) return notFound();
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return new Response('too large', { status: 413 });
  const raw = await request.text().catch(() => null);
  const signature = request.headers.get('x-whoop-signature') ?? '', timestamp = request.headers.get('x-whoop-signature-timestamp') ?? '';
  if (raw === null || raw.length > MAX_WEBHOOK_BYTES || !timestamp || !signature || !constantTimeEqual(signature, await whoopSignature(config.clientSecret, timestamp, raw))) { log('bad_signature'); return new Response('forbidden', { status: 403 }); }
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return new Response('ok'); }
  const { user_id: user, id, type, trace_id: trace } = body;
  // An unknown shape is acknowledged and dropped: a verified sender's noise must not become a retry storm.
  if (typeof user !== 'number' || !Number.isSafeInteger(user) || user <= 0 || typeof id !== 'string' || typeof type !== 'string' || typeof trace !== 'string') return new Response('ok');
  try {
    const rows = await call('health_provider_route', `provroute.whoop.${user}`, { p_provider: 'whoop', p_account: String(user) });
    const targets = Array.isArray(rows) ? rows.filter((row): row is { do_name: string } => typeof (row as { do_name?: unknown })?.do_name === 'string') : [];
    const answers = await Promise.all(targets.map(row => callOwnerProvider(owners, secret, row.do_name, 'hint', { type, id, trace })));
    const retry = answers.some(answer => !answer || answer.status >= 500 || answer.json.result === 'failed' || answer.json.result === 'rate_limited');
    log(retry ? 'hint_retry' : 'hint_routed', !retry);
    return retry ? new Response('owner unavailable', { status: 503 }) : new Response('ok');
  } catch { log('route_failed'); return new Response('unavailable', { status: 503 }); }
};
