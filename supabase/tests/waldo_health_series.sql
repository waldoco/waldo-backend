begin;
create extension if not exists pgtap with schema extensions;
select plan(47);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.series(owner text,from_day date,to_day date,signals jsonb default null) returns jsonb language sql as $$
  select pg_temp.h('series_read',owner,jsonb_strip_nulls(jsonb_build_object('from',from_day,'to',to_day,'signals',signals))) $$;

insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-0000000000a1','series-a@example.invalid'),
 ('b1000000-0000-0000-0000-0000000000b1','series-b@example.invalid'),
 ('c1000000-0000-0000-0000-0000000000c1','series-c@example.invalid'),
 ('d1000000-0000-0000-0000-0000000000d1','series-d@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000a3','a1000000-0000-0000-0000-0000000000a1','series-owner-a','series-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000b3','b1000000-0000-0000-0000-0000000000b1','series-owner-b','series-b@example.invalid'),
 ('c3000000-0000-0000-0000-0000000000c3','c1000000-0000-0000-0000-0000000000c1','series-owner-c','series-c@example.invalid'),
 ('d3000000-0000-0000-0000-0000000000d3','d1000000-0000-0000-0000-0000000000d1','series-owner-d','series-d@example.invalid');
update waldo.owners set state='suspended' where do_name='series-owner-c';

create function pg_temp.grant_body(rid text,src text,purpose text,epoch int default 0) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',2,'expected_epoch',epoch,'age_attested_18_plus',true) $$;
create function pg_temp.withdraw_body(rid text,src text,purpose text,epoch int) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'expected_epoch',epoch) $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.hour_start(back int) returns timestamptz language sql as $$ select date_trunc('hour',now())-make_interval(hours=>back) $$;
create function pg_temp.steps(id text,back int,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint,'signal','steps_window','unit','count','value',val,
    'day',(pg_temp.hour_start(back) at time zone 'UTC')::date,'start_at',pg_temp.iso(pg_temp.hour_start(back)),'end_at',pg_temp.iso(pg_temp.hour_start(back)+interval '1 hour'),'utc_offset_minutes',0) $$;
create function pg_temp.hrv(id text,method text,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','overnight_hrv','unit','milliseconds','method',method,'value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,epoch int,before_anchor text,after_anchor text,samples jsonb,tz text default 'UTC',deletions jsonb default '[]',src text default 'apple') returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'consent_epoch',epoch,'timezone',tz,'anchor_before',before_anchor,'anchor_after',after_anchor,'samples',samples,'deletions',deletions) $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'UTC')::date $$;

-- Signing, ownership, shape.
select throws_ok($$select waldo.health_series_read('series-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused');
select throws_ok(format($$select waldo.health_series_read('series-owner-a','{"from":"2026-01-01","to":"2026-01-02"}',%s,%L)$$,extract(epoch from now())::bigint,pg_temp.sig('health.ingest.series-owner-a.'||md5('{"from":"2026-01-01","to":"2026-01-02"}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature made for another operation is refused');
select throws_ok(format($$select waldo.health_series_read('series-owner-a','{"from":"2026-01-01","to":"2026-01-03"}',%s,%L)$$,extract(epoch from now())::bigint,pg_temp.sig('health.series_read.series-owner-a.'||md5('{"from":"2026-01-01","to":"2026-01-02"}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature over a different payload is refused');
select is(pg_temp.series('series-owner-c',pg_temp.today()-3,pg_temp.today())->>'error','not_linked','a suspended owner has no series');
select is(pg_temp.series('series-owner-nobody',pg_temp.today()-3,pg_temp.today())->>'error','not_linked','an unprovisioned locator has no series');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-05","to":"2026-01-04"}')->>'error','invalid_request','a range that ends before it starts is refused');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-01","to":"2026-02-01"}')->>'error','invalid_request','a range longer than 31 days is refused');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-01","to":"2026-01-31"}')->>'error',null,'thirty-one days is allowed');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-1-1","to":"2026-01-02"}')->>'error','invalid_request','a malformed day is refused');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-02-30","to":"2026-03-01"}')->>'error','invalid_request','an impossible date is refused without a raw database error');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-01","to":"2026-01-02","owner":"x"}')->>'error','invalid_request','an unknown key is refused');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-01","to":"2026-01-02","signals":["nope"]}')->>'error','invalid_request','an unknown signal is refused');
select is(pg_temp.h('series_read','series-owner-a','{"from":"2026-01-01","to":"2026-01-02","signals":[]}')->>'error','invalid_request','an empty signal list is refused');

-- Access states say why there is nothing to compute from.
select is(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->>'access','consent_required','an owner who never consented is consent_required');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'),0,'and no source is returned');
select is(pg_temp.h('consent_grant','series-owner-a',pg_temp.grant_body('grant-a-storage1','apple','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->>'access','granted','a live storage grant is granted access');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'->0->'samples'),0,'a source with no readings returns an empty sample list');
select is(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'->0->>'consent_epoch','1','the source carries the epoch it holds now');
select matches(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->>'read_at','^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$','the read carries its instant to the microsecond, which a derived row records as its read_at');

-- Readings come back with the zone they were uploaded in; tombstones and other days do not.
select is(pg_temp.h('ingest','series-owner-a',pg_temp.batch('series-a-0001',1,null,'sa1',jsonb_build_array(pg_temp.steps('step-1',2,100),pg_temp.steps('step-2',3,200),pg_temp.hrv('hrv-r','rmssd',48),pg_temp.hrv('hrv-s','sdnn',61)),'Asia/Kolkata'))->>'accepted','4','a batch uploaded in Asia/Kolkata is accepted');
select is((select array_agg(distinct timezone) from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='series-owner-a'),array['Asia/Kolkata'],'every stored reading keeps the zone of its batch');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'->0->'samples'),4,'the series returns the owner readings in range');
select is((select array_agg(distinct s->>'timezone') from jsonb_array_elements(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'->0->'samples') s),array['Asia/Kolkata'],'and each carries its own zone');
select is((select array_agg(s->>'method' order by s->>'method') from jsonb_array_elements(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today(),'["overnight_hrv"]')->'sources'->0->'samples') s),array['rmssd','sdnn'],'RMSSD and SDNN come back as separate labelled readings, never blended');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today(),'["steps_window"]')->'sources'->0->'samples'),2,'a signal filter returns only the named signals');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-400+390,pg_temp.today()-400+391)->'sources'->0->'samples'),0,'readings on other days are not returned');
select is(pg_temp.h('ingest','series-owner-a',pg_temp.batch('series-a-0002',1,'sa1','sa2','[]','Asia/Kolkata',jsonb_build_array(jsonb_build_object('sample_id','step-1','signal','steps_window','revision',extract(epoch from now())::bigint+1))))->>'deleted','1','a deletion is accepted');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today(),'["steps_window"]')->'sources'->0->'samples'),1,'a deleted reading is not returned');
select is((select timezone from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='series-owner-a' and s.sample_id='step-1'),null,'a tombstone keeps no zone');
select is(pg_temp.h('ingest','series-owner-a',pg_temp.batch('series-a-0003',1,'sa2','sa3',jsonb_build_array(pg_temp.steps('step-2',3,250)||jsonb_build_object('revision',extract(epoch from now())::bigint+5)),'Europe/Paris'))->>'accepted','1','a newer revision uploaded in another zone replaces the reading');
select is((select timezone from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='series-owner-a' and s.sample_id='step-2'),'Europe/Paris','and takes the zone of that upload, while older readings keep theirs');

