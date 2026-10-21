import type { HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';

// WHOOP API v2 records mapped onto the same normalized samples HealthKit and Health Connect produce. Pure: no I/O, no
// clock. A field the provider has not scored, or does not state, produces no sample, never a zero, so the score producer
// reads the day as missing. A sample's revision is the record's own updated_at in epoch seconds, so an older page of a
// backfill can never overwrite a newer webhook fetch of the same record.
export type WhoopScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
export type WhoopSleep = Readonly<{
  id: string; cycle_id: number; updated_at: string; start: string; end: string; timezone_offset: string; nap: boolean; score_state: WhoopScoreState;
  score: Readonly<{ stage_summary: Readonly<{ light: number; slow_wave: number; rem: number }>; efficiency: number | null }> | null;
}>;
export type WhoopRecovery = Readonly<{
  cycle_id: number; sleep_id: string; updated_at: string; score_state: WhoopScoreState;
  score: Readonly<{ resting_heart_rate: number | null; hrv_rmssd_milli: number | null; spo2_percentage: number | null }> | null;
}>;
export type WhoopWorkout = Readonly<{
  id: string; updated_at: string; start: string; end: string; timezone_offset: string; sport_name: string; score_state: WhoopScoreState;
  score: Readonly<{ kilojoule: number | null }> | null;
}>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const state = (value: unknown): WhoopScoreState | null => (value === 'SCORED' || value === 'PENDING_SCORE' || value === 'UNSCORABLE' ? value : null);
const id = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null);

// The provider's answers are parsed here and nowhere else, field by field. One that does not fit is null, so a record
// the shape rules cannot place is never guessed at.
export const whoopSleep = (raw: unknown): WhoopSleep | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), start = instant(r?.start), end = instant(r?.end), scoreState = state(r?.score_state), sleepId = id(r?.id), cycle = num(r?.cycle_id);
  if (!r || !updated || !start || !end || !scoreState || !sleepId || cycle === null || typeof r.timezone_offset !== 'string' || typeof r.nap !== 'boolean') return null;
  const score = record(r.score), stages = record(score?.stage_summary);
  const light = num(stages?.total_light_sleep_time_milli), slow = num(stages?.total_slow_wave_sleep_time_milli), rem = num(stages?.total_rem_sleep_time_milli);
  return {
    id: sleepId, cycle_id: cycle, updated_at: updated, start, end, timezone_offset: r.timezone_offset, nap: r.nap, score_state: scoreState,
    score: scoreState === 'SCORED' && light !== null && slow !== null && rem !== null ? { stage_summary: { light, slow_wave: slow, rem }, efficiency: num(score?.sleep_efficiency_percentage) } : null,
  };
};
export const whoopRecovery = (raw: unknown): WhoopRecovery | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), scoreState = state(r?.score_state), sleepId = id(r?.sleep_id), cycle = num(r?.cycle_id);
  if (!r || !updated || !scoreState || !sleepId || cycle === null) return null;
  const score = record(r.score);
  return {
    cycle_id: cycle, sleep_id: sleepId, updated_at: updated, score_state: scoreState,
    score: scoreState === 'SCORED' && score ? { resting_heart_rate: num(score.resting_heart_rate), hrv_rmssd_milli: num(score.hrv_rmssd_milli), spo2_percentage: num(score.spo2_percentage) } : null,
  };
};
export const whoopWorkout = (raw: unknown): WhoopWorkout | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), start = instant(r?.start), end = instant(r?.end), scoreState = state(r?.score_state), workoutId = id(r?.id);
  if (!r || !updated || !start || !end || !scoreState || !workoutId || typeof r.timezone_offset !== 'string' || typeof r.sport_name !== 'string') return null;
  return { id: workoutId, updated_at: updated, start, end, timezone_offset: r.timezone_offset, sport_name: r.sport_name, score_state: scoreState, score: scoreState === 'SCORED' ? { kilojoule: num(record(r.score)?.kilojoule) } : null };
};

