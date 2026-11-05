import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geohashCentre, weatherKit, weatherKitCredentials, weatherKitToken, type Forecast, type WeatherCache } from '../src/connectors/weatherkit';

// Synthetic values: a generated key, made-up ids and a made-up forecast.
const NOW = Date.parse('2026-11-05T08:30:00Z');
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey) as ArrayBuffer);
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
const credentials = { teamId: 'TEAM123456', serviceId: 'in.heywaldo.weather', keyId: 'KEY1234567', privateKey: pem };
const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
const bytes = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

const apple = {
  currentWeather: { temperature: 28.4, conditionCode: 'Clear', uvIndex: 7, metadata: { readTime: '2026-11-05T08:29:00Z' } },
  forecastDaily: {
    metadata: { readTime: '2026-11-05T08:29:00Z', expireTime: '2026-11-05T09:29:00Z' },
    days: [
      { forecastStart: '2026-11-04T18:30:00Z', forecastEnd: '2026-11-05T18:30:00Z', conditionCode: 'PartlyCloudy', temperatureMax: 31.5, temperatureMin: 22.1,
        precipitationChance: 0.2, precipitationAmount: 1.4, maxUvIndex: 9, sunrise: '2026-11-05T00:50:00Z', sunset: '2026-11-05T12:30:00Z' },
      { forecastStart: '2026-11-05T18:30:00Z', forecastEnd: '2026-11-06T18:30:00Z', conditionCode: 'Rain', temperatureMax: 27, temperatureMin: 21,
        precipitationChance: 85, precipitationAmount: 12, maxUvIndex: 4 },
      { forecastStart: '2026-11-06T18:30:00Z', conditionCode: 'Clear', temperatureMax: 30, temperatureMin: 20, maxUvIndex: 9 },
    ],
  },
};

const logged: string[] = [];
beforeEach(() => { logged.length = 0; vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }); });
afterEach(() => { vi.restoreAllMocks(); });

const memoryCache = () => {
  const store = new Map<string, Forecast>(), puts: { key: string; seconds: number }[] = [];
  const cache: WeatherCache = { async get(key) { return store.get(key) ?? null; }, async put(key, value, seconds) { store.set(key, value); puts.push({ key, seconds }); } };
  return { cache, puts, store };
};
const provider = (answer: unknown, status = 200) => {
  const asked: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(new Request(input, init));
    if (answer instanceof Error) throw answer;
    return Response.json(answer, { status });
  }) as typeof fetch;
  return { asked, fetcher };
};

describe('WeatherKit', () => {
  it('needs all four secrets before it is offered', () => {
    const env = { WEATHERKIT_TEAM_ID: 'TEAM123456', WEATHERKIT_SERVICE_ID: 'in.heywaldo.weather', WEATHERKIT_KEY_ID: 'KEY1234567', WEATHERKIT_PRIVATE_KEY: pem };
    expect(weatherKitCredentials(env)).toEqual(credentials);
    for (const missing of Object.keys(env)) expect(weatherKitCredentials({ ...env, [missing]: '' })).toBeNull();
  });

  it('finds the centre of a geohash cell (tdr1v is the cell holding 12.9716, 77.5946)', () => {
    const { latitude, longitude } = geohashCentre('tdr1v');
    expect(latitude).toBe(12.98583984375);
    expect(longitude).toBe(77.58544921875);
    expect(() => geohashCentre('tdr1a')).toThrow();
  });

  it('signs a developer token with only the header fields and claims Apple lists, which the public key verifies', async () => {
    const token = await weatherKitToken(credentials, NOW);
    const [header, payload, signature] = token.split('.');
    expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'KEY1234567', id: 'TEAM123456.in.heywaldo.weather' });
    expect(decode(payload!)).toEqual({ iss: 'TEAM123456', iat: NOW / 1000, exp: NOW / 1000 + 600, sub: 'in.heywaldo.weather' });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, bytes(signature!), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });

  it('asks for one cell\'s centre and zone with a bearer token, and nothing that names the owner', async () => {
    const { asked, fetcher } = provider(apple);
    await weatherKit(credentials, null, fetcher, () => NOW).forecast('tdr1v', 'Asia/Kolkata');
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://weatherkit.apple.com/api/v1/weather/en/12.9858/77.5854');
    expect(Object.fromEntries(url.searchParams)).toEqual({ dataSets: 'currentWeather,forecastDaily', timezone: 'Asia/Kolkata' });
    expect(asked[0]!.headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect([...asked[0]!.headers.keys()]).toEqual(['authorization']);
  });

  it('keeps today and tomorrow in the owner\'s local dates, metric as given, and leaves out what does not fit', async () => {
    const forecast = await weatherKit(credentials, null, provider(apple).fetcher, () => NOW).forecast('tdr1v', 'Asia/Kolkata');
    expect(forecast).toEqual({
      now: { temperature_c: 28.4, condition: 'Clear', uv_index: 7 },
      days: [
        { date: '2026-11-05', condition: 'PartlyCloudy', high_c: 31.5, low_c: 22.1, uv_max: 9, precipitation_chance: 0.2, precipitation_mm: 1.4, sunrise: '2026-11-05T00:50:00Z', sunset: '2026-11-05T12:30:00Z' },
        { date: '2026-11-06', condition: 'Rain', high_c: 27, low_c: 21, uv_max: 4, precipitation_mm: 12 },
      ],
      read_at: '2026-11-05T08:29:00Z',
    });
  });

  it('answers from the cache by cell, zone and hour, and keeps it no later than the end of the hour', async () => {
    const { cache, puts } = memoryCache(), { asked, fetcher } = provider(apple);
    const kit = weatherKit(credentials, cache, fetcher, () => NOW);
    const first = await kit.forecast('tdr1v', 'Asia/Kolkata');
    expect(await kit.forecast('tdr1v', 'Asia/Kolkata')).toEqual(first);
    expect(asked).toHaveLength(1);
    expect(puts).toEqual([{ key: `https://weather-cache.waldo.invalid/v1/tdr1v/Asia%2FKolkata/${Math.floor(NOW / 3_600_000)}`, seconds: 1800 }]);
    await kit.forecast('tdr1y', 'Asia/Kolkata');
    expect(asked).toHaveLength(2);
  });

  it('answers null on any provider failure and logs a fixed code, never the cell', async () => {
    const cases: [ReturnType<typeof provider>, string][] = [
      [provider(apple, 401), 'status_401'], [provider(new Error('network')), 'fetch_failed'],
      [provider({ forecastDaily: { days: [] } }), 'shape'], [provider({ currentWeather: { temperature: 1 } }), 'shape'],
    ];
    for (const [{ fetcher }, code] of cases) {
      logged.length = 0;
      expect(await weatherKit(credentials, null, fetcher, () => NOW).forecast('tdr1v', 'Asia/Kolkata')).toBeNull();
      expect(logged.map(line => JSON.parse(line))).toEqual([{ hop: 'weatherkit', code }]);
    }
    expect(await weatherKit({ ...credentials, privateKey: 'not a key' }, null, provider(apple).fetcher, () => NOW).forecast('tdr1v', 'Asia/Kolkata')).toBeNull();
  });
});
