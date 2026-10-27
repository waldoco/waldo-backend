import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresHistoryResponseV1Schema } from '../../contracts/src/app/health-ingest';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
let limiterAllows = true;
const env = () => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: limiterAllows }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

const rpcs: Array<{ fn: string; body: Record<string, unknown> }> = [];
let rpcResult: unknown = {};
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; limiterAllows = true; rpcResult = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (rpcResult instanceof Error) throw rpcResult;
    return Response.json(rpcResult);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const contracts = (revision: string): Record<string, string> => ({ 'x-waldo-app-contract': revision });
type Reply = Omit<Response, 'json'> & { json(): Promise<any> };
const call = (path: string, extra: Record<string, string> = {}, method = 'GET') => handleApp(new Request(`https://w.test${path}`, { method, headers: { authorization: `Bearer ${CREDENTIAL}`, ...extra } }), env(), auth) as Promise<Reply>;
const HISTORY = '/app/v1/health/scores/history';
const REV4 = contracts('health=4');

// Stored rows, in the database's vocabulary, with synthetic values.
const available = (over: Record<string, unknown>) => ({ score: 72, zone: 'good', algorithm_version: 'form.v9', activation: 'accepted', confidence: 0.8, hrv_method: null, ...over });
const recovery = (over: Record<string, unknown> = {}) => available({ score: 64, zone: 'moderate', algorithm_version: 'recovery.v5', hrv_method: 'rmssd', ...over });
const stored = (day: string, over: Record<string, unknown> = {}) => ({ day, form: available({}), recovery: recovery(), weight: { reason: 'missing_sleep' }, ...over });
const answerOf = (from: string, to: string, rows: unknown) => ({ history: { from, to, days: rows } });
const dayAt = (base: string, offset: number) => new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const tagsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(args => JSON.stringify(args)).join('\n');
const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('score history: revision gating', () => {
  it('answers a build below health revision 4 as an unknown route, calling nothing, whatever it asks', async () => {
    for (const header of [{}, contracts('health=1'), contracts('health=2'), contracts('health=3'), contracts('approvals=4,health=3')]) {
      for (const path of [`${HISTORY}?days=7`, `${HISTORY}?days=nope`, HISTORY]) {
        const response = await call(path, header);
        expect([response.status, await response.json()], `${JSON.stringify(header)} ${path}`).toEqual([404, { error: 'invalid_request' }]);
      }
      expect((await call(`${HISTORY}?days=7`, header, 'POST')).status).toBe(404);
    }
    expect(rpcs).toEqual([]);
  });
  it('serves a build that names revision 4 or later', async () => {
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10')]);
    for (const header of [REV4, contracts('approvals=3,health=4'), contracts('health=5')]) expect((await call(`${HISTORY}?days=7`, header)).status, JSON.stringify(header)).toBe(200);
  });
  it('answers only GET, and no other path under it', async () => {
    expect((await call('/app/v1/health/scores/other', REV4)).status).toBe(404);
    expect((await call(`${HISTORY}/`, REV4)).status).toBe(404);
    expect((await call(`${HISTORY}?days=7`, REV4, 'POST')).status).toBe(405);
    expect(rpcs).toEqual([]);
  });
});

describe('score history: the query', () => {
  it('takes 7, 30 and 90, and asks the database for exactly that window through a call signed over its payload', async () => {
    for (const days of [7, 30, 90]) {
      rpcs.length = 0; rpcResult = answerOf(dayAt('2026-10-10', 1 - days), '2026-10-10', [stored('2026-10-10')]);
      const response = await call(`${HISTORY}?days=${days}`, REV4);
      const body = await response.json();
      expect([response.status, healthScoresHistoryResponseV1Schema.safeParse(body).success, body.window_days]).toEqual([200, true, days]);
      expect(rpcs).toHaveLength(1);
      const [sent] = rpcs;
      expect(sent!.fn).toBe('health_scores_history');
      expect(sent!.body).toMatchObject({ p_do_name: 'owner-1', p_payload: JSON.stringify({ days }) });
      expect(sent!.body.p_sig).toBe(await routerSignature(SECRET, sent!.body.p_at as number, `health.scores_history.owner-1.${md5Hex(JSON.stringify({ days }))}`));
    }
  });
  it('refuses a missing, unknown, repeated or padded window, and any other key, before any call', async () => {
    for (const query of ['', '?days=', '?days=14', '?days=0', '?days=91', '?days=-7', '?days=07', '?days=7.0', '?days=7&days=30', '?days=7&days=7', '?days=7&owner=other', '?days=7&from=2026-10-01', '?day=2026-10-10', '?days=%207', '?days=seven'])
      expect([(await call(`${HISTORY}${query}`, REV4)).status, query]).toEqual([400, query]);
    expect(rpcs).toEqual([]);
  });
  it('takes the owner from the session, never from the request', async () => {
    expect((await call(`${HISTORY}?days=7&owner=owner-2`, REV4)).status).toBe(400);
    rpcResult = answerOf('2026-10-04', '2026-10-10', []);
    await call(`${HISTORY}?days=7`, REV4);
    expect(rpcs.map(rpc => rpc.body.p_do_name)).toEqual(['owner-1']);
    expect(Object.keys(rpcs[0]!.body).sort()).toEqual(['p_at', 'p_do_name', 'p_payload', 'p_sig']);
  });
  it('spends the health budget of the owner, and answers 429 without a call when it is spent', async () => {
    rpcResult = answerOf('2026-10-04', '2026-10-10', []);
    await call(`${HISTORY}?days=7`, REV4);
    expect(limiterKeys).toEqual(['app-health:owner-1']);
    limiterAllows = false; rpcs.length = 0;
    expect((await call(`${HISTORY}?days=7`, REV4)).status).toBe(429);
    expect(rpcs).toEqual([]);
  });
  it('rejects a call without a credential before anything else', async () => {
    const response = await handleApp(new Request(`https://w.test${HISTORY}?days=7`, { headers: REV4 }), env(), auth);
    expect(response!.status).toBe(401);
    expect(rpcs).toEqual([]);
  });
});

