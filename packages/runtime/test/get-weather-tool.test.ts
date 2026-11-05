import { describe, expect, it } from 'vitest';
import { getWeatherResultSchema } from '@waldo/contracts';
import { md5Hex } from '../src/channels/md5';
import type { Forecast, WeatherKit } from '../src/connectors/weatherkit';
import { getWeatherHandler, weatherPlaceBook, weatherTools } from '../src/tools/live/weather';

// Synthetic values: made-up cells, cities and forecast. "now" is 12:00 UTC on 5 Nov 2026.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-11-05T12:00:00Z') };
const row = (id: string, timezone: string, place: Record<string, unknown> | null) => ({
  device_id: `0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5${id}`, received_at: '2026-11-05T11:30:00.000Z', platform: 'ios', timezone, timezone_observed_at: '2026-11-05T11:30:00.000Z', place,
});
const forecast: Forecast = {
  now: { temperature_c: 28.4, condition: 'Clear', uv_index: 7 },
  days: [{ date: '2026-11-05', condition: 'PartlyCloudy', high_c: 31.5, low_c: 22.1, uv_max: 9, precipitation_chance: 0.2 }],
  read_at: '2026-11-05T11:59:00Z',
};

const setup = (answer: unknown, weather: Forecast | null | Error = forecast) => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [], asked: { cell: string; timezone: string }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const provider: WeatherKit = { async forecast(cell, timezone) { asked.push({ cell, timezone }); if (weather instanceof Error) throw weather; return weather; } };
  return { calls, asked, handler: getWeatherHandler(weatherPlaceBook(call, 'do-x'), provider, clock) };
};
const ctx = {} as never;

describe('get_weather', () => {
  it('declares a turn-only output and serves the triggers the ADR names', () => {
    const { handler } = setup({ places: [] });
    expect([handler.turn_only_output, handler.autonomy_gated]).toEqual([true, false]);
    expect([...handler.trigger_allowlist].sort()).toEqual(['brief', 'fetch_alert', 'handoff_plan', 'intervention', 'patrol', 'user_message']);
  });

  it('reads the cell with the weather purpose, which needs all three place consents', async () => {
    const { calls, handler } = setup({ places: [] });
    await handler.handle({}, ctx);
    const payload = JSON.stringify({ purpose: 'weather' });
    expect(calls).toEqual([{ fn: 'device_context_place_read', message: `device_context.place_read.do-x.${md5Hex(payload)}`, args: { p_do_name: 'do-x', p_payload: payload } }]);
  });

  it('forecasts the most recently observed place, with its names and age, and never gives the model the cell', async () => {
    const { asked, handler } = setup({ places: [
      row('1', 'Asia/Dubai', null),
      row('2', 'Asia/Kolkata', { cell: 'tdr1v', locality: 'Testville', country: 'IN', observed_at: '2026-11-05T10:00:00.000Z' }),
      row('3', 'Europe/London', { cell: 'gcpvj', locality: 'Oldtown', observed_at: '2026-11-04T10:00:00.000Z' }),
    ] });
    const answer = await handler.handle({}, ctx);
    expect(asked).toEqual([{ cell: 'tdr1v', timezone: 'Asia/Kolkata' }]);
    expect(answer).toEqual({ ok: true, source_taint: null, data: {
      state: 'available', source: 'Apple Weather',
      place: { locality: 'Testville', country: 'IN', timezone: 'Asia/Kolkata', observed_at: '2026-11-05T10:00:00.000Z', age_minutes: 120 },
      now: forecast.now, days: forecast.days, read_at: forecast.read_at,
    } });
    expect(getWeatherResultSchema.safeParse((answer as { data: unknown }).data).success).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('tdr1v');
  });

  it('says why when there is no weather to give, and never invents one', async () => {
    const placed = { places: [row('1', 'Asia/Kolkata', { cell: 'tdr1v', observed_at: '2026-11-05T10:00:00.000Z' })] };
    for (const [answer, weather, reason] of [
      [{ error: 'consent_required' }, forecast, 'consent_required'], [{ error: 'consent_withdrawn' }, forecast, 'consent_withdrawn'],
      [{ error: 'not_linked' }, forecast, 'not_linked'], [{ error: 'boom' }, forecast, 'read_failed'], [new Error('network'), forecast, 'read_failed'],
      [{ places: [] }, forecast, 'no_place'], [{ places: [row('1', 'Asia/Kolkata', null)] }, forecast, 'no_place'],
      [placed, null, 'provider_unavailable'], [placed, new Error('provider'), 'provider_unavailable'],
    ] as const) {
      const { asked, handler } = setup(answer, weather);
      expect(await handler.handle({}, ctx)).toEqual({ ok: true, source_taint: null, data: { state: 'unavailable', reason } });
      if (reason !== 'provider_unavailable') expect(asked).toEqual([]);
    }
  });

  it('is offered only with both switches on and all four WeatherKit secrets set', () => {
    const on = { DEVICE_PLACE: '1', DEVICE_WEATHER: '1', WEATHERKIT_TEAM_ID: 'TEAM123456', WEATHERKIT_SERVICE_ID: 'in.example.weather', WEATHERKIT_KEY_ID: 'KEY1234567', WEATHERKIT_PRIVATE_KEY: 'synthetic' };
    const offered = (env: Record<string, string>) => weatherTools(env, null, 'do-x', clock, null).map(tool => tool.name);
    expect(offered(on)).toEqual(['get_weather']);
    for (const off of [{ DEVICE_PLACE: '0' }, { DEVICE_WEATHER: '0' }, { DEVICE_PLACE: '' }, { DEVICE_WEATHER: '' }, { WEATHERKIT_PRIVATE_KEY: '' }, { WEATHERKIT_TEAM_ID: '' }]) {
      expect(offered({ ...on, ...off })).toEqual([]);
    }
  });
});
