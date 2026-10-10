import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHealthRoutesV1, healthApiErrorV1Schema, healthScoresResponseV1Schema } from '../../contracts/src/app/health-ingest';
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
  TELEGRAM_OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: limiterAllows }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; limiterAllows = true; rpcResult = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (rpcResult instanceof Error) throw rpcResult;
    return Response.json(rpcResult);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${CREDENTIAL}`, ...extra });
const get = (path: string) => handleApp(new Request(`https://w.test${path}`, { headers: headers() }), env(), auth) as Promise<Response>;
const post = (path: string, body: unknown, extra: Record<string, string> = {}) => handleApp(new Request(`https://w.test${path}`, {
  method: 'POST', headers: headers({ 'content-type': 'application/json', ...extra }), body: typeof body === 'string' ? body : JSON.stringify(body),
}), env(), auth) as Promise<Response>;

const sample = { sample_id: 'steps-2026-10-10T08', revision: 1_760_000_000, signal: 'steps_window', unit: 'count', value: 1200, start_at: '2026-10-10T08:00:00Z', end_at: '2026-10-10T09:00:00Z', day: '2026-10-10', utc_offset_minutes: 0 };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, timezone: 'Asia/Kolkata', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [sample], deletions: [] };
const receipt = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
const grant = { request_id: 'consent-grant-001', source: 'apple', purpose: 'storage_compute', version: 2, expected_epoch: 0, age_attested_18_plus: true };
const withdraw = { request_id: 'consent-withdraw-001', source: 'apple', purpose: 'model_processing', expected_epoch: 1 };
const consent = { consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: 2, status: 'granted', epoch: 1, granted_at: '2026-10-10T08:00:00.000Z', withdrawn_at: null, deletion_state: 'not_required' };
const change = { consent, replayed: false, deletion_routed: false };
const available = (over: Record<string, unknown>) => ({ score: 72, zone: 'good', algorithm_version: 'form.v1', activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null, drivers: [], ...over });
const row = { day: '2026-10-10', timezone: 'Asia/Kolkata', compiled_at: '2026-10-10T08:30:00.000Z', freshness: 'fresh', form: available({}), recovery: available({ score: 64, zone: 'moderate', algorithm_version: 'recovery.v1', hrv_method: 'rmssd' }), weight: { reason: 'missing_sleep' } };

describe('app health routes: authentication, limits, framing', () => {
  it('rejects a call without a valid credential, generically, before any database call', async () => {
    for (const [method, path] of [['GET', '/app/v1/health/consents'], ['POST', '/app/v1/health/ingest'], ['GET', '/app/v1/health/scores']] as const) {
      const response = await handleApp(new Request(`https://w.test${path}`, { method }), env(), auth);
      expect([response!.status, await response!.json()]).toEqual([401, { error: 'unavailable' }]);
    }
    expect(rpcs).toEqual([]);
  });
  it('rate-limits per owner on its own key, not the chat budget', async () => {
    rpcResult = { consents: [] };
    expect((await get('/app/v1/health/consents')).status).toBe(200);
    expect(limiterKeys).toEqual(['app-health:owner-1']);
    limiterAllows = false;
    const limited = await get('/app/v1/health/consents');
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '60']);
    expect(rpcs).toHaveLength(1);
  });
  it('answers an unknown health path 404 and a wrong method 405, calling nothing', async () => {
    expect((await get('/app/v1/health/unknown')).status).toBe(404);
    expect((await get('/app/v1/health/ingest')).status).toBe(405);
    expect((await post('/app/v1/health/scores', {})).status).toBe(405);
    expect((await post('/app/v1/health/consents/withdraw', withdraw, { 'content-type': 'text/plain' })).status).toBe(400);
    expect(rpcs).toEqual([]);
  });
  it('is no-store on every answer', async () => {
    rpcResult = change;
    for (const response of [await post('/app/v1/health/consents', grant), await get('/app/v1/health/unknown'), await post('/app/v1/health/ingest', {})]) expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('bounds the body: a declared length over the cap is 413 and nothing is called', async () => {
    const response = await post('/app/v1/health/ingest', batch, { 'content-length': '98305' });
    expect(response.status).toBe(413);
    const streamed = await post('/app/v1/health/ingest', 'x'.repeat(98_305));
    expect(streamed.status).toBe(413);
    expect(rpcs).toEqual([]);
  });
});

