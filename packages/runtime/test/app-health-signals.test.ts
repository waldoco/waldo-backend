import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthSignalsResponseV1Schema, healthSignalsUnavailableV1Schema } from '../../contracts/src/app/health-ingest';
import fixture from '../../contracts/src/app/fixtures/health-signals.v9.json';
import parts from '../../contracts/src/app/fixtures/health-scores-parts.v8.json';
import { handleApp } from '../src/channels/app-api';
import { SERIES_READS } from '../src/health/signals';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { GOLDEN_READ_AT, goldenReadingsOfDay, syntheticAddDays } from './support/health-golden';

// Health revision 9: one reading's daily series, served only to a build that names it and only while the switch is on. The route
// exists nowhere else; the owner always comes from the session. Synthetic values only.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const limiterKeys: string[] = [];
let limiterAllows = true;
const env = (over: Record<string, string> = {}) => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 503 }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: limiterAllows }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, ...over,
}) as never;

const rpcs: Array<{ fn: string; body: Record<string, unknown> }> = [];
let answers: Record<string, unknown> = {};
beforeEach(() => {
  rpcs.length = 0; answers = {}; limiterKeys.length = 0; limiterAllows = true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    const answer = answers[fn] ?? {};
    if (answer instanceof Error) throw answer;
    return Response.json(answer);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ON = { HEALTH_SIGNALS_READ: '1' };
const R9 = { 'x-waldo-app-contract': 'health=9' };
const call = (path: string, header: Record<string, string> = R9, over: Record<string, string> = ON, method = 'GET') =>
  handleApp(new Request(`https://w.test${path}`, { method, headers: { authorization: `Bearer ${CREDENTIAL}`, ...header } }), env(over), auth) as Promise<Response>;
const HRV = '/app/v1/health/signals?signal=overnight_hrv&days=7';

const TODAY = '2026-03-20';
const nights = (count: number) => Array.from({ length: count }, (_, back) => goldenReadingsOfDay(syntheticAddDays(TODAY, -back), back)).flat();
const stored = (signal: keyof typeof SERIES_READS, count = 10) => nights(count).filter(s => SERIES_READS[signal].stored.includes(String(s.signal)));
const read = (samples: unknown[], over: Record<string, unknown> = {}) => ({ access: 'granted', read_at: GOLDEN_READ_AT, from: syntheticAddDays(TODAY, -6), to: TODAY, sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples }], ...over });

describe('the signals route is there only for revision 9 and a switch that is on', () => {
  it('is not there for a build below revision 9, or none, with the switch on: no read is made', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    for (const revision of ['', 'health=1', 'health=4', 'health=7', 'health=8', 'approvals=9,health=8']) {
      const response = await call(HRV, revision === '' ? {} : { 'x-waldo-app-contract': revision });
      expect(response.status, revision).toBe(404);
      expect(await response.json(), revision).toEqual({ error: 'invalid_request' });
    }
    expect(rpcs).toEqual([]);
  });
  it('is not there at revision 9 while the switch is off, or is anything but exactly 1', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    for (const value of [undefined, '0', '', 'true', 'on', ' 1', '01']) {
      const response = await call(HRV, R9, value === undefined ? {} : { HEALTH_SIGNALS_READ: value });
      expect(response.status, String(value)).toBe(404);
    }
    expect(rpcs).toEqual([]);
  });
  it('is served at revision 9 and later with the switch on, and only by GET', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    for (const revision of ['health=9', 'health=10', 'approvals=4,health=9']) expect((await call(HRV, { 'x-waldo-app-contract': revision })).status, revision).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await call(HRV, R9, ON, method)).status, method).toBe(405);
  });
});

