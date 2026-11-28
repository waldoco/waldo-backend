import { WEATHER_ATTRIBUTION_V1, WEATHER_MAX_AGE_MINUTES_V1, weatherV1Schema, type WeatherV1 } from '../../../contracts/src/app/weather';
import type { WeatherKit } from '../connectors/weatherkit';
import { newestPlace, type WeatherPlaceBook } from '../tools/live/weather';

// GET /app/v1/weather: the app's date card, from the same place read and provider the agent's get_weather uses. The place read
// is the weather purpose, so the database decides consent; the answer carries the temperature and today's range only, never the
// cell, a place name or a zone. A failure is logged by a fixed code, never the place or a figure.
const PROVIDER_CEILING_MS = 8_000;
const reply = (body: WeatherV1) => Response.json(body, { headers: { 'cache-control': 'no-store' } });
const failed = () => Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
const localDate = (at: number, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

export const handleAppWeather = async (input: Readonly<{ book: WeatherPlaceBook; provider: WeatherKit; now: () => number }>): Promise<Response> => {
  let raw: unknown;
  try { raw = await input.book.places(); } catch { return failed(); }
  const answer = (raw ?? {}) as { error?: unknown; places?: unknown };
  if (answer.error === 'consent_required' || answer.error === 'consent_withdrawn') return reply({ state: 'consent', reason: answer.error });
  if (answer.error === 'not_linked') return reply({ state: 'unavailable', reason: 'not_linked' });
  if (!Array.isArray(answer.places)) return failed();
  const placed = newestPlace(answer.places);
  if (!placed) return reply({ state: 'unavailable', reason: 'no_place' });

  const unavailable = (): Response => reply({ state: 'unavailable', reason: 'provider_unavailable' });
  let forecast: Awaited<ReturnType<WeatherKit['forecast']>>;
  try { forecast = await input.provider.forecast(placed.place.cell, placed.timezone, AbortSignal.timeout(PROVIDER_CEILING_MS)); } catch { forecast = null; }
  const at = input.now();
  const today = forecast?.days.find(day => day.date === localDate(at, placed.timezone));
  if (!forecast?.now || !today || !(at - Date.parse(forecast.read_at) <= WEATHER_MAX_AGE_MINUTES_V1 * 60_000)) return unavailable();
  const available = weatherV1Schema.safeParse({
    state: 'available', now: { temperature_c: forecast.now.temperature_c, condition: forecast.now.condition },
    today: { high_c: today.high_c, low_c: today.low_c }, as_of: forecast.read_at, attribution: WEATHER_ATTRIBUTION_V1,
  });
  if (!available.success) {
    console.error(JSON.stringify({ hop: 'app_weather', code: 'result_shape' }));
    return unavailable();
  }
  return reply(available.data);
};
