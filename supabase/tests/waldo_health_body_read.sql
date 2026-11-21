begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The model's body read: the row the model's health block stands on, with its parts and usual bands, and today's load, stress
-- curve and changes only while the row is today's; nothing without live storage and model-use grants, and nothing of another
-- owner. Rows go in through the real writer. Synthetic owners and synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.body(owner text,payload text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_body_read(owner,payload,a,pg_temp.sig('health.body_read.'||owner||'.'||md5(payload),a)); end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.withdraw_body(rid text,purpose text,epoch int) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'expected_epoch',epoch) $$;
create function pg_temp.day(days_back int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD') $$;
create function pg_temp.usual() returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('signal','breathing_rate','method',null,'state','personal','low',13,'centre',14,'high',15,
    'own_days',20,'own_share',1,'days_until_personal',0,'window_days',30,'estimator','own_mean_sd')) $$;
create function pg_temp.changes() returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('subject',jsonb_build_object('tier',3,'key','breathing_rate','method',null),'pillar','recovery',
    'from',14,'to',16.2,'unit','breaths_per_minute','against','usual','verdict','neutral','significant',true)) $$;
create function pg_temp.load() returns jsonb language sql as $$ select '{"state":"unavailable","reason":"no_readings"}'::jsonb $$;
create function pg_temp.write(owner text,days_back int,extra jsonb) returns jsonb language sql as $$
  select pg_temp.h('context_write',owner,jsonb_build_object('day',pg_temp.day(days_back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('score',71,'zone','good','algorithm_version','form.v9','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra) $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000b1','body@example.invalid'),('f1000000-0000-0000-0000-0000000000b2','other@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('f3000000-0000-0000-0000-0000000000b1','f1000000-0000-0000-0000-0000000000b1','body-owner','body@example.invalid'),
  ('f3000000-0000-0000-0000-0000000000b2','f1000000-0000-0000-0000-0000000000b2','other-owner','other@example.invalid');

select throws_ok($$select waldo.health_body_read('body-owner','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused');
select is(pg_temp.body('body-owner-nobody')->>'error','not_linked','an unprovisioned locator has no body read');
select is(pg_temp.body('body-owner','{"day":"2026-01-01"}')->>'error','invalid_request','a payload that asks for anything is refused');
select is(pg_temp.body('body-owner','not json')->>'error','invalid_request','a payload that is not JSON is refused without a raw database error');
select is(pg_temp.body('body-owner'),null,'with no row there is no body');
select ok(has_function_privilege('anon','waldo.health_body_read(text,text,bigint,text)','execute')
  and not has_function_privilege('authenticated','waldo.health_body_read(text,text,bigint,text)','execute'),'the Worker''s role may call it and a signed-in client may not');

select is(pg_temp.h('consent_grant','body-owner',pg_temp.grant_body('body-grant-store','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.write('body-owner',1,jsonb_build_object('usual',pg_temp.usual(),'changes',pg_temp.changes(),'day_load',pg_temp.load()))->>'written','true','yesterday''s row is written with its bands, changes and load');
select is(pg_temp.body('body-owner'),null,'storage alone does not let the body reach the model');

select is(pg_temp.h('consent_grant','body-owner',pg_temp.grant_body('body-grant-model','model_processing'))->'consent'->>'status','granted','the owner grants model use');
select is(pg_temp.body('body-owner'),jsonb_build_object('body',jsonb_build_object('day',pg_temp.day(1),'usual',pg_temp.usual())),
  'the newest row is yesterday''s: its day and bands, and none of its load or changes, which are today''s alone');

select is(pg_temp.write('body-owner',0,jsonb_build_object('usual',pg_temp.usual(),'changes',pg_temp.changes(),'day_load',pg_temp.load()))->>'written','true','today''s row is written');
select is(pg_temp.body('body-owner'),jsonb_build_object('body',jsonb_build_object('day',pg_temp.day(0),'usual',pg_temp.usual(),'day_load',pg_temp.load(),'changes',pg_temp.changes())),
  'today''s row gives its bands, its load and what changed');
select is(pg_temp.body('other-owner'),null,'another owner reads none of it');

select is(pg_temp.h('consent_withdraw','body-owner',pg_temp.withdraw_body('body-withdraw-model','model_processing',1))->'consent'->>'status','withdrawn','the owner withdraws model use');
select is(pg_temp.body('body-owner'),null,'and the body read answers nothing');

select * from finish();
rollback;