describe('the query', () => {
  it('is exactly one signal from the closed list and one of the three windows, and nothing else', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    for (const query of [
      '', '?signal=overnight_hrv', '?days=7', '?signal=steps&days=7', '?signal=overnight_hrv&days=14', '?signal=overnight_hrv&days=7&days=30', '?signal=overnight_hrv&signal=spo2&days=7',
      '?signal=overnight_hrv&days=7&day=2026-03-20', '?signal=movement&days=90', '?signal=OVERNIGHT_HRV&days=7', '?signal=overnight_hrv&days=07', '?signal=sleep_duration&days=7',
    ]) {
      const response = await call(`/app/v1/health/signals${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toEqual({ error: 'invalid_request' });
    }
    expect(rpcs).toEqual([]);
  });
});

describe('the read it makes', () => {
  it('is the owner\'s signed signal read, for the window and the stored set of that signal alone, never a caller\'s list', async () => {
    answers = { health_signal_read: read(stored('resting_heart_rate')) };
    for (const days of [7, 30, 90]) {
      rpcs.length = 0;
      await call(`/app/v1/health/signals?signal=resting_heart_rate&days=${days}`);
      expect(rpcs).toHaveLength(1);
      expect(rpcs[0]!.fn).toBe('health_signal_read');
      expect(rpcs[0]!.body.p_do_name).toBe('owner-1');
      expect(JSON.parse(String(rpcs[0]!.body.p_payload))).toEqual({ days, signals: SERIES_READS.resting_heart_rate.stored });
    }
  });
  it('spends the same per-owner health budget as every health route, and is refused when it is spent', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    await call(HRV);
    expect(limiterKeys).toEqual(['app-health:owner-1']);
    limiterAllows = false; rpcs.length = 0;
    expect((await call(HRV)).status).toBe(429);
    expect(rpcs).toEqual([]);
  });
  it('is refused without the owner\'s credential, and reads nothing', async () => {
    const response = await handleApp(new Request(`https://w.test${HRV}`, { headers: R9 }), env(ON), auth) as Response;
    expect([401, 403]).toContain(response.status);
    expect(rpcs).toEqual([]);
  });
});

describe('what it answers', () => {
  it('is the contract\'s body, one value a day, with the source and the method', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv', 7)) };
    const response = await call('/app/v1/health/signals?signal=overnight_hrv&days=7');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, any>;
    expect(healthSignalsResponseV1Schema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ state: 'available', signal: 'overnight_hrv', unit: 'milliseconds', used_in: ['recovery', 'form'], window_days: 7 });
    expect(body.days.length).toBeGreaterThan(0);
    for (const entry of body.days) expect(Object.keys(entry).sort()).toEqual(['day', 'method', 'source', 'value']);
  });
  it('answers a window that is not the span the database said as a fault, never a chart of another window', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv'), { from: syntheticAddDays(TODAY, -2) }) };
    const response = await call(HRV);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });
  it('gives today\'s hours for a signal made of hourly windows, and none for a nightly one', async () => {
    answers = { health_signal_read: read(stored('daylight')) };
    const hourly = await (await call('/app/v1/health/signals?signal=daylight&days=7')).json() as Record<string, any>;
    expect(hourly.hours).toHaveLength(8);
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    expect('hours' in (await (await call(HRV)).json() as object)).toBe(false);
  });
  it('says why there is nothing, as the closed reasons, with a 200 and never a zero', async () => {
    for (const [answer, reason] of [
      [{ error: 'not_linked' }, 'not_linked'],
      [{ access: 'consent_required', read_at: GOLDEN_READ_AT, from: 'x', to: 'y', sources: [] }, 'consent_required'],
      [{ access: 'consent_withdrawn', read_at: GOLDEN_READ_AT, from: 'x', to: 'y', sources: [] }, 'consent_withdrawn'],
      [read([]), 'no_readings'],
    ] as const) {
      answers = { health_signal_read: answer };
      const response = await call('/app/v1/health/signals?signal=spo2&days=7');
      expect(response.status, reason).toBe(200);
      const body = await response.json();
      expect(body, reason).toEqual({ state: 'unavailable', signal: 'spo2', reason });
      expect(healthSignalsUnavailableV1Schema.safeParse(body).success, reason).toBe(true);
    }
    expect(fixture.unavailable.state).toBe('unavailable');
  });
  it('maps the database\'s closed errors, and answers a fault as unavailable without detail', async () => {
    for (const [answer, status, error] of [[{ error: 'invalid_request' }, 400, 'invalid_request'], [{ error: 'something_else' }, 503, 'unavailable'], [null, 503, 'unavailable'], ['text', 503, 'unavailable'], [new Error('boom'), 503, 'unavailable']] as const) {
      answers = { health_signal_read: answer };
      const response = await call(HRV);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });
});

describe('the owner\'s usual beside the series', () => {
  const band = parts.scores.usual.find(entry => entry.signal === 'overnight_hrv')!;
  it('rides along only while the usual is served too, and the scores read is not made otherwise', async () => {
    answers = { health_signal_read: read(stored('overnight_hrv')), health_scores_read: { scores: { usual: parts.scores.usual } } };
    const on = await (await call(HRV, R9, { ...ON, HEALTH_USUAL: '1' })).json() as Record<string, unknown>;
    expect(on.usual).toEqual(band);
    expect(rpcs.map(rpc => rpc.fn).sort()).toEqual(['health_scores_read', 'health_signal_read']);
    rpcs.length = 0;
    for (const over of [ON, { ...ON, HEALTH_USUAL: '0' }, { ...ON, HEALTH_USUAL: 'true' }]) {
      const off = await (await call(HRV, R9, over)).json() as Record<string, unknown>;
      expect('usual' in off).toBe(false);
    }
    expect(rpcs.every(rpc => rpc.fn === 'health_signal_read')).toBe(true);
  });
  it('is the band of this signal, left out when the signal has none or the stored band does not read, and never fails the series', async () => {
    const withUsual = (usual: unknown) => { answers = { health_signal_read: read(stored('sleep_asleep')), health_scores_read: { scores: { usual } } }; };
    withUsual(parts.scores.usual);
    expect('usual' in (await (await call('/app/v1/health/signals?signal=sleep_asleep&days=7', R9, { ...ON, HEALTH_USUAL: '1' })).json() as object)).toBe(false);
    answers = { health_signal_read: read(stored('overnight_hrv')), health_scores_read: { scores: { usual: [{ ...band, low: 99 }] } } };
    const broken = await call(HRV, R9, { ...ON, HEALTH_USUAL: '1' });
    expect(broken.status).toBe(200);
    expect('usual' in (await broken.json() as object)).toBe(false);
    answers = { health_signal_read: read(stored('overnight_hrv')), health_scores_read: { error: 'consent_required' } };
    expect((await call(HRV, R9, { ...ON, HEALTH_USUAL: '1' })).status).toBe(200);
    answers = { health_signal_read: read(stored('overnight_hrv')), health_scores_read: new Error('down') };
    expect((await call(HRV, R9, { ...ON, HEALTH_USUAL: '1' })).status).toBe(200);
  });
});

describe('what it writes to a log', () => {
  it('names no reading, day or owner, on a fault or on a good answer', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
    answers = { health_signal_read: read(stored('overnight_hrv')) };
    await call(HRV);
    answers = { health_signal_read: read(stored('overnight_hrv'), { from: 'broken' }) };
    await call(HRV);
    const sample = String(nights(1).find(s => s.signal === 'overnight_hrv')!.value);
    for (const line of logs) {
      expect(line).not.toContain(sample);
      expect(line).not.toContain(TODAY);
      expect(line).not.toContain('owner-1');
    }
  });
});