describe('score history: what it serves', () => {
  it('serves the stored rows oldest first as pillars with their label, and says the window it covers', async () => {
    const personal = { state: 'personal', personal_days: 20, needed: 14, prior: 'adults' };
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-06'), stored('2026-10-08', { recovery: recovery({ score: 55, baseline: personal }) }), stored('2026-10-10')]);
    const response = await call(`${HISTORY}?days=7`, REV4);
    const body = await response.json();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(healthScoresHistoryResponseV1Schema.safeParse(body).success).toBe(true);
    expect([body.state, body.window_days, body.from, body.to]).toEqual(['available', 7, '2026-10-04', '2026-10-10']);
    expect(body.days.map((d: { day: string }) => d.day)).toEqual(['2026-10-06', '2026-10-08', '2026-10-10']);
    expect(body.days[1].recovery).toMatchObject({ state: 'available', score: 55, zone: 'mixed', activation: 'accepted', baseline: personal });
    expect(body.days[0].weight).toEqual({ state: 'unavailable', reason: 'missing_sleep' });
    expect(body.days[0].form).toMatchObject({ state: 'available', zone: 'steady' });
  });
  it('leaves a day with no row out of the list, never as a zero', async () => {
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-04'), stored('2026-10-10')]);
    const body = await (await call(`${HISTORY}?days=7`, REV4)).json();
    expect(body.days.map((d: { day: string }) => d.day)).toEqual(['2026-10-04', '2026-10-10']);
    expect(JSON.stringify(body)).not.toContain('"score":0');
  });
  it('passes the provisional label through, which a build at revision 4 can show', async () => {
    const provisional = { state: 'provisional', personal_days: 5, needed: 14, prior: 'adults' };
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10', { recovery: recovery({ baseline: provisional }) })]);
    const body = await (await call(`${HISTORY}?days=7`, REV4)).json();
    expect(body.days[0].recovery.baseline).toEqual(provisional);
  });
  it('fails closed on a stored label it cannot read: that pillar reads as not yet learned, the day is still served, and the log holds a tag only', async () => {
    const spy = quietly();
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10', { recovery: recovery({ baseline: { state: 'learning' } }) })]);
    const body = await (await call(`${HISTORY}?days=7`, REV4)).json();
    expect(body.days[0].recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(tagsOf(spy)).not.toMatch(/64|2026-10/);
  });
  it('passes backfilled only when the row says true', async () => {
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-08', { backfilled: true }), stored('2026-10-09', { backfilled: false }), stored('2026-10-10', { backfilled: 'yes' })]);
    const body = await (await call(`${HISTORY}?days=7`, REV4)).json();
    expect(body.days.map((d: Record<string, unknown>) => d.backfilled)).toEqual([true, undefined, undefined]);
    expect(healthScoresHistoryResponseV1Schema.safeParse(body).success).toBe(true);
  });
  it('carries no reading, freshness, driver, window or sleep debt, whatever else the stored row holds', async () => {
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10', {
      drivers: ['blood oxygen below usual'], windows: [], sleep_debt: { state: 'unavailable', reason: 'missing_sleep' }, freshness: 'fresh', timezone: 'UTC', compiled_at: '2026-10-10T07:00:00.000Z',
      recovery: recovery({ inputs: { synthetic_note: 'x' } }),
    })]);
    const body = await (await call(`${HISTORY}?days=7`, REV4)).json();
    expect(Object.keys(body.days[0]).sort()).toEqual(['day', 'form', 'recovery', 'weight']);
    expect(Object.keys(body.days[0].recovery).sort()).toEqual(['activation', 'algorithm_version', 'confidence', 'hrv_method', 'score', 'state', 'zone']);
  });
});

