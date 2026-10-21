import type { HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';
import { offsetMinutes } from './whoop-map';

// Oura API v2 sleep mapped onto the shared signals. This is a mapper only: nothing connects to Oura, stores its data or
// accepts it as a source, because the Oura API agreement bars using its data with an AI model outside Oura's own MCP
// server and bars storing it without Oura's written consent. It exists so a decision to add Oura later changes the wiring,
// not the shape. Pure: no I/O, no clock. The caller says when the record was fetched, since a sleep document carries no
// updated_at to revise by.
//
// Oura's `average_hrv` is not mapped. The API documents neither its unit nor its method, and the shared contract takes
// only RMSSD or SDNN, so reading it as one of them would mix two measures in one baseline. Recovery then rests on sleep
// and resting heart rate until Oura states it.
export type OuraSleep = Readonly<{
  id: string; day: string; type: string; bedtime_start: string; bedtime_end: string;
  total_sleep_duration: number | null; efficiency: number | null; lowest_heart_rate: number | null;
}>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

export const ouraSleep = (raw: unknown): OuraSleep | null => {
  const r = record(raw);
  const start = instant(r?.bedtime_start), end = instant(r?.bedtime_end);
  if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || typeof r.type !== 'string' || !start || !end) return null;
  return { id: r.id, day: r.day, type: r.type, bedtime_start: start, bedtime_end: end, total_sleep_duration: num(r.total_sleep_duration), efficiency: num(r.efficiency), lowest_heart_rate: num(r.lowest_heart_rate) };
};

const MIN = 60_000;
const DAY_MS = 1_440 * MIN;
// The offset an ISO timestamp was written in, or null for a bare UTC one.
const offsetOf = (iso: string): number | null => { const match = /(Z|[+-]\d{2}:\d{2})$/.exec(iso); return match ? offsetMinutes(match[1]!) : null; };

export const ouraSleepSamples = (sleep: OuraSleep, fetchedAtSeconds: number): HealthSampleV1[] => {
  const offset = offsetOf(sleep.bedtime_end);
  const start = Date.parse(sleep.bedtime_start), end = Date.parse(sleep.bedtime_end);
  // Only the main sleep is the night; a nap or a rest period is not.
  if (sleep.type !== 'long_sleep' || offset === null || !(start < end)) return [];
  const base = { day: sleep.day, utc_offset_minutes: offset, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), revision: fetchedAtSeconds };
  const out: HealthSampleV1[] = [];
  const asleep = sleep.total_sleep_duration !== null ? sleep.total_sleep_duration / 60 : null;
  if (asleep !== null && asleep > 0 && asleep <= 1_440) {
    const midpoint = ((((start + end) / 2 + offset * MIN) % DAY_MS) + DAY_MS) % DAY_MS / MIN;
    out.push({ ...base, sample_id: `oura:${sleep.id}:sleep_duration`, signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: Math.round(asleep * 100) / 100 });
    out.push({ ...base, sample_id: `oura:${sleep.id}:sleep_midpoint`, signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: Math.min(Math.round(midpoint * 1000) / 1000, 1439.999) });
    if (sleep.efficiency !== null && sleep.efficiency >= 0 && sleep.efficiency <= 100) out.push({ ...base, sample_id: `oura:${sleep.id}:sleep_efficiency`, signal: 'sleep_efficiency', unit: 'ratio', value: Math.round(sleep.efficiency) / 100 });
  }
  if (sleep.lowest_heart_rate !== null && sleep.lowest_heart_rate > 0 && sleep.lowest_heart_rate <= 300) out.push({ ...base, sample_id: `oura:${sleep.id}:resting_heart_rate`, signal: 'resting_heart_rate', unit: 'beats_per_minute', method: 'overnight_resting', value: sleep.lowest_heart_rate });
  return out;
};
