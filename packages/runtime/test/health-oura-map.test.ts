import { describe, expect, it } from 'vitest';
import { healthSampleV1Schema } from '../../contracts/src/app/health-ingest';
import { ouraSleep, ouraSleepSamples } from '../src/health/providers/oura-map';

// Synthetic: the field names follow Oura's public OpenAPI document and every value is invented.
const record = (over: Record<string, unknown> = {}) => ({
  id: 'oura-synthetic-sleep-1', day: '2026-10-20', type: 'long_sleep', bedtime_start: '2026-10-19T23:30:00+02:00', bedtime_end: '2026-10-20T07:10:00+02:00',
  total_sleep_duration: 25_800, time_in_bed: 27_600, efficiency: 93, average_hrv: 44, lowest_heart_rate: 51, average_breath: 14.5, ...over,
});
const samples = (over: Record<string, unknown> = {}) => ouraSleepSamples(ouraSleep(record(over))!, 1_790_000_000);

describe('Oura sleep mapping (a mapper only: nothing connects to Oura)', () => {
  it('maps the main sleep onto the shared signals, on Oura\'s own day and in the record\'s offset', () => {
    const out = samples();
    expect(out.map(s => s.signal)).toEqual(['sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'resting_heart_rate']);
    expect(out[0]).toMatchObject({ value: 430, day: '2026-10-20', utc_offset_minutes: 120, revision: 1_790_000_000, sample_id: 'oura:oura-synthetic-sleep-1:sleep_duration' });
    expect(out[1]!.value).toBe(200);
    expect(out[2]!.value).toBe(0.93);
    for (const sample of out) expect(healthSampleV1Schema.safeParse(sample).success, sample.signal).toBe(true);
  });

  it('does not read average_hrv as RMSSD or SDNN, since Oura states neither, so no HRV baseline is ever mixed', () => {
    expect(samples().map(s => s.signal)).not.toContain('overnight_hrv');
    expect(samples({ average_hrv: 90 }).map(s => s.signal)).not.toContain('overnight_hrv');
  });

  it('gives no reading for a nap, a rest period, a deleted record or a missing figure', () => {
    for (const type of ['late_nap', 'rest', 'sleep', 'deleted']) expect(samples({ type }), type).toEqual([]);
    expect(samples({ total_sleep_duration: null }).map(s => s.signal)).toEqual(['resting_heart_rate']);
    expect(samples({ total_sleep_duration: 0, lowest_heart_rate: 0 })).toEqual([]);
    expect(samples({ bedtime_end: '2026-10-20T05:10:00' })).toEqual([]);
  });

  it('reads only what has the documented shape', () => {
    for (const bad of [null, [], {}, record({ id: 5 }), record({ day: 'today' }), record({ bedtime_start: 'x' })]) expect(ouraSleep(bad), JSON.stringify(bad)).toBeNull();
  });
});
