import { describe, expect, it } from 'vitest';
import { getWeatherArgsSchema } from '@waldo/contracts';
import { weatherHandler } from '../src/tools/live/weather';
import { coarsen } from '../src/connectors/open-meteo';

const forecastBody = {
  timezone: 'Asia/Kolkata',
  hourly: {
    time: ['2026-10-11T12:00', '2026-10-11T13:00', '2026-10-11T14:00'],
    temperature_2m: [30, 31, null], apparent_temperature: [33, 34, 35], precipitation_probability: [10, 20, 30],
  },
  daily: { time: ['2026-10-11', '2026-10-12'], sunrise: ['2026-10-11T06:20', '2026-10-12T06:20'], sunset: ['2026-10-11T18:10', '2026-10-12T18:09'], daylight_duration: [42600, 42540], uv_index_max: [8, 7] },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const clock = { now: () => new Date('2026-10-11T12:30:00Z') };
const home = { get: () => ({ lat: 18.5204, lon: 73.8567 }) };
const none = { get: () => null };
const route = (urls: string[], overrides: Partial<Record<'forecast' | 'air' | 'geo', () => Response>> = {}): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('geocoding')) return (overrides.geo ?? (() => json({ results: [{ latitude: 18.51957, longitude: 73.85535 }] })))();
    if (url.includes('air-quality')) return (overrides.air ?? (() => json({ current: { us_aqi: 55, european_aqi: 40 } })))();
    return (overrides.forecast ?? (() => json(forecastBody)))();
  }) as typeof fetch;

describe('get_weather args', () => {
  it('accepts a place, a day and hours', () => {
    expect(getWeatherArgsSchema.parse({ place: 'Pune', day: '2026-10-12', hours: 6 })).toEqual({ place: 'Pune', day: '2026-10-12', hours: 6 });
    expect(getWeatherArgsSchema.parse({})).toEqual({ day: 'today', hours: 12 });
  });
  it('rejects unknown keys, bad days and out-of-range hours', () => {
    expect(getWeatherArgsSchema.safeParse({ lat: 1 }).success).toBe(false);
    expect(getWeatherArgsSchema.safeParse({ day: 'tomorrow' }).success).toBe(false);
    expect(getWeatherArgsSchema.safeParse({ hours: 0 }).success).toBe(false);
    expect(getWeatherArgsSchema.safeParse({ place: '' }).success).toBe(false);
  });
});

describe('get_weather handler', () => {
  it('returns hours, UV, air quality and daylight tagged external, with no advice text', async () => {
    const urls: string[] = [];
    const out = await weatherHandler(home, clock, route(urls)).handle({ day: 'today', hours: 2 }, undefined as never);
    expect(out.ok && out.source_taint).toBe('external');
    if (!out.ok) throw new Error('expected ok');
    expect(out.data).toMatchObject({ status: 'ok', source: 'open-meteo', timezone: 'Asia/Kolkata', uv_index_max: 8, daylight_seconds: 42600, sunrise: '2026-10-11T06:20' });
    if (out.data.status !== 'ok') throw new Error('expected ok');
    expect(out.data.hours).toHaveLength(2);
    expect(out.data.hours[0]).toEqual({ time: '2026-10-11T12:00', temperature_c: 30, feels_like_c: 33, precipitation_probability_pct: 10 });
    expect(out.data.air_quality).toEqual({ us_aqi: 55, european_aqi: 40 });
  });
  it('never sends a four-decimal coordinate', async () => {
    const urls: string[] = [];
    await weatherHandler(home, clock, route(urls)).handle({ day: 'today', hours: 2 }, undefined as never);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain('18.5204');
      expect(url).not.toContain('73.8567');
      expect(url).toContain('latitude=18.5');
    }
    expect(coarsen({ lat: 18.5204, lon: 73.8567 })).toEqual({ lat: 18.5, lon: 73.9 });
  });
  it('prefers the named place over stored location', async () => {
    const urls: string[] = [];
    await weatherHandler(none, clock, route(urls)).handle({ place: 'Pune', day: 'today', hours: 1 }, undefined as never);
    expect(urls[0]).toContain('geocoding');
    expect(urls[0]).toContain('name=Pune');
    expect(urls.some(url => url.includes('latitude=18.5'))).toBe(true);
  });
  it('returns a typed no-location result without calling the provider', async () => {
    const urls: string[] = [];
    const out = await weatherHandler(none, clock, route(urls)).handle({ day: 'today', hours: 1 }, undefined as never);
    expect(out.ok && out.data.status).toBe('no_location');
    expect(urls).toEqual([]);
  });
  it('reports an unknown place and an out-of-range day', async () => {
    const empty = await weatherHandler(none, clock, route([], { geo: () => json({}) })).handle({ place: 'Nowhere', day: 'today', hours: 1 }, undefined as never);
    expect(empty.ok && empty.data).toEqual({ status: 'unavailable', reason: 'place_not_found' });
    const far = await weatherHandler(home, clock, route([])).handle({ day: '2027-01-01', hours: 1 }, undefined as never);
    expect(far.ok && far.data).toEqual({ status: 'unavailable', reason: 'day_out_of_range' });
  });
  it.each([
    ['429', () => json({}, 429), 'rate_limited'],
    ['5xx', () => json({}, 503), 'provider_error'],
    ['missing field', () => json({ timezone: 'x', hourly: {}, daily: {} }), 'invalid_response'],
    ['oversize', () => new Response('x'.repeat(200_001)), 'oversize'],
  ])('maps a %s forecast to unavailable', async (_name, forecast, reason) => {
    const out = await weatherHandler(home, clock, route([], { forecast })).handle({ day: 'today', hours: 1 }, undefined as never);
    expect(out.ok && out.data).toEqual({ status: 'unavailable', reason });
  });
  it('maps a timeout to unavailable', async () => {
    const fetcher = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    const out = await weatherHandler(home, clock, fetcher).handle({ day: 'today', hours: 1 }, undefined as never);
    expect(out.ok && out.data).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
  it('still answers when air quality fails', async () => {
    const out = await weatherHandler(home, clock, route([], { air: () => json({}, 500) })).handle({ day: 'today', hours: 1 }, undefined as never);
    expect(out.ok && out.data.status === 'ok' && out.data.air_quality).toBeNull();
  });
  it('is registered read-only', async () => {
    const { TOOL_PERMISSIONS, EXTERNAL_ORIGIN_TOOLS } = await import('@waldo/contracts');
    expect(Object.values(TOOL_PERMISSIONS).some(list => list.includes('get_weather'))).toBe(true);
    expect(EXTERNAL_ORIGIN_TOOLS).toContain('get_weather');
    const handler = weatherHandler(home, clock, route([]));
    expect(handler.autonomy_gated).toBe(false);
  });
});
