import { whoopRecovery, whoopSleep, whoopWorkout, type WhoopRecovery, type WhoopSleep, type WhoopWorkout } from './whoop-map';

// WHOOP API v2: OAuth 2 (no PKCE; WHOOP documents none), rotating single-use refresh tokens, and the three record
// collections the health plane reads. Every request is bounded, every answer is parsed by whoop-map, and nothing here
// logs or returns a token to anything but its caller.
export type WhoopConfig = Readonly<{ clientId: string; clientSecret: string; redirectUri: string }>;
export type WhoopTokens = Readonly<{ access: string; refresh: string; expiresAt: number }>;
// offline is what makes a refresh token exist. The scopes are the three record kinds and the account id, no more.
export const WHOOP_SCOPES = 'offline read:profile read:sleep read:recovery read:workout';
export const WHOOP_CALLBACK_PATH = '/oauth/whoop/callback';
const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer/v2';
const TIMEOUT_MS = 15_000;
export const WHOOP_PAGE_SIZE = 25;

// unauthorized: the access token is not accepted (expired or revoked). rejected: WHOOP refused the request itself (a spent
// authorization code, a revoked refresh token, a missing scope). rate_limited carries the seconds until WHOOP's window
// resets. unavailable: WHOOP or the network failed, so trying again later is safe. malformed: an answer of the wrong shape.
export class WhoopError extends Error {
  constructor(readonly kind: 'unauthorized' | 'rejected' | 'rate_limited' | 'unavailable' | 'malformed', readonly status: number, readonly resetSeconds = 0) { super(`whoop ${kind}`); }
}

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
export type WhoopPage<T> = Readonly<{ records: readonly T[]; next: string | null; dropped: number }>;

export const whoopClient = (config: WhoopConfig, fetcher: typeof fetch, now: () => number) => {
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { throw new WhoopError('unavailable', 0); }
    if (response.ok) return response;
    void response.body?.cancel();
    if (response.status === 401) throw new WhoopError('unauthorized', 401);
    if (response.status === 429) throw new WhoopError('rate_limited', 429, Math.max(1, Math.min(3_600, Number(response.headers.get('x-ratelimit-reset')) || 60)));
    throw new WhoopError(response.status >= 500 ? 'unavailable' : 'rejected', response.status);
  };
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    const body = record(await response.json().catch(() => null));
    if (!body) throw new WhoopError('malformed', response.status);
    return body;
  };
  const api = (path: string, access: string, init: RequestInit = {}) => send(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${access}` } });

  const tokens = async (form: Record<string, string>): Promise<WhoopTokens> => {
    let response: Response;
    try {
      response = await send(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, client_id: config.clientId, client_secret: config.clientSecret }) });
    } catch (error) {
      // The token endpoint answers a spent or revoked grant with 400 or 401: the grant is gone, not the network.
      if (error instanceof WhoopError && error.kind === 'unauthorized') throw new WhoopError('rejected', 401);
      throw error;
    }
    const body = await json(response);
    const expires = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : null;
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || !body.access_token || !body.refresh_token || expires === null) throw new WhoopError('malformed', response.status);
    return { access: body.access_token, refresh: body.refresh_token, expiresAt: now() + expires * 1000 };
  };

  const page = async <T>(path: string, access: string, window: Readonly<{ start: string; end: string; next: string | null }>, parse: (raw: unknown) => T | null): Promise<WhoopPage<T>> => {
    const query = new URLSearchParams({ start: window.start, end: window.end, limit: String(WHOOP_PAGE_SIZE), ...(window.next ? { nextToken: window.next } : {}) });
    const body = await json(await api(`${path}?${query}`, access));
    const raw = Array.isArray(body.records) ? body.records : null;
    if (!raw) throw new WhoopError('malformed', 200);
    const records = raw.flatMap(item => { const parsed = parse(item); return parsed ? [parsed] : []; });
    return { records, next: typeof body.next_token === 'string' && body.next_token ? body.next_token : null, dropped: raw.length - records.length };
  };
  // One record by id; a record WHOOP no longer has is null, not an error.
  const one = async <T>(path: string, access: string, parse: (raw: unknown) => T | null): Promise<T | null> => {
    try { return parse(await json(await api(path, access))); }
    catch (error) { if (error instanceof WhoopError && error.kind === 'rejected' && error.status === 404) return null; throw error; }
  };

  return {
    authorizeUrl: (state: string): string => `${AUTH_URL}?${new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: WHOOP_SCOPES, state })}`,
    exchange: (code: string) => tokens({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
    refresh: (refresh: string) => tokens({ grant_type: 'refresh_token', refresh_token: refresh, scope: 'offline' }),
    // The account id is WHOOP's own numeric user id, the only thing that says whose data this is.
    profile: async (access: string): Promise<string> => {
      const body = await json(await api('/user/profile/basic', access));
      if (typeof body.user_id !== 'number' || !Number.isSafeInteger(body.user_id) || body.user_id <= 0) throw new WhoopError('malformed', 200);
      return String(body.user_id);
    },
    sleeps: (access: string, window: Parameters<typeof page>[2]) => page<WhoopSleep>('/activity/sleep', access, window, whoopSleep),
    recoveries: (access: string, window: Parameters<typeof page>[2]) => page<WhoopRecovery>('/recovery', access, window, whoopRecovery),
    workouts: (access: string, window: Parameters<typeof page>[2]) => page<WhoopWorkout>('/activity/workout', access, window, whoopWorkout),
    sleep: (access: string, id: string) => one(`/activity/sleep/${encodeURIComponent(id)}`, access, whoopSleep),
    workout: (access: string, id: string) => one(`/activity/workout/${encodeURIComponent(id)}`, access, whoopWorkout),
    cycleRecovery: (access: string, cycle: number) => one(`/cycle/${cycle}/recovery`, access, whoopRecovery),
    // WHOOP answers 204 and stops sharing and sending webhooks for this member.
    revoke: async (access: string): Promise<boolean> => {
      try { await api('/user/access', access, { method: 'DELETE' }); return true; } catch { return false; }
    },
  };
};
export type WhoopClient = ReturnType<typeof whoopClient>;
