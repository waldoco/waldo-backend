begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.d(back integer) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.ctx(back integer,score numeric) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.d(back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',score,'zone','moderate','algorithm_version','recovery.candidate.v1','activation','candidate_unaccepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),
    'freshness','fresh') $$;
create function pg_temp.week(owner text) returns jsonb language sql as $$ select pg_temp.h('scores_history',owner,jsonb_build_object('from',pg_temp.d(6),'to',pg_temp.d(0))) $$;

-- Synthetic owners and synthetic values throughout.
insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','history@example.invalid'), ('e2000000-0000-0000-0000-0000000000e2','other@example.invalid'), ('e4000000-0000-0000-0000-0000000000e4','fresh@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','history-owner','history@example.invalid'),
  ('e5000000-0000-0000-0000-0000000000e5','e2000000-0000-0000-0000-0000000000e2','other-owner','other@example.invalid'),
  ('e6000000-0000-0000-0000-0000000000e6','e4000000-0000-0000-0000-0000000000e4','fresh-owner','fresh@example.invalid');

select has_function('waldo','health_scores_history',array['text','text','bigint','text'],'the history read exists with the router-signed signature');
select ok(not has_function_privilege('authenticated','waldo.health_scores_history(text,text,bigint,text)','execute'),'a signed-in client cannot call it directly');
select throws_ok($$ select waldo.health_scores_history('history-owner','{}',extract(epoch from now())::bigint,'0') $$,'42501',null,'an unsigned call is refused');

select is(pg_temp.week('history-owner'),'{"unavailable":"consent_required"}'::jsonb,'before any grant it says consent is required');
select is(pg_temp.h('consent_grant','history-owner',pg_temp.grant_body('grant-h-storage1'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.week('history-owner'),'{"unavailable":"no_readings"}'::jsonb,'with no rows it says there are no readings, never a zero');

-- Three days inside the week, one before it, and another owner's row on the same day.
select is((select count(*)::int from unnest(array[pg_temp.ctx(6,51),pg_temp.ctx(4,58),pg_temp.ctx(0,64),pg_temp.ctx(9,40)]) c where pg_temp.h('context_write','history-owner',c)->>'written' = 'true'),4,'four derived rows are written');
select is(pg_temp.h('consent_grant','other-owner',pg_temp.grant_body('grant-o-storage1'))->'consent'->>'status','granted','another owner grants storage');
select is(pg_temp.h('context_write','other-owner',pg_temp.ctx(4,99))->>'written','true','and has a row on one of the same days');

select is((select array_agg(d->>'day' order by n) from jsonb_array_elements(pg_temp.week('history-owner')->'history') with ordinality as x(d,n)),array[pg_temp.d(6),pg_temp.d(4),pg_temp.d(0)],'the week lists only its own days that have a row, oldest first');
select is((select array_agg((d->'recovery'->>'score')::numeric order by n) from jsonb_array_elements(pg_temp.week('history-owner')->'history') with ordinality as x(d,n)),array[51,58,64]::numeric[],'with this owner''s values, never the other owner''s');
select is(pg_temp.week('history-owner')->'history'->1,pg_temp.h('scores_read','history-owner',jsonb_build_object('day',pg_temp.d(4)))->'scores','each day is exactly the row the day read returns');

select is((select count(*)::int from unnest(array[
  jsonb_build_object('from',pg_temp.d(0),'to',pg_temp.d(6)), jsonb_build_object('from',pg_temp.d(31),'to',pg_temp.d(0)), jsonb_build_object('from',pg_temp.d(6)),
  jsonb_build_object('from',pg_temp.d(6),'to',pg_temp.d(0),'owner','other-owner'), jsonb_build_object('from','2026-02-30','to','2026-03-01'),
  jsonb_build_object('from',6,'to',0), '"week"'::jsonb
]) bad where pg_temp.h('scores_history','history-owner',bad)->>'error' = 'invalid_request'),7,'every window outside 1 to 31 local days, and every malformed body, is refused');
select is(jsonb_array_length(pg_temp.h('scores_history','history-owner',jsonb_build_object('from',pg_temp.d(30),'to',pg_temp.d(0)))->'history'),4,'a 31-day window is served');

select is(pg_temp.week('nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner object is not linked');

-- Withdrawing storage deletes the rows, so the history goes with them.
select is(pg_temp.h('consent_withdraw','history-owner',jsonb_build_object('request_id','withdraw-h-store1','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is(pg_temp.week('history-owner'),'{"unavailable":"consent_withdrawn"}'::jsonb,'and the week then says so');

select * from finish();
rollback;
