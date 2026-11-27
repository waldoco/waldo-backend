import { HEALTH_PROVIDER_SCORE_SIGNALS_V1, healthSleepStageTotalsV1Schema, type HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';

// WHOOP API v2 records mapped onto the same normalized samples HealthKit and Health Connect produce, plus the kinds only a
// provider sends (health revision 16). Pure: no I/O, no clock. A field the provider has not scored, or does not state,
// produces no sample, never a zero, so the score producer reads the day as missing. A sample's revision is the record's own
// updated_at in epoch seconds, so an older page of a backfill can never overwrite a newer webhook fetch of the same record.
// WHOOP's own scores are labelled method 'whoop' and land in provider_* kinds, which Waldo's own Recovery, Form and Load
// never read.
export type WhoopScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
type Need = Readonly<{ baseline: number; debt: number; strain: number; nap: number }>;
type Stages = Readonly<{ light: number; slow_wave: number; rem: number; in_bed: number | null; awake: number | null; no_data: number | null; cycles: number | null; disturbances: number | null }>;
export type WhoopSleep = Readonly<{
  id: string; cycle_id: number; updated_at: string; start: string; end: string; timezone_offset: string; nap: boolean; score_state: WhoopScoreState;
  score: Readonly<{ stage_summary: Stages; efficiency: number | null; respiratory_rate: number | null; performance: number | null; consistency: number | null; need: Need | null }> | null;
}>;
export type WhoopRecovery = Readonly<{
  cycle_id: number; sleep_id: string; updated_at: string; score_state: WhoopScoreState;
  score: Readonly<{ recovery_score: number | null; calibrating: boolean | null; resting_heart_rate: number | null; hrv_rmssd_milli: number | null; spo2_percentage: number | null; skin_temp_celsius: number | null }> | null;
}>;
type Zones = readonly [number, number, number, number, number, number];
export type WhoopWorkout = Readonly<{
  id: string; updated_at: string; start: string; end: string; timezone_offset: string; sport_name: string; score_state: WhoopScoreState;
  score: Readonly<{
    kilojoule: number | null; strain: number | null; average_heart_rate: number | null; max_heart_rate: number | null; percent_recorded: number | null;
    distance_meter: number | null; altitude_gain_meter: number | null; altitude_change_meter: number | null; zone_milli: Zones | null;
  }> | null;
}>;
// A physiological cycle: WHOOP's day, from one sleep's start to the next. It has no end while the owner is in it.
export type WhoopCycle = Readonly<{
  id: number; updated_at: string; start: string; end: string | null; timezone_offset: string; score_state: WhoopScoreState; step_count: number | null;
  score: Readonly<{ strain: number; kilojoule: number | null; average_heart_rate: number | null; max_heart_rate: number | null }> | null;
}>;
export type WhoopBody = Readonly<{ height_meter: number | null; weight_kilogram: number | null; max_heart_rate: number | null }>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const state = (value: unknown): WhoopScoreState | null => (value === 'SCORED' || value === 'PENDING_SCORE' || value === 'UNSCORABLE' ? value : null);
const id = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null);

