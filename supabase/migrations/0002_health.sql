-- HEY-9 · Supabase schema · 0002 health (raw + derived)
-- Source: WALDO_V1_MASTER_PLAN.md §5 #3-5.
-- Raw biometrics live ONLY here (overview §9, ADR-0002). Written by sync/build-intelligence
-- EFs (service role); clients read own rows via RLS. health_value-lockout: these columns
-- must never appear in DO SQLite, R2, logs, or prompts.

-- §5 #3 — health_daily (source-agnostic, one row per user per day, upserted)
create table health_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  primary_source text not null,           -- apple_watch | whoop | oura | samsung | garmin | manual
  sources_active text[],
  -- Sleep
  sleep_duration_min integer,
  sleep_efficiency real,
  sleep_deep_min integer,
  sleep_rem_min integer,
  sleep_light_min integer,
  sleep_awake_min integer,
  sleep_onset_time time,
  -- HRV
  hrv_overnight_ms real,
  hrv_method text,                        -- rmssd | sdnn | hr_proxy
  hrv_confidence real,                    -- 1.0 HealthKit | 0.8 WHOOP | 0.85 Oura | 0.6 Samsung
  -- Heart rate
  rhr_bpm integer,
  -- Activity
  steps integer,
  active_energy_kcal integer,
  strain_score real,                      -- 0-21, native or TRIMP-computed
  strain_source text,                     -- native | computed
  exercise_min integer,
  vo2max real,
  -- Biometrics / environment
  spo2_avg real,
  resp_rate_avg real,
  skin_temp_deviation real,
  daylight_minutes integer,
  weather_json jsonb,
  aqi integer,
  synced_at timestamptz default now(),
  unique (user_id, date)
);

alter table health_daily enable row level security;
alter table health_daily force row level security;
revoke all on health_daily from anon, authenticated;
grant select on health_daily to authenticated;
create policy health_daily_select_own on health_daily
  for select to authenticated
  using (user_id = app_user_id());

create index idx_health_daily_user_date on health_daily (user_id, date desc);

-- §5 #4 — crs_scores (computed Form/Recovery/Weight + sub-scores, upserted). Re-derivable
-- from health_daily, so retention can drop old rows (ADR-0061). zone enum per ADR-0029.
create table crs_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  score integer not null,                 -- Form 0-100
  zone text not null,                     -- energized | steady | flagging | depleted
  confidence real,
  recovery_score integer,
  weight_score integer,
  load_score real,                        -- 0-21 Day Strain
  sleep_score integer,
  hrv_score integer,
  circadian_score integer,
  motion_score integer,
  stress_score integer,
  rhrts_score integer,
  rrs_score integer,
  wts_score integer,
  so2s_score integer,
  das_score integer,
  pillar_drag_primary text,
  pillar_drag_json jsonb,
  summary text,
  pillars_json jsonb,
  unique (user_id, date)
);

alter table crs_scores enable row level security;
alter table crs_scores force row level security;
revoke all on crs_scores from anon, authenticated;
grant select on crs_scores to authenticated;
create policy crs_scores_select_own on crs_scores
  for select to authenticated
  using (user_id = app_user_id());

create index idx_crs_scores_user_date on crs_scores (user_id, date desc);

-- §5 #5 — user_baselines (30-day rolling EMA, upserted)
create table user_baselines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  computed_at date not null,
  hrv_baseline real,
  rhr_baseline real,
  sleep_baseline real,
  form_baseline real,
  baselines_json jsonb,
  unique (user_id, computed_at)
);

alter table user_baselines enable row level security;
alter table user_baselines force row level security;
revoke all on user_baselines from anon, authenticated;
grant select on user_baselines to authenticated;
create policy user_baselines_select_own on user_baselines
  for select to authenticated
  using (user_id = app_user_id());
