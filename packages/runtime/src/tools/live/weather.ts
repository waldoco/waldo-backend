import {
  getWeatherArgsSchema, getWeatherResultSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type GetWeatherArgs, type GetWeatherResult, type ToolHandler,
} from '@waldo/contracts';
import { effectSignal } from '../../channels/run-effect-scope';
import { devicePlaceStoredV1Schema } from '../../../../contracts/src/app/device-context';
import { invokeDeviceContext } from '../../channels/app-device-context';
import { weatherKit, weatherKitCredentials, type WeatherCache, type WeatherKit, type WeatherKitEnv } from '../../connectors/weatherkit';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

// Today's and tomorrow's weather where the owner's most recently placed phone is. The cell comes from the health plane's weather
// read, which the database grants only while storage, model use and provider lookup are all granted; the Worker sends the cell's
// centre to WeatherKit and gives the model the forecast with the city's names, never the cell. The result lives in the turn that
// asked (turn_only_output), so neither the place nor the forecast reaches the tool ledger, memory, logs or storage. The forecast
// is the provider's text, so it is checked against the result contract and marks the turn as carrying external content.
const WEATHER_CEILING_MS = 8_000;
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type WeatherPlaceBook = Readonly<{ places(): Promise<unknown> }>;

export const weatherPlaceBook = (call: SignedCall | null, doName: string | null): WeatherPlaceBook => ({
  async places() {
    if (!call || !doName) return { error: 'not_linked' };
    return invokeDeviceContext(call, doName, 'place_read', JSON.stringify({ purpose: 'weather' }));
  },
});

type Unavailable = Extract<GetWeatherResult, { state: 'unavailable' }>['reason'];
const REFUSALS: ReadonlySet<string> = new Set<Unavailable>(['consent_required', 'consent_withdrawn', 'not_linked']);
const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_weather'));

export const getWeatherHandler = (book: WeatherPlaceBook, provider: WeatherKit, clock: OwnerClock): ToolHandler<GetWeatherArgs, GetWeatherResult, ToolDispatcherContext> => ({
  name: 'get_weather',
  description:
    "Today's and tomorrow's weather where the owner's phones last placed them (the most recent place), from Apple Weather: each day's condition, high and low in Celsius, chance of rain (0 to 1) and millimetres, the highest UV index, sunrise and sunset, and the current temperature, condition and UV when given. place names the city it is for and how many minutes ago the phone was there; an old place may no longer be where the owner is. phone_timezone is the zone that phone last reported, which can be newer than the place, and the days' dates are in it. Whenever you share it, say it is from Apple Weather; when the weather is what you are telling them, also give Apple's link to its data sources, https://developer.apple.com/weatherkit/data-source-attribution/ (Apple's attribution terms). It stays in this turn: never stored or logged.",
  schema: getWeatherArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle(_args, ctx) {
    const unavailable = (reason: Unavailable) => result({ state: 'unavailable', reason });
    let raw: unknown;
    try { raw = await book.places(); } catch { return unavailable('read_failed'); }
    const answer = (raw ?? {}) as { error?: unknown; places?: unknown };
    if (typeof answer.error === 'string') return unavailable(REFUSALS.has(answer.error) ? answer.error as Unavailable : 'read_failed');
    if (!Array.isArray(answer.places)) return unavailable('read_failed');
    // The forecast is for the place observed most recently, whichever phone sent it.
    const placed = answer.places.flatMap((row) => {
      const stored = devicePlaceStoredV1Schema.safeParse(row);
      return stored.success && stored.data.place ? [{ ...stored.data, place: stored.data.place }] : [];
    }).sort((a, b) => Date.parse(b.place.observed_at) - Date.parse(a.place.observed_at))[0];
    if (!placed) return unavailable('no_place');
    let forecast: Awaited<ReturnType<WeatherKit['forecast']>>;
    try { forecast = await provider.forecast(placed.place.cell, placed.timezone, effectSignal(ctx?.runScope, WEATHER_CEILING_MS)); } catch { forecast = null; }
    if (!forecast) return unavailable('provider_unavailable');
    const { locality, region, country, observed_at } = placed.place;
    const available = getWeatherResultSchema.safeParse({
      state: 'available', source: 'Apple Weather',
      place: {
        ...(locality ? { locality } : {}), ...(region ? { region } : {}), ...(country ? { country } : {}),
        phone_timezone: placed.timezone, observed_at, age_minutes: Math.max(0, Math.floor((clock.now().getTime() - Date.parse(observed_at)) / 60_000)),
      },
      ...(forecast.now ? { now: forecast.now } : {}),
      days: forecast.days,
      read_at: forecast.read_at,
    });
    if (!available.success) {
      console.error(JSON.stringify({ hop: 'weatherkit', code: 'result_shape' }));
      return unavailable('provider_unavailable');
    }
    return { ok: true as const, data: available.data, source_taint: 'external' as const };
  },
});

const result = (data: GetWeatherResult) => ({ ok: true as const, data, source_taint: null });

// get_weather is offered only with the place switch, the weather switch and the WeatherKit key all present.
export const weatherTools = (
  env: WeatherKitEnv & Readonly<{ DEVICE_PLACE?: string; DEVICE_WEATHER?: string }>, call: SignedCall | null, doName: string | null, clock: OwnerClock, cache: WeatherCache | null,
) => {
  const credentials = env.DEVICE_PLACE === '1' && env.DEVICE_WEATHER === '1' ? weatherKitCredentials(env) : null;
  return credentials ? [getWeatherHandler(weatherPlaceBook(call, doName), weatherKit(credentials, cache), clock)] : [];
};
