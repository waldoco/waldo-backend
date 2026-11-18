import { md5Hex } from '../../channels/md5';
import { constantTimeEqual } from '../../connectors/constant-time';
import { signedRpc } from '../../identity/owner-directory';
import { googleHealthAuthorizeUrl, GOOGLE_HEALTH_CALLBACK_PATH, GOOGLE_HEALTH_START_PATH, type GoogleHealthConfig } from './google-health-client';
import { connectRoutes, type ConnectRoutesEnv } from './provider-connect-routes';
import { callOwnerProvider } from './provider-route';

// Google Health's public edges: the shared start link and callback, and the webhook Google's subscriber calls. Google sends
// the secret Waldo set on the subscriber as the Authorization header, and challenges a new endpoint once with it and once
// without, expecting a refusal the second time.
export { GOOGLE_HEALTH_CALLBACK_PATH, GOOGLE_HEALTH_START_PATH };
export const GOOGLE_HEALTH_WEBHOOK_PATH = '/events/google-health';
const ATTEMPT_TTL_MS = 30 * 60_000;
const MAX_WEBHOOK_BYTES = 65_536;
const MAX_NOTIFICATIONS = 200;

type OwnerNamespace = Parameters<typeof callOwnerProvider>[0];
type GoogleHealthEnvVars = Readonly<{ GOOGLE_HEALTH_CLIENT_ID?: string; GOOGLE_HEALTH_REDIRECT_URI?: string; GOOGLE_HEALTH_WEBHOOK_SECRET?: string }>;
export type GoogleHealthRoutesEnv = ConnectRoutesEnv & GoogleHealthEnvVars & Readonly<{ OWNER_DO?: OwnerNamespace }>;
// Both or none. The client secret is the edge's alone; the webhook secret is checked only by the webhook.
export const googleHealthConfig = (env: GoogleHealthEnvVars): GoogleHealthConfig | null =>
  env.GOOGLE_HEALTH_CLIENT_ID && env.GOOGLE_HEALTH_REDIRECT_URI ? { clientId: env.GOOGLE_HEALTH_CLIENT_ID, redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI } : null;

const googleHealth = connectRoutes<GoogleHealthRoutesEnv, GoogleHealthConfig>({
  provider: 'google_health', label: 'Google Health', slug: 'google-health', startPath: GOOGLE_HEALTH_START_PATH, callbackPath: GOOGLE_HEALTH_CALLBACK_PATH,
  state: /^[A-Za-z0-9]{32}$/, attemptTtlMs: ATTEMPT_TTL_MS, config: googleHealthConfig, authorizeUrl: googleHealthAuthorizeUrl, exchangeBody: { provider: 'google_health' },
  linked: 'Waldo can now read your Fitbit or Pixel Watch sleep, vitals, activity and workouts from Google Health. Your first days arrive in a few minutes. You can close this tab.',
  // The most likely cause: Google has no Google Health account for this sign-in until the owner opens the Google Health app.
  failed: 'Google approved access but Waldo could not read your Google Health account. Open the Google Health app once and sign in with the same Google account (moving your Fitbit account if it asks), then connect again from Waldo.',
});
export const googleHealthPage = googleHealth.page;
export const handleGoogleHealthStart = googleHealth.start;
export const handleGoogleHealthCallback = googleHealth.callback;

const log = (code: string, ok = false) => console.log(JSON.stringify({ trace: 'google_health', hop: 'google_health_edge', ok, code }));
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const ACCOUNT = /^[\x21-\x7e]{1,63}$/;
const TYPE = /^[a-z][a-z-]{0,63}$/;

// One change Google reports: whose data, which type, and the earliest instant it touched.
type Change = Readonly<{ account: string; type: string; from: number; text: string }>;
const changeOf = (raw: unknown): Change | null => {
  const item = record(raw), data = record(item?.data) ?? item;
  if (!data || typeof data.healthUserId !== 'string' || !ACCOUNT.test(data.healthUserId) || typeof data.dataType !== 'string' || !TYPE.test(data.dataType) || !Array.isArray(data.intervals)) return null;
  const starts = data.intervals.map(interval => Date.parse(String(record(record(interval)?.physicalTimeInterval)?.startTime ?? ''))).filter(Number.isFinite);
  return starts.length ? { account: data.healthUserId, type: data.dataType, from: Math.min(...starts), text: JSON.stringify(data) } : null;
};

// A notification is a hint, never data: only the type and the earliest changed instant go to the owner's object, which
// reconciles with the owner's own token. A delivery for an account no live connection holds is acknowledged and dropped,
// and only a delivery that could not reach an owner's object asks Google to send it again.
export const handleGoogleHealthWebhook = async (request: Request, env: GoogleHealthRoutesEnv): Promise<Response> => {
  const expected = env.GOOGLE_HEALTH_WEBHOOK_SECRET, secret = env.WALDO_ROUTER_HMAC_SECRET, owners = env.OWNER_DO, call = signedRpc(env);
  if (request.method !== 'POST' || !googleHealthConfig(env) || !expected || !secret || !owners || !call) return new Response('not found', { status: 404 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return new Response('too large', { status: 413 });
  if (!constantTimeEqual(request.headers.get('authorization') ?? '', expected)) { log('unauthorized'); return new Response('unauthorized', { status: 401 }); }
  const raw = await request.text().catch(() => null);
  if (raw === null || raw.length > MAX_WEBHOOK_BYTES) return new Response('too large', { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('ok'); }
  if (record(body)?.type === 'verification') { log('verified', true); return new Response('ok'); }
  // An unknown shape is acknowledged and dropped: a verified sender's noise must not become a retry storm.
  const changes = (Array.isArray(body) ? body : [body]).slice(0, MAX_NOTIFICATIONS).map(changeOf).filter((change): change is Change => change !== null);
  const grouped = new Map<string, Change[]>();
  for (const change of changes) grouped.set(`${change.account}\u0000${change.type}`, [...(grouped.get(`${change.account}\u0000${change.type}`) ?? []), change]);
  try {
    const answers = await Promise.all([...grouped.values()].map(async group => {
      const { account, type } = group[0]!;
      const rows = await call('health_provider_route', `provroute.google_health.${account}`, { p_provider: 'google_health', p_account: account });
      const targets = Array.isArray(rows) ? rows.filter((row): row is { do_name: string } => typeof (row as { do_name?: unknown })?.do_name === 'string') : [];
      const hint = { provider: 'google_health', type, from: new Date(Math.min(...group.map(change => change.from))).toISOString(), trace: md5Hex(group.map(change => change.text).sort().join('\n')) };
      return Promise.all(targets.map(row => callOwnerProvider(owners, secret, row.do_name, 'hint', hint)));
    }));
    const retry = answers.flat().some(answer => !answer || answer.status >= 500 || answer.json.result === 'failed' || answer.json.result === 'rate_limited');
    log(retry ? 'hint_retry' : 'hint_routed', !retry);
    return retry ? new Response('owner unavailable', { status: 503 }) : new Response('ok');
  } catch { log('route_failed'); return new Response('unavailable', { status: 503 }); }
};
