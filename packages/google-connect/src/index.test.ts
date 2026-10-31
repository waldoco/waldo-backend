import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleConnectHandler,
  GOOGLE_CONNECT_SCOPES,
  type GoogleAccountGrant,
  type GoogleConnectStore,
  type PendingGoogleConnect,
} from './index';

const functionUrl = 'https://project.supabase.co/functions/v1/google-connect';
const appReturnUrl = 'https://app.waldo.example/connect/google';
const clientId = 'client-123.apps.googleusercontent.com';
const clientSecret = 'client-secret-value';
const ownerAuthId = '00000000-0000-4000-8000-0000000000a1';
const ownerUserId = '10000000-0000-4000-8000-0000000000a1';
const otherAuthId = '00000000-0000-4000-8000-0000000000b2';
const otherUserId = '20000000-0000-4000-8000-0000000000b2';
const tokens: Record<string, string> = {
  'owner.jwt.sig': ownerAuthId,
  'other.jwt.sig': otherAuthId,
};
const start = new Date('2026-10-31T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

type StateRow = { userId: string; pending: PendingGoogleConnect; expiresAt: Date; used: boolean };

function memoryStore(overrides: Partial<GoogleConnectStore> = {}) {
  const states = new Map<string, StateRow>();
  const saved: GoogleAccountGrant[] = [];
  const store: GoogleConnectStore = {
    async appUserIdForAuthUser(authUserId) {
      return { [ownerAuthId]: ownerUserId, [otherAuthId]: otherUserId }[authUserId] ?? null;
    },
    async countPendingStates(userId, now) {
      return [...states.values()].filter((row) => row.userId === userId && !row.used && row.expiresAt > now).length;
    },
    async insertState({ state, userId, pending, expiresAt }) {
      states.set(state, { userId, pending, expiresAt, used: false });
    },
    async consumeState({ state, userId, now }) {
      const row = states.get(state);
      if (!row || row.used || row.userId !== userId || row.expiresAt <= now) return null;
      row.used = true;
      return row.pending;
    },
    async saveAccount(grant) {
      const existing = saved.findIndex((row) => row.userId === grant.userId && row.providerAccountId === grant.providerAccountId);
      if (existing >= 0) {
        saved[existing] = grant;
        return { connectionId: `conn-${existing}`, created: false };
      }
      saved.push(grant);
      return { connectionId: `conn-${saved.length - 1}`, created: true };
    },
    ...overrides,
  };
  return { store, states, saved };
}

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', kid: 'google-key' })}.${encode(claims)}.signature`;
}

function googleClaims(sub: string, email: string, overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub,
    email,
    email_verified: true,
    iat: Math.floor(start.getTime() / 1000),
    exp: Math.floor(start.getTime() / 1000) + 3600,
    ...overrides,
  };
}

function googleTokenResponse(sub: string, email: string, overrides: Record<string, unknown> = {}, claimOverrides: Record<string, unknown> = {}) {
  return {
    access_token: `access-${sub}`,
    refresh_token: `refresh-${sub}`,
    expires_in: 3599,
    token_type: 'Bearer',
    scope: GOOGLE_CONNECT_SCOPES.join(' '),
    id_token: idToken(googleClaims(sub, email, claimOverrides)),
    ...overrides,
  };
}

function setup(options: {
  store?: Partial<GoogleConnectStore>;
  google?: (body: URLSearchParams) => Response | Promise<Response>;
  now?: () => Date;
} = {}) {
  const memory = memoryStore(options.store);
  const googleCalls: URLSearchParams[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'https://oauth2.googleapis.com/token') throw new Error(`unexpected fetch ${url}`);
    const body = new URLSearchParams(String(init?.body));
    googleCalls.push(body);
    if (!options.google) throw new Error('no google responder');
    return options.google(body);
  });
  const handle = createGoogleConnectHandler({
    functionUrl,
    clientId,
    clientSecret,
    appReturnUrl,
    verifyIdentity: async (token) => (tokens[token] ? { id: tokens[token] } : null),
    store: memory.store,
    fetch: fetcher as typeof fetch,
    now: options.now ?? (() => start),
  });
  return { handle, googleCalls, ...memory };
}