// "+05:30", "-05:00" or "Z" in minutes; null for anything else or an offset no zone has.
export const offsetMinutes = (offset: string): number | null => {
  if (offset === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return null;
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  return Math.abs(minutes) <= 840 && Number(match[3]) < 60 ? minutes : null;
};
const MIN = 60_000;
const DAY_MIN = 1_440;
const localDayOf = (at: number, offset: number): string => new Date(at + offset * MIN).toISOString().slice(0, 10);
const epochSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

type Base = Readonly<{ day: string; utc_offset_minutes: number; start_at: string; end_at: string }>;

// The night a main sleep and its recovery describe, placed on the waking day in the record's own offset. A nap is not the
// night; a sleep that is not scored gives no sleep reading; a recovery that is not scored, or belongs to another sleep,
// gives no recovery reading.
export const whoopNightSamples = (night: Readonly<{ sleep: WhoopSleep; recovery: WhoopRecovery | null }>): HealthSampleV1[] => {
  const { sleep, recovery } = night;
  const offset = offsetMinutes(sleep.timezone_offset);
  if (sleep.nap || offset === null) return [];
  const start = Date.parse(sleep.start), end = Date.parse(sleep.end);
  if (!(start < end)) return [];
  const base: Base = { day: localDayOf(end, offset), utc_offset_minutes: offset, start_at: sleep.start, end_at: sleep.end };
  const out: HealthSampleV1[] = [];
  if (sleep.score) {
    const { light, slow_wave, rem } = sleep.score.stage_summary;
    const asleep = (light + slow_wave + rem) / MIN;
    const revision = epochSeconds(sleep.updated_at);
    if (asleep > 0 && asleep <= DAY_MIN) {
      const midpoint = (((start + end) / 2 + offset * MIN) % (DAY_MIN * MIN) + DAY_MIN * MIN) % (DAY_MIN * MIN) / MIN;
      out.push({ ...base, sample_id: `whoop:${sleep.id}:sleep_duration`, revision, signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: round(asleep) });
      out.push({ ...base, sample_id: `whoop:${sleep.id}:sleep_midpoint`, revision, signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: Math.min(round(midpoint, 3), 1439.999) });
      const efficiency = sleep.score.efficiency;
      if (efficiency !== null && efficiency >= 0 && efficiency <= 100) out.push({ ...base, sample_id: `whoop:${sleep.id}:sleep_efficiency`, revision, signal: 'sleep_efficiency', unit: 'ratio', value: round(efficiency / 100, 4) });
    }
  }
  if (recovery?.score && recovery.sleep_id === sleep.id) {
    const revision = epochSeconds(recovery.updated_at);
    const { hrv_rmssd_milli: hrv, resting_heart_rate: rhr, spo2_percentage: spo2 } = recovery.score;
    if (hrv !== null && hrv > 0 && hrv <= 1000) out.push({ ...base, sample_id: `whoop:${sleep.id}:overnight_hrv`, revision, signal: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: round(hrv, 3) });
    if (rhr !== null && rhr > 0 && rhr <= 300) out.push({ ...base, sample_id: `whoop:${sleep.id}:resting_heart_rate`, revision, signal: 'resting_heart_rate', unit: 'beats_per_minute', method: 'provider_resting_daily', value: round(rhr, 2) });
    if (spo2 !== null && spo2 >= 50 && spo2 <= 100) out.push({ ...base, sample_id: `whoop:${sleep.id}:spo2`, revision, signal: 'spo2', unit: 'percent', value: round(spo2, 2) });
  }
  return out;
};

const SPORT = /[^a-z0-9 _-]/g;
// Workout minutes from the record's own span, on the day it started in its own offset. Energy only when WHOOP scored it.
export const whoopWorkoutSamples = (workout: WhoopWorkout): HealthSampleV1[] => {
  const offset = offsetMinutes(workout.timezone_offset);
  const start = Date.parse(workout.start), end = Date.parse(workout.end);
  const minutes = (end - start) / MIN;
  const activity = workout.sport_name.toLowerCase().replace(SPORT, '').trim().slice(0, 64);
  if (offset === null || !(minutes > 0) || minutes > DAY_MIN || !activity) return [];
  const kilojoule = workout.score?.kilojoule ?? null;
  const kcal = kilojoule !== null && kilojoule >= 0 ? round(kilojoule / 4.184, 1) : null;
  return [{
    day: localDayOf(start, offset), utc_offset_minutes: offset, start_at: workout.start, end_at: workout.end, sample_id: `whoop:${workout.id}:workout`, revision: epochSeconds(workout.updated_at),
    signal: 'workout', unit: 'minutes', activity, value: round(minutes), ...(kcal !== null && kcal <= 30_000 ? { energy_kcal: kcal } : {}),
  }];
};

const SLEEP_SIGNALS = ['sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'overnight_hrv', 'resting_heart_rate', 'spo2'] as const;
const RECOVERY_SIGNALS = ['overnight_hrv', 'resting_heart_rate', 'spo2'] as const;
export type WhoopDeletion = Readonly<{ sample_id: string; signal: (typeof SLEEP_SIGNALS)[number] | 'workout'; revision: number }>;
// A deleted record removes every reading it produced. The deletion's revision is the time WHOOP said so, which is never
// below the record's own updated_at.
export const whoopDeletions = (kind: 'sleep' | 'recovery' | 'workout', recordId: string, deletedAtSeconds: number): WhoopDeletion[] =>
  kind === 'workout'
    ? [{ sample_id: `whoop:${recordId}:workout`, signal: 'workout', revision: deletedAtSeconds }]
    : (kind === 'sleep' ? SLEEP_SIGNALS : RECOVERY_SIGNALS).map(signal => ({ sample_id: `whoop:${recordId}:${signal}`, signal, revision: deletedAtSeconds }));
