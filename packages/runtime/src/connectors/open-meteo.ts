import { z } from 'zod';

// Open-Meteo needs no key. Coordinates are rounded to one decimal (about 11 km) before any request,
// so a precise position never leaves the Worker. Nothing here logs a place or a coordinate.
const FORECAST_HOST = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_HOST = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEOCODING_HOST = 'https://geocoding-api.open-meteo.com/v1/search';
const MAX_BODY_CHARS = 200_000;
const TIMEOUT_MS = 10_000;

export type Coordinates = Readonly<{ lat: number; lon: number }>;
export const coarse = (value: number): number => Math.round(value * 10) / 10;
export const coarsen = (point: Coordinates): Coordinates => ({ lat: coarse(point.lat), lon: coarse(point.lon) });

export class OpenMeteoError extends Error {
  constructor(readonly kind: 'rate_limited' | 'provider_error' | 'timeout' | 'oversize' | 'invalid_response') {
    super(`open-meteo ${kind}`);
  }
}

const getJson = async (url: URL, fetcher: typeof fetch): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetcher(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  } catch (error) {
    throw new OpenMeteoError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'provider_error');
  }
  if (response.status === 429) throw new OpenMeteoError('rate_limited');
  if (!response.ok) throw new OpenMeteoError('provider_error');
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new OpenMeteoError('oversize');
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenMeteoError('invalid_response');
  }
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new OpenMeteoError('invalid_response');
  return result.data;
};

const geocodingSchema = z.object({ results: z.array(z.object({ latitude: z.number().finite(), longitude: z.number().finite() })).optional() });
// The first match for a place name, already coarsened. Null when nothing matches.
export const geocode = async (name: string, fetcher: typeof fetch): Promise<Coordinates | null> => {
  const url = new URL(GEOCODING_HOST);
  url.search = new URLSearchParams({ name, count: '1' }).toString();
  const first = parse(geocodingSchema, await getJson(url, fetcher)).results?.[0];
  return first ? coarsen({ lat: first.latitude, lon: first.longitude }) : null;
};

const hourlySchema = z.object({
  time: z.array(z.string()),
  temperature_2m: z.array(z.number().nullable()),
  apparent_temperature: z.array(z.number().nullable()),
  precipitation_probability: z.array(z.number().nullable()),
});
const dailySchema = z.object({
  time: z.array(z.string()),
  sunrise: z.array(z.string()),
  sunset: z.array(z.string()),
  daylight_duration: z.array(z.number().nullable()),
  uv_index_max: z.array(z.number().nullable()),
});
const forecastSchema = z.object({ timezone: z.string(), hourly: hourlySchema, daily: dailySchema });
export type Forecast = z.infer<typeof forecastSchema>;

export const forecast = async (at: Coordinates, days: number, fetcher: typeof fetch): Promise<Forecast> => {
  const point = coarsen(at);
  const url = new URL(FORECAST_HOST);
  url.search = new URLSearchParams({
    latitude: String(point.lat), longitude: String(point.lon), timezone: 'auto', forecast_days: String(days),
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability',
    daily: 'sunrise,sunset,daylight_duration,uv_index_max',
  }).toString();
  return parse(forecastSchema, await getJson(url, fetcher));
};

const airSchema = z.object({ current: z.object({ us_aqi: z.number().nullable().optional(), european_aqi: z.number().nullable().optional() }).optional() });
export type AirQuality = Readonly<{ us_aqi: number | null; european_aqi: number | null }>;
export const airQuality = async (at: Coordinates, fetcher: typeof fetch): Promise<AirQuality> => {
  const point = coarsen(at);
  const url = new URL(AIR_QUALITY_HOST);
  url.search = new URLSearchParams({ latitude: String(point.lat), longitude: String(point.lon), current: 'us_aqi,european_aqi', timezone: 'auto' }).toString();
  const current = parse(airSchema, await getJson(url, fetcher)).current;
  return { us_aqi: current?.us_aqi ?? null, european_aqi: current?.european_aqi ?? null };
};
