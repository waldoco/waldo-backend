begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.grant_body(rid text,src text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'UTC')::date $$;
-- A derived row from one source. Pillars take a stored zone word, or null for an unavailable pillar with its reason.
create function pg_temp.row(day date,src text,recovery text,weight text default 'moderate') returns jsonb language sql as $$
  select jsonb_build_object('day',to_char(day,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source',src,'consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',case when recovery is null then jsonb_build_object('reason','missing_sleep')
      else jsonb_build_object('score',47.3,'zone',recovery,'algorithm_version','recovery.candidate.v1','activation','candidate_unaccepted','hrv_method','rmssd') end,
    'weight',jsonb_build_object('score',61.4,'zone',weight,'algorithm_version','weight.candidate.v3','activation','candidate_unaccepted'),
    'freshness','fresh') $$;

insert into auth.users(id,email) values ('2c100000-0000-0000-0000-0000000000c1','zone@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('2c300000-0000-0000-0000-0000000000c3','2c100000-0000-0000-0000-0000000000c1','zone-owner','zone@example.invalid');
select pg_temp.h('consent_grant','zone-owner',pg_temp.grant_body('grant-z-apple-s','apple','storage_compute'));
select pg_temp.h('consent_grant','zone-owner',pg_temp.grant_body('grant-z-apple-m','apple','model_processing'));
select pg_temp.h('consent_grant','zone-owner',pg_temp.grant_body('grant-z-sams-st','samsung','storage_compute'));

select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-2,'apple','good')),'{"written":true,"changed":[]}'::jsonb,'a first row has nothing to change from');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-2,'apple','good'))->'changed','[]'::jsonb,'rewriting the same zones is no change');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-2,'apple','low'))->'changed','["recovery"]'::jsonb,'a rewrite into another recovery zone names the pillar');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-2,'apple','low','high'))->'changed','["weight"]'::jsonb,'only the pillar that moved is named');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-1,'apple','good','high'))->'changed','["recovery"]'::jsonb,'a day''s first row is compared with the newest earlier day');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today(),'samsung','low','low'))->'changed','[]'::jsonb,'a row from another wearable is never a change');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today(),'samsung',null,'low'))->'changed','[]'::jsonb,'a pillar going unavailable is not a zone change');
select is(pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today(),'samsung','good','low'))->'changed','[]'::jsonb,'nor is a pillar becoming available again');

-- The answer and the read model carry zone words only where they already lived: no score reaches the answer.
select ok(position('47.3' in pg_temp.h('context_write','zone-owner',pg_temp.row(pg_temp.today()-1,'apple','moderate','high'))::text) = 0,'the write answer carries no score');

-- The prompt read: the earlier day's zone words and both bases, only under a live model grant. Today's row came from a
-- source with no model grant, so the newest readable row is yesterday's.
select is(pg_temp.read('zone-owner')->'context'->>'day',to_char(pg_temp.today()-1,'YYYY-MM-DD'),'the newest readable row is read');
select is(pg_temp.read('zone-owner')->'context'->'basis','[{"source":"apple","consent_epoch":1}]'::jsonb,'with the sources it was computed from');
select is(pg_temp.read('zone-owner')->'previous'->>'recovery_zone','low','and the earlier day''s recovery zone word');
select is(pg_temp.read('zone-owner')->'previous'->>'weight_zone','high','and its load zone word');
select pg_temp.h('consent_withdraw','zone-owner',jsonb_build_object('request_id','withdraw-z-model','source','apple','purpose','model_processing','expected_epoch',1));
select is(pg_temp.read('zone-owner'),null,'withdrawing model use silences the read the trigger depends on');

select * from finish();
rollback;
