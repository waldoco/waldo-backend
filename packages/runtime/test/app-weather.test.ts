import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEATHER_ATTRIBUTION_V1, weatherV1Schema } from '../../contracts/src/app/weather';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values: a generated key, made-up ids, a made-up place and a made-up forecast.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey) as ArrayBuffer);
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
const NOW = Date.parse('2026-11-19T08:30:00Z');

const LOCALITY = 'Testville';
// The Workers pool keeps a real Cache API across tests, and the provider's answer is cached by cell, zone and hour, so each read
// that must reach the provider is for a cell no earlier test used.
const CELLS = ['tdr1v', 'tdr1w', 'tdr1y', 'tdr1z', 'tdr3b', 'tdr3c', 'tdr3f', 'tdr3g', 'tdr3u', 'tdr3v', 'tdr3y', 'tdr3z', 'tdr40', 'tdr41'];
let used = 0;
let CELL = CELLS[0]!;
const freshCell = () => { CELL = CELLS[used++]!; return CELL; };
const row = (id: string, place: Record<string, unknown> | null, timezone = 'Asia/Kolkata') => ({
  device_id: `0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5${id}`, received_at: '2026-11-19T08:00:00.000Z', platform: 'ios', timezone, timezone_observed_at: '2026-11-19T08:00:00.000Z', place,
});
const apple = (readTime = '2026-11-19T08:29:00Z', current: object | null = { temperature: 27.4, conditionCode: 'PartlyCloudy', uvIndex: 6 }) => ({
  ...(current ? { currentWeather: current } : {}),
  forecastDaily: {
    metadata: { readTime },
    days: [
      { forecastStart: '2026-11-18T18:30:00Z', conditionCode: 'PartlyCloudy', temperatureMax: 31, temperatureMin: 22.5, maxUvIndex: 9 },
      { forecastStart: '2026-11-19T18:30:00Z', conditionCode: 'Rain', temperatureMax: 27, temperatureMin: 21, maxUvIndex: 4 },
    ],
  },
});

let switches: Record<string, string> = {};
const limiterKeys: string[] = [];
let limited = false;
const env = () => ({
  ...switches,
  WEATHERKIT_TEAM_ID: 'TEAM123456', WEATHERKIT_SERVICE_ID: 'in.example.weather', WEATHERKIT_KEY_ID: 'KEY1234567', WEATHERKIT_PRIVATE_KEY: PEM,
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: !limited }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

const rpcs: { fn: string; body: Record<string, unknown> }[] = [];
const providerAsks: string[] = [];
let placeAnswer: unknown = {};
let providerAnswer: unknown = apple();
const logged: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  switches = { DEVICE_PLACE: '1', DEVICE_WEATHER: '1' };
  rpcs.length = 0; providerAsks.length = 0; limiterKeys.length = 0; logged.length = 0; limited = false;
  placeAnswer = { places: [row('1', { cell: freshCell(), locality: LOCALITY, country: 'IN', observed_at: '2026-11-19T07:00:00.000Z' })] };
  providerAnswer = apple();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('https://weatherkit.apple.com/')) {
      providerAsks.push(url);
      if (providerAnswer instanceof Error) throw providerAnswer;
      return Response.json(providerAnswer, { status: providerAnswer === null ? 500 : 200 });
    }
    rpcs.push({ fn: url.split('/rpc/')[1]!, body: JSON.parse(String(init.body)) });
    if (placeAnswer instanceof Error) throw placeAnswer;
    return Response.json(placeAnswer);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const read = (method = 'GET', credential: string | null = CREDENTIAL) => handleApp(new Request('https://w.test/app/v1/weather', {
  method, ...(credential ? { headers: { authorization: `Bearer ${credential}` } } : {}),
}), env(), auth) as Promise<Response>;
const body = async (response: Response) => { expect(response.headers.get('cache-control')).toBe('no-store'); return response.json() as Promise<Record<string, unknown>>; };

