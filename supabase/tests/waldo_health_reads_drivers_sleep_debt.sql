begin;
create extension if not exists pgtap with schema extensions;
select plan(25);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The scores read returns the row's drivers, so the app can show them from health revision 4, and the model's read returns
-- the row's sleep debt beside the drivers it already had. Synthetic owners and values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.ctx(drivers jsonb default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',64,'zone','moderate','algorithm_version','recovery.candidate.v2','activation','candidate_unaccepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),
    'freshness','fresh','sleep_debt','{"state":"unavailable","reason":"missing_sleep"}'::jsonb,'drivers',drivers)) $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.scores(owner text) returns jsonb language sql as $$ select pg_temp.h('scores_read',owner)->'scores' $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','drv-one@example.invalid'),('e1000000-0000-0000-0000-0000000000e2','drv-two@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','drv-owner-one','drv-one@example.invalid'),
  ('e3000000-0000-0000-0000-0000000000e4','e1000000-0000-0000-0000-0000000000e2','drv-owner-two','drv-two@example.invalid');
select is(pg_temp.h('consent_grant','drv-owner-one',pg_temp.grant_body('grant-r1-storage1','storage_compute'))->'consent'->>'status','granted','the first owner grants storage');
select is(pg_temp.h('consent_grant','drv-owner-one',pg_temp.grant_body('grant-r1-model0001','model_processing'))->'consent'->>'status','granted','and model use');
select is(pg_temp.h('consent_grant','drv-owner-two',pg_temp.grant_body('grant-r2-storage1','storage_compute'))->'consent'->>'status','granted','the second owner grants storage');

select is(pg_temp.h('context_write','drv-owner-one',pg_temp.ctx('["wrist temperature far above usual","blood oxygen below usual"]'))->>'written','true','a row with drivers is written');
select is(pg_temp.scores('drv-owner-one')->'drivers','["wrist temperature far above usual","blood oxygen below usual"]'::jsonb,'and the scores read returns them as stored');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.scores('drv-owner-one')) k),
  array['compiled_at','day','drivers','form','freshness','recovery','sleep_debt','timezone','weight'],'beside the keys it always had, and no energy windows');
select is(pg_temp.scores('drv-owner-one')->'sleep_debt','{"state":"unavailable","reason":"missing_sleep"}'::jsonb,'with the sleep debt as before');
select is(pg_temp.scores('drv-owner-one')->'recovery'->>'score','64','and the pillars as before');


-- The model's read returns the sleep debt beside the drivers, and each pillar whole, so a baseline rides inside its pillar.
select is(pg_temp.model_read('drv-owner-one')->'context'->'drivers','["wrist temperature far above usual","blood oxygen below usual"]'::jsonb,'the model''s read carries the drivers');
select is(pg_temp.model_read('drv-owner-one')->'context'->'sleep_debt','{"state":"unavailable","reason":"missing_sleep"}'::jsonb,'and the sleep debt, as stored');
update public.health_context_daily set recovery = recovery || '{"baseline":{"state":"provisional","personal_days":5,"needed":14,"prior":"adults"}}'::jsonb where user_id='e1000000-0000-0000-0000-0000000000e1';
select is(pg_temp.model_read('drv-owner-one')->'context'->'recovery'->'baseline','{"state":"provisional","personal_days":5,"needed":14,"prior":"adults"}'::jsonb,'and a pillar with whatever it was stored with, a baseline label included');
select is(pg_temp.h('context_write','drv-owner-one',pg_temp.ctx('["blood oxygen below usual"]') - 'sleep_debt')->>'written','true','a row written without sleep debt lands');
select ok(not (pg_temp.model_read('drv-owner-one')->'context' ? 'sleep_debt'),'and the model''s read leaves the key out, never a zero');
select ok(not (pg_temp.scores('drv-owner-one') ? 'sleep_debt'),'as the scores read does');

select is(pg_temp.h('context_write','drv-owner-one',pg_temp.ctx('[]'))->>'written','true','a row written with no drivers lands');
select is(pg_temp.scores('drv-owner-one')->'drivers','[]'::jsonb,'and reads back an empty list');
select is(pg_temp.h('context_write','drv-owner-one',pg_temp.ctx())->>'written','true','a row written by a Worker that sends none lands');
select is(pg_temp.scores('drv-owner-one')->'drivers','[]'::jsonb,'and reads back the same empty list');

-- Each owner reads only their own row.
select is(pg_temp.h('context_write','drv-owner-two',pg_temp.ctx('["breathing rate above usual"]'))->>'written','true','the second owner writes a different driver');
select is(pg_temp.scores('drv-owner-two')->'drivers','["breathing rate above usual"]'::jsonb,'and reads their own');
select ok(pg_temp.model_read('drv-owner-two') is null,'while the model''s read still returns nothing without model-use consent');
select is(pg_temp.scores('drv-owner-one')->'drivers','[]'::jsonb,'while the first owner still reads theirs');

-- A read with no row says why, as before, and a call without the router signature is refused.
select is(pg_temp.h('consent_withdraw','drv-owner-two',jsonb_build_object('request_id','withdraw-r2-store1','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the second owner withdraws storage');
select is(pg_temp.h('scores_read','drv-owner-two'),'{"unavailable":"consent_withdrawn"}'::jsonb,'and a read with no row still says why, with no drivers to show');
select throws_ok($$select waldo.health_scores_read('drv-owner-one','{}',extract(epoch from now())::bigint,'bad')$$,'42501',null,'a scores read without the router signature is refused');

select * from finish();
rollback;
