import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleAccess } from '../src/channels/console';
import { handleConsole } from '../src/channels/console-signin';
import { ADMIN_HEALTH_READ_LIMIT, consoleHealth, DASHBOARD_ADMIN_HEALTH_PATH, DASHBOARD_HEALTH_PATH, HEALTH_READ_LIMIT } from '../src/channels/dashboard-health';
import { md5Hex } from '../src/channels/md5';
import type { ConsoleAuth } from '../src/identity/console-auth';

// One instant per fixture: the workerd clock moves inside synchronous code.
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const HOUR = 3_600_000;
// Distinctive values that may reach the owner's own view but never an admin view or a log.
const READING = 4321, RECOVERY = 87.5, FORM = 61.25, WEIGHT = 42.75;

type Call = { fn: string; message: string; args: Record<string, string | number> };
const pillar = (score: number, zone: string, version: string) => ({ score, zone, algorithm_version: version, activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null });
const stored = (compiledAt: number, day = '2026-10-23') => ({ scores: {
  day, timezone: 'Europe/London', compiled_at: new Date(compiledAt).toISOString(), freshness: 'fresh',
  recovery: pillar(RECOVERY, 'high', 'recovery.v1'), form: pillar(FORM, 'good', 'form.candidate.v4'), weight: pillar(WEIGHT, 'low', 'weight.v1'),
} });
const consent = (purpose: string, status: string) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status, epoch: 1,
  granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: status === 'withdrawn' ? '2026-10-21T08:00:00.000Z' : null, deletion_state: status === 'withdrawn' ? 'completed' : 'not_required' });
const freshness = {
  sources: [{ source: 'apple', newest_upload_at: '2026-10-23T11:00:00.000Z', uploads_7d: 12, rejected_readings_7d: [{ reason: 'invalid_sample', count: 2 }] }],
  refusals_7d: [{ code: 'invalid_request', status: 400, count: 3, newest_at: '2026-10-23T10:00:00.000Z' }],
  newest_derived: { day: '2026-10-23', compiled_at: '2026-10-23T11:30:00.000Z' },
};
const answers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  health_scores_read: stored(NOW - HOUR), health_consent_list: { consents: [consent('model_processing', 'withdrawn'), consent('storage_compute', 'granted')] },
  health_freshness_read: { freshness }, ...over,
});
const fakeRpc = (table: Record<string, unknown>) => {
  const calls: Call[] = [];
  const rpc = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    const answer = table[fn];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { rpc, calls };
};
const fakeKv = () => { const store = new Map<string, unknown>(); return { store, kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } } }; };
const read = (path: string, init: RequestInit = {}) => new Request(`https://w.test${path}`, { headers: { accept: 'application/json' }, ...init });
const run = (request: Request, table: Record<string, unknown>, kv = fakeKv().kv, now = NOW, doName: string | undefined = 'owner-b') => {
  const fake = fakeRpc(table);
  return { response: consoleHealth({ request, kv, doName, rpc: fake.rpc, now }), calls: fake.calls };
};
const logs = () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
  return () => spies.flatMap(spy => spy.mock.calls.map(args => JSON.stringify(args))).join('\n');
};
afterEach(() => { vi.restoreAllMocks(); });

