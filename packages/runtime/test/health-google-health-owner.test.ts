import { describe, expect, it } from 'vitest';
import { oauthProxy } from '../src/connectors/oauth-proxy-client';
import type { GoogleHealthConfig } from '../src/health/providers/google-health-client';
import { googleHealthOwner, holdsGoogleHealthData, type GoogleHealthLog } from '../src/health/providers/google-health-owner';
import { NOW, planeRpc, syncedClock, edge, type Plane } from './helpers/whoop-fakes';
import { routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV } from './support/oauth-edge-harness';

// The Google Health owner on the shared provider owner, against the real oauth-proxy edge running in process and a fake of
// Google's documented token, revocation, identity, list and reconcile behaviour. Every value is synthetic.
const HOUR = 3_600_000, DAY = 86_400_000;
const CONFIG: GoogleHealthConfig = { clientId: 'gh-client-fixture', redirectUri: 'https://worker.example.invalid/oauth/google-health/callback' };
const SECRET = 'gh-client-secret-fixture';
const TOKEN = 'https://oauth2.googleapis.com/token', REVOKE = 'https://oauth2.googleapis.com/revoke';
const ACCOUNT = 'HuId-Fixture7';

type Point = Record<string, unknown> & { _key: string };
type World = {
  points: Record<string, Point[]>; validAccess: Set<string>; validRefresh: Set<string>; issued: number; calls: string[]; refreshed: number; revoked: number;
  limited: boolean; notLinked: boolean; expiresIn: number;
};
const newWorld = (): World => ({ points: {}, validAccess: new Set(), validRefresh: new Set(), issued: 0, calls: [], refreshed: 0, revoked: 0, limited: false, notLinked: false, expiresIn: 3600 });
const iso = (at: number) => new Date(at).toISOString().replace('.000Z', 'Z');
const fitbit = { platform: 'FITBIT' };
const add = (world: World, type: string, key: string, body: Record<string, unknown>) => { (world.points[type] ??= []).push({ ...body, _key: key }); };
const sleepEnding = (world: World, end: number) => add(world, 'sleep', iso(end), { dataSource: fitbit, sleep: {
  interval: { startTime: iso(end - 7.5 * HOUR), startUtcOffset: '0s', endTime: iso(end), endUtcOffset: '0s' },
  metadata: { mainSleep: true }, summary: { minutesAsleep: '420', minutesInSleepPeriod: '450' }, updateTime: iso(end + HOUR),
} });
const restingOn = (world: World, day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  add(world, 'daily-resting-heart-rate', day, { dataSource: fitbit, dailyRestingHeartRate: { date: { year, month, day: date }, beatsPerMinute: '58' } });
};
const stepsFrom = (world: World, start: number, minutes: number, count = 40) => {
  for (let i = 0; i < minutes; i += 1) {
    const at = start + i * 60_000;
    add(world, 'steps', iso(at), { steps: { interval: { startTime: iso(at), startUtcOffset: '0s', endTime: iso(at + 60_000), endUtcOffset: '0s' }, count: String(count) } });
  }
};

