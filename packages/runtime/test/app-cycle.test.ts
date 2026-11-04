import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CYCLE_MAX_REQUEST_BYTES_V1 } from '../../contracts/src/app/cycle';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;

const limiterKeys: string[] = [];
let cycle: string | undefined = '1';
const env = () => ({
  ...(cycle === undefined ? {} : { CYCLE_CONTEXT: cycle }),
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let rpcResult: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  rpcs.length = 0; limiterKeys.length = 0; logged.length = 0; rpcResult = {}; cycle = '1';
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

const origin = {
  read_api: 'healthkit', source_bundle_id: 'com.example.cycle', source_package_name: null, source_version: null, source_revision: null, device_ref: null, recording_method: 'manual',
};
const period = { signal: 'menstrual_period', start_date: '2026-10-08', end_date: '2026-10-12', origin, source_name: 'Example Cycle' };
const upload = { request_id: 'cycle-ingest-0001', expected_epoch: 1, source: 'apple', window_start: '2026-08-06', periods: [period] };
const consent = (status = 'granted') => ({
  consent_class: 'reproductive_health', purpose: 'cycle_context', version: 1, status, epoch: 1, granted_at: '2026-11-01T08:00:00.000Z',
  withdrawn_at: status === 'withdrawn' ? '2026-11-02T08:00:00.000Z' : null, deletion_state: status === 'withdrawn' ? 'completed' : 'not_required',
});

describe('app cycle routes', () => {
  it('are not there while CYCLE_CONTEXT is off, stay up while paused, and need a credential before anything', async () => {
    for (const flag of [undefined, '0', 'true']) {
      cycle = flag;
      expect((await get('/app/v1/cycle/status')).status, String(flag)).toBe(404);
      expect((await post('/app/v1/cycle/periods', upload)).status, String(flag)).toBe(404);
    }
    expect(rpcs).toEqual([]);
    cycle = 'paused';
    rpcResult = { consent: consent('withdrawn'), replayed: false, deletion_routed: true };
    expect((await post('/app/v1/cycle/consents/withdraw', { request_id: 'cycle-withdraw-01', purpose: 'cycle_context', expected_epoch: 1 })).status).toBe(200);
    cycle = '1';
    const anonymous = await handleApp(new Request('https://w.test/app/v1/cycle/status'), env(), auth);
    expect(anonymous!.status).toBe(401);
  });

  it('signs the upload for the session\'s owner over the exact payload, on its own budget', async () => {
    rpcResult = { request_id: 'cycle-ingest-0001', replayed: false, accepted: 1, ignored: 0 };
    const response = await post('/app/v1/cycle/periods', upload);
    expect([response.status, await response.json()]).toEqual([200, rpcResult]);
    expect(limiterKeys).toEqual(['app-cycle:owner-1']);
    const [call] = rpcs;
    expect(call!.fn).toBe('cycle_ingest');
    const payload = String(call!.body.p_payload);
    expect(JSON.parse(payload)).toEqual(upload);
    expect(call!.body.p_do_name).toBe('owner-1');
    expect(call!.body.p_sig).toBe(await routerSignature(SECRET, Number(call!.body.p_at), `cycle.ingest.owner-1.${md5Hex(payload)}`));
  });

  it('refuses a body outside the contract before any database call', async () => {
    for (const bad of [
      { ...upload, owner: 'someone-else' },
      { ...upload, periods: [{ ...period, flow: 'heavy' }] },
      { ...upload, periods: [{ ...period, signal: 'sexual_activity' }] },
      { ...upload, source: 'flo' },
      'not json',
    ]) expect((await post('/app/v1/cycle/periods', bad)).status).toBe(400);
    expect((await post('/app/v1/cycle/periods', upload, { 'idempotency-key': 'another-key-1' })).status).toBe(400);
    expect((await post('/app/v1/cycle/periods', upload, { 'content-length': String(CYCLE_MAX_REQUEST_BYTES_V1 + 1) })).status).toBe(413);
    expect((await get('/app/v1/cycle/status?phase=1')).status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it('passes the database\'s refusals on with their status, and hides anything else', async () => {
    for (const [error, status] of [['consent_required', 403], ['consent_withdrawn', 403], ['epoch_conflict', 409], ['idempotency_conflict', 409], ['not_linked', 403]] as const) {
      rpcResult = { error };
      const response = await post('/app/v1/cycle/periods', upload);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    rpcResult = { error: 'relation "waldo.cycle_periods" does not exist' };
    expect((await post('/app/v1/cycle/periods', upload)).status).toBe(503);
    rpcResult = new Error('network');
    expect((await post('/app/v1/cycle/periods', upload)).status).toBe(503);
  });

  it('consents: lists the one purpose, and grants and withdraws through signed calls', async () => {
    rpcResult = { consents: [consent('not_granted')] };
    const list = await get('/app/v1/cycle/consents');
    expect([list.status, rpcs.at(-1)!.fn, rpcs.at(-1)!.body.p_payload]).toEqual([200, 'cycle_consent_list', '{}']);
    rpcResult = { consent: consent(), replayed: false, deletion_routed: false };
    const granted = await post('/app/v1/cycle/consents', { request_id: 'cycle-grant-0001', purpose: 'cycle_context', version: 1, expected_epoch: 0, age_attested_18_plus: true });
    expect([granted.status, rpcs.at(-1)!.fn]).toEqual([200, 'cycle_consent_grant']);
    rpcResult = { consent: consent('withdrawn'), replayed: false, deletion_routed: true };
    const withdrawn = await post('/app/v1/cycle/consents/withdraw', { request_id: 'cycle-withdraw-01', purpose: 'cycle_context', expected_epoch: 1 });
    expect([withdrawn.status, (await withdrawn.json() as { deletion_routed: boolean }).deletion_routed, rpcs.at(-1)!.fn]).toEqual([200, true, 'cycle_consent_withdraw']);
    expect((await get('/app/v1/cycle/consents/withdraw')).status).toBe(405);
    expect((await post('/app/v1/cycle/status', {})).status).toBe(405);
    expect((await get('/app/v1/cycle/phase')).status).toBe(404);
  });

  it('the Cycle row reads its status, and a status outside the contract is a fault', async () => {
    rpcResult = { state: 'active', last_period_start: '2026-10-08', last_source_name: 'Example Cycle' };
    const response = await get('/app/v1/cycle/status');
    expect([response.status, await response.json(), rpcs.at(-1)!.fn]).toEqual([200, rpcResult, 'cycle_status_read']);
    rpcResult = { state: 'active', last_period_start: '2026-10-08', phase: 'luteal' };
    expect((await get('/app/v1/cycle/status')).status).toBe(503);
    expect(logged).toEqual(['app cycle status_read shape']);
  });

  it('never logs a date, a phase or an app name', async () => {
    rpcResult = { error: 'consent_required' };
    await post('/app/v1/cycle/periods', upload);
    rpcResult = { state: 'active', last_period_start: '2026-10-08', last_source_name: 'Example Cycle', phase: 'luteal' };
    await get('/app/v1/cycle/status');
    expect(logged.join('\n')).not.toMatch(/2026-10|luteal|Example Cycle|menstrual/);
  });
});