describe('owner health read', () => {
  it('shows the scores, consents and uploads the app and the agent read, each signed for the session owner only', async () => {
    const { response, calls } = run(read(DASHBOARD_HEALTH_PATH), answers());
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json() as Record<string, any>;
    expect(body.version).toBe(1);
    expect(body.as_of).toBe(new Date(NOW).toISOString());
    expect(body.scores).toMatchObject({ day: '2026-10-23', freshness: 'fresh', compiled_at: new Date(NOW - HOUR).toISOString(),
      recovery: { state: 'available', score: RECOVERY, zone: 'excellent' }, form: { score: FORM, zone: 'steady' }, weight: { score: WEIGHT, zone: 'light' } });
    expect(body.consents.map((c: { purpose: string; status: string }) => `${c.purpose}:${c.status}`)).toEqual(['model_processing:withdrawn', 'storage_compute:granted']);
    expect(body.freshness).toEqual(freshness);
    expect(calls.map(c => [c.fn, c.message, c.args])).toEqual(['scores_read', 'consent_list', 'freshness_read'].map(op =>
      [`health_${op}`, `health.${op}.owner-b.${md5Hex('{}')}`, { p_do_name: 'owner-b', p_payload: '{}' }]));
  });
  it('ages the newest row when it is read: fresh, stale after six hours, expired after three days', async () => {
    const freshnessAt = async (compiledAt: number, day?: string) => ((await (await run(read(DASHBOARD_HEALTH_PATH), answers({ health_scores_read: stored(compiledAt, day) })).response).json()) as { scores: { freshness: string } }).scores.freshness;
    expect(await freshnessAt(NOW - HOUR)).toBe('fresh');
    expect(await freshnessAt(NOW - 7 * HOUR)).toBe('stale');
    expect(await freshnessAt(NOW - 2 * HOUR, '2026-10-20')).toBe('stale');
    expect(await freshnessAt(NOW - 73 * HOUR, '2026-10-20')).toBe('expired');
  });
  it('says why there is nothing when health is not shared, and lists no consent rows', async () => {
    const body = await (await run(read(DASHBOARD_HEALTH_PATH), answers({
      health_scores_read: { unavailable: 'consent_required' }, health_consent_list: { consents: [] },
      health_freshness_read: { freshness: { sources: [], refusals_7d: [], newest_derived: null } },
    })).response).json() as Record<string, unknown>;
    expect(body.scores).toEqual({ state: 'unavailable', day: null, reason: 'consent_required' });
    expect(body.consents).toEqual([]);
    expect(body.freshness).toEqual({ sources: [], refusals_7d: [], newest_derived: null });
  });
  it('keeps showing the parts it could read when one read fails, and logs no value', async () => {
    const captured = logs();
    const body = await (await run(read(DASHBOARD_HEALTH_PATH), answers({ health_freshness_read: new Error('down'), health_consent_list: { consents: [{ ...consent('storage_compute', 'granted'), status: 'maybe' }] } })).response).json() as Record<string, unknown>;
    expect(body.freshness).toBeNull();
    expect(body.consents).toBeNull();
    expect(body.scores).toMatchObject({ recovery: { score: RECOVERY } });
    const text = captured();
    for (const value of [READING, RECOVERY, FORM, WEIGHT]) expect(text).not.toContain(String(value));
  });
  it('drops anything the projection does not name', async () => {
    const leaky = { freshness: { ...freshness, sources: [{ ...freshness.sources[0], value: READING, signal: 'spo2' }], payload: { value: READING } } };
    const body = await (await run(read(DASHBOARD_HEALTH_PATH), answers({ health_freshness_read: leaky })).response).text();
    expect(body).not.toContain(String(READING));
    expect(body).not.toContain('"signal"');
    expect(body).not.toContain('"payload"');
  });
  it('takes no owner selector, no query and no write, before any database call', async () => {
    for (const request of [read(`${DASHBOARD_HEALTH_PATH}?owner=owner-a`), read(`${DASHBOARD_HEALTH_PATH}?day=2026-10-22`)]) {
      const { response, calls } = run(request, answers());
      const res = await response;
      expect([res.status, await res.json()]).toEqual([400, { error: 'invalid_query' }]);
      expect(calls).toEqual([]);
    }
    const { response, calls } = run(read(DASHBOARD_HEALTH_PATH, { method: 'POST' }), answers());
    expect((await response).status).toBe(405);
    expect(calls).toEqual([]);
  });
  it('is rate-limited per owner, on its own window, without a database call', async () => {
    const { kv, store } = fakeKv();
    store.set('console:health-rate', { start: NOW, count: HEALTH_READ_LIMIT });
    const limited = run(read(DASHBOARD_HEALTH_PATH), answers(), kv);
    const res = await limited.response;
    expect([res.status, res.headers.get('retry-after'), await res.json()]).toEqual([429, '60', { error: 'rate_limited' }]);
    expect(limited.calls).toEqual([]);
    expect((await run(read(DASHBOARD_HEALTH_PATH), answers(), kv, NOW + 60_001).response).status).toBe(200);
    expect(store.get('console:health-rate')).toEqual({ start: NOW + 60_001, count: 1 });
  });
});

