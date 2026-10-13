begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.ctx(debt jsonb default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',64,'zone','moderate','algorithm_version','recovery.candidate.v1','activation','candidate_unaccepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),
    'freshness','fresh','sleep_debt',debt)) $$;
create function pg_temp.scores() returns jsonb language sql as $$ select pg_temp.h('scores_read','debt-owner')->'scores' $$;

-- Synthetic owner and synthetic values throughout.
insert into auth.users(id,email) values ('d1000000-0000-0000-0000-0000000000d1','debt@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('d3000000-0000-0000-0000-0000000000d3','d1000000-0000-0000-0000-0000000000d1','debt-owner','debt@example.invalid');

select col_type_is('public','health_context_daily','sleep_debt','jsonb','the derived row has a sleep_debt column');
select col_is_null('public','health_context_daily','sleep_debt','which is nullable, so a row written without it holds nothing');
select is(pg_temp.h('consent_grant','debt-owner',pg_temp.grant_body('grant-d-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','debt-owner',pg_temp.grant_body('grant-d-model0001','model_processing'))->'consent'->>'status','granted','and model use');

-- Each state is written and read back in exactly the shape the app reads.
select is(pg_temp.h('context_write','debt-owner',pg_temp.ctx('{"state":"available","debt_minutes":630,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}'))->>'written','true','an available sleep debt is written');
select is(pg_temp.scores()->'sleep_debt','{"state":"available","debt_minutes":630,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}'::jsonb,'and read back as written');
select is(pg_temp.h('context_write','debt-owner',pg_temp.ctx('{"state":"partial","confidence":0.6,"algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}'))->>'written','true','a partial window is written');
select is(pg_temp.scores()->'sleep_debt','{"state":"partial","confidence":0.6,"algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}'::jsonb,'and read back without a figure');
select is(pg_temp.h('context_write','debt-owner',pg_temp.ctx('{"state":"unavailable","reason":"missing_sleep"}'))->>'written','true','an unavailable sleep debt is written with its reason');
select is(pg_temp.scores()->'sleep_debt','{"state":"unavailable","reason":"missing_sleep"}'::jsonb,'and read back with it');

-- A row written without it, as by a Worker that predates it, reads without the key rather than as zero, and does not
-- keep the previous value beside newer pillars.
select is(pg_temp.h('context_write','debt-owner',pg_temp.ctx())->>'written','true','a row written without sleep debt lands');
select ok(not (pg_temp.scores() ? 'sleep_debt'),'and reads without the key, the earlier value cleared');

select is((select count(*)::int from unnest(array[
  'null', '"available"', '{"state":"zero"}', '{"state":"unavailable"}', '{"state":"unavailable","reason":"made_up"}',
  '{"state":"partial","confidence":0.6,"debt_minutes":630,"algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"partial","confidence":1.5,"algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":630,"algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":630,"need_basis":"guessed","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":20161,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":-1,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":"630","need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":630,"need_basis":"own_average","zone":"high","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":630,"need_basis":"own_average","algorithm_version":"sleep debt","activation":"candidate_unaccepted"}',
  '{"state":"available","debt_minutes":630,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"live"}'
]::jsonb[]) bad where pg_temp.h('context_write','debt-owner',pg_temp.ctx() || jsonb_build_object('sleep_debt',bad))->>'error' = 'invalid_request'),15,'every sleep debt outside the read shape is refused');
select ok(not (pg_temp.scores() ? 'sleep_debt'),'and a refused write leaves the row as it was');

-- The model's read never carries it, though it reads the same row.
select is(pg_temp.h('context_write','debt-owner',pg_temp.ctx('{"state":"available","debt_minutes":630,"need_basis":"own_average","algorithm_version":"sleep-debt.candidate.v1","activation":"candidate_unaccepted"}'))->>'written','true','sleep debt is written again');
select isnt(pg_temp.model_read('debt-owner')->'context',null,'the model reads the row');
select is(position('sleep_debt' in pg_temp.model_read('debt-owner')::text),0,'and finds no sleep debt in it');

-- Withdrawing storage deletes the row, and the sleep debt with it.
select is(pg_temp.h('consent_withdraw','debt-owner',jsonb_build_object('request_id','withdraw-d-store1','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is((select count(*)::int from public.health_context_daily where user_id = 'd1000000-0000-0000-0000-0000000000d1'),0,'and the row holding sleep debt is gone');

select * from finish();
rollback;
