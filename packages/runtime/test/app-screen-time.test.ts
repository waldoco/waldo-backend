import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_TIME_MAX_REQUEST_BYTES_V1 } from '../../contracts/src/app/screen-time';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
let screenTime: string | undefined = '1';
const env = () => ({
  ...(screenTime === undefined ? {} : { SCREEN_TIME: screenTime }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; logged.length = 0; rpcResult = {}; screenTime = '1';
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

const day = {
  day: '2026-11-02', timezone: 'Asia/Kolkata', platform: 'android', coverage: 'complete', screen_on_minutes: 214, pickups: 61, unlocks: 48,
  late_night_minutes: 22, late_night_window: '23:00-05:00', first_use_at: '07:12', last_use_at: '23:58', categories: [{ category: 'social', minutes: 70 }],
};
const DEVICE = '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const upload = { request_id: 'st-ingest-0001', expected_epoch: 1, device_id: DEVICE, days: [day] };
const consent = (purpose: string, status = 'granted') => ({ purpose, version: 1, status, epoch: 1, granted_at: '2026-11-01T08:00:00.000Z', withdrawn_at: null });

describe('app screen-time routes', () => {
  it('are not there while SCREEN_TIME is off, and need a credential before anything', async () => {
    screenTime = undefined;
    expect((await get('/app/v1/screen-time/consents')).status).toBe(404);
    screenTime = '0';
    expect((await post('/app/v1/screen-time/days', upload)).status).toBe(404);
    screenTime = '1';
    const anonymous = await handleApp(new Request('https://w.test/app/v1/screen-time/consents'), env(), auth);
    expect(anonymous!.status).toBe(401);
    expect(rpcs).toEqual([]);
  });

  it('signs the upload for the session\'s owner over the exact payload, on its own budget', async () => {
    rpcResult = { request_id: 'st-ingest-0001', replayed: false, results: [{ day: '2026-11-02', status: 'accepted' }] };
    const response = await post('/app/v1/screen-time/days', upload);
    expect([response.status, await response.json()]).toEqual([200, rpcResult]);
    expect(limiterKeys).toEqual(['app-screen-time:owner-1']);
    const [call] = rpcs;
    expect(call!.fn).toBe('screen_time_ingest');
    const payload = String(call!.body.p_payload);
    expect(JSON.parse(payload)).toEqual(upload);
    expect(call!.body.p_do_name).toBe('owner-1');
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, Number(call!.body.p_at), `screen_time.ingest.owner-1.${md5Hex(payload)}`));
  });

  it('refuses a body outside the contract before any database call', async () => {
    for (const bad of [
      { ...upload, owner: 'someone-else' },
      { ...upload, days: [{ ...day, top_apps: [{ package: 'com.example', minutes: 5 }] }] },
      { ...upload, days: [{ ...day, coverage: 'none' }] },
      'not json',
    ]) expect((await post('/app/v1/screen-time/days', bad)).status).toBe(400);
    expect((await post('/app/v1/screen-time/days', upload, { 'idempotency-key': 'another-key-1' })).status).toBe(400);
    expect((await post('/app/v1/screen-time/days', upload, { 'content-length': String(SCREEN_TIME_MAX_REQUEST_BYTES_V1 + 1) })).status).toBe(413);
    expect(rpcs).toEqual([]);
  });

  it('passes the database\'s refusals on with their status, and hides anything else', async () => {
    for (const [error, status] of [['consent_required', 403], ['consent_withdrawn', 403], ['epoch_conflict', 409], ['idempotency_conflict', 409], ['not_linked', 403]] as const) {
      rpcResult = { error };
      const response = await post('/app/v1/screen-time/days', upload);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    rpcResult = { error: 'relation "waldo.screen_time_days" does not exist' };
    expect([(await post('/app/v1/screen-time/days', upload)).status]).toEqual([503]);
    rpcResult = new Error('network');
    expect((await post('/app/v1/screen-time/days', upload)).status).toBe(503);
  });

  it('consents: lists both purposes, and grants and withdraws through signed calls', async () => {
    rpcResult = { consents: [consent('storage_compute'), consent('model_processing', 'not_granted')] };
    const list = await get('/app/v1/screen-time/consents');
    expect([list.status, rpcs.at(-1)!.fn, rpcs.at(-1)!.body.p_payload]).toEqual([200, 'screen_time_consent_list', '{}']);
    rpcResult = { consent: consent('model_processing'), replayed: false, deletion_routed: false };
    const granted = await post('/app/v1/screen-time/consents', { request_id: 'st-grant-0001', purpose: 'model_processing', version: 1, expected_epoch: 0 });
    expect([granted.status, rpcs.at(-1)!.fn]).toEqual([200, 'screen_time_consent_grant']);
    rpcResult = { consent: consent('storage_compute', 'withdrawn'), replayed: false, deletion_routed: true };
    const withdrawn = await post('/app/v1/screen-time/consents/withdraw', { request_id: 'st-withdraw-0001', purpose: 'storage_compute', expected_epoch: 1 });
    expect([withdrawn.status, (await withdrawn.json() as { deletion_routed: boolean }).deletion_routed, rpcs.at(-1)!.fn]).toEqual([200, true, 'screen_time_consent_withdraw']);
    expect((await get('/app/v1/screen-time/consents/withdraw')).status).toBe(405);
    expect((await get('/app/v1/screen-time/anything')).status).toBe(404);
  });

  it('the owner\'s read-back asks for the owner purpose and returns what was kept, without the agent\'s device numbers', async () => {
    rpcResult = { days: [{ device_id: DEVICE, device: 1, received_at: '2026-11-03T01:00:00.000Z', summary: day }, { device_id: DEVICE, device: 1, received_at: '2026-11-03T01:00:00.000Z', summary: { day: 'broken' } }] };
    const response = await get('/app/v1/screen-time/days?from=2026-10-27&to=2026-11-02');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ days: [{ device_id: DEVICE, received_at: '2026-11-03T01:00:00.000Z', summary: day }] });
    expect(JSON.parse(String(rpcs.at(-1)!.body.p_payload))).toEqual({ from: '2026-10-27', to: '2026-11-02', purpose: 'owner' });
    expect(logged).toEqual(['app screen time stored day shape']);
    expect((await get('/app/v1/screen-time/days?from=2026-09-01&to=2026-11-02')).status).toBe(400);
  });

  it('never logs a number or a summary', async () => {
    rpcResult = { error: 'consent_required' };
    await post('/app/v1/screen-time/days', upload);
    rpcResult = { days: [{ device_id: DEVICE, received_at: 'not a time', summary: day }] };
    await get('/app/v1/screen-time/days?from=2026-11-01&to=2026-11-02');
    expect(logged.join('\n')).not.toMatch(/214|Asia\/Kolkata|social/);
  });
});
