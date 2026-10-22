// Photon (Spectrum cloud) for the shared Waldo iMessage number. On Photon's shared-pool plans a phone can text the
// pool only once it is a user of Waldo's Photon project, and Photon assigns it the number to text. Adding a user goes
// through Photon's Dashboard API, which takes only a user OAuth token (no client credentials grant), so an operator
// connects their Photon account once and the Worker keeps the rotating refresh token in one Durable Object.

export type PhotonEnv = Readonly<{
  PHOTON_PROJECT_ID?: string;
  PHOTON_OAUTH_CLIENT_ID?: string;
  PHOTON_OAUTH_CLIENT_SECRET?: string;
}>;
export type PhotonConfig = Readonly<{ projectId: string; clientId: string; clientSecret: string }>;

const ORIGIN = 'https://app.photon.codes';
const ID = /^[A-Za-z0-9._-]{1,200}$/;
// projects/spectrum write cover Spectrum users; offline_access yields the refresh token.
const SCOPE = 'openid offline_access projects:read projects:write spectrum:read spectrum:write';
export const PHOTON_CALLBACK_PATH = '/imessage/photon/callback';
export const PHOTON_ATTEMPT_TTL_MS = 15 * 60_000;
const ACCESS_SLACK_MS = 60_000;
/** Every Photon call is bounded: a hung call must not hold the serialized token refresh. */
const TIMEOUT_MS = 10_000;
/** Refresh tokens live 30 days and rotate on use; a weekly refresh keeps an idle connection alive. */
export const PHOTON_KEEPALIVE_MS = 7 * 24 * 60 * 60_000;

export const photonConfig = (env: PhotonEnv): PhotonConfig | null => {
  const projectId = env.PHOTON_PROJECT_ID ?? '', clientId = env.PHOTON_OAUTH_CLIENT_ID ?? '', clientSecret = env.PHOTON_OAUTH_CLIENT_SECRET ?? '';
  return ID.test(projectId) && ID.test(clientId) && clientSecret.length >= 16 ? { projectId, clientId, clientSecret } : null;
};

