import { APP_RETURN_DEEP_LINK } from '../../channels/google-oauth';
import { hex, signedRpc, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import { callOwnerProvider } from './provider-route';
import { WHOOP_CALLBACK_PATH, type WhoopConfig } from './whoop-client';

// The two public edges of WHOOP's connection: the page WHOOP sends the owner back to, and the webhook it calls. Neither
// carries an owner session, so each is proved another way: the callback by a single-use state that only an attempt the
// owner's own app started can match, the webhook by WHOOP's signature over the exact bytes it sent.
export { WHOOP_CALLBACK_PATH };
export const WHOOP_WEBHOOK_PATH = '/events/whoop';
const MAX_WEBHOOK_BYTES = 8_192;

type OwnerNamespace = Parameters<typeof callOwnerProvider>[0];
export type WhoopRoutesEnv = OwnerDirectoryEnv & Readonly<{
  WHOOP_CLIENT_ID?: string; WHOOP_CLIENT_SECRET?: string; WHOOP_REDIRECT_URI?: string;
  OWNER_DO?: OwnerNamespace; RESPONSIBILITY_RATE_LIMITER?: Readonly<{ limit(options: { key: string }): Promise<{ success: boolean }> }>;
}>;
// All three or none: a deploy that sets only some of them runs no WHOOP at all. The Worker keeps the client secret only to
// verify WHOOP's webhook signature; the token exchange and refresh use the copy the edge holds in Vault.
export const whoopConfig = (env: Readonly<{ WHOOP_CLIENT_ID?: string; WHOOP_CLIENT_SECRET?: string; WHOOP_REDIRECT_URI?: string }>): (WhoopConfig & Readonly<{ clientSecret: string }>) | null =>
  env.WHOOP_CLIENT_ID && env.WHOOP_CLIENT_SECRET && env.WHOOP_REDIRECT_URI ? { clientId: env.WHOOP_CLIENT_ID, clientSecret: env.WHOOP_CLIENT_SECRET, redirectUri: env.WHOOP_REDIRECT_URI } : null;

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });

const PAGES = {
  linked: { status: 200, title: 'WHOOP is connected', body: 'Waldo can now read your WHOOP sleep, recovery and workouts. Your first days arrive in a few minutes. You can close this tab.' },
  denied: { status: 400, title: 'WHOOP was not connected', body: 'Access was not granted. You can connect WHOOP from Waldo whenever you want to try again.' },
  expired: { status: 410, title: 'This link has expired', body: 'Connect links last 30 minutes. Start the connection again from Waldo.' },
  consent_required: { status: 403, title: 'WHOOP was not connected', body: 'Waldo needs your consent to store your WHOOP data and use it with AI to plan your day. Give both in Waldo, then connect again.' },
  invalid: { status: 400, title: 'This link is not valid', body: 'It may have been copied incompletely. Start the connection again from Waldo.' },
  already_linked: { status: 409, title: 'That WHOOP account is already connected', body: 'It is connected to another Waldo. Disconnect it there first, or use a different WHOOP account.' },
  failed: { status: 502, title: 'WHOOP could not be connected', body: 'WHOOP approved access but saving it failed. Start the connection again from Waldo.' },
} as const;
const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// The callback URL carries the authorization code, so the page is never cached, framed or sent as a referrer, and the
// code and state leave the address bar as soon as it loads.
export const whoopPage = (outcome: keyof typeof PAGES): Response => {
  const page = PAGES[outcome];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.title)} - Waldo</title><script>history.replaceState(null, '', location.pathname);</script>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--ok:#1f7a4d;--bad:#b3261e;--btn:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--ok:#5cc28f;--bad:#f2837a;--btn:#5b93f0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.mark{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:28px;color:#fff;background:var(${outcome === 'linked' ? '--ok' : '--bad'})}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}.button{display:inline-block;margin-top:8px;padding:12px 20px;border-radius:10px;background:var(--btn);color:#fff;text-decoration:none;font-weight:bold}</style></head>
<body><main><div class="mark" aria-hidden="true">${outcome === 'linked' ? '&#10003;' : '!'}</div><h1>${escape(page.title)}</h1><p>${escape(page.body)}</p><a class="button" href="${APP_RETURN_DEEP_LINK}">Back to the app</a></main></body></html>`;
  return new Response(html, { status: page.status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'sha256-BSHIA8uyEksveTZNsWDdE7q9p6Oqa/LdAOuySBi6RJg='; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  } });
};

const log = (code: string, ok = false) => console.log(JSON.stringify({ trace: 'whoop', hop: 'whoop_edge', ok, code }));

// WHOOP sends the owner back here. The state names one attempt, started by that owner's own app and valid for 30 minutes;
// the owner's object does the exchange, so the token never passes through this Worker.
export const handleWhoopCallback = async (request: Request, env: WhoopRoutesEnv): Promise<Response> => {
  const secret = env.WALDO_ROUTER_HMAC_SECRET, owners = env.OWNER_DO, call = signedRpc(env);
  if (request.method !== 'GET' || !whoopConfig(env) || !secret || !owners || !call) return notFound();
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? '', error = params.get('error'), code = params.get('code');
  if (!/^[A-Za-z0-9]{8}$/.test(state)) { log('bad_state'); return whoopPage(error ? 'denied' : 'invalid'); }
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try { if (env.RESPONSIBILITY_RATE_LIMITER && !(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `whoop-callback:${ip}` })).success) return new Response('slow down', { status: 429, headers: { 'cache-control': 'no-store' } }); } catch { return whoopPage('failed'); }
  const hash = await sha256(state);
  let session: { status?: string; do_name?: string } | null;
  try { session = (await call('connect_session_resolve', `connsess.resolve.${hash}`, { p_ticket_hash: hash })) as typeof session; } catch { log('resolve_failed'); return whoopPage('failed'); }
  if (!session) { log('unknown_state'); return whoopPage('invalid'); }
  if (session.status === 'expired') return whoopPage('expired');
  if (session.status !== 'ok' || !session.do_name) return whoopPage('invalid');
  const answer = await callOwnerProvider(owners, secret, session.do_name, 'exchange', { code: code ?? null, denied: Boolean(error) || !code });
  const outcome = answer?.json.outcome;
  if (outcome === 'linked') { await call('connect_session_complete', `connsess.complete.${hash}`, { p_ticket_hash: hash }).catch(() => undefined); log('linked', true); return whoopPage('linked'); }
  log(typeof outcome === 'string' ? outcome : 'owner_unreachable');
  return whoopPage(outcome === 'denied' || outcome === 'already_linked' || outcome === 'consent_required' ? outcome : 'failed');
};

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ (right[i] ?? 0);
  return diff === 0;
};
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