describe('app health routes: signed database calls', () => {
  it('lists consents through a signed call whose message binds the operation, the owner and the payload digest', async () => {
    rpcResult = { consents: [consent] };
    const response = await get('/app/v1/health/consents');
    expect([response.status, await response.json()]).toEqual([200, { consents: [consent] }]);
    const [call] = rpcs;
    expect(call!.fn).toBe('health_consent_list');
    expect(call!.body).toMatchObject({ p_do_name: 'owner-1', p_payload: '{}' });
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, call!.body.p_at as number, `health.consent_list.owner-1.${md5Hex('{}')}`));
  });
  it('sends the validated body, re-serialized, and never an owner from the client', async () => {
    rpcResult = change;
    const response = await post('/app/v1/health/consents', grant, { 'idempotency-key': grant.request_id });
    expect([response.status, await response.json()]).toEqual([200, change]);
    const [call] = rpcs;
    expect(call!.fn).toBe('health_consent_grant');
    expect(call!.body.p_payload).toBe(JSON.stringify(grant));
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, call!.body.p_at as number, `health.consent_grant.owner-1.${md5Hex(JSON.stringify(grant))}`));
    expect((await post('/app/v1/health/consents', { ...grant, owner_id: 'someone-else' })).status).toBe(400);
    expect((await post('/app/v1/health/consents', { ...grant, version: 1 })).status).toBe(400);
    expect(rpcs).toHaveLength(1);
  });
  it('withdraws through its own operation', async () => {
    rpcResult = { consent: { ...consent, purpose: 'model_processing', status: 'withdrawn', epoch: 2, withdrawn_at: '2026-10-10T09:00:00.000Z' }, replayed: false, deletion_routed: false };
    const response = await post('/app/v1/health/consents/withdraw', withdraw);
    expect([response.status, (await response.json() as { deletion_routed: boolean }).deletion_routed]).toEqual([200, false]);
    expect(rpcs[0]!.fn).toBe('health_consent_withdraw');
  });
  it('ingests a valid batch and returns the receipt', async () => {
    rpcResult = receipt;
    const response = await post('/app/v1/health/ingest', batch, { 'idempotency-key': batch.request_id });
    expect([response.status, await response.json()]).toEqual([200, receipt]);
    expect(rpcs[0]!.fn).toBe('health_ingest');
    // The Worker signs and forwards its own serialization of the validated body.
    expect(JSON.parse(rpcs[0]!.body.p_payload as string)).toEqual(batch);
    expect(rpcs[0]!.body.p_sig).toBe(await routerSignature(SECRET, rpcs[0]!.body.p_at as number, `health.ingest.owner-1.${md5Hex(rpcs[0]!.body.p_payload as string)}`));
  });
  it('refuses a bad batch before any database call, without echoing it', async () => {
    const bad = [
      { ...batch, samples: [{ ...sample, unit: 'steps' }] },
      { ...batch, timezone: 'Not/AZone' },
      { ...batch, request_id: 'short' },
      { ...batch, extra: true },
      { ...batch, samples: Array.from({ length: 129 }, (_, i) => ({ ...sample, sample_id: `s${i}` })) },
    ];
    for (const body of bad) {
      const response = await post('/app/v1/health/ingest', body);
      expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }]);
    }
    expect((await post('/app/v1/health/ingest', '{"request_id":')).status).toBe(400);
    expect(rpcs).toEqual([]);
  });
  it('requires an Idempotency-Key, when sent, to equal the request id', async () => {
    const response = await post('/app/v1/health/ingest', batch, { 'idempotency-key': 'another-key-0001' });
    expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }]);
    expect(rpcs).toEqual([]);
  });
});

describe('app health routes: error mapping', () => {
  const statuses: Record<string, number> = { invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403, epoch_conflict: 409, idempotency_conflict: 409, anchor_conflict: 409, sample_conflict: 409, unavailable: 503 };
  it('maps every closed error code to one status and passes only the code', async () => {
    expect(Object.keys(statuses).sort()).toEqual([...healthApiErrorV1Schema.shape.error.options].sort());
    for (const [code, status] of Object.entries(statuses)) {
      rpcResult = { error: code };
      const response = await post('/app/v1/health/ingest', batch);
      expect([code, response.status, await response.json()]).toEqual([code, status, { error: code }]);
    }
  });
  it('treats an unknown code, a transport failure and a drifted success shape as unavailable', async () => {
    rpcResult = { error: 'database_exploded: select * from secrets' };
    expect([(await post('/app/v1/health/ingest', batch)).status]).toEqual([503]);
    rpcResult = new Error('owner directory 500');
    expect(await (await post('/app/v1/health/ingest', batch)).json()).toEqual({ error: 'unavailable' });
    rpcResult = { ...receipt, accepted: 'many' };
    expect((await post('/app/v1/health/ingest', batch)).status).toBe(503);
  });
});

