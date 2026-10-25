import { afterEach, expect, vi } from 'vitest';
import { healthIngestV1Schema } from '../../../contracts/src/app/health-ingest';
import { oauthProxy } from '../../src/connectors/oauth-proxy-client';
import type { WhoopConfig } from '../../src/health/providers/whoop-client';
import { whoopOwner, type WhoopLog } from '../../src/health/providers/whoop-owner';
import { recoveryRecord, sleepRecord, workoutRecord } from '../fixtures/whoop-synthetic';
import { loadEdge, routeEdgeFetch, vaultFake, workerToEdge, WORKER_ENV, type VaultFake } from '../support/oauth-edge-harness';

// Recorded fakes for WHOOP's API and for the health plane's database calls, written from the provider's documented
// behaviour and the database functions' own rules (consent, epoch, revision order, idempotency); every value is synthetic.
// Tokens are not faked at the owner's seam: the owner object talks to the real oauth-proxy Edge Function running in
// process, over a Vault stand-in with the migration's custody, compare-and-set and unique-account rules, so a call to a
// function the database does not have fails here as it would there.
export const DAY = 86_400_000;
export const NOW = Date.parse('2026-10-21T08:00:00Z');
export const CONFIG: WhoopConfig = { clientId: 'client-id-fixture', redirectUri: 'https://worker.example.invalid/oauth/whoop/callback' };
// The edge's own copy of the client secret, entered at deploy; the owner object never gets it.
export const CLIENT_SECRET = 'client-secret-fixture';
export const WHOOP_ISSUER = 'https://api.prod.whoop.com';

export type World = {
  sleeps: Record<string, unknown>[]; recoveries: Record<string, unknown>[]; workouts: Record<string, unknown>[];
  validAccess: Set<string>; validRefresh: Set<string>; spent: string[]; calls: string[]; issued: number;
  pageSize: number; limited: { until: number } | null; breakAfter: { path: string; count: number; status: number } | null; revokeStatus: number; account: number;
};
export const newWorld = (): World => ({ sleeps: [], recoveries: [], workouts: [], validAccess: new Set(), validRefresh: new Set(), spent: [], calls: [], issued: 0, pageSize: 25, limited: null, breakAfter: null, revokeStatus: 204, account: 70001 });

// One night, i days before today, with the recovery WHOOP scored for it.
export const night = (i: number, over: { sleep?: Record<string, unknown>; recovery?: Record<string, unknown> | null } = {}) => {
  const end = Date.UTC(2026, 9, 21 - i, 6, 0, 0);
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const sleep = sleepRecord({ id, cycle_id: 900000 + i, start: new Date(end - 7.5 * 3_600_000).toISOString(), end: new Date(end).toISOString(), created_at: new Date(end).toISOString(), updated_at: new Date(end + 1_800_000).toISOString(), ...over.sleep });
  const recovery = over.recovery === null ? null : recoveryRecord({ sleep_id: id, cycle_id: 900000 + i, created_at: new Date(end).toISOString(), updated_at: new Date(end + 2_100_000).toISOString(), ...over.recovery });
  return { sleep, recovery };
};
export const addNight = (world: World, i: number, over: Parameters<typeof night>[1] = {}) => { const n = night(i, over); world.sleeps.push(n.sleep); if (n.recovery) world.recoveries.push(n.recovery); return n; };

