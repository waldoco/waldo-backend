import { getWeatherArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type GetWeatherArgs, type ToolHandler, type ToolName } from '@waldo/contracts';
import { airQuality, forecast, geocode, OpenMeteoError, type AirQuality, type Coordinates, type Forecast } from '../../connectors/open-meteo';
import type { ToolDispatcherContext } from '../dispatcher';

// The owner's coarse location, if one is stored. The host supplies the storage; the app side that writes it is not here.
export interface OwnerLocationSource { get(): Promise<Coordinates | null> | Coordinates | null }

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes(name));
const FORECAST_DAYS = 16;

type Hour = Readonly<{ time: string; temperature_c: number | null; feels_like_c: number | null; precipitation_probability_pct: number | null }>;
export type WeatherResult =
  | Readonly<{ status: 'ok'; source: 'open-meteo'; fetched_at: string; timezone: string; day: string; hours: readonly Hour[]; uv_index_max: number | null; air_quality: AirQuality | null; sunrise: string; sunset: string; daylight_seconds: number | null }>
  | Readonly<{ status: 'no_location'; hint: string }>
  | Readonly<{ status: 'unavailable'; reason: 'place_not_found' | 'day_out_of_range' | 'rate_limited' | 'provider_error' | 'timeout' | 'oversize' | 'invalid_response' }>;

const result = (data: WeatherResult) => ({ ok: true as const, data, source_taint: 'external' as const });

const pick = (data: Forecast, index: number, count: number, from: string): readonly Hour[] => {
  const start = data.hourly.time.findIndex(time => time >= from);
  if (start < 0) return [];
  return data.hourly.time.slice(start, start + count).map((time, offset) => ({
    time, temperature_c: data.hourly.temperature_2m[start + offset] ?? null, feels_like_c: data.hourly.apparent_temperature[start + offset] ?? null,
    precipitation_probability_pct: data.hourly.precipitation_probability[start + offset] ?? null,
  }));
};

export const weatherHandler = (
  location: OwnerLocationSource,
  clock: Readonly<{ now(): Date }>,
  fetcher: typeof fetch = fetch,
): ToolHandler<GetWeatherArgs, WeatherResult, ToolDispatcherContext> => ({
  name: 'get_weather',
  description: 'Hourly temperature, feels-like and rain chance, UV, air quality, sunrise, sunset and daylight for a place the owner named or their stored coarse location. Read-only. Pass day as today or a YYYY-MM-DD within 16 days, and hours for how many hours to return.',
  schema: getWeatherArgsSchema,
  trigger_allowlist: allowlist('get_weather'),
  autonomy_gated: false,
  async handle({ place, day, hours }: GetWeatherArgs, ctx) {
    try {
      await ctx?.assertTaskSourceCurrent?.();
      const at = place ? await geocode(place, fetcher) : await location.get();
      if (place && !at) return result({ status: 'unavailable', reason: 'place_not_found' });
      if (!at) return result({ status: 'no_location', hint: 'Ask the owner where they are, or to share location in the app.' });
      const data = await forecast(at, FORECAST_DAYS, fetcher);
      const target = day === 'today' ? clock.now().toISOString().slice(0, 10) : day;
      const dayIndex = data.daily.time.indexOf(target);
      if (dayIndex < 0) return result({ status: 'unavailable', reason: 'day_out_of_range' });
      const from = day === 'today' ? `${clock.now().toISOString().slice(0, 13)}:00` : `${target}T00:00`;
      const air = await airQuality(at, fetcher).catch(() => null);
      return result({
        status: 'ok', source: 'open-meteo', fetched_at: clock.now().toISOString(), timezone: data.timezone, day: target,
        hours: pick(data, dayIndex, hours, from), uv_index_max: data.daily.uv_index_max[dayIndex] ?? null, air_quality: air,
        sunrise: data.daily.sunrise[dayIndex] ?? '', sunset: data.daily.sunset[dayIndex] ?? '', daylight_seconds: data.daily.daylight_duration[dayIndex] ?? null,
      });
    } catch (error) {
      if (error instanceof OpenMeteoError) return result({ status: 'unavailable', reason: error.kind });
      throw error;
    }
  },
});
