begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The candidate training load on the derived row (ADR-0081 amendment of 31 October 2026, section 2): written through the
-- current writer in its closed shape only, read back by the model's read, never by the app's scores read. Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}') returns jsonb language sql as $$ select pg_temp.h('context_write','load-owner',pg_temp.ctx(extra)) $$;
create function pg_temp.refused(load jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('training_load',load))->>'error' = 'invalid_request' $$;
create function pg_temp.load(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('state','available','phrase','heavier than usual','method','hr_zones','algorithm_version','training-load.candidate.v1','activation','candidate_unaccepted') || extra $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000f1','load@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000f3','f1000000-0000-0000-0000-0000000000f1','load-owner','load@example.invalid');
select is(pg_temp.h('consent_grant','load-owner',pg_temp.grant_body('grant-l-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','load-owner',pg_temp.grant_body('grant-l-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','training_load','jsonb','the derived row has a training_load column');

select is(pg_temp.write(jsonb_build_object('training_load',pg_temp.load()))->>'written','true','a row with a candidate load is written');
select is(pg_temp.model_read('load-owner')->'context'->'training_load',pg_temp.load(),'the model''s read returns it as written');
select ok(not (pg_temp.h('scores_read','load-owner')->'scores' ? 'training_load'),'the app''s scores read never does');
select is(pg_temp.write(jsonb_build_object('training_load','{"state":"unavailable","reason":"baseline_immature"}'::jsonb))->>'written','true','an unavailable load with its reason is written');
select is(pg_temp.write()->>'written','true','a row written without a load lands');
select ok(not (pg_temp.model_read('load-owner')->'context' ? 'training_load'),'and clears it, so no load outlives the recompute that had none');

-- Everything outside the closed shape is refused whole, so no figure can ride it.
select is((select count(*)::int from unnest(array[
  'null', '[]', '"heavier than usual"', '7', '{}',
  pg_temp.load('{"phrase":"heavier than usual (1.4x)"}')::text, pg_temp.load('{"phrase":"risky"}')::text, pg_temp.load('{"method":"trimp"}')::text,
  pg_temp.load('{"algorithm_version":"training-load.v1"}')::text, pg_temp.load('{"activation":"accepted"}')::text, pg_temp.load('{"ratio":1.4}')::text,
  (pg_temp.load() - 'method')::text, '{"state":"unavailable","reason":"no_workouts"}', '{"state":"unavailable","reason":"no_readings","phrase":"about usual"}',
  '{"state":"available","reason":"no_readings"}', '{"state":"unknown"}'
]::jsonb[]) bad where pg_temp.refused(bad)),16,'every load outside its shape is refused');
select ok(pg_temp.h('context_write','load-owner',pg_temp.ctx(jsonb_build_object('training_load',pg_temp.load(),'backfilled',true,'recovery',jsonb_build_object('reason','missing_sleep')),5))->>'error' = 'invalid_request',
  'a backfilled row never carries a load');

-- Withdrawing model use hides the row from the model's read, load included; withdrawing storage deletes it.
select is(pg_temp.write(jsonb_build_object('training_load',pg_temp.load()))->>'written','true','the load is written again');
select pg_temp.h('consent_withdraw','load-owner',jsonb_build_object('request_id','withdraw-load-01','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000f1'),0,'withdrawing storage deletes the row and its load');

select * from finish();
rollback;