export const whoopFetch = (world: World, clock: { now: number }): typeof fetch => async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/developer/v2', '');
  world.calls.push(`${method} ${path}`);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (world.limited && clock.now < world.limited.until && path !== '/oauth/oauth2/token') return new Response('slow down', { status: 429, headers: { 'x-ratelimit-reset': '30' } });
  if (url.pathname === '/oauth/oauth2/token') {
    const form = new URLSearchParams(String(init?.body));
    if (form.get('client_id') !== CONFIG.clientId || form.get('client_secret') !== CLIENT_SECRET) return json({ error: 'invalid_client' }, 401);
    const issue = () => { world.issued += 1; const tokens = { access_token: `access-${world.issued}`, refresh_token: `refresh-${world.issued}`, expires_in: 3600 }; world.validAccess.add(tokens.access_token); world.validRefresh.add(tokens.refresh_token); return tokens; };
    if (form.get('grant_type') === 'authorization_code') return form.get('code') === 'good-code' ? json(issue()) : json({ error: 'invalid_grant' }, 400);
    if (form.get('grant_type') === 'refresh_token') {
      const old = form.get('refresh_token') ?? '';
      if (!world.validRefresh.has(old)) return json({ error: 'invalid_grant' }, 400);
      world.validRefresh.delete(old);
      world.spent.push(old);
      return json(issue());
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  const bearer = /^Bearer (.+)$/.exec(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))?.[1] ?? '';
  if (!world.validAccess.has(bearer)) return new Response('unauthorized', { status: 401 });
  if (world.breakAfter && path.startsWith(world.breakAfter.path)) {
    if (world.breakAfter.count <= 0) { world.validAccess.clear(); world.validRefresh.clear(); return new Response('unauthorized', { status: world.breakAfter.status }); }
    world.breakAfter.count -= 1;
  }
  if (path === '/user/profile/basic') return json({ user_id: world.account, email: 'x@example.invalid' });
  if (path === '/user/access' && method === 'DELETE') { world.validAccess.clear(); world.validRefresh.clear(); return new Response(null, { status: world.revokeStatus }); }
  const listing = (records: Record<string, unknown>[], field: string) => {
    const start = Date.parse(url.searchParams.get('start') ?? ''), end = Date.parse(url.searchParams.get('end') ?? '');
    const inside = records.filter(record => { const at = Date.parse(String(record[field])); return at >= start && at < end; }).sort((a, b) => Date.parse(String(b[field])) - Date.parse(String(a[field])));
    const from = Number(url.searchParams.get('nextToken') ?? 0);
    const slice = inside.slice(from, from + world.pageSize);
    return json({ records: slice, next_token: from + world.pageSize < inside.length ? String(from + world.pageSize) : null });
  };
  if (path === '/activity/sleep') return listing(world.sleeps, 'end');
  if (path === '/recovery') return listing(world.recoveries, 'created_at');
  if (path === '/activity/workout') return listing(world.workouts, 'start');
  const byId = /^\/activity\/(sleep|workout)\/(.+)$/.exec(path);
  if (byId) { const found = (byId[1] === 'sleep' ? world.sleeps : world.workouts).find(record => record.id === byId[2]); return found ? json(found) : json({}, 404); }
  const cycle = /^\/cycle\/(\d+)\/recovery$/.exec(path);
  if (cycle) { const found = world.recoveries.find(record => String(record.cycle_id) === cycle[1]); return found ? json(found) : json({}, 404); }
  return json({}, 404);
};

export type Stored = { revision: number; payload: Record<string, unknown> };
export type Plane = {
  samples: Map<string, Stored>; requests: Map<string, { digest: string; response: unknown }>; ingests: number; consent: 'granted' | 'withdrawn' | 'none'; model: 'granted' | 'withdrawn' | 'none'; epoch: number;
  sessions: string[]; handoffs: string[]; vault: VaultFake;
};
// Any owner name may link: the owner gate is the real function's job and is covered by the edge's own tests.
const anyOwner = { includes: () => true } as unknown as readonly string[];
export const newVault = (): VaultFake => {
  const vault = vaultFake(anyOwner, { custody: { google: 'connector-proxy', mcp: 'oauth-proxy', whoop: 'oauth-proxy' }, uniqueAccounts: ['whoop'] });
  vault.clients.set(`${WHOOP_ISSUER} ${CONFIG.redirectUri}`, { client_id: CONFIG.clientId, client_auth: 'client_secret_post', client_secret: CLIENT_SECRET });
  return vault;
};
export const newPlane = (): Plane => ({ samples: new Map(), requests: new Map(), ingests: 0, consent: 'granted', model: 'granted', epoch: 1, sessions: [], handoffs: [], vault: newVault() });

