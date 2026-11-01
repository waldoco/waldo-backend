begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 5: body composition, stand hours and a workout's detail on the series read.
-- Every reading here is synthetic.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.point(id text,sig text,unit text,val numeric,extra jsonb default '{}',minutes int default 1) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal',sig,'unit',unit,'value',val,'day',((now()-make_interval(mins=>minutes+180)) at time zone 'UTC')::date,
    'start_at',pg_temp.iso(now()-make_interval(mins=>minutes+180)),'end_at',pg_temp.iso(now()-interval '180 minutes'),'utc_offset_minutes',0) || extra $$;
-- One whole local hour (UTC), three hours back, so it is over.
create function pg_temp.hour(id text,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','stand_hour','unit','count','value',val,'day',((date_trunc('hour',now())-interval '3 hours') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(date_trunc('hour',now())-interval '3 hours'),'end_at',pg_temp.iso(date_trunc('hour',now())-interval '2 hours'),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,samples jsonb,deletions jsonb default '[]',per_sample boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions',deletions)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.rejected(sig text,idx int,rsn text default 'invalid_sample') returns jsonb language sql as $$
  select jsonb_build_object('change','sample','index',idx,'signal',sig,'reason',rsn) $$;
create function pg_temp.stored(sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='coach-owner' and s.sample_id=sid $$;
create function pg_temp.series(signals jsonb) returns jsonb language sql as $$
  select pg_temp.h('series_read','coach-owner',jsonb_build_object('from',((now() at time zone 'UTC')::date-3)::text,'to',((now() at time zone 'UTC')::date+1)::text,'signals',signals)) $$;
insert into auth.users(id,email) values ('3c100000-0000-0000-0000-0000000000c1','coach@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('3c300000-0000-0000-0000-0000000000c3','3c100000-0000-0000-0000-0000000000c1','coach-owner','coach@example.invalid');
select pg_temp.h('consent_grant','coach-owner',jsonb_build_object('request_id','grant-coach-st1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true));

-- Every new signal is stored, and a workout keeps its detail.
select is(pg_temp.h('ingest','coach-owner',pg_temp.batch('coach-all-000001',jsonb_build_array(
  pg_temp.point('mass','body_mass','kilograms',72.4),
  pg_temp.point('fat','body_fat_percentage','percent',14.2),
  pg_temp.point('lean','lean_body_mass','kilograms',61.9),
  pg_temp.hour('stood',1),
  pg_temp.point('run','workout','minutes',58,'{"activity":"running","energy_kcal":640,"distance_m":12400,"avg_hr_bpm":152,"max_hr_bpm":181,"hr_zones":{"basis":"heart_rate_reserve","lower_bounds_bpm":[120,136,151,166],"seconds":[300,900,1500,600,180]},"effort":{"score":7,"method":"rated"},"running":{"cadence_spm":176},"origin":{"read_api":"healthkit","source_bundle_id":"com.example.watch","source_package_name":null,"source_version":null,"source_revision":null,"device_ref":"synthetic-watch-1","recording_method":"automatic"}}',58),
  pg_temp.point('walk','workout','minutes',20,'{"activity":"walking"}',20))))->>'accepted','6','an older build''s batch of the new signals and two workouts is stored whole');
select is(pg_temp.stored('run')->'hr_zones'->'seconds','[300,900,1500,600,180]'::jsonb,'a workout''s zones are stored as sent');
select is(pg_temp.stored('run')->'origin'->>'device_ref','synthetic-watch-1','a workout''s origin is stored, so the read below has one to leave out');

-- Per sample: each bad new reading is named by its signal.
create temp table mixed as select pg_temp.h('ingest','coach-owner',pg_temp.batch('coach-mixed-0001',jsonb_build_array(
  pg_temp.point('lbs','body_mass','pounds',160),
  pg_temp.point('heavy','body_mass','kilograms',401),
  pg_temp.point('ratio','body_fat_percentage','percent',0.14),
  pg_temp.point('lean-low','lean_body_mass','kilograms',9),
  pg_temp.hour('half',0.5),
  pg_temp.point('not-hour','stand_hour','count',1),
  pg_temp.hour('two',2),
  '{"rejected":"invalid_sample","signal":"stand_hour"}'::jsonb,
  pg_temp.hour('idle',0)),'[]',true)) as r;
select is((select r->>'accepted' from mixed),'1','a per-sample batch stores its one good stand hour');
select is((select r->'rejected' from mixed),jsonb_build_array(
  pg_temp.rejected('body_mass',0),pg_temp.rejected('body_mass',1),pg_temp.rejected('body_fat_percentage',2),pg_temp.rejected('lean_body_mass',3),
  pg_temp.rejected('stand_hour',4),pg_temp.rejected('stand_hour',5),pg_temp.rejected('stand_hour',6),pg_temp.rejected('stand_hour',7)),
  'and names every bad one by its signal: pounds, out of bounds, a ratio for a percent, a fraction of an hour, a point record for a window, and the Worker''s own');
select ok(pg_temp.stored('lbs') is null and pg_temp.stored('half') is null and pg_temp.stored('not-hour') is null,'no rejected reading is stored');
select ok((select r from mixed)::text !~ '160|401|0\.14','the receipt carries no value of a rejected reading');
select is(pg_temp.h('ingest','coach-owner',pg_temp.batch('coach-old-bad01',jsonb_build_array(pg_temp.point('o-ok','body_mass','kilograms',70),pg_temp.hour('o-bad',3))))->>'error',
  'invalid_request','an older build''s batch with one bad new reading is refused whole');
select is(pg_temp.stored('o-ok'),null,'and stores nothing');

-- Deletions name the new signals, and the table still refuses a signal outside the list.
select is(pg_temp.h('ingest','coach-owner',pg_temp.batch('coach-del-000001','[]',jsonb_build_array(jsonb_build_object('sample_id','lean','signal','lean_body_mass','revision',2))))->>'deleted',
  '1','a deletion of a new signal removes it');
select throws_ok($$ insert into waldo.health_samples(owner_id,source,signal,sample_id,revision,epoch,payload,deleted_at) values ('3c300000-0000-0000-0000-0000000000c3','apple','blood_glucose','x',1,1,null,now()) $$,
  '23514',null,'the table still refuses a signal outside the list');

-- The series read takes all twenty-three signals and returns a workout's detail, and only a workout's.
select is(pg_temp.series('["sleep_duration","sleep_efficiency","sleep_midpoint","overnight_hrv","resting_heart_rate","daylight_duration","movement_duration","heart_rate_window","hrv_window","spo2","respiratory_rate","steps_window","active_energy_window","workout","wrist_temperature","walking_heart_rate_average","vo2_max","heart_rate_recovery","mindful_duration","body_mass","body_fat_percentage","lean_body_mass","stand_hour"]')->>'access',
  'granted','the series read takes all twenty-three signals in one call');
select is((select s->'workout' from jsonb_array_elements(pg_temp.series('["workout"]')->'sources'->0->'samples') s where s->>'activity' = 'running'),
  '{"energy_kcal":640,"distance_m":12400,"avg_hr_bpm":152,"max_hr_bpm":181,"hr_zones":{"basis":"heart_rate_reserve","lower_bounds_bpm":[120,136,151,166],"seconds":[300,900,1500,600,180]},"effort":{"score":7,"method":"rated"},"running":{"cadence_spm":176}}'::jsonb,
  'a workout comes back with its detail');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.series('["workout"]')->'sources'->0->'samples') s where s->>'activity' = 'walking' and s ? 'workout'),
  'a workout with no detail has no workout key');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.series('["body_mass","stand_hour","sleep_duration"]')->'sources'->0->'samples') s where s ? 'workout'),
  'nor does any other signal');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.series('["workout"]')->'sources'->0->'samples') s where s::text like '%synthetic-watch-1%' or s::text like '%com.example.watch%'),
  'the read carries no part of a workout''s origin');
select is((select jsonb_agg(s->'value' order by s->>'signal', (s->>'value')::numeric desc) from jsonb_array_elements(pg_temp.series('["body_mass","body_fat_percentage","stand_hour"]')->'sources'->0->'samples') s),
  '[14.2,72.4,1,0]'::jsonb,'body composition and stand hours come back as readings');

-- Health revision 6: zones set from the highest heart rate seen in a workout are stored and read back with that basis.
select is(pg_temp.h('ingest','coach-owner',pg_temp.batch('coach-peak-00001',jsonb_build_array(pg_temp.point('ride','workout','minutes',45,
  '{"activity":"cycling","hr_zones":{"basis":"observed_workout_peak","lower_bounds_bpm":[110,125,140,155],"seconds":[600,900,900,300,0]}}',45)),'[]',true))->>'accepted',
  '1','a workout whose zones were set from an observed peak is stored');
select is((select s->'workout'->'hr_zones'->>'basis' from jsonb_array_elements(pg_temp.series('["workout"]')->'sources'->0->'samples') s where s->>'activity' = 'cycling'),
  'observed_workout_peak','and the series read gives the producer its basis');

select * from finish();
rollback;
