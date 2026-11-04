begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The series read says only whether Samsung Health wrote a reading, so the producer can tell one in Health Connect from
-- any other writer's. The stored sample keeps the whole change, origin included; no package name leaves the database. Synthetic owner and values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'UTC')::date $$;
create function pg_temp.rhr(id text,val numeric,origin jsonb default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('sample_id',id,'revision',1,'signal','resting_heart_rate','unit','beats_per_minute','method','overnight_resting','value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0,'origin',origin)) $$;
create function pg_temp.origin(package text) returns jsonb language sql as $$
  select jsonb_build_object('read_api','health_connect','source_bundle_id',null,'source_package_name',package,'source_version',null,'source_revision',null,'device_ref',null,'recording_method','automatic') $$;
create function pg_temp.batch(rid text,before_anchor text,after_anchor text,samples jsonb) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','consent_epoch',1,'timezone','UTC','anchor_before',before_anchor,'anchor_after',after_anchor,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.read() returns jsonb language sql as $$
  select pg_temp.h('series_read','origin-owner',jsonb_build_object('from',pg_temp.today()-2,'to',pg_temp.today(),'signals',jsonb_build_array('resting_heart_rate'))) $$;
create function pg_temp.samsung() returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(s->>'value', s->'samsung_writer'), '{}'::jsonb)
  from jsonb_array_elements(pg_temp.read()->'sources'->0->'samples') s where s ? 'samsung_writer' $$;

insert into auth.users(id,email) values ('e5000000-0000-0000-0000-0000000000e5','origin@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e6000000-0000-0000-0000-0000000000e6','e5000000-0000-0000-0000-0000000000e5','origin-owner','origin@example.invalid');
select is(pg_temp.h('consent_grant','origin-owner',jsonb_build_object('request_id','grant-o-storage01','source','health_connect','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true))->'consent'->>'status','granted','the owner grants storage for Health Connect');

select is(pg_temp.h('ingest','origin-owner',pg_temp.batch('origin-0001',null::text,'oa1',jsonb_build_array(
  pg_temp.rhr('r-shealth',51,pg_temp.origin('com.sec.android.app.shealth')),
  pg_temp.rhr('r-other',52,pg_temp.origin('com.example.ringapp')),
  pg_temp.rhr('r-none',53,null),
  pg_temp.rhr('r-nullpkg',54,pg_temp.origin(null)))))->>'accepted','4','readings with and without a recorded writer are accepted');
select is(pg_temp.read()->'sources'->0->'samples'->0->>'signal','resting_heart_rate','the series read returns them');
select is(pg_temp.samsung()->'51','true'::jsonb,'a reading Samsung Health wrote is marked as such');
select ok(not (pg_temp.samsung() ? '52'),'another app''s reading is not marked');
select ok(not (pg_temp.samsung() ? '53'),'a reading with no origin is not marked');
select ok(not (pg_temp.samsung() ? '54'),'and one whose origin names no package is not marked either');
select is((select count(*)::int from jsonb_array_elements(pg_temp.read()->'sources'->0->'samples') s where s ? 'origin' or s ? 'origin_package' or s ? 'source_package_name'),0,'no origin, and no package name, is returned for any reading');
select ok(position('com.example.ringapp' in pg_temp.read()::text)=0 and position('com.sec.android' in pg_temp.read()::text)=0,'a package name appears nowhere in the read');

-- An hourly heart-rate window is marked the same way, so a Health Connect night with no resting reading can be accepted.
create function pg_temp.hour(id text,val numeric,origin jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','heart_rate_window','unit','beats_per_minute','value',val,'min',val-5,'max',val+8,'n_samples',40,
    'day',((date_trunc('hour',now())-interval '5 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(date_trunc('hour',now())-interval '5 hours'),'end_at',pg_temp.iso(date_trunc('hour',now())-interval '4 hours'),'utc_offset_minutes',0,'origin',origin) $$;
select is(pg_temp.h('ingest','origin-owner',pg_temp.batch('origin-0002','oa1','oa2',jsonb_build_array(pg_temp.hour('w-shealth',61,pg_temp.origin('com.sec.android.app.shealth')),pg_temp.hour('w-other',62,pg_temp.origin('com.example.ringapp')))))->>'accepted',
  '2','hourly heart-rate windows with a recorded writer are accepted');
select is((select jsonb_object_agg(s->>'value', coalesce(s->'samsung_writer','false'::jsonb)) from jsonb_array_elements(pg_temp.h('series_read','origin-owner',jsonb_build_object('from',pg_temp.today()-2,'to',pg_temp.today(),'signals',jsonb_build_array('heart_rate_window')))->'sources'->0->'samples') s),
  '{"61":true,"62":false}'::jsonb,'and the window Samsung Health wrote is marked, the other app''s is not');

select * from finish();
rollback;