describe('admin tester freshness', () => {
  const owner = (email: string, over: Record<string, unknown> = {}) => ({ id: `0000000${email.length}-0000-0000-0000-000000000000`, email, state: 'active', created_at: '2026-10-01T00:00:00.000Z',
    consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: null }], freshness, ...over });
  const admin = (owners: unknown[]) => ({ admin_health_freshness: { owners } });

  it('is not found for an owner who is not the admin, after one signed call for the session owner', async () => {
    const { response, calls } = run(read(DASHBOARD_ADMIN_HEALTH_PATH), { admin_health_freshness: null });
    const res = await response;
    expect([res.status, await res.json()]).toEqual([404, { error: 'not_found' }]);
    expect(calls).toEqual([{ fn: 'admin_health_freshness', message: 'admin_health.owner-b', args: { p_do_name: 'owner-b' } }]);
  });
  it('shows each tester\'s uploads, refusals, newest derived day and consent state, and nothing that carries a value', async () => {
    const captured = logs();
    const leaky = owner('tester@example.invalid', {
      scores: { recovery: { score: RECOVERY, zone: 'high' } }, form: FORM,
      freshness: { ...freshness, sources: [{ ...freshness.sources[0], value: READING, signal: 'spo2', payload: { value: READING } }] },
      consents: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: null, epoch: WEIGHT }],
    });
    const res = await run(read(DASHBOARD_ADMIN_HEALTH_PATH), admin([leaky, owner('quiet@example.invalid', { consents: [], freshness: { sources: [], refusals_7d: [], newest_derived: null } })])).response;
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { version: number; as_of: string; owners: Record<string, unknown>[] };
    expect(body.version).toBe(1);
    expect(body.owners.map(o => Object.keys(o).sort())).toEqual([['consents', 'created_at', 'email', 'freshness', 'id', 'state'], ['consents', 'created_at', 'email', 'freshness', 'id', 'state']]);
    expect(body.owners[0]!.freshness).toEqual(freshness);
    expect(body.owners[0]!.consents).toEqual([{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-20T08:00:00.000Z', withdrawn_at: null }]);
    expect(body.owners[1]!.consents).toEqual([]);
    for (const value of [READING, RECOVERY, FORM, WEIGHT]) { expect(text).not.toContain(String(value)); expect(captured()).not.toContain(String(value)); }
    for (const key of ['score', 'zone', 'signal', 'payload', 'value', 'epoch']) expect(text).not.toContain(`"${key}"`);
  });
  it('answers a malformed projection generically, without echoing it to the log', async () => {
    const captured = logs();
    const res = await run(read(DASHBOARD_ADMIN_HEALTH_PATH), admin([owner('tester@example.invalid', { freshness: { sources: [{ source: 'apple', uploads_7d: -1, value: READING }] } })])).response;
    expect([res.status, await res.json()]).toEqual([503, { error: 'health_unavailable' }]);
    expect(captured()).not.toContain(String(READING));
    expect(captured()).not.toContain('tester@example.invalid');
  });
  it('answers a failed database call generically', async () => {
    const res = await run(read(DASHBOARD_ADMIN_HEALTH_PATH), { admin_health_freshness: new Error('connection reset') }).response;
    expect([res.status, await res.json()]).toEqual([503, { error: 'health_unavailable' }]);
  });
  it('has a tighter window than the owner read, and neither window spends the other', async () => {
    expect(ADMIN_HEALTH_READ_LIMIT).toBeLessThan(HEALTH_READ_LIMIT);
    const { kv, store } = fakeKv();
    store.set('console:health-rate', { start: NOW, count: HEALTH_READ_LIMIT });
    expect((await run(read(DASHBOARD_ADMIN_HEALTH_PATH), admin([]), kv).response).status).toBe(200);
    store.set('console:admin-health-rate', { start: NOW, count: ADMIN_HEALTH_READ_LIMIT });
    const limited = run(read(DASHBOARD_ADMIN_HEALTH_PATH), admin([]), kv);
    expect((await limited.response).status).toBe(429);
    expect(limited.calls).toEqual([]);
  });
  it('takes no owner selector and no write', async () => {
    for (const request of [read(`${DASHBOARD_ADMIN_HEALTH_PATH}?owner=owner-a`), read(DASHBOARD_ADMIN_HEALTH_PATH, { method: 'POST' })]) {
      const { response, calls } = run(request, admin([]));
      expect([400, 405]).toContain((await response).status);
      expect(calls).toEqual([]);
    }
  });
});

