import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appHealthRoutesV1, HEALTH_INGEST_MAX_REQUEST_BYTES_V1, healthApiErrorV1Schema, healthDriverPhraseV1Schema, healthIngestV1Schema, healthScoresResponseV1Schema, healthScoresV1Schema } from '../../contracts/src/app/health-ingest';
import { handleApp } from '../src/channels/app-api';
import { healthScoresView } from '../src/channels/app-health';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
let limiterAllows = true;
let coaching: string | undefined;
const env = () => ({
  ...(coaching === undefined ? {} : { HEALTH_COACHING: coaching }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: limiterAllows }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; limiterAllows = true; rpcResult = {}; coaching = undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (rpcResult instanceof Error) throw rpcResult;
    return Response.json(rpcResult);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${CREDENTIAL}`, ...extra });
const get = (path: string, extra: Record<string, string> = {}) => handleApp(new Request(`https://w.test${path}`, { headers: headers(extra) }), env(), auth) as Promise<Response>;
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
  it('shows a provider\'s consent rows only to a build that names health revision 2', async () => {
    const whoopRow = { ...consent, source: 'whoop', version: 3 };
    rpcResult = { consents: [consent, whoopRow] };
    const older = await get('/app/v1/health/consents');
    expect(await older.json()).toEqual({ consents: [consent] });
    const asked = (header: string) => handleApp(new Request('https://w.test/app/v1/health/consents', { headers: headers({ 'x-waldo-app-contract': header }) }), env(), auth) as Promise<Response>;
    expect(await (await asked('health=2')).json()).toEqual({ consents: [consent, whoopRow] });
    expect(await (await asked('health=1')).json()).toEqual({ consents: [consent] });
    expect(await (await asked('approvals=2')).json()).toEqual({ consents: [consent] });
  });
  it('refuses an app upload that claims a provider\'s name, and never calls the database', async () => {
    const whoop = { ...batch, request_id: 'health-upload-w1', source: 'whoop' };
    const response = await post('/app/v1/health/ingest', whoop, { 'idempotency-key': whoop.request_id });
    expect([response.status, await response.json(), rpcs]).toEqual([400, { error: 'invalid_request' }, []]);
  });
  it('takes a WHOOP grant only on the WHOOP notice\'s copy version, and a device grant only on the device copy', async () => {
    const whoopGrant = { ...grant, request_id: 'consent-grant-w01', source: 'whoop', version: 3 };
    for (const refused of [{ ...whoopGrant, version: 2 }, { ...grant, version: 3 }]) {
      expect((await post('/app/v1/health/consents', refused, { 'idempotency-key': refused.request_id })).status, JSON.stringify(refused)).toBe(400);
    }
    expect(rpcs).toEqual([]);
    rpcResult = { consent: { ...consent, source: 'whoop', version: 3 }, replayed: false, deletion_routed: false };
    const accepted = await post('/app/v1/health/consents', whoopGrant, { 'idempotency-key': whoopGrant.request_id });
    expect([accepted.status, rpcs.map(call => call.fn)]).toEqual([200, ['health_consent_grant']]);
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
  it('ingests a Health Connect batch the same way, keeping its HC origin', async () => {
    const origin = { read_api: 'health_connect', source_bundle_id: null, source_package_name: 'com.example.ringapp', source_version: null, source_revision: null, device_ref: null, recording_method: 'automatic', client_record_version: 3 };
    const hc = { ...batch, request_id: 'health-upload-hc-1', source: 'health_connect', samples: [{ ...sample, sample_id: 'hc:steps:2026-10-10T08', origin }] };
    rpcResult = { ...receipt, request_id: hc.request_id, source: 'health_connect' };
    const response = await post('/app/v1/health/ingest', hc, { 'idempotency-key': hc.request_id });
    expect([response.status, rpcs[0]!.fn]).toEqual([200, 'health_ingest']);
    expect(JSON.parse(rpcs[0]!.body.p_payload as string)).toEqual(hc);
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

// Health revision 3: one bad reading never fails an upload. The Worker checks each change on its own and forwards a bad one
// as its reason and kind only; the database stores the rest and numbers every rejection on the receipt.
describe('app health ingest: per-sample rejection at health revision 3', () => {
  const v3 = { 'x-waldo-app-contract': 'approvals=2,health=3' };
  // Synthetic marker values: a bad reading's value must never leave the Worker.
  const tooMany = { ...sample, sample_id: 'steps-bad-1', value: 777_777 };
  const unknownKind = { ...sample, sample_id: 'glucose-1', signal: 'blood_glucose', unit: 'mmol_per_l', value: 6.6123 };
  const goodDeletion = { sample_id: 'spo2-gone-1', signal: 'spo2', revision: 3 };
  const mixed = { ...batch, request_id: 'health-upload-v3-1', samples: [sample, tooMany, unknownKind, 'hostile', { ...sample, sample_id: 'steps-2026-10-10T09', start_at: '2026-10-10T09:00:00Z', end_at: '2026-10-10T10:00:00Z' }], deletions: [goodDeletion, { ...goodDeletion, revision: -5 }] };
  const rejections = [
    { change: 'sample', index: 1, signal: 'steps_window', reason: 'invalid_sample' }, { change: 'sample', index: 2, signal: null, reason: 'unsupported_signal' },
    { change: 'sample', index: 3, signal: null, reason: 'invalid_sample' }, { change: 'deletion', index: 1, signal: 'spo2', reason: 'invalid_sample' },
  ];
  const v3Receipt = { ...receipt, request_id: mixed.request_id, accepted: 2, deleted: 1, rejected: rejections };
  it('forwards the good changes and only the position, kind and reason of the bad ones, and returns the receipt with them', async () => {
    rpcResult = v3Receipt;
    const response = await post('/app/v1/health/ingest', mixed, { ...v3, 'idempotency-key': mixed.request_id });
    expect([response.status, await response.json()]).toEqual([200, v3Receipt]);
    const payload = rpcs[0]!.body.p_payload as string;
    expect(JSON.parse(payload)).toEqual({
      ...mixed, rejection: 'per_sample',
      samples: [sample, { rejected: 'invalid_sample', signal: 'steps_window' }, { rejected: 'unsupported_signal', signal: null }, { rejected: 'invalid_sample', signal: null }, mixed.samples[4]],
      deletions: [goodDeletion, { rejected: 'invalid_sample', signal: 'spo2' }],
    });
    for (const leaked of ['777777', '6.6123', 'hostile', 'blood_glucose', '-5']) expect(payload).not.toContain(leaked);
    expect(rpcs[0]!.body.p_sig).toBe(await routerSignature(SECRET, rpcs[0]!.body.p_at as number, `health.ingest.owner-1.${md5Hex(payload)}`));
  });
  it('takes the Watch wellness signals in both modes, and at revision 3 names a bad one by its signal and nothing else', async () => {
    const point = { ...sample, start_at: '2026-10-10T02:00:00Z', end_at: '2026-10-10T02:00:00Z' };
    const temperature = { ...point, sample_id: 'temp-1', signal: 'wrist_temperature', unit: 'celsius', method: 'absolute', value: 34.2 };
    const fitness = { ...point, sample_id: 'vo2-1', signal: 'vo2_max', unit: 'ml_per_kg_min', value: 41.5 };
    const wellness = { ...batch, request_id: 'health-upload-watch-1', samples: [temperature, fitness], deletions: [{ sample_id: 'mind-1', signal: 'mindful_duration', revision: 2 }] };
    rpcResult = { ...receipt, request_id: wellness.request_id, accepted: 2, deleted: 1 };
    expect((await post('/app/v1/health/ingest', wellness)).status).toBe(200);
    expect(JSON.parse(rpcs[0]!.body.p_payload as string)).toEqual(wellness);
    const fahrenheit = { ...wellness, request_id: 'health-upload-watch-2', samples: [{ ...temperature, value: 93.9871 }, fitness] };
    rpcResult = { ...receipt, request_id: fahrenheit.request_id, accepted: 1, deleted: 1, rejected: [{ change: 'sample', index: 0, signal: 'wrist_temperature', reason: 'invalid_sample' }] };
    expect((await post('/app/v1/health/ingest', fahrenheit, v3)).status).toBe(200);
    const payload = rpcs[1]!.body.p_payload as string;
    expect(JSON.parse(payload).samples).toEqual([{ rejected: 'invalid_sample', signal: 'wrist_temperature' }, fitness]);
    expect(payload).not.toContain('93.9871');
    // The same batch from an older build is refused whole, as every bad batch always was.
    expect((await post('/app/v1/health/ingest', { ...fahrenheit, request_id: 'health-upload-watch-3' })).status).toBe(400);
    expect(rpcs).toHaveLength(2);
  });
  it('keeps an older build all-or-nothing, exactly as before: the same mixed batch is refused and nothing is called', async () => {
    for (const header of [{}, { 'x-waldo-app-contract': 'health=2' }, { 'x-waldo-app-contract': 'health=1' }, { 'x-waldo-app-contract': 'health=3,health=3' }, { 'x-waldo-app-contract': 'approvals=3' }] as Record<string, string>[]) {
      const response = await post('/app/v1/health/ingest', mixed, header);
      expect([JSON.stringify(header), response.status, await response.json()]).toEqual([JSON.stringify(header), 400, { error: 'invalid_request' }]);
    }
    expect(rpcs).toEqual([]);
    rpcResult = receipt;
    const response = await post('/app/v1/health/ingest', batch, { 'x-waldo-app-contract': 'health=2' });
    expect([response.status, await response.json()]).toEqual([200, receipt]);
    expect(rpcs[0]!.body.p_payload).toBe(JSON.stringify(healthIngestV1Schema.parse(batch)));
  });
  it('sends an all-bad batch and an empty one to the database, so the anchor and the receipt still record them', async () => {
    const allBad = { ...batch, request_id: 'health-upload-v3-2', samples: [tooMany, unknownKind], deletions: [] };
    rpcResult = { ...receipt, request_id: allBad.request_id, accepted: 0, rejected: rejections.slice(0, 2) };
    expect((await post('/app/v1/health/ingest', allBad, v3)).status).toBe(200);
    expect(JSON.parse(rpcs[0]!.body.p_payload as string).samples).toEqual([{ rejected: 'invalid_sample', signal: 'steps_window' }, { rejected: 'unsupported_signal', signal: null }]);
    const empty = { ...batch, request_id: 'health-upload-v3-3', samples: [], deletions: [] };
    rpcResult = { ...receipt, request_id: empty.request_id, accepted: 0, rejected: [] };
    const answered = await post('/app/v1/health/ingest', empty, v3);
    expect([answered.status, (await answered.json() as { rejected: unknown }).rejected]).toEqual([200, []]);
    expect(JSON.parse(rpcs[1]!.body.p_payload as string)).toEqual({ ...empty, rejection: 'per_sample' });
  });
  it('passes duplicates and out-of-order revisions through in their own positions, for the database to order', async () => {
    const older = { ...sample, revision: sample.revision - 10 };
    const twice = { ...batch, request_id: 'health-upload-v3-4', samples: [sample, sample, older] };
    rpcResult = { ...receipt, request_id: twice.request_id, ignored: 2, rejected: [] };
    expect((await post('/app/v1/health/ingest', twice, v3)).status).toBe(200);
    expect(JSON.parse(rpcs[0]!.body.p_payload as string).samples).toEqual([sample, sample, older]);
  });
  it('still refuses a whole request whose envelope is wrong, and never lets a client choose the mode', async () => {
    const refused = [
      { ...mixed, rejection: 'all_or_nothing' }, { ...mixed, rejection: 'per_sample' }, { ...mixed, owner_id: 'someone-else' }, { ...mixed, samples: { 0: sample } },
      { ...mixed, samples: Array.from({ length: 129 }, () => 'x'), deletions: [] }, { ...mixed, timezone: 'Not/AZone' }, { ...mixed, source: 'whoop' }, { ...mixed, request_id: 'short' },
    ];
    for (const body of refused) {
      const response = await post('/app/v1/health/ingest', body, v3);
      expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }]);
    }
    expect((await post('/app/v1/health/ingest', '{"samples":[', v3)).status).toBe(400);
    expect((await post('/app/v1/health/ingest', mixed, { ...v3, 'content-length': '98305' })).status).toBe(413);
    expect((await post('/app/v1/health/ingest', mixed, { ...v3, 'idempotency-key': 'another-key-0001' })).status).toBe(400);
    expect(rpcs).toEqual([]);
  });
  it('answers 413, calling nothing, when a body at the cap would pass it once the bad changes are stood in for', async () => {
    // Real sleep readings can be long: a session lists every contributing record. Six valid sessions, each grown until the
    // client body sits just under the cap, and 122 bad changes whose stand-ins are longer than the changes themselves.
    const night = (n: number, contributors: number) => ({
      ...sample, sample_id: `sleep-2026-10-0${n}`, signal: 'sleep_duration', unit: 'minutes', value: 420,
      start_at: `2026-10-0${n}T22:00:00Z`, end_at: `2026-10-0${n}T23:00:00Z`, day: `2026-10-0${n}`,
      sleep_context: { source_ref: 'watch', session_ref: `session-${n}`, waking_day: `2026-10-0${n}`, reducer_version: 'asleep-interval-union.v1',
        contributor_ids: Array.from({ length: contributors }, (_, i) => `c${n}-${String(i).padStart(3, '0')}-${'x'.repeat(115)}`), intervals: [] },
    });
    const body = (contributors: number) => ({ ...batch, request_id: 'health-upload-v3-big', anchor_after: 'a'.repeat(2048), samples: [...[1, 2, 3, 4, 5, 6].map((n) => night(n, contributors)), ...Array.from({ length: 122 }, () => 0)] });
    let contributors = 1;
    while (JSON.stringify(body(contributors + 1)).length <= HEALTH_INGEST_MAX_REQUEST_BYTES_V1) contributors += 1;
    const big = body(contributors);
    expect(healthIngestV1Schema.shape.samples.element.safeParse(big.samples[0]).success).toBe(true);
    expect(HEALTH_INGEST_MAX_REQUEST_BYTES_V1 - JSON.stringify(big).length).toBeLessThan(122 * 40);
    const response = await post('/app/v1/health/ingest', big, { ...v3, 'idempotency-key': big.request_id });
    expect([response.status, await response.json()]).toEqual([413, { error: 'invalid_request' }]);
    expect(rpcs).toEqual([]);
  });
  it('maps a database refusal of the whole request as before', async () => {
    for (const code of ['consent_required', 'epoch_conflict', 'anchor_conflict', 'idempotency_conflict']) {
      rpcResult = { error: code };
      const response = await post('/app/v1/health/ingest', mixed, v3);
      expect([response.status, await response.json()]).toEqual([code === 'consent_required' ? 403 : 409, { error: code }]);
    }
    rpcResult = { ...v3Receipt, rejected: [{ ...rejections[0], value: 777_777 }] };
    expect((await post('/app/v1/health/ingest', mixed, v3)).status).toBe(503);
  });
  it('logs a refused upload by code and status only, so a stuck sync is visible without its readings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await post('/app/v1/health/ingest', mixed);
      rpcResult = { error: 'anchor_conflict' };
      await post('/app/v1/health/ingest', batch);
      rpcResult = receipt;
      await post('/app/v1/health/ingest', batch);
      expect(warn.mock.calls).toEqual([['app health ingest refused', { status: 400, error: 'invalid_request' }], ['app health ingest refused', { status: 409, error: 'anchor_conflict' }]]);
    } finally { warn.mockRestore(); }
  });
});

// Health revision 6: zones the phone set from the highest heart rate seen in a workout reach the database with that basis, so the
// producer can call them approximate.
describe('app health ingest: zones from an observed workout peak at health revision 6', () => {
  it('forwards the workout whole, its zone basis included', async () => {
    const coach = (await import('../../contracts/src/app/fixtures/health-ingest-coach.v5.json')).default.request;
    const workout = coach.samples[0]!, ride = { ...workout, hr_zones: { ...workout.hr_zones, basis: 'observed_workout_peak' } };
    const upload = { ...coach, request_id: 'health-upload-peak-1', samples: [ride], deletions: [] };
    rpcResult = { ...receipt, request_id: upload.request_id, anchor_after: upload.anchor_after };
    const response = await post('/app/v1/health/ingest', upload, { 'x-waldo-app-contract': 'approvals=2,health=6', 'idempotency-key': upload.request_id });
    expect(response.status).toBe(200);
    expect(JSON.parse(rpcs[0]!.body.p_payload as string).samples).toEqual([ride]);
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

// The scores schema an installed build parses with, copied from the app's own pin of this contract: strict objects, with
// sleep_debt optional. A body this rejects would break that build.
const pinnedUnavailable = z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['not_linked', 'consent_required', 'consent_withdrawn', 'no_readings', 'baseline_immature', 'missing_sleep', 'missing_resting_signal', 'stale_inputs', 'conflicting_inputs', 'intraday_inputs_unavailable', 'calendar_demand_unavailable']) });
const pinnedVersion = { algorithm_version: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.v[0-9]+$/).max(64), activation: z.enum(['candidate_unaccepted', 'accepted']) };
const pinnedPillar = (zone: readonly [string, ...string[]]) => z.union([pinnedUnavailable, z.strictObject({ state: z.literal('available'), score: z.number().finite().min(0).max(100), zone: z.enum(zone).nullable(), ...pinnedVersion, confidence: z.number().finite().min(0).max(1).nullable(), hrv_method: z.enum(['rmssd', 'sdnn']).nullable() })]);
const pinnedScores = z.strictObject({
  day: z.iso.date(), timezone: z.string(), compiled_at: z.iso.datetime({ offset: true }), freshness: z.enum(['fresh', 'stale', 'expired']),
  recovery: pinnedPillar(['excellent', 'solid', 'mixed', 'compromised']), form: pinnedPillar(['energized', 'steady', 'flagging', 'depleted']), weight: pinnedPillar(['light', 'moderate', 'heavy', 'peak']),
  sleep_debt: z.union([pinnedUnavailable, z.strictObject({ state: z.literal('partial'), confidence: z.number().finite().min(0).max(1), ...pinnedVersion }),
    z.strictObject({ state: z.literal('available'), debt_minutes: z.number().finite().min(0).max(20_160), need_basis: z.enum(['owner_confirmed', 'own_average']), ...pinnedVersion })]).optional(),
});

// Builds pinned before the app took sleep_debt parse the scores with no such key, strictly.
const pinnedBeforeSleepDebt = pinnedScores.omit({ sleep_debt: true });

describe('app health scores', () => {
  const version = { algorithm_version: 'sleep-debt.candidate.v1', activation: 'candidate_unaccepted' };
  const debts = [{ state: 'unavailable', reason: 'missing_sleep' }, { state: 'partial', confidence: 0.6, ...version }, { state: 'available', debt_minutes: 315.5, need_basis: 'own_average', ...version }];
  it('serves stored sleep debt from health revision 2, in a shape an installed build parses with its own pin', async () => {
    for (const sleep_debt of debts) {
      rpcResult = { scores: { ...row, sleep_debt } };
      for (const contract of [{ 'x-waldo-app-contract': 'health=2' }, { 'x-waldo-app-contract': 'health=3' }, { 'x-waldo-app-contract': 'approvals=3,health=3' }] as Record<string, string>[]) {
        const body = await (await get('/app/v1/health/scores', contract)).json() as Record<string, unknown>;
        expect(pinnedScores.safeParse(body).success, `${sleep_debt.state} ${JSON.stringify(contract)}`).toBe(true);
        expect(body.sleep_debt).toEqual(sleep_debt);
      }
    }
  });
  it('never shows sleep debt to a build below health revision 2, which keeps all three scores', async () => {
    for (const sleep_debt of debts) {
      rpcResult = { scores: { ...row, sleep_debt } };
      for (const contract of [{}, { 'x-waldo-app-contract': 'health=1' }, { 'x-waldo-app-contract': 'approvals=3' }, { 'x-waldo-app-contract': 'health=two' }] as Record<string, string>[]) {
        const response = await get('/app/v1/health/scores', contract);
        const body = await response.json() as Record<string, unknown>;
        const label = `${sleep_debt.state} ${JSON.stringify(contract)}`;
        expect([response.status, 'sleep_debt' in body], label).toEqual([200, false]);
        expect(pinnedBeforeSleepDebt.safeParse(body).success, label).toBe(true);
      }
    }
  });
  it('answers without sleep debt when the row has none, or holds one it cannot read, and still serves the scores', async () => {
    for (const stored of [row, { ...row, sleep_debt: { state: 'available', debt_minutes: -1 } }, { ...row, sleep_debt: 'lots' }]) {
      rpcResult = { scores: stored };
      const response = await get('/app/v1/health/scores', { 'x-waldo-app-contract': 'health=2' });
      const body = await response.json() as Record<string, unknown>;
      expect([response.status, 'sleep_debt' in body, pinnedScores.safeParse(body).success]).toEqual([200, false, true]);
    }
  });
  it('translates the stored read model into the contract: zone words by meaning, unavailable pillars with their reason', async () => {
    rpcResult = { scores: row };
    const response = await get('/app/v1/health/scores');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(healthScoresResponseV1Schema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      day: '2026-10-10', timezone: 'Asia/Kolkata', compiled_at: '2026-10-10T08:30:00.000Z',
      form: { state: 'available', score: 72, zone: 'steady', algorithm_version: 'form.v1', activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null },
      recovery: { state: 'available', score: 64, zone: 'mixed', hrv_method: 'rmssd' },
      weight: { state: 'unavailable', reason: 'missing_sleep' },
    });
    expect(rpcs[0]!.fn).toBe('health_scores_read');
    expect(rpcs[0]!.body.p_payload).toBe('{}');
  });
  it('ages a stored row by ADR-0081 §2 when read, whatever freshness it was written with', async () => {
    const realNow = Date.now;
    const freshnessAt = async (instant: string, stored: Record<string, unknown> = {}) => {
      Date.now = () => Date.parse(instant);
      try {
        rpcResult = { scores: { ...row, freshness: 'stale', ...stored } };
        return (await (await get('/app/v1/health/scores')).json() as { freshness: string }).freshness;
      } finally { Date.now = realNow; }
    };
    // The row is the 10th in Kolkata, compiled at 08:30 UTC on the 10th.
    expect(await freshnessAt('2026-10-10T14:30:00Z')).toBe('fresh');
    expect(await freshnessAt('2026-10-10T14:30:01Z', { freshness: 'fresh' })).toBe('stale');
    expect(await freshnessAt('2026-10-11T18:00:00Z', { freshness: 'fresh' })).toBe('stale');
    expect(await freshnessAt('2026-10-13T08:30:00Z')).toBe('stale');
    expect(await freshnessAt('2026-10-13T08:30:01Z', { freshness: 'fresh' })).toBe('expired');
    // Compiled two hours before the read, but by then the row's day is two local days back.
    expect(await freshnessAt('2026-10-11T22:00:00Z', { compiled_at: '2026-10-11T20:00:00.000Z', freshness: 'fresh' })).toBe('stale');
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
    // A row in a zone the platform does not know cannot be aged, so it is not shown with a guessed freshness.
    rpcResult = { scores: { ...row, timezone: 'Mars/Olympus_Mons' } };
    expect((await get('/app/v1/health/scores')).status).toBe(503);
  });
});

