import { buildSessionState } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import type { Forecast, WeatherKit } from '../src/connectors/weatherkit';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { deviceContextReadBook, getDeviceContextHandler } from '../src/tools/live/device-context';
import { getWeatherHandler, weatherPlaceBook } from '../src/tools/live/weather';

// Synthetic values: a made-up cell, city and forecast. These run the real dispatcher, which checks each result's taint stamp
// against the tool's origin class.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-11-05T12:00:00Z') };
const context = () => ({
  authenticatedUserId: 'owner',
  trigger: 'user_message' as const,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});
const places = { places: [{
  device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e51', received_at: '2026-11-05T11:30:00.000Z', platform: 'ios', timezone: 'Asia/Kolkata', timezone_observed_at: '2026-11-05T11:30:00.000Z',
  place: { cell: 'tdr1v', locality: 'Testville', country: 'IN', observed_at: '2026-11-05T10:00:00.000Z' },
}] };
const call = (answer: unknown) => async () => answer;
const forecast: Forecast = { days: [{ date: '2026-11-05', condition: 'Clear', high_c: 31, low_c: 22, uv_max: 9 }], read_at: '2026-11-05T11:59:00Z' };
const provider = (answer: Forecast | null): WeatherKit => ({ async forecast() { return answer; } });

describe('get_weather through the real dispatcher', () => {
  it('passes a forecast to the model stamped as outside text', async () => {
    const out = await dispatchTool({ id: 'w-ok', name: 'get_weather', args: {} }, context(), { handlers: [getWeatherHandler(weatherPlaceBook(call(places), 'do-x'), provider(forecast), clock)] });
    expect(out).toMatchObject({ ok: true, source_taint: 'external', data: { state: 'available', source: 'Apple Weather', place: { locality: 'Testville' } } });
    expect(JSON.stringify(out)).not.toContain('tdr1v');
  });

  it('passes "unavailable" as Waldo\'s own words', async () => {
    for (const [answer, weather] of [[places, null], [{ error: 'consent_required' }, forecast]] as const) {
      const out = await dispatchTool({ id: 'w-none', name: 'get_weather', args: {} }, context(), { handlers: [getWeatherHandler(weatherPlaceBook(call(answer), 'do-x'), provider(weather), clock)] });
      expect(out).toMatchObject({ ok: true, source_taint: null, data: { state: 'unavailable' } });
    }
  });
});

describe('get_device_context through the real dispatcher', () => {
  it('passes the phones\' places and refusals as Waldo\'s own reading, never outside text', async () => {
    for (const answer of [places, { error: 'consent_withdrawn' }]) {
      const out = await dispatchTool({ id: 'dc', name: 'get_device_context', args: {} }, context(), { handlers: [getDeviceContextHandler(deviceContextReadBook(call(answer), 'do-x'), clock)] });
      expect(out).toMatchObject({ ok: true, source_taint: null });
      expect(JSON.stringify(out)).not.toContain('tdr1v');
    }
  });
});
