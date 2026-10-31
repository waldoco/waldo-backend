import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGoogleConnectHandler, createPostgrestGoogleConnectStore, GOOGLE_CONNECT_SCOPES } from '../src/index';

type LocalSupabase = Readonly<{ API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }>;
type TestUser = { authId: string; userId: string; accessToken: string };

const clientId = 'local-client.apps.googleusercontent.com';
const functionUrl = 'http://127.0.0.1:54321/functions/v1/google-connect';

describe.sequential('google-connect against local Supabase Auth and REST', () => {
  let local: LocalSupabase;
  const users: TestUser[] = [];
  const googleAccounts = new Map<string, { sub: string; email: string }>();

  const rest = (path: string, init: { method?: string; body?: unknown; token?: string; key?: string } = {}) => {
    const key = init.key ?? local.SECRET_KEY;
    return fetch(`${local.API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: key,
        authorization: `Bearer ${init.token ?? key}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };

  async function createUser(): Promise<TestUser> {
    const email = `google-connect-${randomUUID()}@example.invalid`;
    const password = `Gc-${randomUUID()}`;
    const created = await rest('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    if (!created.ok) throw new Error(`local test-user creation failed (${created.status})`);
    const authId = ((await created.json()) as { id: string }).id;
    const profile = await fetch(`${local.API_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        apikey: local.SECRET_KEY,
        authorization: `Bearer ${local.SECRET_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({ auth_id: authId, name: 'Local Test', email }),
    });
    if (!profile.ok) throw new Error(`local Waldo user creation failed (${profile.status})`);
    const userId = ((await profile.json()) as [{ id: string }])[0].id;
    const signedIn = await rest('/auth/v1/token?grant_type=password', { key: local.PUBLISHABLE_KEY, method: 'POST', body: { email, password } });
    if (!signedIn.ok) throw new Error(`local sign-in failed (${signedIn.status})`);
    const user = { authId, userId, accessToken: ((await signedIn.json()) as { access_token: string }).access_token };
    users.push(user);
    return user;
  }

  function fakeGoogleIdToken(sub: string, email: string) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const nowSeconds = Math.floor(Date.now() / 1000);
    return `${encode({ alg: 'RS256' })}.${encode({
      iss: 'https://accounts.google.com', aud: clientId, sub, email, email_verified: true, iat: nowSeconds, exp: nowSeconds + 3600,
    })}.sig`;
  }

  const googleOnlyFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url !== 'https://oauth2.googleapis.com/token') return fetch(input, init);
    const code = new URLSearchParams(String(init?.body)).get('code')!;
    const account = googleAccounts.get(code);
    if (!account) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({
      access_token: `access-${account.sub}-${randomUUID()}`,
      refresh_token: `refresh-${account.sub}-${randomUUID()}`,
      expires_in: 3599,
      scope: GOOGLE_CONNECT_SCOPES.join(' '),
      id_token: fakeGoogleIdToken(account.sub, account.email),
    });
  };

  let handle: (request: Request) => Promise<Response>;

  const call = (path: string, user: TestUser, body?: unknown) => handle(new Request(`${functionUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.accessToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));

  async function begin(user: TestUser, label?: string) {
    const response = await call('/start', user, label ? { account_label: label } : undefined);
    expect(response.status).toBe(200);
    return new URL(((await response.json()) as { authorization_url: string }).authorization_url).searchParams.get('state')!;
  }

  beforeAll(async () => {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const status = spawnSync(npx, ['-y', 'supabase@2.109.1', 'status', '--output', 'json'], {
      cwd: new URL('../../..', import.meta.url), encoding: 'utf8',
    });
    if (status.error) throw status.error;
    if (status.status !== 0) throw new Error('local Supabase status is unavailable');
    local = JSON.parse(status.stdout) as LocalSupabase;
    if (local.API_URL !== 'http://127.0.0.1:54321' || !local.PUBLISHABLE_KEY || !local.SECRET_KEY) {
      throw new Error('local Supabase Auth/REST services are not running');
    }
    handle = createGoogleConnectHandler({
      functionUrl,
      clientId,
      clientSecret: 'local-client-secret',
      appReturnUrl: 'https://app.waldo.example/connect/google',
      // The production verifier requires https; local Auth serves http, so call its /user directly.
      verifyIdentity: async (token) => {
        const response = await rest('/auth/v1/user', { key: local.PUBLISHABLE_KEY, token });
        return response.ok ? { id: ((await response.json()) as { id: string }).id } : null;
      },
      store: createPostgrestGoogleConnectStore({ projectUrl: local.API_URL, serviceRoleKey: local.SECRET_KEY }),
      fetch: googleOnlyFetch,
    });
  });

  afterAll(async () => {
    for (const user of users) {
      await rest(`/rest/v1/users?id=eq.${user.userId}`, { method: 'DELETE' });
      await rest(`/auth/v1/admin/users/${user.authId}`, { method: 'DELETE' });
    }
  });

  it('connects a work and a personal Google account to one user, then refreshes on reconnect', async () => {
    const sam = await createUser();
    googleAccounts.set('code-work', { sub: `sub-work-${randomUUID()}`, email: 'sam@work.example' });
    googleAccounts.set('code-personal', { sub: `sub-personal-${randomUUID()}`, email: 'sam@gmail.example' });

    for (const [label, code] of [['work', 'code-work'], ['personal', 'code-personal'], [undefined, 'code-work']] as const) {
      const response = await call('/complete', sam, { state: await begin(sam, label), code });
      expect(response.status).toBe(200);
    }

    const rows = await rest(`/rest/v1/oauth_tokens?user_id=eq.${sam.userId}&select=provider,provider_account_id,account_email,account_label,access_token_enc,refresh_token_enc&order=account_email`);
    expect(rows.status).toBe(200);
    const stored = (await rows.json()) as Array<Record<string, string>>;
    expect(stored.map(({ provider, account_email, account_label }) => ({ provider, account_email, account_label }))).toEqual([
      { provider: 'google', account_email: 'sam@gmail.example', account_label: 'personal' },
      { provider: 'google', account_email: 'sam@work.example', account_label: 'work' },
    ]);
    for (const row of stored) {
      expect(row.access_token_enc).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.refresh_token_enc).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("rejects another user's state and accepts each state once", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    googleAccounts.set('code-owner', { sub: `sub-owner-${randomUUID()}`, email: 'owner@example.invalid' });
    const state = await begin(owner);

    const stolen = await call('/complete', intruder, { state, code: 'code-owner' });
    expect(stolen.status).toBe(400);
    expect((await call('/complete', owner, { state, code: 'code-owner' })).status).toBe(200);
    expect((await call('/complete', owner, { state, code: 'code-owner' })).status).toBe(400);

    const intruderRows = await rest(`/rest/v1/oauth_tokens?user_id=eq.${intruder.userId}&select=id`);
    expect(await intruderRows.json()).toEqual([]);
  });

  it('keeps tokens and states unreadable to the signed-in user', async () => {
    const user = await createUser();
    for (const table of ['oauth_tokens', 'one_time_tokens']) {
      const response = await rest(`/rest/v1/${table}?select=*`, { key: local.PUBLISHABLE_KEY, token: user.accessToken });
      expect(response.ok).toBe(false);
    }
    const rpc = await rest('/rest/v1/rpc/save_google_oauth_account', {
      key: local.PUBLISHABLE_KEY,
      token: user.accessToken,
      method: 'POST',
      body: {
        p_user_id: user.userId, p_provider_account_id: 'x', p_account_email: 'x@example.invalid', p_account_label: null,
        p_access_token: 'a', p_refresh_token: 'r', p_expires_at: new Date().toISOString(), p_scopes: [],
      },
    });
    expect(rpc.ok).toBe(false);
  });
});
