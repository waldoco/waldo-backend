import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CYCLE_MAX_REQUEST_BYTES_V1 } from '../../contracts/src/app/cycle';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values: invented dates, ids and app names.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
let healthCycle: string | undefined = '1';
const env = () => ({
  ...(healthCycle === undefined ? {} : { HEALTH_CYCLE: healthCycle }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; logged.length = 0; rpcResult = {}; healthCycle = '1';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (rpcResult instanceof Error) throw rpcResult;
    return Response.json(rpcResult);
  });
  for (const method of ['error', 'log', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${CREDENTIAL}`, ...extra });
const get = (path: string) => handleApp(new Request(`https://w.test${path}`, { headers: headers() }), env(), auth) as Promise<Response>;
const post = (path: string, body: unknown, extra: Record<string, string> = {}) => handleApp(new Request(`https://w.test${path}`, {
  method: 'POST', headers: headers({ 'content-type': 'application/json', ...extra }), body: typeof body === 'string' ? body : JSON.stringify(body),
}), env(), auth) as Promise<Response>;

const REQUEST = '7b1e2f8a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const grant = { request_id: REQUEST, version: 1, expected_epoch: 0 };
const withdraw = { request_id: REQUEST, expected_epoch: 1 };
const origin = { read_api: 'healthkit', source_bundle_id: 'com.example.cycle', source_package_name: null, source_version: null, source_revision: null, device_ref: null, recording_method: 'manual' };
const upload = { request_id: REQUEST, expected_epoch: 1, source: 'apple', window_start: '2026-08-06', periods: [{ signal: 'menstrual_period', start_date: '2026-10-08', end_date: '2026-10-12', origin, source_name: 'Example Cycle' }] };
const active = { state: 'active', consent: { status: 'granted', epoch: 1, version: 1 }, last_period_start: '2026-10-08', last_source_name: 'Example Cycle' };
const off = { state: 'off', consent: { status: 'withdrawn', epoch: 2, version: 1 } };

describe('app cycle routes', () => {
  it('are not there while HEALTH_CYCLE is off, and need a credential before anything', async () => {
    for (const value of [undefined, '0', 'on', 'true']) {
      healthCycle = value;
      expect((await get('/app/v1/health/cycle')).status).toBe(404);
      expect((await post('/app/v1/health/cycle/consent', grant)).status).toBe(404);
      expect((await post('/app/v1/health/cycle/consent/withdraw', withdraw)).status).toBe(404);
      expect((await post('/app/v1/health/cycle/periods', upload)).status).toBe(404);
    }
    healthCycle = '1';
    const anonymous = await handleApp(new Request('https://w.test/app/v1/health/cycle'), env(), auth);
    expect(anonymous!.status).toBe(401);
    expect(rpcs).toEqual([]);
    expect(limiterKeys).toEqual([]);
  });

  it('reads the Cycle row for the session\'s owner, signed over the exact payload, on its own budget', async () => {
    rpcResult = active;
    const response = await get('/app/v1/health/cycle');
    expect([response.status, await response.json()]).toEqual([200, active]);
    expect(limiterKeys).toEqual(['app-cycle:owner-1']);
    const [call] = rpcs;
    expect([call!.fn, call!.body.p_do_name, call!.body.p_payload]).toEqual(['cycle_status_read', 'owner-1', '{}']);
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, Number(call!.body.p_at), `cycle.status_read.owner-1.${md5Hex('{}')}`));
  });

  it('answers a grant and a withdrawal with the status', async () => {
    rpcResult = { state: 'waiting_for_data', consent: { status: 'granted', epoch: 1, version: 1 } };
    const granted = await post('/app/v1/health/cycle/consent', grant);
    expect([granted.status, await granted.json()]).toEqual([200, rpcResult]);
    rpcResult = off;
    const withdrawn = await post('/app/v1/health/cycle/consent/withdraw', withdraw);
    expect([withdrawn.status, await withdrawn.json()]).toEqual([200, off]);
    expect(rpcs.map(call => [call.fn, JSON.parse(String(call.body.p_payload))])).toEqual([['cycle_consent_grant', grant], ['cycle_consent_withdraw', withdraw]]);
    for (const call of rpcs) expect(call.body.p_sig).toBe(await routerSignature(SECRET, Number(call.body.p_at), `${call.fn.replace('cycle_', 'cycle.')}.owner-1.${md5Hex(String(call.body.p_payload))}`));
  });

  it('passes each closed refusal through with its status: a stale epoch, a reused request id, missing storage consent, another account', async () => {
    for (const [error, status] of [['epoch_conflict', 409], ['idempotency_conflict', 409], ['consent_required', 403], ['consent_withdrawn', 403], ['not_linked', 403], ['invalid_request', 400]] as const) {
      rpcResult = { error };
      const response = await post('/app/v1/health/cycle/consent', grant);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
  });

  it('takes period dates only, and refuses a body outside the contract before any database call', async () => {
    rpcResult = { request_id: REQUEST, replayed: false, accepted: 1, ignored: 0 };
    expect((await post('/app/v1/health/cycle/periods', upload)).status).toBe(200);
    rpcs.length = 0;
    for (const bad of [
      { ...upload, owner_id: 'someone-else' },
      { ...upload, periods: [{ ...upload.periods[0], flow: 'heavy' }] },
      { ...upload, request_id: 'not-a-uuid-request' },
    ]) expect((await post('/app/v1/health/cycle/periods', bad)).status).toBe(400);
    expect((await post('/app/v1/health/cycle/consent', { ...grant, purpose: 'cycle_context' })).status).toBe(400);
    expect((await post('/app/v1/health/cycle/consent', grant, { 'idempotency-key': 'other-key' })).status).toBe(400);
    expect((await post('/app/v1/health/cycle/periods', 'x'.repeat(10), { 'content-length': String(CYCLE_MAX_REQUEST_BYTES_V1 + 1) })).status).toBe(413);
    expect(rpcs).toEqual([]);
  });

  it('pauses: the kill switch keeps the Cycle row and withdrawal, and takes no grant or period', async () => {
    healthCycle = 'paused';
    rpcResult = off;
    expect((await get('/app/v1/health/cycle')).status).toBe(200);
    expect((await post('/app/v1/health/cycle/consent/withdraw', withdraw)).status).toBe(200);
    expect((await post('/app/v1/health/cycle/consent', grant)).status).toBe(404);
    expect((await post('/app/v1/health/cycle/periods', upload)).status).toBe(404);
    expect(rpcs.map(call => call.fn)).toEqual(['cycle_status_read', 'cycle_consent_withdraw']);
  });

  it('turns an answer outside the contract, or no answer, into unavailable, and logs no date, name or state', async () => {
    rpcResult = { ...active, phase: 'luteal' };
    expect((await get('/app/v1/health/cycle')).status).toBe(503);
    rpcResult = { state: 'off', consent: { status: 'granted', epoch: 1, version: 1 } };
    expect((await get('/app/v1/health/cycle')).status).toBe(503);
    rpcResult = new Error('network');
    expect((await get('/app/v1/health/cycle')).status).toBe(503);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) for (const word of ['2026-10-08', 'Example Cycle', 'luteal', 'granted', 'active', 'menstrual']) expect(line).not.toContain(word);
  });

  it('answers 405 for a wrong method and 404 for an unknown cycle path', async () => {
    expect((await post('/app/v1/health/cycle', {})).status).toBe(405);
    expect((await get('/app/v1/health/cycle/consent')).status).toBe(405);
    expect((await get('/app/v1/health/cycle/phase')).status).toBe(404);
  });
});