describe('app health scores', () => {
  it('translates the stored read model into the contract: zone words by meaning, unavailable pillars with their reason', async () => {
    rpcResult = { scores: row };
    const response = await get('/app/v1/health/scores');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(healthScoresResponseV1Schema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      day: '2026-10-10', timezone: 'Asia/Kolkata', compiled_at: '2026-10-10T08:30:00.000Z', freshness: 'fresh',
      form: { state: 'available', score: 72, zone: 'steady', algorithm_version: 'form.v1', activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null },
      recovery: { state: 'available', score: 64, zone: 'mixed', hrv_method: 'rmssd' },
      weight: { state: 'unavailable', reason: 'missing_sleep' },
    });
    expect(rpcs[0]!.fn).toBe('health_scores_read');
    expect(rpcs[0]!.body.p_payload).toBe('{}');
  });
  it('reads a Weight score by its meaning: a stored high is a peak day', async () => {
    rpcResult = { scores: { ...row, weight: available({ score: 91, zone: 'high', algorithm_version: 'weight.v1' }) } };
    expect((await (await get('/app/v1/health/scores')).json() as { weight: { zone: string } }).weight.zone).toBe('peak');
  });
  it('passes the requested day and refuses a malformed or unknown query', async () => {
    rpcResult = { scores: row };
    await get('/app/v1/health/scores?day=2026-10-10');
    expect(rpcs[0]!.body.p_payload).toBe('{"day":"2026-10-10"}');
    expect((await get('/app/v1/health/scores?day=nope')).status).toBe(400);
    expect((await get('/app/v1/health/scores?owner=x')).status).toBe(400);
    expect(rpcs).toHaveLength(1);
  });
  it('says why there is nothing to show as a 200, never a number', async () => {
    for (const reason of ['consent_required', 'consent_withdrawn', 'no_readings']) {
      rpcResult = { unavailable: reason };
      const response = await get('/app/v1/health/scores');
      expect([response.status, await response.json()]).toEqual([200, { state: 'unavailable', day: null, reason }]);
    }
    rpcResult = { unavailable: 'no_readings' };
    expect(await (await get('/app/v1/health/scores?day=2026-10-09')).json()).toEqual({ state: 'unavailable', day: '2026-10-09', reason: 'no_readings' });
    rpcResult = { error: 'not_linked' };
    expect(await (await get('/app/v1/health/scores')).json()).toEqual({ state: 'unavailable', day: null, reason: 'not_linked' });
  });
  it('keeps real faults as errors: an outage is 503, a malformed reason is 503', async () => {
    rpcResult = new Error('owner directory 500');
    expect((await get('/app/v1/health/scores')).status).toBe(503);
    rpcResult = { unavailable: 'because' };
    expect((await get('/app/v1/health/scores')).status).toBe(503);
  });
  it('shows a score whose algorithm has no zone bands yet without a zone word', async () => {
    rpcResult = { scores: { ...row, recovery: available({ score: 64, zone: 'unknown', algorithm_version: 'recovery.v1' }) } };
    const body = await (await get('/app/v1/health/scores')).json() as { recovery: { state: string; score: number; zone: unknown } };
    expect(body.recovery).toMatchObject({ state: 'available', score: 64, zone: null });
  });
  it('does not invent a pillar the contract cannot express', async () => {
    rpcResult = { scores: { ...row, form: available({ zone: 'excellent' }) } };
    expect((await get('/app/v1/health/scores')).status).toBe(503);
    rpcResult = { scores: { ...row, freshness: null } };
    expect((await get('/app/v1/health/scores')).status).toBe(503);
  });
});

describe('app health route table', () => {
  it('serves exactly the routes the contract declares', () => {
    expect(appHealthRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/health/consents', 'POST /app/v1/health/consents', 'POST /app/v1/health/consents/withdraw', 'POST /app/v1/health/ingest', 'GET /app/v1/health/scores',
    ]);
  });
});