describe('console session at the Worker', () => {
  it('answers a signed-out health read with a JSON 401, never the sign-in page', async () => {
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ reached: true }) }) } as unknown as DurableObjectNamespace;
    for (const path of [DASHBOARD_HEALTH_PATH, DASHBOARD_ADMIN_HEALTH_PATH]) {
      const response = await handleConsole(read(path), { OWNER_DO: ns }, { readOwnerCookie: async () => null } as unknown as ConsoleAuth);
      expect(response?.status).toBe(401);
      expect(response?.headers.get('cache-control')).toContain('no-store');
    }
  });
  it('routes by the verified owner cookie, never by a URL selector', async () => {
    const owners: string[] = [];
    const ns = { idFromName: (n: string) => n, get: (n: string) => ({ fetch: async () => { owners.push(n); return Response.json({ reached: true }); } }) } as unknown as DurableObjectNamespace;
    const response = await handleConsole(read(`${DASHBOARD_HEALTH_PATH}?owner=owner-a`, { headers: { accept: 'application/json', cookie: 'waldo_owner=signed' } }), { OWNER_DO: ns }, { readOwnerCookie: async () => 'owner-b' } as unknown as ConsoleAuth);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toContain('no-store');
    expect(owners).toEqual(['owner-b']);
  });
});

describe('actual owner object health route', () => {
  it('needs this owner\'s console session, and signs every read for this owner', async () => {
    const { env: bindings } = await import('cloudflare:workers');
    const { runInDurableObject } = await import('cloudflare:test');
    const mine = bindings.OWNER_DO!.get(bindings.OWNER_DO!.idFromName('health-view-mine'));
    const other = bindings.OWNER_DO!.get(bindings.OWNER_DO!.idFromName('health-view-other'));
    const token = await runInDurableObject(mine, (_instance, state) => consoleAccess(state.storage).grant());
    const cookie = `waldo_console=${token}`;
    expect((await mine.fetch(`https://w.test${DASHBOARD_HEALTH_PATH}`, { headers: { accept: 'application/json' } })).status).toBe(401);
    expect((await other.fetch(`https://w.test${DASHBOARD_HEALTH_PATH}`, { headers: { cookie, accept: 'application/json' } })).status).toBe(401);
    await runInDurableObject(mine, async (instance, state) => {
      const host = instance as unknown as { env: Record<string, unknown>; fetch: (r: Request) => Promise<Response> };
      Object.assign(host.env, { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' });
      state.storage.kv.put('do_name', 'health-view-mine');
      const original = globalThis.fetch; const calls: { fn: string; body: Record<string, unknown> }[] = [];
      const table = answers();
      globalThis.fetch = async (input, init) => { const fn = String(input).split('/rpc/')[1]!; calls.push({ fn, body: JSON.parse(String(init!.body)) }); return Response.json(table[fn] ?? null); };
      try {
        const res = await host.fetch(new Request(`https://w.test${DASHBOARD_HEALTH_PATH}`, { headers: { cookie, accept: 'application/json' } }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ version: 1, consents: [{ purpose: 'model_processing' }, { purpose: 'storage_compute' }], freshness });
        expect(calls.map(c => [c.fn, c.body.p_do_name])).toEqual([['health_scores_read', 'health-view-mine'], ['health_consent_list', 'health-view-mine'], ['health_freshness_read', 'health-view-mine']]);
        const adminRead = await host.fetch(new Request(`https://w.test${DASHBOARD_ADMIN_HEALTH_PATH}`, { headers: { cookie, accept: 'application/json' } }));
        expect(adminRead.status).toBe(404);
        expect(calls.at(-1)).toMatchObject({ fn: 'admin_health_freshness', body: { p_do_name: 'health-view-mine' } });
      } finally { globalThis.fetch = original; }
    });
  });
});
