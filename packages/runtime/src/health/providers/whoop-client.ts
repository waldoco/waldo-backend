import { HANDOFF_PARAM } from '../../channels/connect-confirm';
import type { ClientPins } from '../../connectors/mcp-oauth';
import { whoopRecovery, whoopSleep, whoopWorkout, type WhoopRecovery, type WhoopSleep, type WhoopWorkout } from './whoop-map';

// WHOOP API v2 as the owner object sees it: the oauth-proxy Edge Function holds every token and the client secret, makes
// each request under the pinned API base, and hands back only a status, the parsed body and the rate-limit headers. This
// module builds the pins the edge is told to trust, names each request as a path under that base, and parses each answer
// through whoop-map. It never sees a token.
export type WhoopConfig = Readonly<{ clientId: string; redirectUri: string }>;
// offline is what makes a refresh token exist. The scopes are the three record kinds and the account id, no more.
export const WHOOP_SCOPES = 'offline read:profile read:sleep read:recovery read:workout';
export const WHOOP_CALLBACK_PATH = '/oauth/whoop/callback';
export const WHOOP_START_PATH = '/oauth/whoop/start/';
// How long a connect the app starts stays usable: the app is told this expiry, and the browser binding lasts no longer.
export const WHOOP_ATTEMPT_TTL_MS = 30 * 60_000;
const ISSUER = 'https://api.prod.whoop.com';
const AUTH_URL = `${ISSUER}/oauth/oauth2/auth`;
const API_BASE = `${ISSUER}/developer/v2/`;
export const WHOOP_PAGE_SIZE = 25;

// WHOOP's own behaviour, pinned for the edge: a pre-issued confidential client, no PKCE, single-use rotating refresh
// tokens that need the offline scope on refresh, and the numeric user id read from the profile.
export const whoopPins = (config: WhoopConfig): ClientPins => ({
  issuer: ISSUER, token_endpoint: `${ISSUER}/oauth/oauth2/token`, client_id: config.clientId, client_auth: 'client_secret_post', redirect_uri: config.redirectUri,
  api_base: API_BASE, account_url: `${API_BASE}user/profile/basic`, account_field: 'user_id', rotation: 'single_use', refresh_scope: 'offline',
});
// The app opens Waldo's own start link, never WHOOP's page directly, so the browser that will receive the callback is
// the one that took the hop and holds the attempt's binding. It is served from the callback's origin for the same reason,
// and carries the one-time handoff code that binds the hop to the browser the app opened it in.
export const whoopStartUrl = (config: WhoopConfig, state: string, handoff: string): string => {
  const url = new URL(`${WHOOP_START_PATH}${state}`, config.redirectUri);
  url.searchParams.set(HANDOFF_PARAM, handoff);
  return url.toString();
};
export const whoopAuthorizeUrl = (config: WhoopConfig, state: string): string =>
  `${AUTH_URL}?${new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: WHOOP_SCOPES, state })}`;

// rejected: WHOOP refused the request itself (a missing scope, a bad parameter). rate_limited carries the seconds until
// WHOOP's window resets. unavailable: WHOOP failed, so trying again later is safe. malformed: an answer of the wrong shape.
export class WhoopError extends Error {
  constructor(readonly kind: 'rejected' | 'rate_limited' | 'unavailable' | 'malformed', readonly status: number, readonly resetSeconds = 0) { super(`whoop ${kind}`); }
}

// What the edge returns for a request under the pinned API base.
export type EdgeReply = Readonly<{ status: number; body: unknown; headers: Readonly<Record<string, string>> }>;
export type WhoopCall = (method: 'GET' | 'DELETE', path: string, query?: Readonly<Record<string, string>>) => Promise<EdgeReply>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
export type WhoopPage<T> = Readonly<{ records: readonly T[]; next: string | null; dropped: number }>;

export const whoopClient = (call: WhoopCall) => {
  const answer = (reply: EdgeReply): Record<string, unknown> => {
    if (reply.status === 429) throw new WhoopError('rate_limited', 429, Math.max(1, Math.min(3_600, Number(reply.headers['x-ratelimit-reset']) || 60)));
    if (reply.status < 200 || reply.status >= 300) throw new WhoopError(reply.status >= 500 ? 'unavailable' : 'rejected', reply.status);
    const body = record(reply.body);
    if (!body) throw new WhoopError('malformed', reply.status);
    return body;
  };
  const page = async <T>(path: string, window: Readonly<{ start: string; end: string; next: string | null }>, parse: (raw: unknown) => T | null): Promise<WhoopPage<T>> => {
    const body = answer(await call('GET', path, { start: window.start, end: window.end, limit: String(WHOOP_PAGE_SIZE), ...(window.next ? { nextToken: window.next } : {}) }));
    const raw = Array.isArray(body.records) ? body.records : null;
    if (!raw) throw new WhoopError('malformed', 200);
    const records = raw.flatMap(item => { const parsed = parse(item); return parsed ? [parsed] : []; });
    return { records, next: typeof body.next_token === 'string' && body.next_token ? body.next_token : null, dropped: raw.length - records.length };
  };
  // One record by id; a record WHOOP no longer has is null, not an error.
  const one = async <T>(path: string, parse: (raw: unknown) => T | null): Promise<T | null> => {
    try { return parse(answer(await call('GET', path))); }
    catch (error) { if (error instanceof WhoopError && error.kind === 'rejected' && error.status === 404) return null; throw error; }
  };

  return {
    sleeps: (window: Parameters<typeof page>[1]) => page<WhoopSleep>('activity/sleep', window, whoopSleep),
    recoveries: (window: Parameters<typeof page>[1]) => page<WhoopRecovery>('recovery', window, whoopRecovery),
    workouts: (window: Parameters<typeof page>[1]) => page<WhoopWorkout>('activity/workout', window, whoopWorkout),
    sleep: (id: string) => one(`activity/sleep/${encodeURIComponent(id)}`, whoopSleep),
    workout: (id: string) => one(`activity/workout/${encodeURIComponent(id)}`, whoopWorkout),
    cycleRecovery: (cycle: number) => one(`cycle/${cycle}/recovery`, whoopRecovery),
    // WHOOP answers 204 and stops sharing and sending webhooks for this member.
    revoke: async (): Promise<boolean> => {
      try { const reply = await call('DELETE', 'user/access'); return reply.status >= 200 && reply.status < 300; } catch { return false; }
    },
  };
};
export type WhoopClient = ReturnType<typeof whoopClient>;
