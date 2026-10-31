export const GOOGLE_CONNECT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const;

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 5;
const MAX_LABEL_LENGTH = 40;
const MAX_BODY_BYTES = 4_096;
const STATE_PATTERN = /^[0-9a-f]{64}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PendingGoogleConnect {
  codeVerifier: string;
  accountLabel: string | null;
}

export interface GoogleAccountGrant {
  userId: string;
  providerAccountId: string;
  email: string;
  accountLabel: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

export interface GoogleConnectStore {
  appUserIdForAuthUser(authUserId: string): Promise<string | null>;
  countPendingStates(userId: string, now: Date): Promise<number>;
  insertState(input: { state: string; userId: string; pending: PendingGoogleConnect; expiresAt: Date }): Promise<void>;
  /** Marks the state used and returns it only if it is unused, unexpired and owned by `userId`. */
  consumeState(input: { state: string; userId: string; now: Date }): Promise<PendingGoogleConnect | null>;
  /** Creates the connection, or refreshes it when this Google account is already connected for the user. */
  saveAccount(grant: GoogleAccountGrant): Promise<{ connectionId: string; created: boolean }>;
}

export interface GoogleConnectConfig {
  functionUrl: string;
  clientId: string;
  clientSecret: string;
  appReturnUrl: string;
  verifyIdentity: (accessToken: string) => Promise<{ id: string } | null>;
  store: GoogleConnectStore;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createGoogleConnectHandler(config: GoogleConnectConfig) {
  const functionUrl = config.functionUrl.replace(/\/$/, '');
  const redirectUri = `${functionUrl}/callback`;
  const functionPath = new URL(functionUrl).pathname;
  const basePaths = [functionPath, `/${functionPath.split('/').filter(Boolean).at(-1)}`];
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());

  const routes = new Map<string, { method: string; run: (request: Request) => Promise<Response> }>([
    ['start', { method: 'POST', run: startConnect }],
    ['callback', { method: 'GET', run: async (request) => callback(request) }],
    ['complete', { method: 'POST', run: completeConnect }],
  ]);

  async function authenticatedUser(request: Request): Promise<string | Response> {
    const token = bearerToken(request.headers.get('authorization'));
    const identity = token ? await config.verifyIdentity(token) : null;
    if (!identity) return jsonResponse({ error: 'unauthorized' }, 401);
    const userId = await config.store.appUserIdForAuthUser(identity.id);
    return userId ?? jsonResponse({ error: 'no_waldo_account' }, 403);
  }

  async function startConnect(request: Request): Promise<Response> {
    const userId = await authenticatedUser(request);
    if (userId instanceof Response) return userId;

    const body = await readJsonObject(request, { optional: true });
    if (!body || !hasOnlyKeys(body, ['account_label'])) return jsonResponse({ error: 'invalid_request' }, 400);
    let accountLabel: string | null = null;
    if (body.account_label !== undefined) {
      accountLabel = typeof body.account_label === 'string' ? body.account_label.trim() : '';
      if (accountLabel.length === 0 || accountLabel.length > MAX_LABEL_LENGTH) {
        return jsonResponse({ error: 'invalid_request' }, 400);
      }
    }

    const issuedAt = now();
    if (await config.store.countPendingStates(userId, issuedAt) >= MAX_PENDING_STATES) {
      return jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': String(STATE_TTL_MS / 1000) });
    }

    const state = toHex(randomBytes(32));
    const codeVerifier = toBase64Url(randomBytes(32));
    await config.store.insertState({
      state,
      userId,
      pending: { codeVerifier, accountLabel },
      expiresAt: new Date(issuedAt.getTime() + STATE_TTL_MS),
    });

    const authorizationUrl = new URL(GOOGLE_AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_CONNECT_SCOPES.join(' '),
      access_type: 'offline',
      // select_account lets the user pick a different Google account than the one the
      // browser is signed into; consent makes Google issue a refresh token every time.
      prompt: 'select_account consent',
      state,
      code_challenge: toBase64Url(new Uint8Array(await sha256(codeVerifier))),
      code_challenge_method: 'S256',
    }).toString();
    return jsonResponse({ authorization_url: authorizationUrl.toString() });
  }

