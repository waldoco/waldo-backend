import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_RECOMPUTE_ID, HEALTH_RECOMPUTE_WINDOW_MS } from '../src/health/recompute';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { callOwnerProvider } from '../src/health/providers/provider-route';
import { WHOOP_SYNC_ID } from '../src/health/providers/whoop-owner';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';
import { addNight, edge, newPlane, newWorld, planeRpc, whoopFetch } from './helpers/whoop-fakes';
import { EDGE_ENV } from './support/oauth-edge-harness';

// The owner object's side of WHOOP, end to end on the real object: a signed call from the Worker, a real alarm pass that
// runs the sync, the recompute it asks for one window later, and the health trigger armed by the zone change the writer reports. The oauth-proxy
// Edge Function runs for real, in process, over a Vault stand-in; the health plane and WHOOP are the recorded fakes; no
// model is ever called.
// The edge in this test verifies the router signature with the key the harness gives it, so the owner object signs with the same one.
const SECRET = EDGE_ENV.WALDO_ROUTER_HMAC_SECRET;
const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const START = Date.parse('2026-10-21T08:00:00Z');
const CONFIG = { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_ROUTER_HMAC_SECRET: SECRET,
  SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable',
  WHOOP_CLIENT_ID: 'client-id-fixture', WHOOP_CLIENT_SECRET: 'client-secret-fixture', WHOOP_REDIRECT_URI: 'https://worker.example.invalid/oauth/whoop/callback' };

