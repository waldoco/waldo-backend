begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

-- After every migration, each reading kind and source the health contract declares (packages/contracts/src/app/health-ingest.ts,
-- healthSignalV1Schema and healthSourceV1Schema) is still taken by the samples table's checks, the ingest function and the
-- series read. The lists below are the contract's; packages/runtime/test/health-contract-kinds-conformance.test.ts fails until
-- they are regenerated whenever the contract grows. A migration that re-creates one of these from an older copy fails here.
create function pg_temp.missing(p_def text, p_kinds text[]) returns text[] language sql as $$
  select coalesce(array_agg(k order by k), '{}'::text[]) from unnest(p_kinds) k where position(quote_literal(k) in p_def) = 0
$$;
create function pg_temp.check_def(p_name text) returns text language sql as $$
  select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'waldo.health_samples'::regclass and c.conname = p_name
$$;
create function pg_temp.kinds() returns table (v_signals text[], v_sources text[]) language plpgsql as $$
declare
  v_signals constant text[] := array['sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout','wrist_temperature','walking_heart_rate_average','vo2_max','heart_rate_recovery','mindful_duration','body_mass','body_fat_percentage','lean_body_mass','stand_hour','nutrition','heart_rate_bins_window','provider_recovery','provider_day_strain','provider_sleep_need','provider_sleep_performance','provider_sleep_consistency','nap','skin_temperature','height','max_heart_rate'];
  v_sources constant text[] := array['apple','samsung','health_connect','whoop'];
begin
  return query select v_signals, v_sources;
end $$;

select is(pg_temp.missing(pg_temp.check_def('health_samples_signal_check'), (select v_signals from pg_temp.kinds())), '{}'::text[],
  'the samples table takes every signal the contract declares');
select is(pg_temp.missing(pg_temp.check_def('health_samples_source_check'), (select v_sources from pg_temp.kinds())), '{}'::text[],
  'the samples table takes every source the contract declares');
select is(pg_temp.missing(pg_get_functiondef('waldo.health_ingest(text,text,bigint,text)'::regprocedure), (select v_signals from pg_temp.kinds())), '{}'::text[],
  'health_ingest names every signal the contract declares');
select is(pg_temp.missing(pg_get_functiondef('waldo.health_ingest(text,text,bigint,text)'::regprocedure), (select v_sources from pg_temp.kinds())), '{}'::text[],
  'health_ingest names every source the contract declares');
select is(pg_temp.missing(pg_get_functiondef('waldo.health_series_read(text,text,bigint,text)'::regprocedure), (select v_signals from pg_temp.kinds())), '{}'::text[],
  'health_series_read names every signal the contract declares');

select * from finish();
rollback;