describe('GET /app/v1/weather', () => {
  it('answers the current temperature and today in the place\'s zone, with Apple\'s attribution and nothing of the place', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    expect(await body(response)).toEqual({
      state: 'available', now: { temperature_c: 27.4, condition: 'PartlyCloudy' }, today: { high_c: 31, low_c: 22.5 },
      as_of: '2026-11-19T08:29:00Z', attribution: WEATHER_ATTRIBUTION_V1,
    });
    expect(weatherV1Schema.safeParse(JSON.parse(text)).success).toBe(true);
    for (const leak of [CELL, LOCALITY, 'Asia/Kolkata', 'IN"', 'owner-1', '0c9d6a7e']) expect(text).not.toContain(leak);
    // The read is the place consent's weather purpose, for the session's owner only.
    const payload = JSON.stringify({ purpose: 'weather' });
    expect(rpcs).toMatchObject([{ fn: 'device_context_place_read', body: { p_do_name: 'owner-1', p_payload: payload } }]);
    expect(rpcs[0]!.body).not.toHaveProperty('cell');
    expect(providerAsks).toHaveLength(1);
    expect(providerAsks[0]).not.toContain(CELL);
    expect(limiterKeys).toEqual(['app-weather:owner-1']);
    expect(logged.join('\n')).not.toMatch(/27\.4|tdr\w|Testville/);
  });

  it('reads the place observed most recently, whichever phone sent it', async () => {
    placeAnswer = { places: [
      row('1', { cell: 'gcpvj', observed_at: '2026-11-18T07:00:00.000Z' }, 'Europe/London'),
      row('2', { cell: CELL, observed_at: '2026-11-19T07:00:00.000Z' }),
      row('3', null),
    ] };
    expect((await body(await read())).state).toBe('available');
    // The provider is asked for the newer place, in its own zone, not the older London one.
    expect(providerAsks[0]).toContain('timezone=Asia%2FKolkata');
  });

  it('is not there while the place or weather switch is off, and needs a credential, a GET and a budget', async () => {
    for (const off of [{ DEVICE_PLACE: '0', DEVICE_WEATHER: '1' }, { DEVICE_PLACE: '1', DEVICE_WEATHER: '0' }, {}] as Record<string, string>[]) {
      switches = off;
      expect((await read()).status).toBe(404);
    }
    switches = { DEVICE_PLACE: '1', DEVICE_WEATHER: '1' };
    expect((await read('GET', null)).status).toBe(401);
    expect((await read('POST')).status).toBe(405);
    limited = true;
    const refused = await read();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(rpcs).toEqual([]);
    expect(providerAsks).toEqual([]);
  });

  it('answers the consent state and asks no provider while the owner has not granted or has withdrawn the place', async () => {
    for (const [error, expected] of [
      ['consent_required', { state: 'consent', reason: 'consent_required' }],
      ['consent_withdrawn', { state: 'consent', reason: 'consent_withdrawn' }],
      ['not_linked', { state: 'unavailable', reason: 'not_linked' }],
    ] as const) {
      placeAnswer = { error };
      const response = await read();
      expect(response.status).toBe(200);
      expect(await body(response)).toEqual(expected);
    }
    expect(providerAsks).toEqual([]);
  });

  it('answers no_place without a placed phone, and 503 when the database cannot answer', async () => {
    placeAnswer = { places: [] };
    expect(await body(await read())).toEqual({ state: 'unavailable', reason: 'no_place' });
    placeAnswer = { places: [row('1', null)] };
    expect(await body(await read())).toEqual({ state: 'unavailable', reason: 'no_place' });
    for (const broken of [new Error('down'), { error: 'unavailable' }, { places: 'x' }, 'nonsense']) {
      placeAnswer = broken;
      expect((await read()).status).toBe(503);
    }
    expect(providerAsks).toEqual([]);
  });

  it('never answers a stale, partial or failed forecast with a number', async () => {
    const cases: unknown[] = [
      new Error('offline'),
      null,
      apple('2026-11-19T06:59:00Z'),
      apple(undefined, null),
      { forecastDaily: { metadata: { readTime: '2026-11-19T08:29:00Z' }, days: [apple().forecastDaily.days[1]] } },
      apple(undefined, { temperature: 75, conditionCode: 'Clear', uvIndex: 1 }),
    ];
    for (const answer of cases) {
      providerAnswer = answer;
      placeAnswer = { places: [row('1', { cell: freshCell(), observed_at: '2026-11-19T07:00:00.000Z' })] };
      const response = await read();
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ state: 'unavailable', reason: 'provider_unavailable' });
    }
    expect(logged.join('\n')).not.toMatch(/tdr\w|Testville/);
  });
});