describe('score history: rows that do not read', () => {
  it('skips a malformed row, serves the rest in order, and logs only a tag and a count', async () => {
    const spy = quietly();
    rpcResult = answerOf('2026-10-04', '2026-10-10', [
      stored('2026-10-05'), stored('2026-10-06', { form: available({ zone: 'excellent' }) }), 'not a row', null, stored('nope'), stored('2026-10-08', { recovery: 7 }), stored('2026-10-09', { weight: { reason: 3 } }), stored('2026-10-10'),
    ]);
    const response = await call(`${HISTORY}?days=7`, REV4);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.days.map((d: { day: string }) => d.day)).toEqual(['2026-10-05', '2026-10-10']);
    const logged = tagsOf(spy);
    expect(logged).toContain('app health scores history rows skipped');
    expect(logged).toMatch(/\b6\b/);
    expect(logged).not.toMatch(/2026-10|excellent|nope|not a row|72|64/);
  });
  it('says there is nothing to show, never a chart of zeros, when no row reads', async () => {
    quietly();
    rpcResult = answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10', { form: 3 })]);
    expect(await (await call(`${HISTORY}?days=7`, REV4)).json()).toEqual({ state: 'unavailable', day: null, reason: 'no_readings' });
  });
  it('treats an answer that breaks the window as a fault of ours, never a mis-ordered or oversized chart', async () => {
    quietly();
    const week = Array.from({ length: 8 }, (_, i) => stored(dayAt('2026-10-04', i)));
    const faults = [
      answerOf('2026-10-04', '2026-10-10', [stored('2026-10-09'), stored('2026-10-08')]),
      answerOf('2026-10-04', '2026-10-10', [stored('2026-10-08'), stored('2026-10-08')]),
      answerOf('2026-10-04', '2026-10-10', [stored('2026-10-03')]),
      answerOf('2026-10-04', '2026-10-10', week),
      answerOf('2026-10-01', '2026-10-10', [stored('2026-10-09')]),
      answerOf('2026-10-10', '2026-10-04', []),
      { history: { from: '2026-10-04', to: '2026-10-10' } }, { history: 'rows' }, { history: null }, { history: { days: [] } },
    ];
    for (const fault of faults) {
      rpcResult = fault;
      const response = await call(`${HISTORY}?days=7`, REV4);
      expect([response.status, await response.json()], JSON.stringify(fault).slice(0, 80)).toEqual([503, { error: 'unavailable' }]);
    }
  });
  it('never serves more than 90 entries', async () => {
    quietly();
    const hundred = Array.from({ length: 100 }, (_, i) => stored(dayAt('2026-07-01', i)));
    rpcResult = answerOf('2026-07-13', '2026-10-10', hundred);
    expect((await call(`${HISTORY}?days=90`, REV4)).status).toBe(503);
    rpcResult = answerOf('2026-07-13', '2026-10-10', hundred.slice(12));
    const response = await call(`${HISTORY}?days=90`, REV4);
    expect([response.status, (await response.json()).days.length]).toEqual([200, 88]);
  });
});

describe('score history: consent and faults match the scores route', () => {
  it('says why there is nothing to show as a 200, for every closed reason', async () => {
    for (const reason of ['consent_required', 'consent_withdrawn', 'no_readings']) {
      rpcResult = { unavailable: reason };
      const response = await call(`${HISTORY}?days=30`, REV4);
      expect([response.status, await response.json()]).toEqual([200, { state: 'unavailable', day: null, reason }]);
    }
    rpcResult = { error: 'not_linked' };
    expect(await (await call(`${HISTORY}?days=30`, REV4)).json()).toEqual({ state: 'unavailable', day: null, reason: 'not_linked' });
  });
  it('shows nothing of a withdrawn owner even if the database were to return rows beside the reason', async () => {
    rpcResult = { unavailable: 'consent_withdrawn', ...answerOf('2026-10-04', '2026-10-10', [stored('2026-10-10')]) };
    expect(await (await call(`${HISTORY}?days=7`, REV4)).json()).toEqual({ state: 'unavailable', day: null, reason: 'consent_withdrawn' });
  });
  it('maps the database\'s closed error codes and its outages as the scores route does', async () => {
    quietly();
    for (const [result, status] of [[{ error: 'invalid_request' }, 400], [{ error: 'consent_withdrawn' }, 403], [{ error: 'something else' }, 503], [new Error('owner directory 500'), 503], [{ unavailable: 'because' }, 503]] as const) {
      rpcResult = result;
      expect((await call(`${HISTORY}?days=7`, REV4)).status).toBe(status);
    }
  });
});