// The provider's answers are parsed here and nowhere else, field by field. One that does not fit is null, so a record
// the shape rules cannot place is never guessed at.
export const whoopSleep = (raw: unknown): WhoopSleep | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), start = instant(r?.start), end = instant(r?.end), scoreState = state(r?.score_state), sleepId = id(r?.id), cycle = num(r?.cycle_id);
  if (!r || !updated || !start || !end || !scoreState || !sleepId || cycle === null || typeof r.timezone_offset !== 'string' || typeof r.nap !== 'boolean') return null;
  const score = record(r.score), stages = record(score?.stage_summary), needed = record(score?.sleep_needed);
  const light = num(stages?.total_light_sleep_time_milli), slow = num(stages?.total_slow_wave_sleep_time_milli), rem = num(stages?.total_rem_sleep_time_milli);
  const parts = [num(needed?.baseline_milli), num(needed?.need_from_sleep_debt_milli), num(needed?.need_from_recent_strain_milli), num(needed?.need_from_recent_nap_milli)] as const;
  return {
    id: sleepId, cycle_id: cycle, updated_at: updated, start, end, timezone_offset: r.timezone_offset, nap: r.nap, score_state: scoreState,
    score: scoreState === 'SCORED' && light !== null && slow !== null && rem !== null ? {
      stage_summary: {
        light, slow_wave: slow, rem, in_bed: num(stages?.total_in_bed_time_milli), awake: num(stages?.total_awake_time_milli), no_data: num(stages?.total_no_data_time_milli),
        cycles: num(stages?.sleep_cycle_count), disturbances: num(stages?.disturbance_count),
      },
      efficiency: num(score?.sleep_efficiency_percentage), respiratory_rate: num(score?.respiratory_rate),
      performance: num(score?.sleep_performance_percentage), consistency: num(score?.sleep_consistency_percentage),
      need: parts.every(part => part !== null) ? { baseline: parts[0]!, debt: parts[1]!, strain: parts[2]!, nap: parts[3]! } : null,
    } : null,
  };
};
export const whoopRecovery = (raw: unknown): WhoopRecovery | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), scoreState = state(r?.score_state), sleepId = id(r?.sleep_id), cycle = num(r?.cycle_id);
  if (!r || !updated || !scoreState || !sleepId || cycle === null) return null;
  const score = record(r.score);
  return {
    cycle_id: cycle, sleep_id: sleepId, updated_at: updated, score_state: scoreState,
    score: scoreState === 'SCORED' && score ? {
      recovery_score: num(score.recovery_score), calibrating: bool(score.user_calibrating), resting_heart_rate: num(score.resting_heart_rate),
      hrv_rmssd_milli: num(score.hrv_rmssd_milli), spo2_percentage: num(score.spo2_percentage), skin_temp_celsius: num(score.skin_temp_celsius),
    } : null,
  };
};
const ZONE_KEYS = ['zone_zero_milli', 'zone_one_milli', 'zone_two_milli', 'zone_three_milli', 'zone_four_milli', 'zone_five_milli'] as const;
export const whoopWorkout = (raw: unknown): WhoopWorkout | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), start = instant(r?.start), end = instant(r?.end), scoreState = state(r?.score_state), workoutId = id(r?.id);
  if (!r || !updated || !start || !end || !scoreState || !workoutId || typeof r.timezone_offset !== 'string' || typeof r.sport_name !== 'string') return null;
  const score = record(r.score), zones = record(score?.zone_durations);
  const zoneMilli = ZONE_KEYS.map(key => num(zones?.[key]));
  return {
    id: workoutId, updated_at: updated, start, end, timezone_offset: r.timezone_offset, sport_name: r.sport_name, score_state: scoreState,
    score: scoreState === 'SCORED' ? {
      kilojoule: num(score?.kilojoule), strain: num(score?.strain), average_heart_rate: num(score?.average_heart_rate), max_heart_rate: num(score?.max_heart_rate),
      percent_recorded: num(score?.percent_recorded), distance_meter: num(score?.distance_meter), altitude_gain_meter: num(score?.altitude_gain_meter),
      altitude_change_meter: num(score?.altitude_change_meter), zone_milli: zoneMilli.every(milli => milli !== null && milli >= 0) ? zoneMilli as unknown as Zones : null,
    } : null,
  };
};
export const whoopCycle = (raw: unknown): WhoopCycle | null => {
  const r = record(raw);
  const updated = instant(r?.updated_at), start = instant(r?.start), scoreState = state(r?.score_state), cycleId = num(r?.id);
  const end = r?.end === undefined || r?.end === null ? null : instant(r.end);
  if (!r || !updated || !start || !scoreState || cycleId === null || !Number.isSafeInteger(cycleId) || typeof r.timezone_offset !== 'string' || (r.end != null && end === null)) return null;
  const score = record(r.score), strain = num(score?.strain);
  return {
    id: cycleId, updated_at: updated, start, end, timezone_offset: r.timezone_offset, score_state: scoreState, step_count: num(r.step_count),
    score: scoreState === 'SCORED' && strain !== null ? { strain, kilojoule: num(score?.kilojoule), average_heart_rate: num(score?.average_heart_rate), max_heart_rate: num(score?.max_heart_rate) } : null,
  };
};
export const whoopBody = (raw: unknown): WhoopBody | null => {
  const r = record(raw);
  return r ? { height_meter: num(r.height_meter), weight_kilogram: num(r.weight_kilogram), max_heart_rate: num(r.max_heart_rate) } : null;
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
const PLACES = 2;
const RMSSD_PLACES = 3;
const round = (value: number, places = PLACES): number => Math.round(value * 10 ** places) / 10 ** places;
const minutesOf = (milli: number): number => round(milli / MIN);
const between = (value: number | null, low: number, high: number): value is number => value !== null && value >= low && value <= high;
const kcalOf = (kilojoule: number | null): number | null => (kilojoule !== null && kilojoule >= 0 && kilojoule / 4.184 <= 30_000 ? round(kilojoule / 4.184, 1) : null);
const bpm = (value: number | null): number | undefined => (between(value, 1, 300) ? value : undefined);
// Average and maximum heart rate only as a pair that can be one session, or each alone.
const heartRates = (average: number | null, max: number | null) => {
  const avg = bpm(average), top = bpm(max);
  return avg !== undefined && top !== undefined && avg > top ? {} : { ...(avg === undefined ? {} : { avg_hr_bpm: avg }), ...(top === undefined ? {} : { max_hr_bpm: top }) };
};

type Base = Readonly<{ day: string; utc_offset_minutes: number; start_at: string; end_at: string }>;

// A night's stage totals as WHOOP gives them, without the intervals behind them: only when every total is stated and they fit
// the night, so a partial or impossible set is left off and the time-asleep reading stands alone.
const stageTotals = (stages: Stages) => {
  const totals = {
    method: 'provider_totals' as const, light: minutesOf(stages.light), deep: minutesOf(stages.slow_wave), rem: minutesOf(stages.rem),
    awake: stages.awake === null ? -1 : minutesOf(stages.awake), no_data: stages.no_data === null ? -1 : minutesOf(stages.no_data), in_bed: stages.in_bed === null ? -1 : minutesOf(stages.in_bed),
    sleep_cycles: stages.cycles ?? -1, disturbances: stages.disturbances ?? -1,
  };
  return healthSleepStageTotalsV1Schema.safeParse(totals).success ? { stage_totals: totals } : {};
};

// The night a main sleep and its recovery describe, placed on the waking day in the record's own offset. A nap is not the
// night (whoopNapSamples); a sleep that is not scored gives no sleep reading; a recovery that is not scored, or belongs to
// another sleep, gives no recovery reading.
export const whoopNightSamples = (night: Readonly<{ sleep: WhoopSleep; recovery: WhoopRecovery | null }>): HealthSampleV1[] => {
  const { sleep, recovery } = night;
  const offset = offsetMinutes(sleep.timezone_offset);
  if (sleep.nap || offset === null) return [];
  const start = Date.parse(sleep.start), end = Date.parse(sleep.end);
  if (!(start < end)) return [];
  const base: Base = { day: localDayOf(end, offset), utc_offset_minutes: offset, start_at: sleep.start, end_at: sleep.end };
  const out: HealthSampleV1[] = [];
  const at = (signal: string) => `whoop:${sleep.id}:${signal}`;
  if (sleep.score) {
    const score = sleep.score;
    const { light, slow_wave, rem } = score.stage_summary;
    const asleep = (light + slow_wave + rem) / MIN;
    const revision = epochSeconds(sleep.updated_at);
    if (asleep > 0 && asleep <= DAY_MIN) {
      const midpoint = (((start + end) / 2 + offset * MIN) % (DAY_MIN * MIN) + DAY_MIN * MIN) % (DAY_MIN * MIN) / MIN;
      out.push({ ...base, sample_id: at('sleep_duration'), revision, signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: round(asleep), ...stageTotals(score.stage_summary) });
      out.push({ ...base, sample_id: at('sleep_midpoint'), revision, signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: Math.min(round(midpoint, 3), 1439.999) });
      if (between(score.efficiency, 0, 100)) out.push({ ...base, sample_id: at('sleep_efficiency'), revision, signal: 'sleep_efficiency', unit: 'ratio', value: round(score.efficiency / 100, 4) });
    }
    if (between(score.respiratory_rate, 4, 80)) out.push({ ...base, sample_id: at('respiratory_rate'), revision, signal: 'respiratory_rate', unit: 'breaths_per_minute', value: round(score.respiratory_rate) });
    if (between(score.performance, 0, 100)) out.push({ ...base, sample_id: at('provider_sleep_performance'), revision, signal: 'provider_sleep_performance', unit: 'percent', method: 'whoop', value: round(score.performance) });
    if (between(score.consistency, 0, 100)) out.push({ ...base, sample_id: at('provider_sleep_consistency'), revision, signal: 'provider_sleep_consistency', unit: 'percent', method: 'whoop', value: round(score.consistency) });
    if (score.need) {
      const parts = { baseline_minutes: minutesOf(score.need.baseline), debt_minutes: minutesOf(score.need.debt), strain_minutes: minutesOf(score.need.strain), nap_minutes: minutesOf(score.need.nap) };
      const total = round(parts.baseline_minutes + parts.debt_minutes + parts.strain_minutes + parts.nap_minutes);
      if (between(total, 0, DAY_MIN) && between(parts.baseline_minutes, 0, DAY_MIN) && between(parts.debt_minutes, -DAY_MIN, DAY_MIN) && between(parts.strain_minutes, 0, DAY_MIN) && between(parts.nap_minutes, -DAY_MIN, 0)) {
        out.push({ ...base, sample_id: at('provider_sleep_need'), revision, signal: 'provider_sleep_need', unit: 'minutes', method: 'whoop', value: total, ...parts });
      }
    }
  }
  if (recovery?.score && recovery.sleep_id === sleep.id) {
    const revision = epochSeconds(recovery.updated_at);
    const { hrv_rmssd_milli: rmssd, resting_heart_rate: resting, spo2_percentage: oxygen, recovery_score: score, calibrating, skin_temp_celsius: skin } = recovery.score;
    if (rmssd !== null && rmssd > 0 && rmssd <= 1000) out.push({ ...base, sample_id: at('overnight_hrv'), revision, signal: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: round(rmssd, RMSSD_PLACES) });
    if (resting !== null && resting > 0 && resting <= 300) out.push({ ...base, sample_id: at('resting_heart_rate'), revision, signal: 'resting_heart_rate', unit: 'beats_per_minute', method: 'provider_resting_daily', value: round(resting) });
    if (between(oxygen, 50, 100)) out.push({ ...base, sample_id: at('spo2'), revision, signal: 'spo2', unit: 'percent', value: round(oxygen) });
    if (between(score, 0, 100) && calibrating !== null) out.push({ ...base, sample_id: at('provider_recovery'), revision, signal: 'provider_recovery', unit: 'percent', method: 'whoop', value: round(score), calibrating });
    if (between(skin, 25, 42)) out.push({ ...base, sample_id: at('skin_temperature'), revision, signal: 'skin_temperature', unit: 'celsius', method: 'absolute', value: round(skin) });
  }
  return out;
};

// A nap is its own session on the day it started, never the night: the minutes asleep WHOOP scored, or its span while unscored.
export const whoopNapSamples = (sleep: WhoopSleep): HealthSampleV1[] => {
  const offset = offsetMinutes(sleep.timezone_offset);
  const start = Date.parse(sleep.start), end = Date.parse(sleep.end);
  if (!sleep.nap || offset === null || !(start < end) || end - start > DAY_MIN * MIN) return [];
  const stages = sleep.score?.stage_summary;
  const asleep = stages ? (stages.light + stages.slow_wave + stages.rem) / MIN : 0;
  return [{
    day: localDayOf(start, offset), utc_offset_minutes: offset, start_at: sleep.start, end_at: sleep.end, sample_id: `whoop:${sleep.id}:nap`, revision: epochSeconds(sleep.updated_at),
    signal: 'nap', unit: 'minutes', ...(asleep > 0 ? { method: 'asleep_duration' as const, value: round(asleep) } : { method: 'span' as const, value: round((end - start) / MIN) }),
  }];
};

const SPORT = /[^a-z0-9 _-]/g;
// A workout's minutes from the record's own span, on the day it started in its own offset, and what WHOOP scored for it:
// energy, heart rate, distance, altitude, its strain and recorded share, and time in its five heart-rate zones (WHOOP's zone
// zero, very light activity, folds into zone 1, and its zones have no bounds Waldo can state).
export const whoopWorkoutSamples = (workout: WhoopWorkout): HealthSampleV1[] => {
  const offset = offsetMinutes(workout.timezone_offset);
  const start = Date.parse(workout.start), end = Date.parse(workout.end);
  const minutes = (end - start) / MIN;
  const activity = workout.sport_name.toLowerCase().replace(SPORT, '').trim().slice(0, 64);
  if (offset === null || !(minutes > 0) || minutes > DAY_MIN || !activity) return [];
  const score = workout.score;
  const kcal = kcalOf(score?.kilojoule ?? null);
  const zones = score?.zone_milli ? [score.zone_milli[0] + score.zone_milli[1], ...score.zone_milli.slice(2)].map(milli => Math.round(milli / 1000)) : null;
  const zonesFit = zones !== null && zones.every(seconds => seconds <= 86_400) && zones.reduce((a, b) => a + b, 0) <= (end - start) / 1000 + 60;
  return [{
    day: localDayOf(start, offset), utc_offset_minutes: offset, start_at: workout.start, end_at: workout.end, sample_id: `whoop:${workout.id}:workout`, revision: epochSeconds(workout.updated_at),
    signal: 'workout', unit: 'minutes', activity, value: round(minutes),
    ...(kcal === null ? {} : { energy_kcal: kcal }),
    ...(score ? heartRates(score.average_heart_rate, score.max_heart_rate) : {}),
    ...(between(score?.distance_meter ?? null, 0, 1_000_000) ? { distance_m: round(score!.distance_meter!) } : {}),
    ...(between(score?.altitude_gain_meter ?? null, 0, 20_000) ? { elevation_gain_m: round(score!.altitude_gain_meter!) } : {}),
    ...(between(score?.altitude_change_meter ?? null, -20_000, 20_000) ? { elevation_change_m: round(score!.altitude_change_meter!) } : {}),
    ...(between(score?.percent_recorded ?? null, 0, 100) ? { percent_recorded: round(score!.percent_recorded!) } : {}),
    ...(between(score?.strain ?? null, 0, 21) ? { strain: { value: round(score!.strain!), method: 'whoop' as const } } : {}),
    ...(zonesFit ? { hr_zones: { basis: 'provider' as const, lower_bounds_bpm: null, seconds: zones as [number, number, number, number, number] } } : {}),
  }];
};

const HOUR_MS = 3_600_000;
// A cycle's strain on the owner's day: the waking day of the sleep that opens it, read as the local day twelve hours after its
// start, never outside the days the cycle spans. An open cycle ends, for now, when WHOOP last scored it, so the same revision
// always carries the same reading.
export const whoopCycleSamples = (cycle: WhoopCycle): HealthSampleV1[] => {
  const offset = offsetMinutes(cycle.timezone_offset);
  const end = cycle.end ?? cycle.updated_at;
  const startMs = Date.parse(cycle.start), endMs = Date.parse(end);
  if (!cycle.score || offset === null || !(startMs <= endMs) || endMs - startMs > 3 * DAY_MIN * MIN || !between(cycle.score.strain, 0, 21)) return [];
  const first = localDayOf(startMs, offset), last = localDayOf(endMs, offset), noon = localDayOf(startMs + 12 * HOUR_MS, offset);
  const kcal = kcalOf(cycle.score.kilojoule);
  return [{
    day: noon > last ? last : noon < first ? first : noon, utc_offset_minutes: offset, start_at: cycle.start, end_at: end, sample_id: `whoop:cycle:${cycle.id}:provider_day_strain`,
    revision: epochSeconds(cycle.updated_at), signal: 'provider_day_strain', unit: 'strain', method: 'whoop', value: round(cycle.score.strain), open: cycle.end === null,
    ...(kcal === null ? {} : { energy_kcal: kcal }),
    ...heartRates(cycle.score.average_heart_rate, cycle.score.max_heart_rate),
    ...(cycle.step_count !== null && Number.isInteger(cycle.step_count) && between(cycle.step_count, 0, 300_000) ? { step_count: cycle.step_count } : {}),
  }];
};

// The owner's offset from UTC in their zone at an instant, in minutes.
const zoneOffset = (timeZone: string, at: number): number => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((local - Math.floor(at / MIN) * MIN) / MIN);
};
// The body measurements WHOOP holds for the owner, as of this read: one rolling reading each, revised at the read, so the
// newest read is the one kept. They are WHOOP's profile values (height and weight as entered, the maximum heart rate WHOOP
// estimates), with no time of their own.
export const whoopBodySamples = (body: WhoopBody, at: number, timeZone: string): HealthSampleV1[] => {
  let offset: number;
  try { offset = zoneOffset(timeZone, at); } catch { offset = 0; }
  const when = new Date(Math.floor(at / 1000) * 1000).toISOString();
  const base = { day: localDayOf(at, offset), utc_offset_minutes: offset, start_at: when, end_at: when, revision: Math.floor(at / 1000) };
  const out: HealthSampleV1[] = [];
  if (between(body.weight_kilogram, 20, 400)) out.push({ ...base, sample_id: 'whoop:body:body_mass', signal: 'body_mass', unit: 'kilograms', value: round(body.weight_kilogram) });
  if (between(body.height_meter, 0.5, 2.75)) out.push({ ...base, sample_id: 'whoop:body:height', signal: 'height', unit: 'meters', value: round(body.height_meter, 3) });
  if (between(body.max_heart_rate, 100, 250)) out.push({ ...base, sample_id: 'whoop:body:max_heart_rate', signal: 'max_heart_rate', unit: 'beats_per_minute', method: 'provider_estimate', value: round(body.max_heart_rate) });
  return out;
};