// The database's own rules, in the parts a sync depends on.
export const planeRpc = (plane: Plane, doName = 'owner-w') => async (fn: string, _message: string, args: Record<string, string | number>): Promise<unknown> => {
  // `consent` is the storage grant and `model` the model-use grant; the database refuses readings on storage alone.
  if (fn === 'health_consent_list') {
    const rows = [['storage_compute', plane.consent], ['model_processing', plane.model]] as const;
    return { consents: rows.filter(([, status]) => status !== 'none').map(([purpose, status]) => ({ consent_class: 'health_processing', source: 'whoop', purpose, version: 3, status, epoch: plane.epoch, granted_at: '2026-10-01T00:00:00.000Z', withdrawn_at: null, deletion_state: 'not_required' })) };
  }
  if (fn === 'health_ingest') {
    const text = String(args.p_payload), body = JSON.parse(text);
    const parsed = healthIngestV1Schema.safeParse(body);
    if (!parsed.success) return { error: 'invalid_request' };
    const prior = plane.requests.get(parsed.data.request_id);
    if (plane.consent !== 'granted') return { error: plane.consent === 'withdrawn' ? 'consent_withdrawn' : 'consent_required' };
    if (parsed.data.consent_epoch !== plane.epoch) return { error: 'epoch_conflict' };
    if (prior) return { ...(prior.response as object), replayed: true };
    plane.ingests += 1;
    let accepted = 0, deleted = 0, ignored = 0;
    for (const sample of parsed.data.samples) {
      const key = `${sample.signal}|${sample.sample_id}`, stored = plane.samples.get(key);
      if (stored && stored.revision > sample.revision) { ignored += 1; continue; }
      plane.samples.set(key, { revision: sample.revision, payload: sample as unknown as Record<string, unknown> }); accepted += 1;
    }
    for (const deletion of parsed.data.deletions) {
      const key = `${deletion.signal}|${deletion.sample_id}`, stored = plane.samples.get(key);
      if (stored && deletion.revision >= stored.revision) { plane.samples.delete(key); deleted += 1; } else ignored += 1;
    }
    const response = { request_id: parsed.data.request_id, source: 'whoop', consent_epoch: plane.epoch, accepted, deleted, ignored, anchor_after: parsed.data.anchor_after, replayed: false };
    plane.requests.set(parsed.data.request_id, { digest: text, response });
    return response;
  }
  // Of the connection functions only the listing is callable from an owner object; tokens are the edge's.
  if (fn === 'connection_list') return plane.vault.rows.filter(c => c.owner === doName && c.status !== 'revoked').map(c => ({ id: c.id, provider: c.provider, account: c.account, status: c.status }));
  if (fn === 'connect_session_issue_handoff') { plane.sessions.push(String(args.p_ticket_hash)); plane.handoffs.push(String(args.p_handoff_hash)); return '00000000-0000-4000-a000-000000000001'; }
  throw new Error(`unfaked rpc ${fn}`);
};

export type Harness = Readonly<{
  owner: ReturnType<typeof whoopOwner>; world: World; plane: Plane; clock: { now: number }; logs: WhoopLog[]; armed: number[]; produced: { count: number }; disarmed: { count: number };
  kv: Map<string, unknown>; edgeCalls: Record<string, unknown>[];
}>;
// The edge handler, loaded once per test file. The owner object reaches it only through the signed proxy client.
export const edge = await loadEdge();
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// One clock for the owner object and the edge: the edge reads the system time, so moving it moves both.
export const syncedClock = (start: number): { now: number } => {
  let at = start;
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  return { get now() { return at; }, set now(value: number) { at = value; vi.setSystemTime(value); } };
};

export const harness = (over: { world?: World; plane?: Plane; clock?: { now: number }; kv?: Map<string, unknown>; configured?: boolean; doName?: string; produce?: () => Promise<unknown> } = {}): Harness => {
  const world = over.world ?? newWorld(), plane = over.plane ?? newPlane(), clock = over.clock ?? syncedClock(NOW), kv = over.kv ?? new Map<string, unknown>();
  const logs: WhoopLog[] = [], armed: number[] = [], produced = { count: 0 }, disarmed = { count: 0 }, edgeCalls: Record<string, unknown>[] = [];
  const doName = over.doName ?? 'owner-w';
  routeEdgeFetch(plane.vault, { fetcher: whoopFetch(world, clock) });
  const configured = over.configured !== false;
  const owner = whoopOwner({
    doName: () => doName, rpc: planeRpc(plane, doName), config: configured ? CONFIG : null, proxy: configured ? oauthProxy(WORKER_ENV, workerToEdge(edge, body => edgeCalls.push(body)), () => clock.now) : null,
    now: () => clock.now, timezone: () => 'Europe/Berlin',
    kv: { get: <T>(key: string) => kv.get(key) as T | undefined, put: (key, value) => { kv.set(key, value); }, delete: key => kv.delete(key), list: <T>({ prefix }: { prefix: string }) => [...kv].filter(([key]) => key.startsWith(prefix)) as [string, T][] },
    produce: over.produce ?? (async () => { produced.count += 1; }), arm: async at => { armed.push(at); }, disarm: async () => { disarmed.count += 1; }, log: line => { logs.push(line); },
  });
  return { owner, world, plane, clock, logs, armed, produced, disarmed, kv, edgeCalls };
};
// A connected owner whose month is on WHOOP's side.
export const connected = async (over: Parameters<typeof harness>[0] = {}, nights = 0): Promise<Harness> => {
  const h = harness(over);
  for (let i = 0; i < nights; i += 1) addNight(h.world, i);
  expect(await h.owner.exchange({ code: 'good-code', denied: false })).toBe('linked');
  return h;
};
export { sleepRecord, recoveryRecord, workoutRecord };