/** The DO storage subset the token custody uses (a SQLite-backed DO's synchronous KV). */
export type PhotonKv = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};
type Attempt = { verifier: string; owner: string; redirectUri: string; expiresAt: number };
type Refresh = { token: string; connectedAt: number; refreshedAt: number; owner: string };
type Access = { token: string; expiresAt: number };
export type PhotonFinish = 'linked' | 'denied' | 'expired' | 'invalid' | 'failed';
export type PhotonStatus = Readonly<{ connected: boolean; connectedAt: number | null }>;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const challenge = async (verifier: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** Fixed reason codes only: never a code, token or secret. */
const failed = (reason: string): 'failed' => {
  console.log(JSON.stringify({ hop: 'photon_oauth_finish', ok: false, code: reason }));
  return 'failed';
};

/** Thrown when Photon could not be reached or answered unexpectedly: the outcome is unknown, nothing was cleared. */
export class PhotonUnavailable extends Error { constructor(readonly code: string) { super(code); } }

/**
 * Token custody inside the Photon Durable Object. The caller serializes accessToken() (blockConcurrencyWhile):
 * a refresh invalidates the token it used, so two overlapping refreshes would lose the connection.
 */
export class PhotonTokens {
  constructor(private kv: PhotonKv, private config: PhotonConfig, private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}

  async begin(owner: string, redirectUri: string): Promise<{ nonce: string; url: string }> {
    for (const [key, attempt] of this.kv.list<Attempt>({ prefix: 'photon.attempt.' })) if (attempt.expiresAt <= this.now()) this.kv.delete(key);
    const nonce = random(32), verifier = random(48);
    this.kv.put(`photon.attempt.${nonce}`, { verifier, owner, redirectUri, expiresAt: this.now() + PHOTON_ATTEMPT_TTL_MS } satisfies Attempt);
    const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    // prompt=consent: OpenID Connect issues a refresh token for offline_access only with it.
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: SCOPE, state: nonce, prompt: 'consent',
      code_challenge: await challenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
    return { nonce, url: url.toString() };
  }

  /** Single use: the attempt is spent before the code is exchanged, so a reloaded callback never redeems twice. */
  async finish(nonce: string, query: URLSearchParams): Promise<PhotonFinish> {
    const key = `photon.attempt.${nonce}`, attempt = this.kv.get<Attempt>(key);
    if (!attempt) return 'invalid';
    this.kv.delete(key);
    if (attempt.expiresAt <= this.now()) return 'expired';
    if (query.get('error')) return 'denied';
    const code = query.get('code');
    if (!code || code.length > 2048) return 'invalid';
    let tokens: Awaited<ReturnType<PhotonTokens['token']>>;
    try { tokens = await this.token({ grant_type: 'authorization_code', code, redirect_uri: attempt.redirectUri, code_verifier: attempt.verifier }); }
    catch (error) { return failed(error instanceof PhotonUnavailable ? error.code : 'photon_token_error'); }
    if (tokens === 'invalid_grant') return failed('photon_token_invalid_grant');
    if (!tokens.refresh) return failed('photon_token_no_refresh_token');
    const at = this.now();
    this.kv.put('photon.refresh', { token: tokens.refresh, connectedAt: at, refreshedAt: at, owner: attempt.owner } satisfies Refresh);
    this.kv.put('photon.access', { token: tokens.access, expiresAt: at + tokens.expiresIn * 1000 } satisfies Access);
    return 'linked';
  }

  /** Forgets the cached access token after Photon refused it, so the next call refreshes. */
  dropAccess(): void { this.kv.delete('photon.access'); }

  /** A live access token, refreshing when needed. null = not connected (or Photon refused the refresh token). */
  async accessToken(): Promise<string | null> {
    const access = this.kv.get<Access>('photon.access');
    if (access && access.expiresAt - ACCESS_SLACK_MS > this.now()) return access.token;
    return this.refresh();
  }

  /** Rotates an idle refresh token before it ages out. */
  async keepAlive(): Promise<'fresh' | 'refreshed' | 'disconnected'> {
    const stored = this.kv.get<Refresh>('photon.refresh');
    if (!stored) return 'disconnected';
    if (this.now() - stored.refreshedAt < PHOTON_KEEPALIVE_MS) return 'fresh';
    return (await this.refresh()) ? 'refreshed' : 'disconnected';
  }

  status(): PhotonStatus {
    const stored = this.kv.get<Refresh>('photon.refresh');
    return { connected: !!stored, connectedAt: stored?.connectedAt ?? null };
  }

  private async refresh(): Promise<string | null> {
    const stored = this.kv.get<Refresh>('photon.refresh');
    if (!stored) return null;
    const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: stored.token });
    // Only an invalid grant ends the connection; a bad client secret or a malformed request keeps the token.
    if (tokens === 'invalid_grant') {
      this.kv.delete('photon.refresh'); this.kv.delete('photon.access');
      return null;
    }
    const at = this.now();
    // The rotated refresh token is stored before the access token is used: the old one is already invalid.
    this.kv.put('photon.refresh', { ...stored, token: tokens.refresh ?? stored.token, refreshedAt: at } satisfies Refresh);
    this.kv.put('photon.access', { token: tokens.access, expiresAt: at + tokens.expiresIn * 1000 } satisfies Access);
    return tokens.access;
  }

  /** 'invalid_grant': Photon refused the code or refresh token. Any other failure throws PhotonUnavailable. */
  private async token(params: Record<string, string>): Promise<{ access: string; refresh: string | null; expiresIn: number } | 'invalid_grant'> {
    let response: Response;
    try {
      response = await this.fetcher(`${ORIGIN}/api/auth/oauth2/token`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...params, client_id: this.config.clientId, client_secret: this.config.clientSecret }) });
    } catch { throw new PhotonUnavailable('photon_token_unreachable'); }
    if (response.status === 400 || response.status === 401) {
      const error = (await response.json().catch(() => null) as { error?: unknown } | null)?.error;
      if (error === 'invalid_grant') return 'invalid_grant';
      throw new PhotonUnavailable(`photon_token_${typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : response.status}`);
    }
    if (!response.ok) throw new PhotonUnavailable(`photon_token_${response.status}`);
    const body = await response.json().catch(() => null) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new PhotonUnavailable('photon_token_malformed');
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 900;
    return { access: body.access_token, refresh: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null, expiresIn };
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;
/** created: Waldo made this Photon user now (rather than finding it in the project). */
export type PhotonUser = Readonly<{ userId: string; assignedNumber: string; created: boolean }>;
export type PhotonEnrollResult = PhotonUser | { error: 'unauthorized' | 'insufficient_scope' | 'refused' };

