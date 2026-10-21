// Synthetic WHOOP API v2 records: the field names and shapes follow the provider's public OpenAPI document, every value is
// invented here. No WHOOP member's data is in any test, fixture or eval (the API terms forbid testing AI with it).
export const sleepRecord = (over: Record<string, unknown> = {}) => ({
  id: '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', cycle_id: 810001, v1_id: 810001, user_id: 70001,
  created_at: '2026-10-20T06:10:00.000Z', updated_at: '2026-10-20T06:40:00.000Z',
  start: '2026-10-19T22:10:00.000Z', end: '2026-10-20T05:50:00.000Z', timezone_offset: '+01:00', nap: false, score_state: 'SCORED',
  score: {
    stage_summary: { total_in_bed_time_milli: 27_600_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 0, total_light_sleep_time_milli: 13_200_000, total_slow_wave_sleep_time_milli: 6_000_000, total_rem_sleep_time_milli: 6_600_000, sleep_cycle_count: 4, disturbance_count: 9 },
    sleep_needed: { baseline_milli: 27_000_000, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
    respiratory_rate: 15.2, sleep_performance_percentage: 88, sleep_consistency_percentage: 81, sleep_efficiency_percentage: 93.5,
  },
  ...over,
});
// The invented readings behind the default recovery, named so the tests can look for them in places they must never reach.
export const SYNTHETIC_RECOVERY = { score: 61, resting: 53, rmssd: 47.318, oxygen: 96.4, skin: 33.2 } as const;
export const recoveryRecord = (over: Record<string, unknown> = {}) => ({
  cycle_id: 810001, sleep_id: '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', user_id: 70001,
  created_at: '2026-10-20T06:10:00.000Z', updated_at: '2026-10-20T06:45:00.000Z', score_state: 'SCORED',
  score: { user_calibrating: false, recovery_score: SYNTHETIC_RECOVERY.score, resting_heart_rate: SYNTHETIC_RECOVERY.resting, hrv_rmssd_milli: SYNTHETIC_RECOVERY.rmssd, spo2_percentage: SYNTHETIC_RECOVERY.oxygen, skin_temp_celsius: SYNTHETIC_RECOVERY.skin },
  ...over,
});
export const workoutRecord = (over: Record<string, unknown> = {}) => ({
  id: '8d2e4b60-1c77-4f3a-9a52-6b0d3e8f1a22', v1_id: 3301, user_id: 70001, created_at: '2026-10-20T12:00:00.000Z', updated_at: '2026-10-20T12:30:00.000Z',
  start: '2026-10-20T11:00:00.000Z', end: '2026-10-20T11:50:00.000Z', timezone_offset: '+01:00', sport_name: 'Running', sport_id: 0, score_state: 'SCORED',
  score: { strain: 9.4, average_heart_rate: 141, max_heart_rate: 172, kilojoule: 1_674, percent_recorded: 100, distance_meter: 8_100, zone_durations: {} },
  ...over,
});
export const webhookBody = (over: Record<string, unknown> = {}) => ({ user_id: 70001, id: '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', type: 'sleep.updated', trace_id: 'a1b2c3d4-0000-4000-8000-00000000aa01', ...over });
