import { describe, expect, it } from 'vitest';
import { parseSeries, produceHealthScores, withoutWhoopEcho, type ProducerDeps, type Series } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';

// An owner with WHOOP connected and Apple Health on the phone: WHOOP's own app also writes the night and the workouts into
// Apple Health, so the same night arrives twice. The WHOOP API's record is kept and the echo is dropped. Synthetic values only.
const NOW = Date.parse('2026-11-26T12:00:00Z');
const TODAY = '2026-11-26';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Sample = Record<string, unknown>;
const night = (day: string, value: number, over: Sample = {}): Sample[] => [
  { signal: 'sleep_duration', day, start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T06:30:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value, method: 'asleep_duration', ...over },
  { signal: 'sleep_midpoint', day, start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T06:30:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 165, method: 'sleep_midpoint', ...over },
  { signal: 'overnight_hrv', day, start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T06:30:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 52, method: 'rmssd', ...over },
  { signal: 'resting_heart_rate', day, start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T06:30:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 55, method: 'provider_resting_daily', ...over },
];
const nights = (count: number, value: number, over: Sample = {}) => Array.from({ length: count }, (_, i) => night(addDays(TODAY, -i), value, over)).flat();
const body = (sources: Readonly<Record<string, Sample[]>>) => ({
  access: 'granted', read_at: '2026-11-26T12:00:00.000Z',
  sources: Object.entries(sources).map(([source, samples]) => ({ source, consent_epoch: 1, truncated: false, samples })),
});
const series = (sources: Readonly<Record<string, Sample[]>>): Series => {
  const parsed = parseSeries(body(sources));
  if (parsed.kind !== 'series') throw new Error('fixture did not parse');
  return parsed.series;
};
const ECHO = { whoop_writer: true };
const kinds = (s: Series, source: string) => s.sources.find(entry => entry.source === source)!.readings.map(r => `${r.signal}@${r.day}=${r.value}`).sort();

describe('the WHOOP API record wins over the copy WHOOP\'s app wrote to the phone', () => {
  it('drops a device reading WHOOP\'s app wrote on a day the WHOOP source holds the same kind', () => {
    const deduped = withoutWhoopEcho(series({ apple: night(TODAY, 431, ECHO), whoop: night(TODAY, 430) }));
    expect(kinds(deduped, 'apple')).toEqual([]);
    expect(kinds(deduped, 'whoop')).toHaveLength(4);
  });

  it('keeps what another app wrote, a kind the WHOOP source does not hold that day, and the echo of a day the API has not delivered yet', () => {
    const watch = night(TODAY, 402);
    const steps = [{ signal: 'steps_window', day: TODAY, start_at: `${TODAY}T08:00:00.000Z`, end_at: `${TODAY}T09:00:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 900, ...ECHO }];
    const earlier = night(addDays(TODAY, -1), 444, ECHO);
    const deduped = withoutWhoopEcho(series({ apple: [...watch, ...steps, ...earlier], whoop: night(TODAY, 430) }));
    expect(kinds(deduped, 'apple')).toEqual(expect.arrayContaining([`sleep_duration@${TODAY}=402`, `steps_window@${TODAY}=900`, `sleep_duration@${addDays(TODAY, -1)}=444`]));
    expect(kinds(deduped, 'apple')).toHaveLength(4 + 1 + 4);
  });

  it('changes nothing without a WHOOP source, so an owner who never connected the API keeps what WHOOP\'s app wrote', () => {
    const only = series({ apple: night(TODAY, 431, ECHO) });
    expect(withoutWhoopEcho(only)).toBe(only);
    expect(kinds(withoutWhoopEcho(only), 'apple')).toHaveLength(4);
  });

  it('drops the echo from Health Connect too', () => {
    const deduped = withoutWhoopEcho(series({ health_connect: night(TODAY, 431, ECHO), whoop: night(TODAY, 430) }));
    expect(kinds(deduped, 'health_connect')).toEqual([]);
  });

  it('computes the day from WHOOP, not from Apple Health holding WHOOP\'s copy, though Apple ranks above WHOOP', async () => {
    const writes: Record<string, unknown>[] = [];
    const all = body({ apple: nights(20, 431, ECHO), whoop: nights(20, 430) });
    const deps: ProducerDeps = {
      readSeries: async range => ({ ...all, sources: all.sources.map(source => ({ ...source, samples: source.samples.filter(entry => range.signals.includes(String(entry.signal))) })) }),
      writeContext: async payload => { writes.push(JSON.parse(payload)); return { written: true }; },
      compute: computeDailyScores,
    };
    expect(await produceHealthScores(deps, { now: NOW, timezone: 'UTC' })).toBe('written');
    const today = writes.find(row => row.day === TODAY)!;
    expect(today.basis).toEqual([{ source: 'whoop', consent_epoch: 1 }]);
    // Without the WHOOP source, the same Apple copy is the owner's data and computes the day.
    const appleOnly: Record<string, unknown>[] = [];
    const alone = body({ apple: nights(20, 431, ECHO) });
    await produceHealthScores({ ...deps, readSeries: async range => ({ ...alone, sources: alone.sources.map(source => ({ ...source, samples: source.samples.filter(entry => range.signals.includes(String(entry.signal))) })) }), writeContext: async payload => { appleOnly.push(JSON.parse(payload)); return { written: true }; } }, { now: NOW, timezone: 'UTC' });
    expect(appleOnly.find(row => row.day === TODAY)!.basis).toEqual([{ source: 'apple', consent_epoch: 1 }]);
  });
});