const userOf = (raw: unknown, phone: string, created: boolean): PhotonUser | null => {
  const u = raw as { id?: unknown; phoneNumber?: unknown; assignedPhoneNumber?: unknown } | null;
  return u && typeof u.id === 'string' && u.id && u.phoneNumber === phone && typeof u.assignedPhoneNumber === 'string' && E164.test(u.assignedPhoneNumber)
    ? { userId: u.id, assignedNumber: u.assignedPhoneNumber, created } : null;
};

/**
 * Find-or-create the Spectrum user for this phone in Waldo's project. Finding first makes a retry after an
 * uncertain create land on the user Photon already made instead of failing as a duplicate.
 */
export async function photonEnroll(config: PhotonConfig, token: string, person: Readonly<{ phone: string; email: string; firstName: string; lastName: string }>,
  fetcher: typeof fetch = fetch): Promise<PhotonEnrollResult> {
  const url = `${ORIGIN}/api/projects/${encodeURIComponent(config.projectId)}/spectrum/users`;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const call = async (init: RequestInit) => {
    try { return await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...headers, ...(init.headers ?? {}) } }); }
    catch { throw new PhotonUnavailable('photon_api_unreachable'); }
  };
  const refusal = (status: number): PhotonEnrollResult | null =>
    status === 401 ? { error: 'unauthorized' } : status === 403 ? { error: 'insufficient_scope' } : null;
  const find = async (created: boolean): Promise<PhotonEnrollResult | null> => {
    const response = await call({ method: 'GET' });
    const refused = refusal(response.status); if (refused) return refused;
    if (!response.ok) throw new PhotonUnavailable(`photon_users_${response.status}`);
    const body = await response.json().catch(() => null) as unknown;
    const rows = Array.isArray(body) ? body : Array.isArray((body as { users?: unknown } | null)?.users) ? (body as { users: unknown[] }).users : null;
    if (!rows) throw new PhotonUnavailable('photon_users_malformed');
    for (const row of rows) { const user = userOf(row, person.phone, created); if (user) return user; }
    return null;
  };
  const existing = await find(false);
  if (existing) return existing;
  const response = await call({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'shared', firstName: person.firstName, lastName: person.lastName, email: person.email, phoneNumber: person.phone, sendInvite: false }) });
  const refused = refusal(response.status); if (refused) return refused;
  const body = await response.json().catch(() => null) as { success?: unknown; user?: unknown; error?: unknown } | null;
  if (response.ok && body?.success === true) {
    const created = userOf(body.user, person.phone, true);
    if (created) return created;
    // Created without an assigned number in the answer: read it back.
    const readBack = await find(true);
    if (readBack) return readBack;
    throw new PhotonUnavailable('photon_user_unassigned');
  }
  // A duplicate means an earlier, unconfirmed create landed: adopt it, but never treat it as Waldo-created.
  if (response.status === 409) {
    const found = await find(false);
    if (found) return found;
    throw new PhotonUnavailable('photon_create_conflict');
  }
  if (response.status === 408 || response.status === 429) throw new PhotonUnavailable(`photon_create_${response.status}`);
  if (response.status >= 400 && response.status < 500) return { error: 'refused' };
  throw new PhotonUnavailable(`photon_create_${response.status}`);
}

/** Best effort: frees a Free-plan slot when an owner moves to another number. false = not removed (harmless). */
export async function photonRemove(config: PhotonConfig, token: string, userId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${ORIGIN}/api/projects/${encodeURIComponent(config.projectId)}/spectrum/users/${encodeURIComponent(userId)}`,
      { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    return response.ok || response.status === 404;
  } catch { return false; }
}

/** Photon wants a name per user; Waldo accounts have only an email. */
export const photonPersonName = (email: string): { firstName: string; lastName: string } => {
  const local = email.split('@')[0]?.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) ?? '';
  return { firstName: local ? local[0]!.toUpperCase() + local.slice(1) : 'Waldo', lastName: 'Waldo' };
};

export const photonDoName = (environment: string) => JSON.stringify(['photon-oauth', environment]);
