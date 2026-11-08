import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 } from '../../contracts/src/app/device-context';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values: a made-up cell and place.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
// What the Worker told the owner's object: the notice path and its signature header.
const notices: { path: string; sig: string | null; body: string }[] = [];
let ownerAnswer = 200;
let devicePlace: string | undefined = '1';
let arrivalLook: string | undefined;
const env = () => ({
  ...(devicePlace === undefined ? {} : { DEVICE_PLACE: devicePlace }),
  ...(arrivalLook === undefined ? {} : { ARRIVAL_LOOK: arrivalLook }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (request: Request) => {
    notices.push({ path: new URL(request.url).pathname, sig: request.headers.get('x-waldo-moved-sig') ?? request.headers.get('x-waldo-arrived-sig'), body: await request.text() });
    return Response.json({ forwarded: true }, { status: ownerAnswer });
  } }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; logged.length = 0; notices.length = 0; ownerAnswer = 200; rpcResult = {}; devicePlace = '1'; arrivalLook = undefined;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (rpcResult instanceof Error) throw rpcResult;
    return Response.json(rpcResult);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${CREDENTIAL}`, ...extra });
const get = (path: string) => handleApp(new Request(`https://w.test${path}`, { headers: headers() }), env(), auth) as Promise<Response>;
const post = (path: string, body: unknown, extra: Record<string, string> = {}) => handleApp(new Request(`https://w.test${path}`, {
  method: 'POST', headers: headers({ 'content-type': 'application/json', ...extra }), body: typeof body === 'string' ? body : JSON.stringify(body),
}), env(), auth) as Promise<Response>;

const place = { cell: 'tdr1w', locality: 'Testville', region: 'Test Region', country: 'IN', timezone: 'Asia/Kolkata', platform: 'android', observed_at: '2026-11-05T08:00:00Z' };
const DEVICE = '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const upload = { request_id: 'dc-place-0001', expected_epoch: 1, device_id: DEVICE, place };
const consent = (purpose: string, status = 'granted') => ({ signal: 'place', purpose, version: 1, status, epoch: 1, granted_at: '2026-11-01T08:00:00.000Z', withdrawn_at: null });

describe('app device-context routes', () => {
  it('are not there while DEVICE_PLACE is off, and need a credential before anything', async () => {
    devicePlace = undefined;
    expect((await get('/app/v1/device-context/consents')).status).toBe(404);
    devicePlace = '0';
    expect((await post('/app/v1/device-context/place', upload)).status).toBe(404);
    devicePlace = '1';
    const anonymous = await handleApp(new Request('https://w.test/app/v1/device-context/consents'), env(), auth);
    expect(anonymous!.status).toBe(401);
    expect(rpcs).toEqual([]);
  });

  it('signs the upload for the session\'s owner over the exact payload, on its own budget', async () => {
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'accepted' };
    const response = await post('/app/v1/device-context/place', upload);
    expect([response.status, await response.json()]).toEqual([200, rpcResult]);
    expect(limiterKeys).toEqual(['app-device-context:owner-1']);
    const [call] = rpcs;
    expect(call!.fn).toBe('device_context_place_ingest');
    const payload = String(call!.body.p_payload);
    expect(JSON.parse(payload)).toEqual(upload);
    expect(call!.body.p_do_name).toBe('owner-1');
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, Number(call!.body.p_at), `device_context.place_ingest.owner-1.${md5Hex(payload)}`));
  });

  it('tells the owner\'s object once when the phone moved, signed and carrying nothing, and answers the app the contract\'s receipt', async () => {
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'accepted', moved: true };
    const response = await post('/app/v1/device-context/place', upload);
    expect([response.status, await response.json()]).toEqual([200, { request_id: 'dc-place-0001', replayed: false, status: 'accepted' }]);
    expect(notices).toEqual([{ path: '/app/v1/internal/place-moved', sig: await routerSignature(SECRET, 0, 'placemoved.owner-1'), body: '{}' }]);
  });

  it('sends the notice after the answer when the Worker can defer work, so a background upload is not held for it', async () => {
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'accepted', moved: true };
    const deferred: Promise<unknown>[] = [];
    const response = await handleApp(new Request('https://w.test/app/v1/device-context/place', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(upload) }), env(), auth, work => { deferred.push(work); }) as Response;
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(notices.map(notice => notice.path)).toEqual(['/app/v1/internal/place-moved']);
  });

  it('tells it nothing on a replay, a reading that is not a move, or a refusal, and a failed notice costs the upload nothing', async () => {
    for (const answer of [{ request_id: 'dc-place-0001', replayed: true, status: 'accepted', moved: true }, { request_id: 'dc-place-0001', replayed: false, status: 'accepted', moved: false },
      { request_id: 'dc-place-0001', replayed: false, status: 'superseded', moved: false }, { error: 'consent_required' }]) {
      rpcResult = answer;
      const response = await post('/app/v1/device-context/place', upload);
      expect(response.status).toBe('error' in answer ? 403 : 200);
      if (!('error' in answer)) expect(await response.json()).not.toHaveProperty('moved');
    }
    expect(notices).toEqual([]);
    ownerAnswer = 503;
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'accepted', moved: true };
    const response = await post('/app/v1/device-context/place', upload);
    expect([response.status, await response.json()]).toEqual([200, { request_id: 'dc-place-0001', replayed: false, status: 'accepted' }]);
    expect(notices).toHaveLength(1);
    expect(logged).toContain('app device context moved notice');
    expect(logged.join(' ')).not.toMatch(/tdr1w|Testville|Asia\/Kolkata/);
  });

  it('with ARRIVAL_LOOK on, sends the phone\'s arrival to the database and tells the owner\'s object once, signed with the place word only', async () => {
    arrivalLook = '1';
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'accepted', moved: false, arrived: 'gym' };
    const response = await post('/app/v1/device-context/place', { ...upload, arrived: 'gym' });
    expect([response.status, await response.json()]).toEqual([200, { request_id: 'dc-place-0001', replayed: false, status: 'accepted' }]);
    expect(JSON.parse(String(rpcs[0]!.body.p_payload))).toMatchObject({ arrived: 'gym' });
    expect(notices).toEqual([{ path: '/app/v1/internal/place-arrived', sig: await routerSignature(SECRET, 0, 'placearrived.gym.owner-1'), body: '{"place":"gym"}' }]);
  });

  it('tells it no arrival with the switch off, on a replay or when the database answers none, and the receipt never carries one', async () => {
    for (const [look, answer] of [[undefined, { replayed: false, arrived: 'home' }], ['0', { replayed: false, arrived: 'home' }], ['1', { replayed: true, arrived: 'home' }], ['1', { replayed: false, arrived: null }]] as const) {
      arrivalLook = look;
      rpcResult = { request_id: 'dc-place-0001', status: 'accepted', moved: false, ...answer };
      const response = await post('/app/v1/device-context/place', { ...upload, arrived: 'home' });
      expect([response.status, await response.json()]).toEqual([200, { request_id: 'dc-place-0001', replayed: answer.replayed, status: 'accepted' }]);
    }
    expect(notices).toEqual([]);
  });

  it('refuses an arrival the contract does not name before the database is asked', async () => {
    arrivalLook = '1';
    for (const arrived of ['office', true, 'Home']) {
      const response = await post('/app/v1/device-context/place', { ...upload, arrived });
      expect(response.status).toBe(400);
    }
    expect(rpcs).toEqual([]);
  });

  it('forwards a time zone sent alone', async () => {
    rpcResult = { request_id: 'dc-zone-0001', replayed: false, status: 'accepted' };
    const zoneOnly = { request_id: 'dc-zone-0001', expected_epoch: 1, device_id: DEVICE, place: { timezone: 'Asia/Dubai', platform: 'ios', observed_at: '2026-11-05T08:00:00Z' } };
    expect((await post('/app/v1/device-context/place', zoneOnly)).status).toBe(200);
    expect(JSON.parse(String(rpcs.at(-1)!.body.p_payload))).toEqual(zoneOnly);
  });

  it('refuses anything finer than the cell, or outside the contract, before any database call', async () => {
    for (const bad of [
      { ...upload, owner: 'someone-else' },
      { ...upload, place: { ...place, cell: 'tdr1wx' } },
      { ...upload, place: { ...place, latitude: 12.97, longitude: 77.59 } },
      { ...upload, place: { ...place, accuracy_m: 3000 } },
      { ...upload, place: { ...place, locality: '12.971599,77.594566' } },
      { ...upload, place: { ...place, locality: '१२.९७१५९९,७७.५९४५६६' } },
      { ...upload, place: { ...place, locality: 'Sector 128', region: 'Block 45' } },
      { ...upload, place: { locality: 'Testville', timezone: 'Asia/Kolkata', platform: 'android', observed_at: '2026-11-05T08:00:00Z' } },
      'not json',
    ]) expect((await post('/app/v1/device-context/place', bad)).status).toBe(400);
    expect((await post('/app/v1/device-context/place', upload, { 'idempotency-key': 'another-key-1' })).status).toBe(400);
    expect((await post('/app/v1/device-context/place', upload, { 'content-length': String(DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 + 1) })).status).toBe(413);
    expect(rpcs).toEqual([]);
  });

  it('passes the database\'s refusals on with their status, and hides anything else', async () => {
    for (const [error, status] of [['consent_required', 403], ['consent_withdrawn', 403], ['epoch_conflict', 409], ['idempotency_conflict', 409], ['not_linked', 403]] as const) {
      rpcResult = { error };
      const response = await post('/app/v1/device-context/place', upload);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    rpcResult = { error: 'relation "waldo.device_place_latest" does not exist' };
    expect((await post('/app/v1/device-context/place', upload)).status).toBe(503);
    rpcResult = new Error('network');
    expect((await post('/app/v1/device-context/place', upload)).status).toBe(503);
  });

  it('consents: lists the three purposes, and grants and withdraws through signed calls', async () => {
    rpcResult = { consents: [consent('storage_compute'), consent('model_processing', 'not_granted'), consent('provider_lookup', 'not_granted')] };
    const list = await get('/app/v1/device-context/consents');
    expect([list.status, rpcs.at(-1)!.fn, rpcs.at(-1)!.body.p_payload]).toEqual([200, 'device_context_consent_list', '{}']);
    rpcResult = { consent: consent('provider_lookup'), replayed: false, deletion_routed: false };
    const granted = await post('/app/v1/device-context/consents', { request_id: 'dc-grant-0001', signal: 'place', purpose: 'provider_lookup', version: 1, expected_epoch: 0 });
    expect([granted.status, rpcs.at(-1)!.fn]).toEqual([200, 'device_context_consent_grant']);
    rpcResult = { consents: [consent('storage_compute'), consent('provider_lookup')], replayed: false };
    const batch = { request_id: 'dc-batch-0001', signal: 'place', version: 1, purposes: [{ purpose: 'storage_compute', expected_epoch: 0 }, { purpose: 'provider_lookup', expected_epoch: 0 }] };
    const both = await post('/app/v1/device-context/consents/batch', batch);
    expect([both.status, (await both.json() as { consents: unknown[] }).consents.length, rpcs.at(-1)!.fn]).toEqual([200, 2, 'device_context_consent_grant_batch']);
    const calls = rpcs.length;
    expect((await post('/app/v1/device-context/consents/batch', { ...batch, purposes: [batch.purposes[0], batch.purposes[0]] })).status).toBe(400);
    expect(rpcs.length).toBe(calls);
    rpcResult = { consent: consent('storage_compute', 'withdrawn'), replayed: false, deletion_routed: true };
    const withdrawn = await post('/app/v1/device-context/consents/withdraw', { request_id: 'dc-withdraw-0001', signal: 'place', purpose: 'storage_compute', expected_epoch: 1 });
    expect([withdrawn.status, (await withdrawn.json() as { deletion_routed: boolean }).deletion_routed, rpcs.at(-1)!.fn]).toEqual([200, true, 'device_context_consent_withdraw']);
    expect((await get('/app/v1/device-context/consents/withdraw')).status).toBe(405);
    expect((await get('/app/v1/device-context/anything')).status).toBe(404);
  });

  it('the owner\'s read-back asks for the owner purpose and drops a stored row that no longer reads as the contract\'s', async () => {
    const stored = { device_id: DEVICE, received_at: '2026-11-05T08:00:01.000Z', platform: 'android', timezone: 'Asia/Kolkata', timezone_observed_at: '2026-11-05T08:00:00.000Z',
      place: { cell: 'tdr1w', locality: 'Testville', region: 'Test Region', country: 'IN', observed_at: '2026-11-05T08:00:00.000Z' } };
    rpcResult = { places: [stored, { ...stored, place: { cell: 'tdr1wxyz', observed_at: '2026-11-05T08:00:00.000Z' } }] };
    const response = await get('/app/v1/device-context/place');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ places: [stored] });
    expect(JSON.parse(String(rpcs.at(-1)!.body.p_payload))).toEqual({ purpose: 'owner' });
    expect(logged).toEqual(['app device context stored place shape']);
  });

  it('never logs a cell, a place name or a time zone', async () => {
    rpcResult = { error: 'consent_required' };
    await post('/app/v1/device-context/place', upload);
    rpcResult = { places: [{ device_id: DEVICE, received_at: 'not a time', platform: 'android', timezone: 'Asia/Kolkata', timezone_observed_at: 'x', place }] };
    await get('/app/v1/device-context/place');
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'kept' };
    await post('/app/v1/device-context/place', upload);
    expect(logged.join('\n')).not.toMatch(/tdr1w|Testville|Test Region|Asia\/Kolkata/);
  });
});
