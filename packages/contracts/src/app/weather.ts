import { z } from 'zod';

// The weather where the owner's phone last was, for the app's date card. The app makes no weather call and sends no position:
// the server answers from the owner's own latest place (by observed_at), through the same read the agent's get_weather uses.
//
// - Consent: that read is the place consent's weather purpose, which the database grants only while storage_compute,
//   model_processing and provider_lookup are all granted. So withdrawing Waldo's AI use of the place also hides the temperature.
// - No cell, coordinate, place name or device id is in the answer. The Worker sends the cell's centre, with no owner or device
//   id, to WeatherKit, and caches the provider's answer by cell, zone and local hour with no owner id. Nothing is stored for
//   the owner and nothing is logged but a fixed failure code.
// - Temperatures are Celsius as measured; the app converts for display by the phone's region.
// - The server owns staleness: a reading older than WEATHER_MAX_AGE_MINUTES_V1 answers unavailable, never an old number.
// - attribution is Apple's: its Weather mark and legal page must sit beside the figure wherever it shows.
// - Per-owner budget app-weather:<owner> on the shared limiter (120 a minute), then 429 with Retry-After. The provider is asked
//   at most once per cell and local hour. The app reads at most once per Home focus, and not within 15 minutes.
// - A Worker with DEVICE_PLACE or DEVICE_WEATHER off, or without the WeatherKit key, answers 404: the app shows no weather.

export const APP_WEATHER_PATH_V1 = '/app/v1/weather';
export const WEATHER_MAX_AGE_MINUTES_V1 = 90;
export const WEATHER_ATTRIBUTION_V1 = { name: 'Apple Weather', legal_url: 'https://weatherkit.apple.com/legal-attribution.html' } as const;

const celsius = z.number().min(-90).max(60);
export const weatherV1Schema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    // condition is the provider's condition code (Clear, PartlyCloudy, Rain and so on), which the app words.
    now: z.strictObject({ temperature_c: celsius, condition: z.string().min(1).max(60) }),
    // Today in the place's own zone.
    today: z.strictObject({ high_c: celsius, low_c: celsius }),
    // When the provider read the weather, never the time of this answer.
    as_of: z.iso.datetime(),
    attribution: z.strictObject({ name: z.literal(WEATHER_ATTRIBUTION_V1.name), legal_url: z.url() }),
  }),
  z.strictObject({ state: z.literal('consent'), reason: z.enum(['consent_required', 'consent_withdrawn']) }),
  z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['no_place', 'not_linked', 'provider_unavailable']) }),
]);
export type WeatherV1 = z.infer<typeof weatherV1Schema>;

export const appWeatherRoutesV1 = [
  { method: 'GET', path: APP_WEATHER_PATH_V1, response: weatherV1Schema, authenticated: true, success_status: 200 },
] as const;
