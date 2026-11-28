begin;
create extension if not exists pgtap with schema extensions;
select plan(22);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 16: every kind WHOOP's API gives, and WHOOP's consent copy 6. Every value here is synthetic.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.grant_body(rid text,src text,purpose text,ver int) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',ver,'expected_epoch',0,'age_attested_18_plus',true) $$;
-- A reading of one night that ended two hours ago, on its waking day in UTC.
create function pg_temp.r(id text,signal text,unit text,val numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint - 60,'signal',signal,'unit',unit,'value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0) || extra $$;
create function pg_temp.batch(rid text,src text,samples jsonb,per_sample boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions','[]'::jsonb)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.stored(owner text,sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name=owner and s.sample_id=sid $$;
create function pg_temp.series(owner text,signals jsonb) returns jsonb language sql as $$
  select pg_temp.h('series_read',owner,jsonb_build_object('from',((now() at time zone 'UTC')::date-2)::text,'to',((now() at time zone 'UTC')::date)::text,'signals',signals)) $$;
create function pg_temp.read(owner text,src text,signal text) returns jsonb language sql as $$
  select s from jsonb_array_elements(pg_temp.series(owner,jsonb_build_array(signal))->'sources') x, jsonb_array_elements(x->'samples') s where x->>'source'=src and s->>'signal'=signal limit 1 $$;

insert into auth.users(id,email) values
 ('d1000000-0000-0000-0000-0000000000d1','whoop-six@example.invalid'),
 ('d2000000-0000-0000-0000-0000000000d2','whoop-four@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('d3000000-0000-0000-0000-0000000000d3','d1000000-0000-0000-0000-0000000000d1','whoop-six','whoop-six@example.invalid'),
 ('d4000000-0000-0000-0000-0000000000d4','d2000000-0000-0000-0000-0000000000d2','whoop-four','whoop-four@example.invalid');

-- Copy 6 is WHOOP's current copy; copy 4, which an installed build still shows, is still taken; nothing else is.
select is(pg_temp.h('consent_grant','whoop-six',pg_temp.grant_body('depth-g5-00001','whoop','storage_compute',5))->>'error','invalid_request','a WHOOP grant on copy 5 is refused');
select is(pg_temp.h('consent_grant','whoop-six',pg_temp.grant_body('depth-a6-00001','apple','storage_compute',6))->>'error','invalid_request','a device grant on WHOOP''s copy 6 is refused');
select is(pg_temp.h('consent_grant','whoop-six',pg_temp.grant_body('depth-g6-00001','whoop','storage_compute',6))->'consent'->>'version','6','a WHOOP grant on copy 6 is stored on copy 6');
select is(pg_temp.h('consent_grant','whoop-four',pg_temp.grant_body('depth-g4-00001','whoop','storage_compute',4))->'consent'->>'version','4','a WHOOP grant on copy 4 is still taken and stored on copy 4');
select pg_temp.h('consent_grant','whoop-six',pg_temp.grant_body('depth-a2-00001','apple','storage_compute',2));

-- Under copy 6 every new kind is stored.
select is(pg_temp.h('ingest','whoop-six',pg_temp.batch('depth-six-00001','whoop',jsonb_build_array(
  pg_temp.r('whoop:s1:provider_recovery','provider_recovery','percent',61,'{"method":"whoop","calibrating":false}'),
  pg_temp.r('whoop:cycle:9:provider_day_strain','provider_day_strain','strain',11.37,'{"method":"whoop","open":true,"energy_kcal":2199.8,"avg_hr_bpm":68,"max_hr_bpm":172,"step_count":9412}'),
  pg_temp.r('whoop:s1:provider_sleep_need','provider_sleep_need','minutes',490,'{"method":"whoop","baseline_minutes":450,"debt_minutes":35,"strain_minutes":20,"nap_minutes":-15}'),
  pg_temp.r('whoop:s1:provider_sleep_performance','provider_sleep_performance','percent',88,'{"method":"whoop"}'),
  pg_temp.r('whoop:s1:provider_sleep_consistency','provider_sleep_consistency','percent',81,'{"method":"whoop"}'),
  pg_temp.r('whoop:n1:nap','nap','minutes',28,'{"method":"asleep_duration"}'),
  pg_temp.r('whoop:s1:skin_temperature','skin_temperature','celsius',33.2,'{"method":"absolute"}'),
  pg_temp.r('whoop:body:height','height','meters',1.762),
  pg_temp.r('whoop:body:max_heart_rate','max_heart_rate','beats_per_minute',189,'{"method":"provider_estimate"}'),
  pg_temp.r('whoop:s1:sleep_duration','sleep_duration','minutes',430,'{"method":"asleep_duration","stage_totals":{"method":"provider_totals","light":220,"deep":100,"rem":110,"awake":30,"no_data":0,"in_bed":460,"sleep_cycles":4,"disturbances":9}}'),
  pg_temp.r('whoop:w1:workout','workout','minutes',50,'{"activity":"running","strain":{"value":9.4,"method":"whoop"},"percent_recorded":96.5,"elevation_change_m":-3.1,"hr_zones":{"basis":"provider","lower_bounds_bpm":null,"seconds":[300,900,1200,480,120]}}')
)))->>'accepted','11','under copy 6, WHOOP''s scores, a nap, skin temperature, body measurements, stage totals and a workout''s strain are stored');

-- Under copy 4 the readings are stored and WHOOP's own scores, and a workout's strain, are not.
create temp table four as select pg_temp.h('ingest','whoop-four',pg_temp.batch('depth-four-0001','whoop',jsonb_build_array(
  pg_temp.r('whoop:s4:provider_recovery','provider_recovery','percent',61,'{"method":"whoop","calibrating":false}'),
  pg_temp.r('whoop:w4:workout','workout','minutes',50,'{"activity":"running","strain":{"value":9.4,"method":"whoop"}}'),
  pg_temp.r('whoop:s4:skin_temperature','skin_temperature','celsius',33.2,'{"method":"absolute"}'),
  pg_temp.r('whoop:w5:workout','workout','minutes',40,'{"activity":"running"}')),true)) as r;
select is((select r->>'accepted' from four),'2','under copy 4 the readings are stored');
select is((select jsonb_agg(x->>'index' order by x->>'index') from four, jsonb_array_elements(r->'rejected') x),'["0","1"]'::jsonb,'and a WHOOP score and a workout carrying its strain are refused');
select ok(pg_temp.stored('whoop-four','whoop:s4:provider_recovery') is null and pg_temp.stored('whoop-four','whoop:w4:workout') is null,'nothing refused is stored');
select is(pg_temp.h('ingest','whoop-four',pg_temp.batch('depth-four-0002','whoop',jsonb_build_array(
  pg_temp.r('whoop:s4b:provider_recovery','provider_recovery','percent',61,'{"method":"whoop","calibrating":false}'))))->>'error','invalid_request','an all-or-nothing batch with a score under copy 4 is refused whole');

-- A provider score from any other source, without its label or flag, or a new kind on another scale or method, is refused.
create temp table bad as select pg_temp.h('ingest','whoop-six',pg_temp.batch('depth-bad-00001','whoop',jsonb_build_array(
  pg_temp.r('b0','provider_recovery','percent',61,'{"method":"oura","calibrating":false}'),
  pg_temp.r('b1','provider_recovery','percent',61,'{"method":"whoop"}'),
  pg_temp.r('b2','provider_day_strain','strain',22,'{"method":"whoop","open":false}'),
  pg_temp.r('b3','provider_day_strain','strain',12,'{"method":"whoop"}'),
  pg_temp.r('b4','nap','minutes',20,'{"method":"time_in_bed"}'),
  pg_temp.r('b5','skin_temperature','celsius',33,'{"method":"baseline_delta"}'),
  pg_temp.r('b6','height','meters',176),
  pg_temp.r('b7','max_heart_rate','beats_per_minute',189,'{"method":"measured"}'),
  pg_temp.r('b8','provider_sleep_performance','score',88,'{"method":"whoop"}')),true)) as r;
select is((select jsonb_array_length(r->'rejected') from bad),9,'a score labelled for another provider, a missing flag, strain off its scale, and each kind on the wrong scale or method are refused');
select is(pg_temp.h('ingest','whoop-six',pg_temp.batch('depth-apple-0001','apple',jsonb_build_array(
  pg_temp.r('HK:rec','provider_recovery','percent',61,'{"method":"whoop","calibrating":false}')),true))->'rejected'->0->>'reason','invalid_sample','a WHOOP score sent from a device source is refused');

-- The series read returns the parts a reader needs, from fixed key lists, and never the origin.
select is(pg_temp.read('whoop-six','whoop','provider_recovery')->'provider','{"calibrating":false}'::jsonb,'the read returns a recovery score''s calibrating flag');
select is(pg_temp.read('whoop-six','whoop','provider_day_strain')->'provider','{"open":true,"energy_kcal":2199.8,"avg_hr_bpm":68,"max_hr_bpm":172,"step_count":9412}'::jsonb,'a cycle''s open flag, energy, heart rate and steps');
select is(pg_temp.read('whoop-six','whoop','provider_sleep_need')->'provider','{"baseline_minutes":450,"debt_minutes":35,"strain_minutes":20,"nap_minutes":-15}'::jsonb,'and a need''s parts');
select is(pg_temp.read('whoop-six','whoop','sleep_duration')->'stage_totals'->>'disturbances','9','a night''s stage totals');
select is(pg_temp.read('whoop-six','whoop','workout')->'workout'->'strain','{"value":9.4,"method":"whoop"}'::jsonb,'and a workout''s strain');
select is(pg_temp.read('whoop-six','whoop','provider_recovery')->>'method','whoop','each score says whose it is');

-- A reading WHOOP's app wrote to Apple Health is marked, so the Worker can prefer the WHOOP API's own record; the origin never leaves.
select is(pg_temp.h('ingest','whoop-six',pg_temp.batch('depth-echo-0001','apple',jsonb_build_array(
  pg_temp.r('HK:echo','sleep_duration','minutes',428,'{"origin":{"read_api":"healthkit","source_bundle_id":"com.whoop.iphone","source_package_name":null,"source_version":null,"source_revision":null,"device_ref":null,"recording_method":"automatic"}}'),
  pg_temp.r('HK:watch','respiratory_rate','breaths_per_minute',15,'{"origin":{"read_api":"healthkit","source_bundle_id":"com.apple.health.watch","source_package_name":null,"source_version":null,"source_revision":null,"device_ref":null,"recording_method":"automatic"}}'),
  pg_temp.r('HK:lookalike','spo2','percent',96,'{"origin":{"read_api":"healthkit","source_bundle_id":"com.whoopsie.app","source_package_name":null,"source_version":null,"source_revision":null,"device_ref":null,"recording_method":"automatic"}}'))))->>'accepted','3','three Apple readings are stored');
select is(pg_temp.read('whoop-six','apple','sleep_duration')->>'whoop_writer','true','one WHOOP''s app wrote is marked');
select ok(pg_temp.read('whoop-six','apple','respiratory_rate') ? 'whoop_writer' is false and pg_temp.read('whoop-six','apple','spo2') ? 'whoop_writer' is false,'one another app wrote is not, nor one whose bundle only begins with the same letters');
select ok(pg_temp.series('whoop-six','["sleep_duration","respiratory_rate","spo2"]'::jsonb)::text !~ 'com\.whoop|healthkit','the origin itself never leaves');

-- Withdrawing storage removes every WHOOP kind.
select pg_temp.h('consent_withdraw','whoop-six',jsonb_build_object('request_id','depth-withdraw-1','source','whoop','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='whoop-six' and s.source='whoop' and s.payload is not null),0,'withdrawing WHOOP storage removes every WHOOP reading and score');
select * from finish();
rollback;
