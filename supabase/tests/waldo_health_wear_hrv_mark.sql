begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The series read marks the night's RMSSD from Waldo's own watch app, so the producer can count it as a trusted writer's
-- reading only while its switch is on. The mark needs all four of: signal overnight_hrv, method rmssd, read_api wear_sensor
-- and package com.heywaldo.app. Nothing else of the origin leaves the database. Synthetic owner and values throughout; each
-- reading's value is only its label here.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'UTC')::date $$;
create function pg_temp.origin(api text,package text) returns jsonb language sql as $$
  select jsonb_build_object('read_api',api,'source_bundle_id',null,'source_package_name',package,'source_version',null,'source_revision',null,'device_ref',null,'recording_method','automatic') $$;
create function pg_temp.wear() returns jsonb language sql as $$ select pg_temp.origin('wear_sensor','com.heywaldo.app') $$;
-- A night-long reading of one signal, dated to the morning it ends.
create function pg_temp.night(id text,signal text,unit text,method text,val numeric,origin jsonb) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('sample_id',id,'revision',1,'signal',signal,'unit',unit,'method',method,'value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0,'origin',origin)) $$;
create function pg_temp.hour(id text,val numeric,origin jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','heart_rate_window','unit','beats_per_minute','value',val,'min',val-5,'max',val+8,'n_samples',40,
    'day',((date_trunc('hour',now())-interval '5 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(date_trunc('hour',now())-interval '5 hours'),'end_at',pg_temp.iso(date_trunc('hour',now())-interval '4 hours'),'utc_offset_minutes',0,'origin',origin) $$;
create function pg_temp.batch(rid text,before_anchor text,after_anchor text,samples jsonb) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','consent_epoch',1,'timezone','UTC','anchor_before',before_anchor,'anchor_after',after_anchor,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.read(signals jsonb) returns jsonb language sql as $$
  select pg_temp.h('series_read','wear-owner',jsonb_build_object('from',pg_temp.today()-2,'to',pg_temp.today(),'signals',signals)) $$;
-- Each returned reading's value, against whether it carries each mark.
create function pg_temp.marks(signals jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(s->>'value', jsonb_build_object('wear', coalesce(s->'waldo_wear','false'::jsonb), 'samsung', coalesce(s->'samsung_writer','false'::jsonb))), '{}'::jsonb)
  from jsonb_array_elements(pg_temp.read(signals)->'sources'->0->'samples') s $$;

insert into auth.users(id,email) values ('e7000000-0000-0000-0000-0000000000e7','wear@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e8000000-0000-0000-0000-0000000000e8','e7000000-0000-0000-0000-0000000000e7','wear-owner','wear@example.invalid');
select is(pg_temp.h('consent_grant','wear-owner',jsonb_build_object('request_id','grant-w-storage01','source','health_connect','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true))->'consent'->>'status','granted','the owner grants storage for Health Connect');

select is(pg_temp.h('ingest','wear-owner',pg_temp.batch('wear-0001',null::text,'wa1',jsonb_build_array(
  pg_temp.night('h-wear','overnight_hrv','milliseconds','rmssd',41,pg_temp.wear()),
  pg_temp.night('h-sdnn','overnight_hrv','milliseconds','sdnn',42,pg_temp.wear()),
  pg_temp.night('h-hcapi','overnight_hrv','milliseconds','rmssd',43,pg_temp.origin('health_connect','com.heywaldo.app')),
  pg_temp.night('h-otherpkg','overnight_hrv','milliseconds','rmssd',44,pg_temp.origin('wear_sensor','com.example.ringapp')),
  pg_temp.night('h-nopkg','overnight_hrv','milliseconds','rmssd',45,pg_temp.origin('wear_sensor',null)),
  pg_temp.night('h-samsung','overnight_hrv','milliseconds','rmssd',46,pg_temp.origin('health_connect','com.sec.android.app.shealth')))))->>'accepted','6','overnight HRV readings of every origin are stored');

select is(pg_temp.marks('["overnight_hrv"]')->'41','{"wear":true,"samsung":false}'::jsonb,'the night''s RMSSD from Waldo''s watch app is marked as the watch''s');
select is(pg_temp.marks('["overnight_hrv"]')->'42','{"wear":false,"samsung":false}'::jsonb,'an SDNN reading from the same origin is not');
select is(pg_temp.marks('["overnight_hrv"]')->'43','{"wear":false,"samsung":false}'::jsonb,'Waldo''s package under another read API is not');
select is(pg_temp.marks('["overnight_hrv"]')->'44','{"wear":false,"samsung":false}'::jsonb,'the watch read API with another package is not');
select is(pg_temp.marks('["overnight_hrv"]')->'45','{"wear":false,"samsung":false}'::jsonb,'nor with no package recorded');
select is(pg_temp.marks('["overnight_hrv"]')->'46','{"wear":false,"samsung":true}'::jsonb,'Samsung Health''s reading keeps its own mark, never the watch''s');

-- The watch's origin on any other signal earns no mark: a night's sleep, a resting rate or an hour of heart rate.
select is(pg_temp.h('ingest','wear-owner',pg_temp.batch('wear-0002','wa1','wa2',jsonb_build_array(
  pg_temp.night('s-wear','sleep_duration','minutes','asleep_duration',421,pg_temp.wear()),
  pg_temp.night('r-wear','resting_heart_rate','beats_per_minute','overnight_resting',51,pg_temp.wear()),
  pg_temp.hour('w-wear',61,pg_temp.wear()))))->>'accepted','3','sleep, resting and hourly heart-rate readings with the watch origin are stored');
select is(pg_temp.marks('["sleep_duration","resting_heart_rate","heart_rate_window"]'),
  '{"421":{"wear":false,"samsung":false},"51":{"wear":false,"samsung":false},"61":{"wear":false,"samsung":false}}'::jsonb,'and none of them is marked as the watch''s');

select ok(position('com.heywaldo.app' in pg_temp.read('["overnight_hrv","sleep_duration","resting_heart_rate","heart_rate_window"]')::text)=0
  and position('wear_sensor' in pg_temp.read('["overnight_hrv","sleep_duration","resting_heart_rate","heart_rate_window"]')::text)=0,'no package name or read API appears anywhere in the read');

select * from finish();
rollback;
