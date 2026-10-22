import { describe, expect, it } from 'vitest';
import { PHOTON_KEEPALIVE_MS, PhotonTokens, PhotonUnavailable, photonConfig, photonEnroll, photonPersonName, type PhotonKv } from '../src/channels/imessage/photon';

// Photon's Dashboard API and OAuth server are answered here; every credential is fictional.
const config = { projectId: 'proj-fixture', clientId: 'client-fixture', clientSecret: 'fictional-client-secret-0000' };
const memoryKv = (): PhotonKv & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return { map, get: <T>(k: string) => map.get(k) as T | undefined, put: (k, v) => { map.set(k, structuredClone(v)); }, delete: (k) => map.delete(k),
    list: <T>({ prefix }: { prefix: string }) => [...map.entries()].filter(([k]) => k.startsWith(prefix)) as [string, T][] };
};
type Call = { url: string; method: string; body: string; auth: string | null };
const scripted = (answers: ((call: Call) => Response)[]) => {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''), auth: new Headers(init?.headers).get('authorization') };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error(`unscripted ${call.method} ${call.url}`);
    return answer(call);
  }) as typeof fetch;
  return { fetcher, calls };
};
const tokens = (access: string, refresh?: string) => () => Response.json({ access_token: access, token_type: 'Bearer', expires_in: 900, ...(refresh ? { refresh_token: refresh } : {}) });

describe('Photon OAuth custody', () => {
  it('needs a project, a client and its secret', () => {
    expect(photonConfig({ PHOTON_PROJECT_ID: 'p', PHOTON_OAUTH_CLIENT_ID: 'c', PHOTON_OAUTH_CLIENT_SECRET: 'x'.repeat(16) })).not.toBeNull();
    expect(photonConfig({ PHOTON_PROJECT_ID: 'p', PHOTON_OAUTH_CLIENT_ID: '', PHOTON_OAUTH_CLIENT_SECRET: 'x'.repeat(16) })).toBeNull();
    expect(photonConfig({ PHOTON_PROJECT_ID: 'p/../q', PHOTON_OAUTH_CLIENT_ID: 'c', PHOTON_OAUTH_CLIENT_SECRET: 'x'.repeat(16) })).toBeNull();
  });

  it('starts with PKCE S256 and offline access, then redeems the code once', async () => {
    const kv = memoryKv(), { fetcher, calls } = scripted([tokens('access-1', 'refresh-1')]);
    const t = new PhotonTokens(kv, config, fetcher, () => 1_000);
    const { nonce, url } = await t.begin('owner-op', 'https://waldo.example/imessage/photon/callback');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://app.photon.codes/api/auth/oauth2/authorize');
    expect(u.searchParams.get('state')).toBe(nonce);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['offline_access', 'spectrum:write']));
    expect(await t.finish(nonce, new URLSearchParams({ code: 'code-1', state: nonce }))).toBe('linked');
    const exchange = new URLSearchParams(calls[0]!.body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(exchange.get('client_secret')).toBe(config.clientSecret);
    expect(t.status()).toEqual({ connected: true, connectedAt: 1_000 });
    expect(await t.finish(nonce, new URLSearchParams({ code: 'code-1' }))).toBe('invalid');
    expect(calls).toHaveLength(1);
  });

  it('refuses an expired, denied or codeless attempt without calling Photon', async () => {
    const kv = memoryKv(); let now = 0;
    const t = new PhotonTokens(kv, config, scripted([]).fetcher, () => now);
    const late = await t.begin('o', 'https://w/cb'); now = 16 * 60_000;
    expect(await t.finish(late.nonce, new URLSearchParams({ code: 'c' }))).toBe('expired');
    const denied = await t.begin('o', 'https://w/cb');
    expect(await t.finish(denied.nonce, new URLSearchParams({ error: 'access_denied' }))).toBe('denied');
    const codeless = await t.begin('o', 'https://w/cb');
    expect(await t.finish(codeless.nonce, new URLSearchParams())).toBe('invalid');
    expect(t.status().connected).toBe(false);
  });

  it('reuses a live access token and stores each rotated refresh token', async () => {
    const kv = memoryKv(); let now = 0;
    const { fetcher, calls } = scripted([tokens('access-1', 'refresh-1'), tokens('access-2', 'refresh-2'), tokens('access-3', 'refresh-3')]);
    const t = new PhotonTokens(kv, config, fetcher, () => now);
    const { nonce } = await t.begin('o', 'https://w/cb');
    await t.finish(nonce, new URLSearchParams({ code: 'c' }));
    expect(await t.accessToken()).toBe('access-1');
    now = 900_000;
    expect(await t.accessToken()).toBe('access-2');
    expect(new URLSearchParams(calls[1]!.body).get('refresh_token')).toBe('refresh-1');
    now += 900_000;
    expect(await t.accessToken()).toBe('access-3');
    expect(new URLSearchParams(calls[2]!.body).get('refresh_token')).toBe('refresh-2');
  });

  it('drops the refresh token only on invalid_grant; unreachable Photon or a bad client keeps it', async () => {
    const kv = memoryKv(); let now = 0;
    const { fetcher } = scripted([tokens('a', 'r'), () => { throw new TypeError('network'); }, () => new Response('', { status: 503 }),
      () => Response.json({ error: 'invalid_client' }, { status: 401 }), () => Response.json({ error: 'invalid_grant' }, { status: 400 })]);
    const t = new PhotonTokens(kv, config, fetcher, () => now);
    const { nonce } = await t.begin('o', 'https://w/cb'); await t.finish(nonce, new URLSearchParams({ code: 'c' }));
    now = 3_600_000;
    for (let i = 0; i < 3; i++) await expect(t.accessToken()).rejects.toBeInstanceOf(PhotonUnavailable);
    expect(t.status().connected).toBe(true);
    expect(await t.accessToken()).toBeNull();
    expect(t.status().connected).toBe(false);
  });

  it('rotates an idle refresh token weekly', async () => {
    const kv = memoryKv(); let now = 0;
    const t = new PhotonTokens(kv, config, scripted([tokens('a', 'r1'), tokens('b', 'r2')]).fetcher, () => now);
    expect(await t.keepAlive()).toBe('disconnected');
    const { nonce } = await t.begin('o', 'https://w/cb'); await t.finish(nonce, new URLSearchParams({ code: 'c' }));
    now = PHOTON_KEEPALIVE_MS - 1;
    expect(await t.keepAlive()).toBe('fresh');
    now = PHOTON_KEEPALIVE_MS;
    expect(await t.keepAlive()).toBe('refreshed');
  });
});