  // Google redirects the browser here. Nothing is trusted or stored: the signed-in app
  // finishes the exchange through /complete, which binds the state to the caller's account.
  function callback(request: Request): Response {
    const params = new URL(request.url).searchParams;
    const state = params.get('state');
    const code = params.get('code');
    const error = params.get('error');
    const target = new URL(config.appReturnUrl);
    if (!state || !STATE_PATTERN.test(state)) {
      target.search = new URLSearchParams({ error: 'invalid_request' }).toString();
    } else if (error) {
      target.search = new URLSearchParams({ state, error: error === 'access_denied' ? 'access_denied' : 'failed' }).toString();
    } else if (code && CODE_PATTERN.test(code)) {
      target.search = new URLSearchParams({ state, code }).toString();
    } else {
      target.search = new URLSearchParams({ state, error: 'invalid_request' }).toString();
    }
    return new Response(null, {
      status: 302,
      headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }

  async function completeConnect(request: Request): Promise<Response> {
    const userId = await authenticatedUser(request);
    if (userId instanceof Response) return userId;

    const body = await readJsonObject(request, { optional: false });
    if (
      !body || !hasOnlyKeys(body, ['state', 'code']) ||
      typeof body.state !== 'string' || !STATE_PATTERN.test(body.state) ||
      typeof body.code !== 'string' || !CODE_PATTERN.test(body.code)
    ) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }

    const pending = await config.store.consumeState({ state: body.state, userId, now: now() });
    if (!pending) return jsonResponse({ error: 'invalid_state' }, 400);

    let tokenBody: unknown;
    try {
      const response = await fetcher(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: body.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: pending.codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.error('google-connect: token exchange rejected', response.status);
        return jsonResponse({ error: 'google_exchange_failed' }, 502);
      }
      tokenBody = await response.json();
    } catch (error) {
      console.error('google-connect: token exchange failed', errorMessage(error));
      return jsonResponse({ error: 'google_exchange_failed' }, 502);
    }

    const tokens = parseTokenResponse(tokenBody);
    if (!tokens) return jsonResponse({ error: 'google_exchange_failed' }, 502);
    const receivedAt = now();
    const identity = googleIdentity(tokens.idToken, config.clientId, receivedAt);
    if (!identity) return jsonResponse({ error: 'google_identity_invalid' }, 502);

    let saved: { connectionId: string; created: boolean };
    try {
      saved = await config.store.saveAccount({
        userId,
        providerAccountId: identity.sub,
        email: identity.email,
        accountLabel: pending.accountLabel,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(receivedAt.getTime() + tokens.expiresIn * 1000),
        scopes: tokens.scopes,
      });
    } catch (error) {
      console.error('google-connect: saving the account failed', errorMessage(error));
      return jsonResponse({ error: 'storage_failed' }, 500);
    }
    // Google lets the user untick individual scopes; the app shows what was actually granted.
    return jsonResponse({
      connection_id: saved.connectionId,
      email: identity.email,
      created: saved.created,
      scopes: tokens.scopes,
    });
  }

  return async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const base = basePaths.find((candidate) => path.startsWith(`${candidate}/`));
    const route = base ? routes.get(path.slice(base.length + 1)) : undefined;
    if (!route) return jsonResponse({ error: 'not_found' }, 404);
    if (request.method !== route.method) {
      return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: route.method });
    }
    try {
      return await route.run(request);
    } catch (error) {
      console.error('google-connect: request failed', errorMessage(error));
      return jsonResponse({ error: 'internal_error' }, 500);
    }
  };
}