const googleFetch = (world: World): typeof fetch => async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? 'GET';
  world.calls.push(`${method} ${url.origin}${url.pathname}`);
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
  if (`${url.origin}${url.pathname}` === TOKEN) {
    const form = new URLSearchParams(String(init?.body));
    if (form.get('client_id') !== CONFIG.clientId || form.get('client_secret') !== SECRET) return json({ error: 'invalid_client' }, 401);
    const access = () => { world.issued += 1; const token = `gh-access-${world.issued}`; world.validAccess.add(token); return token; };
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
      const refresh = `gh-refresh-${world.issued + 1}`; world.validRefresh.add(refresh);
      return json({ access_token: access(), refresh_token: refresh, expires_in: world.expiresIn, token_type: 'Bearer' });
    }
    // Google does not rotate refresh tokens: a refresh answers with an access token only.
    if (form.get('grant_type') === 'refresh_token') {
      if (!world.validRefresh.has(form.get('refresh_token') ?? '')) return json({ error: 'invalid_grant' }, 400);
      world.refreshed += 1;
      return json({ access_token: access(), expires_in: world.expiresIn, token_type: 'Bearer' });
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  if (`${url.origin}${url.pathname}` === REVOKE) { world.revoked += 1; world.validAccess.clear(); world.validRefresh.clear(); return new Response(null, { status: 200 }); }
  const bearer = /^Bearer (.+)$/.exec(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))?.[1] ?? '';
  if (!world.validAccess.has(bearer)) return json({ error: { status: 'UNAUTHENTICATED' } }, 401);
  if (world.limited) return json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429, { 'retry-after': '30' });
  const path = url.pathname.replace(/^\/v4\//, '');
  if (path === 'users/me/identity') return world.notLinked ? json({ error: { status: 'FAILED_PRECONDITION', message: 'ACCOUNT_NOT_LINKED' } }, 400) : json({ name: 'users/me/identity', healthUserId: ACCOUNT });
  const match = /^users\/me\/dataTypes\/([a-z-]+)\/dataPoints(:reconcile)?$/.exec(path);
  if (!match) return json({}, 404);
  const bounds = /^\S+ >= "([^"]+)" AND \S+ < "([^"]+)"$/.exec(url.searchParams.get('filter') ?? '');
  if (!bounds) return json({ error: { status: 'INVALID_ARGUMENT' } }, 400);
  const inside = (world.points[match[1]!] ?? []).filter(point => point._key >= bounds[1]! && point._key < bounds[2]!);
  const from = Number(url.searchParams.get('pageToken') ?? 0), size = Number(url.searchParams.get('pageSize') ?? 1440);
  const page = inside.slice(from, from + size).map(({ _key, ...point }) => point);
  return json({ dataPoints: page, ...(from + size < inside.length ? { nextPageToken: String(from + size) } : {}) });
};

const newPlane = (): Plane => {
  const vault = vaultFake({ includes: () => true } as unknown as readonly string[], { custody: { google_health: 'oauth-proxy', whoop: 'oauth-proxy' }, uniqueAccounts: ['google_health', 'whoop'] });
  vault.clients.set(`https://accounts.google.com ${CONFIG.redirectUri}`, { client_id: CONFIG.clientId, client_auth: 'client_secret_post', client_secret: SECRET });
  return { samples: new Map(), requests: new Map(), ingests: 0, consent: 'granted', model: 'granted', epoch: 1, sessions: [], handoffs: [], vault };
};

const harness = (over: { world?: World; plane?: Plane; clock?: { now: number }; configured?: boolean } = {}) => {
  const world = over.world ?? newWorld(), plane = over.plane ?? newPlane(), clock = over.clock ?? syncedClock(NOW), kv = new Map<string, unknown>();
  const logs: GoogleHealthLog[] = [], armed: number[] = [], produced = { count: 0 }, disarmed = { count: 0 };
  routeEdgeFetch(plane.vault, { fetcher: googleFetch(world) });
  const configured = over.configured !== false;
  const owner = googleHealthOwner({
    doName: () => 'owner-g', rpc: planeRpc(plane, 'owner-g', 'google_health'), config: configured ? CONFIG : null,
    proxy: configured ? oauthProxy(WORKER_ENV, workerToEdge(edge), () => clock.now) : null, now: () => clock.now, timezone: () => 'UTC',
    kv: { get: <T>(key: string) => kv.get(key) as T | undefined, put: (key, value) => { kv.set(key, value); }, delete: key => kv.delete(key), list: <T>({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)) as [string, T][] },
    produce: async () => { produced.count += 1; }, arm: async at => { armed.push(at); }, disarm: async () => { disarmed.count += 1; }, log: line => { logs.push(line); },
  });
  return { owner, world, plane, clock, kv, logs, armed, produced, disarmed };
};
const linked = async (over: Parameters<typeof harness>[0] = {}) => {
  const h = harness(over);
  expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('linked');
  return h;
};
const stored = (plane: Plane, signal: string, id: string) => plane.samples.get(`${signal}|${id}`)?.payload;

describe('Google Health owner: connecting', () => {
  it('starts only with both grants live, and hands the app a first-party start link', async () => {
    const h = harness();
    h.plane.model = 'none';
    expect(await h.owner.connect()).toEqual({ error: 'consent_required', missing: ['model_processing'] });
    h.plane.model = 'granted';
    const result = await h.owner.connect();
    if ('error' in result) throw new Error('expected a link');
    const url = new URL(result.authorize_url);
    expect([url.origin, url.pathname.startsWith('/oauth/google-health/start/'), url.searchParams.has('handoff')]).toEqual(['https://worker.example.invalid', true, true]);
    expect(url.pathname.split('/').at(-1)).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(h.plane.sessions).toHaveLength(1);
    expect(await harness({ configured: false }).owner.connect()).toEqual({ error: 'not_configured' });
  });

  it('has the edge trade the code and read the account from Google\'s identity, keeping the id in its own case, and arms the first sync', async () => {
    const h = await linked();
    expect(h.plane.vault.rows).toMatchObject([{ provider: 'google_health', account: ACCOUNT, status: 'active' }]);
    expect(h.kv.get('google_health:conn')).toMatchObject({ account: ACCOUNT });
    expect(h.armed).toEqual([NOW]);
    expect(await h.owner.status()).toEqual({ provider: 'google_health', state: 'connected', last_sync_at: null });
  });

  it('keeps nothing when Google says the account is not linked to Google Health yet', async () => {
    const world = newWorld();
    world.notLinked = true;
    const h = harness({ world });
    expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('failed');
    expect([h.plane.vault.rows.filter(row => row.status !== 'revoked').length, h.kv.has('google_health:conn')]).toEqual([0, false]);
    expect(h.logs.at(-1)).toEqual({ hop: 'google_health', ok: false, code: 'exchange_token_failed' });
  });
});

describe('Google Health owner: syncing', () => {
  it('backfills a month: the night with its vitals, and steps in whole local hours even where a window boundary cuts an hour', async () => {
    const world = newWorld(), clock = syncedClock(NOW);
    const started = NOW + 20 * 60_000;
    sleepEnding(world, Date.parse('2026-10-20T06:00:00Z'));
    restingOn(world, '2026-10-20');
    // started - 2 days is 08:20 on the 19th, a window boundary inside this hour.
    stepsFrom(world, Date.parse('2026-10-19T08:00:00Z'), 60);
    // The hour the sync runs in is still growing, so it is left for the next pass.
    stepsFrom(world, Date.parse('2026-10-21T08:05:00Z'), 10);
    const h = await linked({ world, clock });
    clock.now = started;
    expect(await h.owner.sync()).toBe('synced');
    expect(stored(h.plane, 'sleep_duration', 'google_health:sleep_duration:2026-10-20')).toMatchObject({ value: 420, utc_offset_minutes: 0 });
    expect(stored(h.plane, 'resting_heart_rate', 'google_health:resting_heart_rate:2026-10-20')).toMatchObject({ value: 58, method: 'provider_resting_daily' });
    expect(stored(h.plane, 'steps_window', 'google_health:steps_window:2026-10-19T08:00:00Z')).toMatchObject({ value: 2400 });
    expect([...h.plane.samples.keys()].filter(key => key.startsWith('steps_window|'))).toEqual(['steps_window|google_health:steps_window:2026-10-19T08:00:00Z']);
    expect([...h.plane.requests.keys()].every(id => /^google_health-[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(h.kv.get('google_health:cursor')).toMatchObject({ backfilled: true, last_sync_at: started });
    expect(h.armed.at(-1)).toBe(started + DAY);
    expect(h.produced.count).toBe(1);
  });

  it('refreshes an expired token once through the edge, which keeps Google\'s unrotated refresh token, and a refused refresh asks the owner to connect again', async () => {
    const world = newWorld(), clock = syncedClock(NOW);
    const h = await linked({ world, clock });
    clock.now = NOW + 2 * HOUR;
    expect(await h.owner.sync()).toBe('synced');
    expect(world.refreshed).toBe(1);
    clock.now = NOW + 4 * HOUR;
    expect(await h.owner.sync()).toBe('synced');
    expect(world.refreshed).toBe(2);
    world.validRefresh.clear();
    world.validAccess.clear();
    expect(await h.owner.sync()).toBe('needs_reconnect');
    expect((await h.owner.status()).state).toBe('needs_reconnect');
  });

  it('waits out Google\'s Retry-After', async () => {
    const world = newWorld(), clock = syncedClock(NOW);
    const h = await linked({ world, clock });
    world.limited = true;
    expect(await h.owner.sync()).toBe('rate_limited');
    expect(h.armed.at(-1)).toBe(NOW + 31_000);
  });

  it('stores nothing without both grants', async () => {
    const world = newWorld(), plane = newPlane(), clock = syncedClock(NOW);
    sleepEnding(world, Date.parse('2026-10-20T06:00:00Z'));
    const h = await linked({ world, plane, clock });
    plane.model = 'withdrawn';
    expect(await h.owner.sync()).toBe('consent_required');
    expect(plane.samples.size).toBe(0);
  });
});

describe('Google Health owner: webhook hints', () => {
  it('turns a burst of notifications into one prompt reconcile reaching back to the oldest change', async () => {
    const world = newWorld(), clock = syncedClock(NOW);
    const h = await linked({ world, clock });
    expect(await h.owner.sync()).toBe('synced');
    const late = Date.parse('2026-10-10T06:00:00Z');
    sleepEnding(world, late);
    const armedBefore = h.armed.length;
    expect(await h.owner.hint({ type: 'sleep', from: iso(late - 8 * HOUR), trace: 'trace-0001' })).toBe('handled');
    expect(await h.owner.hint({ type: 'steps', from: iso(NOW - HOUR), trace: 'trace-0002' })).toBe('handled');
    expect(await h.owner.hint({ type: 'sleep', from: iso(late - 8 * HOUR), trace: 'trace-0001' })).toBe('duplicate');
    expect(h.armed.slice(armedBefore)).toEqual([NOW + 5 * 60_000]);
    clock.now = NOW + 5 * 60_000;
    expect(await h.owner.sync()).toBe('synced');
    expect(stored(h.plane, 'sleep_duration', 'google_health:sleep_duration:2026-10-10')).toMatchObject({ value: 420 });
    expect(h.kv.has('google_health:dirty_from')).toBe(false);
  });

  it('ignores a type it does not map, a bad trace or time, and an owner with no connection, without calling Google', async () => {
    const h = await linked();
    const calls = h.world.calls.length;
    expect(await h.owner.hint({ type: 'heart-rate', from: iso(NOW), trace: 'trace-0003' })).toBe('ignored');
    expect(await h.owner.hint({ type: 'sleep', from: 'yesterday', trace: 'trace-0004' })).toBe('ignored');
    expect(await h.owner.hint({ type: 'sleep', from: iso(NOW), trace: 'not a trace!' })).toBe('ignored');
    expect(await harness().owner.hint({ type: 'sleep', from: iso(NOW), trace: 'trace-0005' })).toBe('ignored');
    expect(h.world.calls.length).toBe(calls);
  });

  it('arms nothing while a grant is missing', async () => {
    const h = await linked();
    h.plane.consent = 'withdrawn';
    const armed = h.armed.length;
    expect(await h.owner.hint({ type: 'sleep', from: iso(NOW - DAY), trace: 'trace-0006' })).toBe('consent_required');
    expect(h.armed.length).toBe(armed);
  });
});

describe('Google Health owner: disconnecting', () => {
  it('has the edge revoke the token at Google, and forgets the connection, cursor and marks', async () => {
    const h = await linked();
    await h.owner.hint({ type: 'sleep', from: iso(NOW - 10 * DAY), trace: 'trace-0007' });
    expect(await h.owner.disconnect()).toEqual({ revoked_at_provider: false });
    expect(h.world.revoked).toBeGreaterThan(0);
    expect([...h.kv.keys()].filter(key => key.startsWith('google_health:'))).toEqual(['google_health:held']);
    expect(h.plane.vault.rows.filter(row => row.status !== 'revoked')).toHaveLength(0);
    expect(h.disarmed.count).toBe(1);
  });

  it('marks the owner as holding Google Health data from the first link, and keeps the mark after a disconnect, since what was stored stays until storage consent is withdrawn', async () => {
    const h = harness();
    const kv = { get: <T>(key: string) => h.kv.get(key) as T | undefined };
    expect(holdsGoogleHealthData(kv)).toBe(false);
    expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('linked');
    expect(holdsGoogleHealthData(kv)).toBe(true);
    await h.owner.disconnect();
    expect([h.kv.has('google_health:conn'), holdsGoogleHealthData(kv)]).toEqual([false, true]);
    expect(holdsGoogleHealthData({ get: <T>(key: string) => (key === 'google_health:conn' ? { id: 'c' } : undefined) as T | undefined })).toBe(true);
  });

  it('keeps no reading, token or zone in a log line or in the object\'s own storage', async () => {
    const world = newWorld(), clock = syncedClock(NOW);
    sleepEnding(world, Date.parse('2026-10-20T06:00:00Z'));
    restingOn(world, '2026-10-20');
    const h = await linked({ world, clock });
    await h.owner.sync();
    const text = JSON.stringify([h.logs, [...h.kv]]);
    expect(text).not.toMatch(/gh-access|gh-refresh|"420"|\b58\b|UTC/);
  });
});
