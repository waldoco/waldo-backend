// WeatherKit REST, the weather provider the place consent names. The Worker asks it for one cell's weather with the cell's centre
// only: no owner, device or place name leaves with the request. A developer token signed with the team's WeatherKit key (ES256)
// authorises each call. Answers are cached by cell, zone and hour with no owner id, which keeps within Apple's "temporary and
// limited" caching for performance and holds no history. Field names and units follow Apple's REST reference: temperatures in
// degrees Celsius, precipitation in millimetres.

export type WeatherKitCredentials = Readonly<{ teamId: string; serviceId: string; keyId: string; privateKey: string }>;
export type WeatherKitEnv = Readonly<{ WEATHERKIT_TEAM_ID?: string; WEATHERKIT_SERVICE_ID?: string; WEATHERKIT_KEY_ID?: string; WEATHERKIT_PRIVATE_KEY?: string }>;

export const weatherKitCredentials = (env: WeatherKitEnv): WeatherKitCredentials | null => {
  const { WEATHERKIT_TEAM_ID: teamId, WEATHERKIT_SERVICE_ID: serviceId, WEATHERKIT_KEY_ID: keyId, WEATHERKIT_PRIVATE_KEY: privateKey } = env;
  return teamId && serviceId && keyId && privateKey ? { teamId, serviceId, keyId, privateKey } : null;
};

export type ForecastDay = Readonly<{
  date: string; condition: string; high_c: number; low_c: number; uv_max: number;
  precipitation_chance?: number; precipitation_mm?: number; sunrise?: string; sunset?: string;
}>;
export type Forecast = Readonly<{ now?: { temperature_c: number; condition: string; uv_index: number }; days: readonly ForecastDay[]; read_at: string }>;
export type WeatherCache = Readonly<{ get(key: string): Promise<Forecast | null>; put(key: string, value: Forecast, seconds: number): Promise<void> }>;

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

// The centre of a geohash cell, longitude and latitude bits interleaved from the first.
export const geohashCentre = (cell: string): { latitude: number; longitude: number } => {
  const lat = [-90, 90], lon = [-180, 180];
  let even = true;
  for (const char of cell) {
    const bits = BASE32.indexOf(char);
    if (bits < 0) throw new Error('not a geohash');
    for (let mask = 16; mask > 0; mask >>= 1) {
      const range = even ? lon : lat, middle = (range[0]! + range[1]!) / 2;
      if (bits & mask) range[0] = middle; else range[1] = middle;
      even = !even;
    }
  }
  return { latitude: (lat[0]! + lat[1]!) / 2, longitude: (lon[0]! + lon[1]!) / 2 };
};

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

// Apple's developer token: ES256, kid the key id, id the team and service ids, and only the claims iss, iat, exp and sub.
export const weatherKitToken = async (credentials: WeatherKitCredentials, now: number): Promise<string> => {
  const der = Uint8Array.from(atob(credentials.privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '')), char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000);
  const unsigned = `${json64({ alg: 'ES256', kid: credentials.keyId, id: `${credentials.teamId}.${credentials.serviceId}` })}.${json64({ iss: credentials.teamId, iat, exp: iat + 600, sub: credentials.serviceId })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
};

const localDate = (instant: string, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

// Today and tomorrow from the provider's daily forecast, and the current conditions when given. A day missing a field the tool
// needs is left out, never filled in; the chance of rain is kept only on the 0 to 1 scale.
const forecastOf = (body: unknown, timezone: string, fetchedAt: string): Forecast | null => {
  const { currentWeather: current, forecastDaily: daily } = (body ?? {}) as { currentWeather?: Record<string, unknown>; forecastDaily?: { days?: unknown; metadata?: { readTime?: unknown } } };
  const days = (Array.isArray(daily?.days) ? daily.days : []).slice(0, 2).flatMap((raw): ForecastDay[] => {
    const day = (raw ?? {}) as Record<string, unknown>;
    if (!text(day.forecastStart) || !text(day.conditionCode) || !finite(day.temperatureMax) || !finite(day.temperatureMin) || !Number.isInteger(day.maxUvIndex)) return [];
    return [{
      date: localDate(day.forecastStart, timezone), condition: day.conditionCode, high_c: day.temperatureMax, low_c: day.temperatureMin, uv_max: day.maxUvIndex as number,
      ...(finite(day.precipitationChance) && day.precipitationChance >= 0 && day.precipitationChance <= 1 ? { precipitation_chance: day.precipitationChance } : {}),
      ...(finite(day.precipitationAmount) && day.precipitationAmount >= 0 ? { precipitation_mm: day.precipitationAmount } : {}),
      ...(text(day.sunrise) ? { sunrise: day.sunrise } : {}), ...(text(day.sunset) ? { sunset: day.sunset } : {}),
    }];
  });
  if (days.length === 0) return null;
  const now = current && finite(current.temperature) && text(current.conditionCode) && Number.isInteger(current.uvIndex)
    ? { temperature_c: current.temperature, condition: current.conditionCode, uv_index: current.uvIndex as number } : undefined;
  return { ...(now ? { now } : {}), days, read_at: text(daily?.metadata?.readTime) ? daily.metadata.readTime : fetchedAt };
};

// The Cache API under a key that names only the cell, the zone and the hour; nothing in it identifies an owner.
export const cacheApiWeatherCache = (cache: Cache): WeatherCache => ({
  async get(key) {
    const hit = await cache.match(key);
    return hit ? await hit.json() as Forecast : null;
  },
  async put(key, value, seconds) {
    await cache.put(key, Response.json(value, { headers: { 'cache-control': `max-age=${seconds}` } }));
  },
});

export type WeatherKit = Readonly<{ forecast(cell: string, timezone: string): Promise<Forecast | null> }>;

// null when the provider cannot be asked or answers anything else; the failure is logged by a fixed code, never the cell.
export const weatherKit = (credentials: WeatherKitCredentials, cache: WeatherCache | null, fetcher: typeof fetch = fetch, now = () => Date.now()): WeatherKit => ({
  async forecast(cell, timezone) {
    const at = now(), hour = Math.floor(at / 3_600_000);
    const key = `https://weather-cache.waldo.invalid/v1/${cell}/${encodeURIComponent(timezone)}/${hour}`;
    try { const hit = await cache?.get(key); if (hit) return hit; } catch { console.error(JSON.stringify({ hop: 'weatherkit', code: 'cache_read' })); }
    const { latitude, longitude } = geohashCentre(cell);
    const url = `https://weatherkit.apple.com/api/v1/weather/en/${latitude.toFixed(4)}/${longitude.toFixed(4)}?dataSets=currentWeather,forecastDaily&timezone=${encodeURIComponent(timezone)}`;
    let response: Response;
    try { response = await fetcher(url, { headers: { authorization: `Bearer ${await weatherKitToken(credentials, at)}` } }); }
    catch { console.error(JSON.stringify({ hop: 'weatherkit', code: 'fetch_failed' })); return null; }
    if (!response.ok) { console.error(JSON.stringify({ hop: 'weatherkit', code: `status_${response.status}` })); return null; }
    let forecast: Forecast | null;
    try { forecast = forecastOf(await response.json(), timezone, new Date(at).toISOString()); } catch { forecast = null; }
    if (!forecast) { console.error(JSON.stringify({ hop: 'weatherkit', code: 'shape' })); return null; }
    try { await cache?.put(key, forecast, 3600 - Math.floor((at % 3_600_000) / 1000)); } catch { console.error(JSON.stringify({ hop: 'weatherkit', code: 'cache_write' })); }
    return forecast;
  },
});
