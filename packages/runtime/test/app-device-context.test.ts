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
let devicePlace: string | undefined = '1';
const env = () => ({
  ...(devicePlace === undefined ? {} : { DEVICE_PLACE: devicePlace }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; logged.length = 0; rpcResult = {}; devicePlace = '1';
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

  it('refuses anything finer than the cell, or outside the contract, before any database call', async () => {
    for (const bad of [
      { ...upload, owner: 'someone-else' },
      { ...upload, place: { ...place, cell: 'tdr1wx' } },
      { ...upload, place: { ...place, latitude: 12.97, longitude: 77.59 } },
      { ...upload, place: { ...place, accuracy_m: 3000 } },
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
    rpcResult = { consent: consent('storage_compute', 'withdrawn'), replayed: false, deletion_routed: true };
    const withdrawn = await post('/app/v1/device-context/consents/withdraw', { request_id: 'dc-withdraw-0001', signal: 'place', purpose: 'storage_compute', expected_epoch: 1 });
    expect([withdrawn.status, (await withdrawn.json() as { deletion_routed: boolean }).deletion_routed, rpcs.at(-1)!.fn]).toEqual([200, true, 'device_context_consent_withdraw']);
    expect((await get('/app/v1/device-context/consents/withdraw')).status).toBe(405);
    expect((await get('/app/v1/device-context/anything')).status).toBe(404);
  });

  it('the owner\'s read-back asks for the owner purpose and drops a stored row that no longer reads as the contract\'s', async () => {
    rpcResult = { places: [{ device_id: DEVICE, received_at: '2026-11-05T08:00:01.000Z', place }, { device_id: DEVICE, received_at: '2026-11-05T08:00:01.000Z', place: { cell: 'tdr1wxyz' } }] };
    const response = await get('/app/v1/device-context/place');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ places: [{ device_id: DEVICE, received_at: '2026-11-05T08:00:01.000Z', place }] });
    expect(JSON.parse(String(rpcs.at(-1)!.body.p_payload))).toEqual({ purpose: 'owner' });
    expect(logged).toEqual(['app device context stored place shape']);
  });

  it('never logs a cell, a place name or a time zone', async () => {
    rpcResult = { error: 'consent_required' };
    await post('/app/v1/device-context/place', upload);
    rpcResult = { places: [{ device_id: DEVICE, received_at: 'not a time', place }] };
    await get('/app/v1/device-context/place');
    rpcResult = { request_id: 'dc-place-0001', replayed: false, status: 'kept' };
    await post('/app/v1/device-context/place', upload);
    expect(logged.join('\n')).not.toMatch(/tdr1w|Testville|Test Region|Asia\/Kolkata/);
  });
});