export function createPostgrestGoogleConnectStore(config: {
  projectUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}): GoogleConnectStore {
  const restUrl = `${config.projectUrl.replace(/\/$/, '')}/rest/v1`;
  const fetcher = config.fetch ?? fetch;

  async function rest(operation: string, path: string, init: { method?: string; body?: unknown; prefer?: string } = {}) {
    const response = await fetcher(`${restUrl}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.prefer ? { prefer: init.prefer } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(5_000),
    });
    // Status only: PostgREST error bodies can echo row values such as account emails.
    if (!response.ok) throw new Error(`postgrest ${operation} failed (${response.status})`);
    return response.status === 204 || init.prefer === 'return=minimal' ? null : await response.json() as unknown;
  }

  const query = (filters: Record<string, string>) => new URLSearchParams(filters).toString();

  return {
    async appUserIdForAuthUser(authUserId) {
      const rows = await rest('app_user', `users?${query({ select: 'id', auth_id: `eq.${authUserId}` })}`);
      const id = Array.isArray(rows) ? (rows[0] as { id?: unknown } | undefined)?.id : undefined;
      return typeof id === 'string' ? id : null;
    },
    async countPendingStates(userId, now) {
      const rows = await rest('count_states', `one_time_tokens?${query({
        select: 'token',
        user_id: `eq.${userId}`,
        kind: 'eq.oauth_state',
        used_at: 'is.null',
        expires_at: `gt.${now.toISOString()}`,
        limit: String(MAX_PENDING_STATES),
      })}`);
      return Array.isArray(rows) ? rows.length : MAX_PENDING_STATES;
    },
    async insertState({ state, userId, pending, expiresAt }) {
      await rest('insert_state', 'one_time_tokens', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          token: state,
          user_id: userId,
          kind: 'oauth_state',
          metadata: { provider: 'google', code_verifier: pending.codeVerifier, account_label: pending.accountLabel },
          expires_at: expiresAt.toISOString(),
        },
      });
    },
    async consumeState({ state, userId, now }) {
      const rows = await rest('consume_state', `one_time_tokens?${query({
        token: `eq.${state}`,
        user_id: `eq.${userId}`,
        kind: 'eq.oauth_state',
        used_at: 'is.null',
        expires_at: `gt.${now.toISOString()}`,
        select: 'metadata',
      })}`, { method: 'PATCH', prefer: 'return=representation', body: { used_at: now.toISOString() } });
      const metadata = Array.isArray(rows) && rows.length === 1
        ? (rows[0] as { metadata?: unknown }).metadata
        : undefined;
      if (!metadata || typeof metadata !== 'object') return null;
      const { provider, code_verifier: codeVerifier, account_label: accountLabel } = metadata as Record<string, unknown>;
      if (provider !== 'google' || typeof codeVerifier !== 'string' || !VERIFIER_PATTERN.test(codeVerifier)) return null;
      if (accountLabel !== null && typeof accountLabel !== 'string') return null;
      return { codeVerifier, accountLabel };
    },
    async saveAccount(grant) {
      const rows = await rest('save_account', 'rpc/save_google_oauth_account', {
        method: 'POST',
        body: {
          p_user_id: grant.userId,
          p_provider_account_id: grant.providerAccountId,
          p_account_email: grant.email,
          p_account_label: grant.accountLabel,
          p_access_token: grant.accessToken,
          p_refresh_token: grant.refreshToken,
          p_expires_at: grant.expiresAt.toISOString(),
          p_scopes: grant.scopes,
        },
      });
      const row = Array.isArray(rows) && rows.length === 1 ? rows[0] as Record<string, unknown> : undefined;
      if (typeof row?.connection_id !== 'string' || typeof row.created !== 'boolean') {
        throw new Error('postgrest save_account returned an unexpected shape');
      }
      return { connectionId: row.connection_id, created: row.created };
    },
  };
}

function parseTokenResponse(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken, expires_in: expiresIn, scope } = body;
  if (
    typeof accessToken !== 'string' || accessToken.length === 0 ||
    typeof refreshToken !== 'string' || refreshToken.length === 0 ||
    typeof idToken !== 'string' ||
    typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
    typeof scope !== 'string'
  ) {
    return null;
  }
  return { accessToken, refreshToken, idToken, expiresIn, scopes: scope.split(' ').filter(Boolean) };
}

// The ID token arrives directly from Google's token endpoint over TLS, so per OpenID
// Connect Core §3.1.3.7 the TLS server check stands in for verifying its signature.
// The claims are still checked so a token minted for another client is never accepted.
function googleIdentity(idToken: string, clientId: string, now: Date): { sub: string; email: string } | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
  } catch {
    return null;
  }
  const audience = claims.aud;
  const audienceMatches = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  if (
    typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss) ||
    !audienceMatches ||
    typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime() ||
    typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255 ||
    typeof claims.email !== 'string' || claims.email.length === 0 ||
    claims.email_verified !== true
  ) {
    return null;
  }
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}

async function readJsonObject(request: Request, options: { optional: boolean }): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length === 0) return options.optional ? {} : null;
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function bearerToken(header: string | null): string | null {
  if (!header || header.length > 8_192) return null;
  return /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}