function post(path: string, body: unknown, token: string | null = 'owner.jwt.sig') {
  return new Request(`${functionUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startFlow(handle: (request: Request) => Promise<Response>, body?: unknown, token = 'owner.jwt.sig') {
  const response = await handle(post('/start', body, token));
  expect(response.status).toBe(200);
  const { authorization_url } = (await response.json()) as { authorization_url: string };
  return new URL(authorization_url);
}

const jsonOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('POST /start', () => {
  it('returns a Google consent URL that forces the account picker and binds a PKCE state to the caller', async () => {
    const { handle, states } = setup();

    const url = await startFlow(handle, { account_label: 'work' });

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${functionUrl}/callback`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CONNECT_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const row = states.get(state)!;
    expect(row.userId).toBe(ownerUserId);
    expect(row.pending.accountLabel).toBe('work');
    expect(row.expiresAt.getTime() - start.getTime()).toBe(10 * 60_000);
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.pending.codeVerifier)),
    ).toString('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('issues a fresh state per call so several accounts can be added one after another', async () => {
    const { handle, states } = setup();
    const first = await startFlow(handle);
    const second = await startFlow(handle);
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'));
    expect(states.size).toBe(2);
    expect([...states.values()].every((row) => row.pending.accountLabel === null)).toBe(true);
  });

  it.each([
    ['missing bearer', null, 401],
    ['unverifiable bearer', 'forged.jwt.sig', 401],
  ])('rejects a %s', async (_name, token, status) => {
    const { handle, states } = setup();
    const response = await handle(post('/start', undefined, token));
    expect(response.status).toBe(status);
    expect(states.size).toBe(0);
  });

  it('rejects an authenticated user with no Waldo account', async () => {
    const { handle, states } = setup({ store: { appUserIdForAuthUser: async () => null } });
    const response = await handle(post('/start', undefined));
    expect(response.status).toBe(403);
    expect(states.size).toBe(0);
  });

  it.each([
    ['an unknown field', { account_label: 'work', scopes: ['admin'] }],
    ['an empty label', { account_label: '   ' }],
    ['a label over 40 characters', { account_label: 'x'.repeat(41) }],
    ['a non-object body', ['work']],
  ])('rejects a body with %s', async (_name, body) => {
    const { handle, states } = setup();
    const response = await handle(post('/start', body));
    expect(response.status).toBe(400);
    expect(states.size).toBe(0);
  });

  it('rejects a declared body larger than 4 KiB before reading it', async () => {
    const { handle, states } = setup();
    const response = await handle(new Request(`${functionUrl}/start`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner.jwt.sig', 'content-length': '1000000' },
      body: '{}',
    }));
    expect(response.status).toBe(400);
    expect(states.size).toBe(0);
  });

  it('reports partially granted scopes back to the app', async () => {
    const granted = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
    const { handle, saved } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example', { scope: granted })),
    });
    const url = await startFlow(handle);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect((await jsonOf(response)).scopes).toEqual(granted.split(' '));
    expect(saved[0]!.scopes).toEqual(granted.split(' '));
  });

  it('caps unfinished connection attempts per user', async () => {
    const { handle } = setup();
    for (let attempt = 0; attempt < 5; attempt += 1) await startFlow(handle);
    const limited = await handle(post('/start', undefined));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    await startFlow(handle, undefined, 'other.jwt.sig');
  });

  it('only accepts POST', async () => {
    const { handle } = setup();
    const response = await handle(new Request(`${functionUrl}/start`));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('GET /callback', () => {
  it('hands the code and state back to the app without touching storage', async () => {
    const { handle, states } = setup();
    const state = 'a'.repeat(64);
    const response = await handle(new Request(`${functionUrl}/callback?state=${state}&code=4/0AbC-dEf_123&scope=email`));

    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(appReturnUrl);
    expect(Object.fromEntries(location.searchParams)).toEqual({ state, code: '4/0AbC-dEf_123' });
    expect(states.size).toBe(0);
  });

  it('reports a declined consent to the app', async () => {
    const { handle } = setup();
    const state = 'b'.repeat(64);
    const response = await handle(new Request(`${functionUrl}/callback?state=${state}&error=access_denied`));
    const location = new URL(response.headers.get('location')!);
    expect(Object.fromEntries(location.searchParams)).toEqual({ state, error: 'access_denied' });
  });

  it.each([
    ['a malformed state', `state=nope&code=abc`, { error: 'invalid_request' }],
    ['a missing code', `state=${'c'.repeat(64)}`, { state: 'c'.repeat(64), error: 'invalid_request' }],
    ['a code with whitespace', `state=${'c'.repeat(64)}&code=a%20b`, { state: 'c'.repeat(64), error: 'invalid_request' }],
    ['another Google error', `state=${'c'.repeat(64)}&error=server_error%3Cscript%3E`, { state: 'c'.repeat(64), error: 'failed' }],
  ])('reports %s to the app without echoing input', async (_name, query, expected) => {
    const { handle } = setup();
    const response = await handle(new Request(`${functionUrl}/callback?${query}`));
    const location = new URL(response.headers.get('location')!);
    expect(Object.fromEntries(location.searchParams)).toEqual(expected);
  });
});

describe('POST /complete', () => {
  it('connects two different Google accounts to the same Waldo user', async () => {
    const accounts = [
      { sub: '111111111111111111111', email: 'sam@work.example' },
      { sub: '222222222222222222222', email: 'sam@gmail.example' },
    ];
    let next = 0;
    const { handle, saved, googleCalls } = setup({
      google: () => {
        const account = accounts[next++]!;
        return Response.json(googleTokenResponse(account.sub, account.email));
      },
    });

    const results = [];
    for (const label of ['work', 'personal']) {
      const url = await startFlow(handle, { account_label: label });
      const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: `code-${label}` }));
      expect(response.status).toBe(200);
      results.push(await jsonOf(response));
    }

    expect(results).toEqual([
      { connection_id: 'conn-0', email: 'sam@work.example', created: true, scopes: [...GOOGLE_CONNECT_SCOPES] },
      { connection_id: 'conn-1', email: 'sam@gmail.example', created: true, scopes: [...GOOGLE_CONNECT_SCOPES] },
    ]);
    expect(saved).toEqual([
      {
        userId: ownerUserId,
        providerAccountId: accounts[0]!.sub,
        email: 'sam@work.example',
        accountLabel: 'work',
        accessToken: `access-${accounts[0]!.sub}`,
        refreshToken: `refresh-${accounts[0]!.sub}`,
        expiresAt: new Date(start.getTime() + 3599_000),
        scopes: [...GOOGLE_CONNECT_SCOPES],
      },
      expect.objectContaining({ providerAccountId: accounts[1]!.sub, accountLabel: 'personal' }),
    ]);
    expect(Object.fromEntries(googleCalls[0]!)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-work',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${functionUrl}/callback`,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('refreshes the existing connection when the same Google account is connected again', async () => {
    const { handle, saved } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example')),
    });
    for (const expected of [true, false]) {
      const url = await startFlow(handle);
      const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
      expect(await jsonOf(response)).toMatchObject({ connection_id: 'conn-0', created: expected });
    }
    expect(saved).toHaveLength(1);
  });

  it("refuses another user's state without calling Google, and leaves it usable by its owner", async () => {
    const { handle, googleCalls } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example')),
    });
    const url = await startFlow(handle);
    const state = url.searchParams.get('state');

    const stolen = await handle(post('/complete', { state, code: 'code' }, 'other.jwt.sig'));
    expect(stolen.status).toBe(400);
    expect(await jsonOf(stolen)).toEqual({ error: 'invalid_state' });
    expect(googleCalls).toHaveLength(0);

    const owned = await handle(post('/complete', { state, code: 'code' }));
    expect(owned.status).toBe(200);
  });

  it('accepts each state once, even after the Google exchange fails', async () => {
    const { handle, googleCalls, saved } = setup({
      google: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    const url = await startFlow(handle);
    const body = { state: url.searchParams.get('state'), code: 'code' };

    const failed = await handle(post('/complete', body));
    expect(failed.status).toBe(502);
    expect(await jsonOf(failed)).toEqual({ error: 'google_exchange_failed' });

    const replay = await handle(post('/complete', body));
    expect(replay.status).toBe(400);
    expect(googleCalls).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  it('rejects an expired state', async () => {
    let now = start;
    const { handle, googleCalls } = setup({ now: () => now });
    const url = await startFlow(handle);
    now = new Date(start.getTime() + 10 * 60_000);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect(response.status).toBe(400);
    expect(googleCalls).toHaveLength(0);
  });

  it.each([
    ['another client as audience', {}, { aud: 'someone-else.apps.googleusercontent.com' }],
    ['an unverified email', {}, { email_verified: false }],
    ['a foreign issuer', {}, { iss: 'https://evil.example' }],
    ['an expired id token', {}, { exp: Math.floor(start.getTime() / 1000) - 1 }],
    ['no subject', {}, { sub: '' }],
  ])('refuses to store an account whose identity has %s', async (_name, tokenOverrides, claimOverrides) => {
    const { handle, saved } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example', tokenOverrides, claimOverrides)),
    });
    const url = await startFlow(handle);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toEqual({ error: 'google_identity_invalid' });
    expect(saved).toHaveLength(0);
  });

  it.each([
    ['no refresh token', { refresh_token: undefined }],
    ['no id token', { id_token: undefined }],
    ['a non-numeric expiry', { expires_in: 'soon' }],
  ])('refuses a token response with %s', async (_name, tokenOverrides) => {
    const { handle, saved } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example', tokenOverrides)),
    });
    const url = await startFlow(handle);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect(response.status).toBe(502);
    expect(saved).toHaveLength(0);
  });

  it('reports an unreachable Google token endpoint', async () => {
    const { handle } = setup({ google: () => { throw new TypeError('network down'); } });
    const url = await startFlow(handle);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toEqual({ error: 'google_exchange_failed' });
  });

  it('fails closed without leaking tokens when storage fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handle } = setup({
      google: () => Response.json(googleTokenResponse('111111111111111111111', 'sam@work.example')),
      store: { saveAccount: async () => { throw new Error('postgrest save_account failed (500)'); } },
    });
    const url = await startFlow(handle);
    const response = await handle(post('/complete', { state: url.searchParams.get('state'), code: 'code' }));
    expect(response.status).toBe(500);
    const text = await response.text();
    const logged = JSON.stringify(errors.mock.calls);
    for (const secret of ['access-111111111111111111111', 'refresh-111111111111111111111', clientSecret, 'sam@work.example']) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  it.each([
    ['a missing code', { state: 'a'.repeat(64) }],
    ['an extra field', { state: 'a'.repeat(64), code: 'c', user_id: otherUserId }],
    ['a malformed state', { state: 'zz', code: 'c' }],
  ])('rejects a body with %s', async (_name, body) => {
    const { handle, googleCalls } = setup();
    const response = await handle(post('/complete', body));
    expect(response.status).toBe(400);
    expect(googleCalls).toHaveLength(0);
  });

  it('requires an authenticated Waldo user', async () => {
    const { handle } = setup();
    const response = await handle(post('/complete', { state: 'a'.repeat(64), code: 'c' }, null));
    expect(response.status).toBe(401);
  });
});

it('serves the same routes when the runtime strips the /functions/v1 prefix', async () => {
  const { handle } = setup();
  const response = await handle(new Request(`https://edge.internal/google-connect/start`, {
    method: 'POST',
    headers: { authorization: 'Bearer owner.jwt.sig' },
  }));
  expect(response.status).toBe(200);
  for (const path of ['/elsewhere', '/constructor', '/__proto__', '']) {
    expect((await handle(new Request(`${functionUrl}${path}`))).status).toBe(404);
  }
});