// WHOOP's own scores, kept only under a storage grant on the copy that names them: the provider_* kinds and a workout's strain.
const SCORE_SIGNALS: readonly string[] = HEALTH_PROVIDER_SCORE_SIGNALS_V1;
export const withoutProviderScores = (samples: readonly HealthSampleV1[]): HealthSampleV1[] => samples.flatMap(sample => {
  if (SCORE_SIGNALS.includes(sample.signal)) return [];
  if (sample.signal === 'workout' && sample.strain !== undefined) { const { strain: _strain, ...rest } = sample; return [rest]; }
  return [sample];
});

const RECOVERY_SIGNALS = ['overnight_hrv', 'resting_heart_rate', 'spo2', 'provider_recovery', 'skin_temperature'] as const;
const SLEEP_SIGNALS = ['sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'respiratory_rate', 'provider_sleep_performance', 'provider_sleep_consistency', 'provider_sleep_need', 'nap', ...RECOVERY_SIGNALS] as const;
export type WhoopDeletion = Readonly<{ sample_id: string; signal: (typeof SLEEP_SIGNALS)[number] | 'workout'; revision: number }>;
// A deleted record removes every reading it produced, a nap's included. The deletion's revision is the time WHOOP said so,
// which is never below the record's own updated_at. A recovery's id is its sleep's, so its readings carry the sleep's id.
export const whoopDeletions = (kind: 'sleep' | 'recovery' | 'workout', recordId: string, deletedAtSeconds: number): WhoopDeletion[] =>
  kind === 'workout'
    ? [{ sample_id: `whoop:${recordId}:workout`, signal: 'workout', revision: deletedAtSeconds }]
    : (kind === 'sleep' ? SLEEP_SIGNALS : RECOVERY_SIGNALS).map(signal => ({ sample_id: `whoop:${recordId}:${signal}`, signal, revision: deletedAtSeconds }));