describe('Photon enrollment', () => {
  const person = { phone: '+15550000001', email: 'sam@example.invalid', firstName: 'Sam', lastName: 'Waldo' };
  const user = { id: 'user-1', phoneNumber: '+15550000001', assignedPhoneNumber: '+16285550100' };

  it('finds the project user already holding this phone and creates nothing', async () => {
    const { fetcher, calls } = scripted([() => Response.json([{ id: 'other', phoneNumber: '+15550000002', assignedPhoneNumber: '+16285550101' }, user])]);
    expect(await photonEnroll(config, 'tok', person, fetcher)).toEqual({ userId: 'user-1', assignedNumber: '+16285550100', created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://app.photon.codes/api/projects/proj-fixture/spectrum/users', auth: 'Bearer tok' });
  });

  it('creates a shared-pool user without an invite and returns the assigned number', async () => {
    const { fetcher, calls } = scripted([() => Response.json([]), () => Response.json({ success: true, user })]);
    expect(await photonEnroll(config, 'tok', person, fetcher)).toEqual({ userId: 'user-1', assignedNumber: '+16285550100', created: true });
    expect(JSON.parse(calls[1]!.body)).toEqual({ type: 'shared', firstName: 'Sam', lastName: 'Waldo', email: 'sam@example.invalid', phoneNumber: '+15550000001', sendInvite: false });
  });

  it('reads the number back when the create answer has none', async () => {
    const { fetcher } = scripted([() => Response.json({ users: [] }), () => Response.json({ success: true, user: { id: 'user-1', phoneNumber: '+15550000001' } }), () => Response.json({ users: [user] })]);
    expect(await photonEnroll(config, 'tok', person, fetcher)).toEqual({ userId: 'user-1', assignedNumber: '+16285550100', created: true });
  });

  it('adopts the user behind a duplicate answer as found, not created', async () => {
    const { fetcher } = scripted([() => Response.json([]), () => Response.json({ error: 'exists' }, { status: 409 }), () => Response.json([user])]);
    expect(await photonEnroll(config, 'tok', person, fetcher)).toEqual({ userId: 'user-1', assignedNumber: '+16285550100', created: false });
  });

  it('separates a disconnected token, a missing scope and a refused number from an unknown outcome', async () => {
    expect(await photonEnroll(config, 't', person, scripted([() => new Response('', { status: 401 })]).fetcher)).toEqual({ error: 'unauthorized' });
    expect(await photonEnroll(config, 't', person, scripted([() => Response.json([]), () => new Response('insufficient_scope: spectrum:write', { status: 403 })]).fetcher)).toEqual({ error: 'insufficient_scope' });
    expect(await photonEnroll(config, 't', person, scripted([() => Response.json([]), () => Response.json({ error: 'shared_user_create_failed' }, { status: 422 })]).fetcher)).toEqual({ error: 'refused' });
    await expect(photonEnroll(config, 't', person, scripted([() => Response.json([]), () => new Response('', { status: 502 })]).fetcher)).rejects.toBeInstanceOf(PhotonUnavailable);
    await expect(photonEnroll(config, 't', person, scripted([() => Response.json([]), () => new Response('', { status: 429 })]).fetcher)).rejects.toBeInstanceOf(PhotonUnavailable);
    await expect(photonEnroll(config, 't', person, scripted([() => Response.json({ unexpected: true })]).fetcher)).rejects.toBeInstanceOf(PhotonUnavailable);
  });

  it('names a Photon user from the account email', () => {
    expect(photonPersonName('sam.lee+waldo@example.invalid')).toEqual({ firstName: 'Samleewaldo', lastName: 'Waldo' });
    expect(photonPersonName('@example.invalid')).toEqual({ firstName: 'Waldo', lastName: 'Waldo' });
  });
});