const models = vi.hoisted(() => ({ formats: [] as unknown[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (params?: { text?: { format?: { name?: unknown } } }) => {
  models.formats.push(params?.text?.format?.name); throw new Error('no model call in this test');
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
const { OwnerDO } = await import('../src/channels/owner-do');

// Synthetic readings and the secrets the sync handled. None may be left in the object's tables or storage, or in any line it printed.
const SENTINELS = ['47.318', '93.5', '96.4', '33.2', 'access-', 'refresh-', 'client-secret-fixture', 'good-code'];
const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);

const world = newWorld();
const plane = newPlane();
const written: string[] = [];
let zoneChanged: string[] = [];
let sequence = 0;

beforeEach(() => {
  Object.assign(world, newWorld()); Object.assign(plane, newPlane()); written.length = 0; zoneChanged = []; models.formats = [];
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  const whoop = whoopFetch(world, { get now() { return Date.now(); } } as { now: number });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.prod.whoop.com')) return whoop(input, init);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    if (url === `${CONFIG.SUPABASE_PROJECT_URL}/functions/v1/oauth-proxy`) return edge(new Request(input, init));
    if (fn && url.startsWith(`${EDGE_ENV.SUPABASE_URL}/`)) return plane.vault.answer(fn, body);
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    if (fn === 'assert_channel_presence' || fn === 'set_owner_settings') return Response.json(true);
    if (fn === 'health_series_read') {
      const samples = [...plane.samples.values()].map(s => ({ signal: s.payload.signal, day: s.payload.day, value: s.payload.value, start_at: s.payload.start_at, end_at: s.payload.end_at, timezone: 'Europe/Berlin', method: s.payload.method ?? null }));
      return Response.json({ access: 'granted', read_at: new Date(Date.now()).toISOString().replace('Z', '123Z'), sources: [{ source: 'whoop', consent_epoch: plane.epoch, truncated: false, samples }] });
    }
    if (fn === 'health_context_write') { written.push(String(body.p_payload)); zoneChanged.push('recovery'); return Response.json({ written: true, changed: ['recovery'] }); }
    if (fn) return Response.json(await planeRpc(plane, String(body.p_do_name))(fn, '', body));
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

type Owner = Readonly<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
const withOwner = (work: (o: { owner: Owner; state: DurableObjectState; doName: string; call(op: Parameters<typeof callOwnerProvider>[3], body?: Record<string, unknown>): Promise<Response>; row(id: string): { kind: string; due_at: number } | null }) => Promise<void>, over: Record<string, unknown> = {}) => {
  const doName = `whoop-do-${sequence++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName);
    state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    const owner = new OwnerDO(state, { ...env, ...CONFIG, WALDO_OWNER_TELEGRAM_ID: '7', ...over }) as unknown as Owner;
    const call = async (op: Parameters<typeof callOwnerProvider>[3], body: Record<string, unknown> = {}) => {
      let sent!: Request;
      await callOwnerProvider({ idFromName: n => n as never, get: () => ({ fetch: async (r: Request) => { sent = r; return Response.json({}); } }) }, SECRET, doName, op, body);
      return owner.fetch(sent);
    };
    const row = (id: string) => state.storage.sql.exec<{ kind: string; due_at: number }>('SELECT kind, due_at FROM schedule WHERE id = ?', id).toArray()[0] ?? null;
    try { await work({ owner, state, doName, call, row }); } finally { await state.storage.deleteAlarm(); }
  });
};

describe('WHOOP on the owner object', () => {
  it('takes a signed call from the Worker and refuses one that is forged, for another owner, or for another operation', async () => {
    await withOwner(async ({ owner, call, doName }) => {
      const ok = await call('status');
      expect([ok.status, await ok.json()]).toEqual([200, { providers: [{ provider: 'whoop', state: 'not_connected', last_sync_at: null }] }]);
      let sent!: Request;
      await callOwnerProvider({ idFromName: n => n as never, get: () => ({ fetch: async (r: Request) => { sent = r; return Response.json({}); } }) }, SECRET, doName, 'status', {});
      const copy = (over: Record<string, string>) => new Request(sent.url, { method: 'POST', headers: { ...Object.fromEntries(sent.headers), ...over }, body: '{}' });
      expect((await owner.fetch(copy({ 'x-waldo-provider-sig': '0'.repeat(64) }))).status).toBe(403);
      expect((await owner.fetch(copy({ 'x-waldo-do-name': 'someone-else' }))).status).toBe(403);
      expect((await owner.fetch(copy({ 'x-waldo-provider-op': 'disconnect' }))).status).toBe(403);
    });
  });

  it('says it is not configured, and does nothing, on a deploy without WHOOP\'s client settings', async () => {
    await withOwner(async ({ call }) => {
      const response = await call('connect');
      expect([response.status, await response.json()]).toEqual([503, { error: 'not_configured' }]);
      expect(plane.sessions).toEqual([]);
    }, { WHOOP_CLIENT_ID: undefined });
  });

  it('links on the callback, arms a sync, and real alarm passes read the month, recompute the owner\'s rows and arm the health trigger', async () => {
    for (let i = 0; i < 30; i += 1) addNight(world, i);
    const printed: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    await withOwner(async ({ owner, state, call, row }) => {
      const linked = await call('exchange', { code: 'good-code', denied: false });
      expect([linked.status, await linked.json()]).toEqual([200, { outcome: 'linked' }]);
      expect(row(WHOOP_SYNC_ID)).toMatchObject({ kind: 'provider_sync' });
      // The code was traded and the tokens saved by the edge, never by the object.
      expect([plane.vault.rpcs, plane.vault.rows.map(connection => [connection.provider, connection.account])]).toEqual([['oauth_client_secret', 'oauth_store'], [['whoop', '70001']]]);
      expect(row(WHOOP_SYNC_ID)!.due_at).toBeLessThanOrEqual(Date.now());
      const pass = async () => { await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); await owner.alarm(); };
      await pass();
      expect([...plane.samples.keys()].filter(key => key.startsWith('sleep_duration|'))).toHaveLength(30);
      expect(plane.ingests).toBeGreaterThan(0);
      // The sync asked for one recompute; it runs a window later, as an upload's does.
      expect(written).toHaveLength(0);
      expect(row(HEALTH_RECOMPUTE_ID)).toMatchObject({ kind: 'provider_sync', due_at: START + HEALTH_RECOMPUTE_WINDOW_MS });
      vi.setSystemTime(START + HEALTH_RECOMPUTE_WINDOW_MS);
      await pass();
      expect(written).toHaveLength(2);
      for (const payload of written) expect(JSON.parse(payload).basis).toEqual([{ source: 'whoop', consent_epoch: 1 }]);
      // The writer said a pillar moved zone: the owner object marked the day and armed the health trigger, with no signed hop in between.
      expect(state.storage.sql.exec('SELECT day FROM health_trigger_pending').toArray()).toEqual([{ day: '2026-10-21' }]);
      expect(row(HEALTH_TRIGGER_ID)).toMatchObject({ kind: 'patrol' });
      expect(row(WHOOP_SYNC_ID)!.due_at).toBeGreaterThan(Date.now());
      // The sync and the recompute call no model. The app runtime the recompute runs in plans its day when it starts, and
      // that is the only call there is.
      expect(models.formats.every(format => format === 'day_plan')).toBe(true);
      expect(dump(state), 'the dump reads the real tables').toContain(WHOOP_SYNC_ID);
      for (const sentinel of SENTINELS) for (const [where, text] of [['tables and storage', dump(state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${sentinel} in ${where}`).not.toContain(sentinel);
      const status = await (await call('status')).json() as { providers: { state: string; last_sync_at: string }[] };
      expect(status.providers[0]).toMatchObject({ state: 'connected', last_sync_at: new Date(START).toISOString() });
    });
  });

  it('disconnects through the Worker\'s call: revoked at WHOOP, the saved access gone, the sync entry cancelled', async () => {
    for (let i = 0; i < 3; i += 1) addNight(world, i);
    await withOwner(async ({ call, row }) => {
      await call('exchange', { code: 'good-code', denied: false });
      const response = await call('disconnect');
      expect([response.status, await response.json()]).toEqual([200, { provider: 'whoop', state: 'not_connected', revoked_at_provider: true }]);
      expect([plane.vault.rows.filter(connection => connection.status !== 'revoked').length, row(WHOOP_SYNC_ID)]).toEqual([0, null]);
      expect(world.calls).toContain('DELETE /user/access');
    });
  });

  it('turns a webhook hint into one fetch and one write for the owner whose account it names', async () => {
    const n = addNight(world, 0);
    await withOwner(async ({ call }) => {
      await call('exchange', { code: 'good-code', denied: false });
      const first = await call('hint', { type: 'sleep.updated', id: n.sleep.id, trace: 'trace-0000-aaaa' });
      expect(await first.json()).toEqual({ result: 'handled' });
      expect([...plane.samples.keys()].some(key => key.startsWith('overnight_hrv|'))).toBe(true);
      const again = await call('hint', { type: 'sleep.updated', id: n.sleep.id, trace: 'trace-0000-aaaa' });
      expect(await again.json()).toEqual({ result: 'duplicate' });
    });
  });
});