// The owner's stated sleep need: read and replaced whole through the signed health-plane calls. Every value is synthetic.
describe('app health settings', () => {
  const put = (body: unknown, path = '/app/v1/health/settings', extra: Record<string, string> = headers()) => handleApp(new Request(`https://w.test${path}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env(), auth) as Promise<Response>;
  beforeEach(() => { coaching = '1'; });

  it('is not served while the coaching switch is off: 404 as an unknown path, with no database call', async () => {
    for (const value of [undefined, '0', 'true']) {
      coaching = value;
      expect((await get('/app/v1/health/settings')).status, String(value)).toBe(404);
      expect((await put({ sleep_need_minutes: 480 })).status, String(value)).toBe(404);
    }
    expect(rpcs).toEqual([]);
  });

  it('writes only after the credential and the owner\'s health budget, and for the session\'s owner alone', async () => {
    expect((await put({ sleep_need_minutes: 480 }, undefined, {})).status).toBe(401);
    expect(limiterKeys).toEqual([]);
    rpcResult = { sleep_need_minutes: 480, updated_at: '2026-10-10T08:00:00.000Z' };
    expect((await put({ sleep_need_minutes: 480 }, '/app/v1/health/settings?owner=owner-2')).status).toBe(200);
    expect(limiterKeys).toEqual(['app-health:owner-1']);
    const [sent] = rpcs;
    expect(Object.keys(sent!.body).sort()).toEqual(['p_at', 'p_do_name', 'p_payload', 'p_sig']);
    expect(sent!.body.p_do_name).toBe('owner-1');
    expect(sent!.body.p_sig).toBe(await routerSignature(SECRET, sent!.body.p_at as number, `health.settings_write.owner-1.${md5Hex('{"sleep_need_minutes":480}')}`));
    limiterAllows = false; rpcs.length = 0;
    const limited = await put({ sleep_need_minutes: 480 });
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '60']);
    expect(rpcs).toEqual([]);
  });

  it('reads the stated need through the signed settings read, and shows the app the need alone', async () => {
    rpcResult = { sleep_need_minutes: 480, updated_at: '2026-10-10T08:00:00.000Z' };
    const response = await get('/app/v1/health/settings');
    expect([response.status, await response.json()]).toEqual([200, { sleep_need_minutes: 480 }]);
    expect(rpcs.map(call => [call.fn, call.body.p_do_name, call.body.p_payload])).toEqual([['health_settings_read', 'owner-1', '{}']]);
  });

  it('replaces it whole, and answers with what the health plane stored', async () => {
    rpcResult = { sleep_need_minutes: 450, updated_at: '2026-10-10T08:00:00.000Z' };
    const response = await put({ sleep_need_minutes: 450 });
    expect([response.status, await response.json()]).toEqual([200, { sleep_need_minutes: 450 }]);
    expect(rpcs.map(call => [call.fn, call.body.p_payload, call.body.p_sig === undefined])).toEqual([['health_settings_write', '{"sleep_need_minutes":450}', false]]);
    rpcResult = { sleep_need_minutes: null, updated_at: '2026-10-10T08:05:00.000Z' };
    expect(await (await put({ sleep_need_minutes: null })).json()).toEqual({ sleep_need_minutes: null });
  });

  it('refuses a body outside the contract before any database call', async () => {
    for (const body of [{}, { sleep_need_minutes: 359 }, { sleep_need_minutes: 601 }, { sleep_need_minutes: 480, owner_id: 'owner-2' }, 'not json']) {
      const response = await put(body);
      expect([response.status, await response.json()], JSON.stringify(body)).toEqual([400, { error: 'invalid_request' }]);
    }
    expect(rpcs).toEqual([]);
  });

  it('passes a closed database refusal on, and never a database answer outside the contract', async () => {
    rpcResult = { error: 'not_linked' };
    expect((await get('/app/v1/health/settings')).status).toBe(403);
    rpcResult = { sleep_need_minutes: 9000 };
    const response = await put({ sleep_need_minutes: 480 });
    expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable' }]);
  });

  it('takes GET and PUT only, behind the app credential', async () => {
    expect((await post('/app/v1/health/settings', { sleep_need_minutes: 480 })).status).toBe(405);
    const anonymous = await handleApp(new Request('https://w.test/app/v1/health/settings'), env(), auth);
    expect(anonymous!.status).toBe(401);
    expect(rpcs).toEqual([]);
  });
});

describe('app health route table', () => {
  it('serves exactly the routes the contract declares', () => {
    expect(appHealthRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/health/consents', 'POST /app/v1/health/consents', 'POST /app/v1/health/consents/withdraw', 'POST /app/v1/health/ingest', 'GET /app/v1/health/scores', 'GET /app/v1/health/scores/history',
      'GET /app/v1/health/settings', 'PUT /app/v1/health/settings',
    ]);
  });
});

// Health revision 4: the baseline label, the drivers and the energy windows. A build that does not name it never sees them,
// and never sees a score that leans on the all-adults prior without its label.
describe('app health scores: revision 4', () => {
  const healthDriverPool = healthDriverPhraseV1Schema.options.slice(0, 5);
  const personal = { state: 'personal', personal_days: 20, needed: 14, prior: 'adults' };
  const provisional = { state: 'provisional', personal_days: 5, needed: 14, prior: 'adults' };
  const drivers = ['wrist temperature far above usual', 'blood oxygen below usual'];
  const windows = [{ start: '09:30', end: '11:45', kind: 'peak' }, { start: '14:00', end: '15:15', kind: 'dip' }];
  const extras = { drivers, windows };
  const withBaseline = (baseline: unknown, over: Record<string, unknown> = {}) => ({
    ...row, recovery: available({ score: 64, zone: 'moderate', algorithm_version: 'recovery.v5', activation: 'accepted', hrv_method: 'rmssd', baseline }), ...over,
  });
  const plain = { ...row, recovery: available({ score: 64, zone: 'moderate', algorithm_version: 'recovery.v5', activation: 'accepted', hrv_method: 'rmssd' }) };
  const contracts = (revision: string): Record<string, string> => ({ 'x-waldo-app-contract': revision });
  const text = async (stored: unknown, header: Record<string, string> = {}) => { rpcResult = { scores: stored }; const response = await get('/app/v1/health/scores', header); return [response.status, await response.text()] as const; };
  const json = async (stored: unknown, header: Record<string, string> = {}) => JSON.parse((await text(stored, header))[1]) as Record<string, any>;
  const tagsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(args => JSON.stringify(args)).join('\n');

  it('answers a build below revision 4 with exactly the bytes it had before, whatever the stored row carries', async () => {
    for (const header of [{}, contracts('health=1'), contracts('health=2'), contracts('health=3'), contracts('approvals=4,health=3')]) {
      const [status, bare] = await text(plain, header);
      const [carriedStatus, carried] = await text(withBaseline(personal, extras), header);
      expect([carriedStatus, carried], JSON.stringify(header)).toEqual([status, bare]);
      expect(carried).not.toMatch(/baseline|drivers|windows/);
    }
    const revisionThree = await json(withBaseline(personal, extras), contracts('health=3'));
    expect(pinnedScores.safeParse(revisionThree).success).toBe(true);
    const revisionOne = await json(withBaseline(personal, extras));
    expect(pinnedBeforeSleepDebt.safeParse(revisionOne).success).toBe(true);
  });
  it('shows a build below revision 4 a provisional pillar as not yet learned, never as a score without its label', async () => {
    for (const header of [{}, contracts('health=2'), contracts('health=3')]) {
      const body = await json(withBaseline(provisional, extras), header);
      expect(body.recovery, JSON.stringify(header)).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
      expect(body.form).toMatchObject({ state: 'available', score: 72 });
      expect(pinnedScores.safeParse(body).success).toBe(true);
    }
  });
  it('hides a provisional pillar from an old build even when its stored label is damaged', async () => {
    for (const baseline of [{ state: 'provisional' }, { ...provisional, personal_days: -3 }, { ...provisional, prior: 'someone' }]) {
      expect((await json(withBaseline(baseline), contracts('health=3'))).recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    }
  });
  it('fails closed on a stored baseline it cannot read for a build below revision 4 as well, never as an unlabelled number', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const damaged = [{ state: 'personal', personal_days: 20 }, { ...personal, needed: 7 }, 'personal', { ...personal, extra: 1 }, null, {}, { ...personal, state: 'learning' }, []];
    for (const header of [{}, contracts('health=2'), contracts('health=3')]) {
      for (const baseline of damaged) {
        const body = await json(withBaseline(baseline), header);
        expect(body.recovery, `${JSON.stringify(header)} ${JSON.stringify(baseline)}`).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
        expect(body.form).toMatchObject({ state: 'available', score: 72 });
        expect(pinnedScores.safeParse(body).success).toBe(true);
      }
    }
    expect(error).toHaveBeenCalledWith('app health scores baseline shape');
    expect(tagsOf(error)).not.toMatch(/provisional|personal|learning/);
  });
  it('does not hide a personal baseline from an old build, and leaves its pillar as it was', async () => {
    expect((await json(withBaseline(personal), contracts('health=3'))).recovery).toEqual((await json(plain, contracts('health=3'))).recovery);
  });
  it('passes the baseline of each pillar, the drivers and the windows through to a build that names revision 4', async () => {
    const stored = withBaseline(provisional, { ...extras, form: available({ baseline: personal }), sleep_debt: { state: 'unavailable', reason: 'missing_sleep' } });
    for (const header of [contracts('health=4'), contracts('approvals=3,health=4'), contracts('health=5')]) {
      const body = await json(stored, header);
      expect(healthScoresV1Schema.safeParse(body).success, JSON.stringify(header)).toBe(true);
      expect(body.recovery).toMatchObject({ state: 'available', score: 64, baseline: provisional });
      expect(body.form).toMatchObject({ state: 'available', baseline: personal });
      expect([body.drivers, body.windows, body.sleep_debt]).toEqual([drivers, windows, { state: 'unavailable', reason: 'missing_sleep' }]);
    }
  });
  it('leaves the three keys out at revision 4 for a row that has none, never as nulls', async () => {
    const body = await json(plain, contracts('health=4'));
    expect(healthScoresV1Schema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/baseline|drivers|windows/);
    expect(Object.keys(body)).toEqual(['day', 'timezone', 'compiled_at', 'freshness', 'recovery', 'form', 'weight']);
  });
  it('fails closed on a stored baseline it cannot read: the pillar is served as not yet learned, never as a score without its label', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const damaged = [{ state: 'provisional', personal_days: 5 }, { ...provisional, needed: 7 }, 'provisional', { ...provisional, extra: 1 }, null, {}, { ...personal, state: 'learning' }];
    for (const baseline of damaged) {
      const body = await json(withBaseline(baseline, { ...extras, form: available({ baseline: personal }) }), contracts('health=4'));
      expect(healthScoresV1Schema.safeParse(body).success, JSON.stringify(baseline)).toBe(true);
      expect(body.recovery, JSON.stringify(baseline)).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
      expect(body.form).toMatchObject({ state: 'available', baseline: personal });
      expect([body.drivers, body.windows]).toEqual([drivers, windows]);
    }
    expect(error).toHaveBeenCalledWith('app health scores baseline shape');
    expect(tagsOf(error)).not.toMatch(/provisional|personal|learning/);
  });
  it('serves a pillar with no baseline key exactly as before, at revision 4 too', async () => {
    const body = await json(plain, contracts('health=4'));
    expect(body.recovery).toMatchObject({ state: 'available', score: 64 });
    expect('baseline' in body.recovery).toBe(false);
  });
  it('drops stored drivers or windows it cannot read, tells the log only a tag, and still serves the pillars and the scores', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badDrivers = await json(withBaseline(personal, { drivers: ['feeling tired near 1234'], windows }), contracts('health=4'));
    const badWindows = await json(withBaseline(personal, { drivers, windows: [{ start: '9:30 secret', end: '11:45', kind: 'peak' }] }), contracts('health=4'));
    const tooMany = await json(withBaseline(personal, { drivers: [...healthDriverPool, ...healthDriverPool], windows }), contracts('health=4'));
    expect([badDrivers.drivers, badDrivers.windows, badDrivers.recovery.baseline]).toEqual([undefined, windows, personal]);
    expect([badWindows.windows, badWindows.drivers]).toEqual([undefined, drivers]);
    expect(tooMany.drivers).toBeUndefined();
    expect(tagsOf(error)).not.toMatch(/1234|secret|feeling|provisional|personal/);
    expect(error).toHaveBeenCalledWith('app health scores drivers shape');
    expect(error).toHaveBeenCalledWith('app health scores windows shape');
  });
  // The app's sleep debt and scores are strict objects, so a key the pin lacks would cost an installed build its whole answer.
  // The trend and the windows' version live on the stored row for the model and the backend only.
  it('never serves the sleep debt trend or the windows version, at any revision, and the answer still parses strictly', async () => {
    const debt = { state: 'available', debt_minutes: 95, need_basis: 'blended_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' };
    for (const trend of ['building', 'easing', 'steady']) {
      const stored = withBaseline(personal, { ...extras, windows_version: 'energy-windows.v1', sleep_debt: { ...debt, trend } });
      const headers: [Record<string, string>, boolean][] = [[{}, false], [contracts('health=2'), false], [contracts('health=3'), false], [contracts('health=4'), true], [contracts('approvals=3,health=4'), true], [contracts('health=5'), true]];
      for (const [header, fromFour] of headers) {
        const [, bytes] = await text(stored, header);
        expect(bytes, JSON.stringify(header)).not.toMatch(/trend|windows_version|energy-windows/);
        const body = JSON.parse(bytes) as Record<string, unknown>;
        if (fromFour) expect(body.sleep_debt, JSON.stringify(header)).toEqual(debt);
        expect(healthScoresV1Schema.safeParse(body).success, JSON.stringify(header)).toBe(true);
      }
    }
    const partial = await json(withBaseline(personal, { sleep_debt: { state: 'partial', confidence: 0.4, algorithm_version: 'sleep-debt.v2', activation: 'accepted', trend: 'steady' } }), contracts('health=4'));
    expect(partial.sleep_debt).toEqual({ state: 'partial', confidence: 0.4, algorithm_version: 'sleep-debt.v2', activation: 'accepted' });
    expect(healthScoresV1Schema.safeParse(partial).success).toBe(true);
  });
  // Every route that shows the stored sleep debt goes through the one view: the app's scores at each revision, and the owner's
  // console. A row that carries the trend must still show its sleep debt, without the key, to a build pinned strictly.
  it('still serves the sleep debt of a row that carries a trend, without it, to builds pinned at revisions 2, 3 and 4 and to the console', async () => {
    const own = { state: 'available', debt_minutes: 95, need_basis: 'own_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' };
    const stored = { ...plain, sleep_debt: { ...own, trend: 'building' } };
    for (const header of [contracts('health=2'), contracts('health=3'), contracts('health=4')]) {
      const body = await json(stored, header);
      expect(body.sleep_debt, JSON.stringify(header)).toEqual(own);
      expect(pinnedScores.safeParse(body).success, JSON.stringify(header)).toBe(true);
      expect(healthScoresV1Schema.safeParse(body).success, JSON.stringify(header)).toBe(true);
    }
    const consoleView = healthScoresView({ scores: stored }, null, Date.parse(row.compiled_at as string), 4);
    expect('body' in consoleView && (consoleView.body as Record<string, unknown>).sleep_debt).toEqual(own);
    expect(JSON.stringify(consoleView)).not.toContain('trend');
  });
  // The app pins the sleep debt need as two words, strictly, so a third must never reach a build below revision 4.
  it('serves a sleep debt that leans on the prior only from revision 4, and leaves the key out below it', async () => {
    const blended = { state: 'available', debt_minutes: 315.5, need_basis: 'blended_average', algorithm_version: 'sleep-debt.v2', activation: 'accepted' };
    const own = { ...blended, need_basis: 'own_average' };
    for (const header of [{}, contracts('health=1'), contracts('health=2'), contracts('health=3'), contracts('approvals=4,health=3')]) {
      const body = await json({ ...plain, sleep_debt: blended }, header);
      expect('sleep_debt' in body, JSON.stringify(header)).toBe(false);
      expect(pinnedScores.safeParse(body).success, JSON.stringify(header)).toBe(true);
      expect(await text({ ...plain, sleep_debt: blended }, header), JSON.stringify(header)).toEqual(await text(plain, header));
    }
    for (const header of [contracts('health=4'), contracts('health=5')]) {
      const body = await json({ ...plain, sleep_debt: blended }, header);
      expect(healthScoresV1Schema.safeParse(body).success).toBe(true);
      expect(body.sleep_debt).toEqual(blended);
    }
    expect((await json({ ...plain, sleep_debt: own }, contracts('health=3'))).sleep_debt).toEqual(own);
    expect((await json({ ...plain, sleep_debt: { ...blended, need_basis: 'guessed' } }, contracts('health=4'))).sleep_debt).toBeUndefined();
  });
  it('keeps the sleep debt rule: shown from revision 2, and the same at revision 4', async () => {
    const debt = { state: 'unavailable', reason: 'missing_sleep' };
    expect((await json({ ...plain, sleep_debt: debt }, contracts('health=4'))).sleep_debt).toEqual(debt);
    expect('sleep_debt' in await json({ ...plain, sleep_debt: debt }, contracts('health=1'))).toBe(false);
  });
});
