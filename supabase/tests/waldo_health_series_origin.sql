begin;
create extension if not exists pgtap with schema extensions;
select plan(9);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The series read returns the app that wrote each reading, so the producer can tell a Samsung Health reading in Health
-- Connect from any other writer's. The stored sample keeps the whole change, origin included; only its package name is
-- returned, and only when it is a string. Synthetic owner and values throughout.
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
create function pg_temp.packages() returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(s->>'value', s->'origin_package'), '{}'::jsonb)
  from jsonb_array_elements(pg_temp.read()->'sources'->0->'samples') s where s ? 'origin_package' $$;

insert into auth.users(id,email) values ('e5000000-0000-0000-0000-0000000000e5','origin@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e6000000-0000-0000-0000-0000000000e6','e5000000-0000-0000-0000-0000000000e5','origin-owner','origin@example.invalid');
select is(pg_temp.h('consent_grant','origin-owner',jsonb_build_object('request_id','grant-o-storage01','source','health_connect','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true))->'consent'->>'status','granted','the owner grants storage for Health Connect');

select is(pg_temp.h('ingest','origin-owner',pg_temp.batch('origin-0001',null::text,'oa1',jsonb_build_array(
  pg_temp.rhr('r-shealth',51,pg_temp.origin('com.sec.android.app.shealth')),
  pg_temp.rhr('r-other',52,pg_temp.origin('com.example.ringapp')),
  pg_temp.rhr('r-none',53,null),
  pg_temp.rhr('r-nullpkg',54,pg_temp.origin(null)))))->>'accepted','4','readings with and without a recorded writer are accepted');
select is(pg_temp.read()->'sources'->0->'samples'->0->>'signal','resting_heart_rate','the series read returns them');
select is(pg_temp.packages()->'51','"com.sec.android.app.shealth"'::jsonb,'a reading carries the package name of the app that wrote it');
select is(pg_temp.packages()->'52','"com.example.ringapp"'::jsonb,'another app''s reading carries its own');
select ok(not (pg_temp.packages() ? '53'),'a reading with no origin carries no package name, not an empty one');
select ok(not (pg_temp.packages() ? '54'),'and one whose origin names no package carries none either');
select is((select count(*)::int from jsonb_array_elements(pg_temp.read()->'sources'->0->'samples') s where s ? 'origin'),0,'the rest of the origin is not returned');
select is((select count(*)::int from jsonb_array_elements(pg_temp.read()->'sources'->0->'samples') s where (s->>'origin_package') is not null and char_length(s->>'origin_package') > 200),0,'and no package name longer than the contract allows');

select * from finish();
rollback;