-- Owners are separate.
select is(pg_temp.h('consent_grant','series-owner-b',pg_temp.grant_body('grant-b-storage1','apple','storage_compute'))->'consent'->>'status','granted','another owner consents independently');
select is(jsonb_array_length(pg_temp.series('series-owner-b',pg_temp.today()-3,pg_temp.today())->'sources'->0->'samples'),0,'another owner sees none of this owner readings');

-- Consent moves the answer: model-only withdrawal keeps the series, a storage withdrawal removes it.
select is(pg_temp.h('consent_grant','series-owner-a',pg_temp.grant_body('grant-a-model1','apple','model_processing'))->'consent'->>'status','granted','the owner grants model use');
select is(pg_temp.h('consent_withdraw','series-owner-a',pg_temp.withdraw_body('withdraw-a-model1','apple','model_processing',1))->'consent'->>'status','withdrawn','the owner withdraws model use only');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'->0->'samples'),3,'model-only withdrawal leaves the series untouched');
select is(pg_temp.h('consent_withdraw','series-owner-a',pg_temp.withdraw_body('withdraw-a-store1','apple','storage_compute',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->>'access','consent_withdrawn','after a storage withdrawal access is consent_withdrawn');
select is(jsonb_array_length(pg_temp.series('series-owner-a',pg_temp.today()-3,pg_temp.today())->'sources'),0,'and no source or reading is returned');

-- The bound: a source returns at most 8000 readings and says when it had more.
select is(pg_temp.h('consent_grant','series-owner-d',pg_temp.grant_body('grant-d-storage1','apple','storage_compute'))->'consent'->>'status','granted','a fourth owner grants storage');
insert into waldo.health_samples(owner_id,source,signal,sample_id,revision,epoch,day,start_at,end_at,utc_offset_minutes,timezone,payload)
  select 'd3000000-0000-0000-0000-0000000000d3','apple','spo2','bulk-'||g,1,1,pg_temp.today(),now()-interval '1 hour',now()-interval '1 hour',0,'UTC','{"value":97}'::jsonb from generate_series(1,8001) g;
select is((pg_temp.series('series-owner-d',pg_temp.today(),pg_temp.today())->'sources'->0->>'truncated')::boolean,true,'a source with more than 8000 readings is flagged truncated');
select is(jsonb_array_length(pg_temp.series('series-owner-d',pg_temp.today(),pg_temp.today())->'sources'->0->'samples'),8000,'and returns exactly the bound');
insert into waldo.health_samples(owner_id,source,signal,sample_id,revision,epoch,day,start_at,end_at,utc_offset_minutes,timezone,payload)
  values ('d3000000-0000-0000-0000-0000000000d3','apple','spo2','old-1',1,1,pg_temp.today()-5,now()-interval '5 days',now()-interval '5 days',0,'UTC','{"value":96}'::jsonb);
select is((select bool_and((s->>'day')::date = pg_temp.today()) from jsonb_array_elements(pg_temp.series('series-owner-d',pg_temp.today()-5,pg_temp.today())->'sources'->0->'samples') s),true,'when the bound is hit the oldest days are shed, never the newest');
select is(jsonb_array_length(pg_temp.series('series-owner-d',pg_temp.today()-5,pg_temp.today())->'sources'->0->'samples'),8000,'and the bound still holds across days');

-- Privileges: only the signed router path may call it.
select is((select has_function_privilege('anon',p.oid,'execute') from pg_proc p where p.pronamespace='waldo'::regnamespace and p.proname='health_series_read'),true,'the signed router path can call the series read');
select is((select count(*)::int from pg_proc p where p.pronamespace='waldo'::regnamespace and p.proname='health_series_read' and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute') or has_function_privilege('public',p.oid,'execute'))),0,'no other role can');

select * from finish();
rollback;
