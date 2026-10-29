begin;
create extension if not exists pgtap with schema extensions;
select plan(31);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Rows recomputed for days that arrived late carry backfilled. The writer never lets one replace a live row, a later live row
-- replaces it, and it never raises a zone change or reaches the reads that feed the trigger and the model. Synthetic owner.
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
create function pg_temp.d(back int) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.recovery(score int, zone text) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone',zone,'algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
-- A live row: Recovery available, the other two unavailable, as the producer writes a thin day.
create function pg_temp.live(back int, score int, zone text) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.d(back),'timezone','UTC','basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'recovery',pg_temp.recovery(score,zone),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') $$;
create function pg_temp.late(back int, score int, zone text) returns jsonb language sql as $$ select pg_temp.live(back,score,zone) || '{"backfilled":true}'::jsonb $$;
create function pg_temp.w(body jsonb) returns jsonb language sql as $$ select pg_temp.h('context_write','bf-owner',body) $$;
create function pg_temp.hist(n int default 30) returns jsonb language sql as $$ select pg_temp.h('scores_history','bf-owner',jsonb_build_object('days',n))->'history'->'days' $$;
create function pg_temp.day_in_history(back int) returns jsonb language sql as $$
  select d from jsonb_array_elements(pg_temp.hist()) d where d->>'day' = pg_temp.d(back) $$;
create function pg_temp.refused(body jsonb) returns boolean language sql as $$ select pg_temp.w(body)->>'error' = 'invalid_request' $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','bf@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','bf-owner','bf@example.invalid');
select is(pg_temp.h('consent_grant','bf-owner',pg_temp.grant_body('grant-b-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','bf-owner',pg_temp.grant_body('grant-b-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','backfilled','boolean','the derived row has a backfilled column');
select col_is_null('public','health_context_daily','backfilled','which is nullable, so a live row holds nothing');

-- A late day is written, never raises a change, and the history says it is backfilled.
select is(pg_temp.w(pg_temp.live(0,70,'good'))->>'written','true','a live row for today is written');
select is(pg_temp.w(pg_temp.live(7,70,'good'))->>'written','true','a live row for a day older still is written, the newest live row before the late day');
select is(pg_temp.w(pg_temp.late(5,55,'moderate')),'{"written":true,"changed":[]}'::jsonb,'a backfilled row for an older day is written and names no pillar that moved, though its zone differs from the live row before it');
select is(pg_temp.day_in_history(5)->'backfilled','true'::jsonb,'and the history marks that day backfilled');
select ok(not (pg_temp.day_in_history(0) ? 'backfilled'),'while the live day carries no such key, never a false');

-- A backfilled row never replaces a live one; a live row replaces a backfilled one.
select is(pg_temp.w(pg_temp.live(6,61,'good'))->>'written','true','a live row for an older day is written');
select is(pg_temp.w(pg_temp.late(6,20,'low')),'{"written":false,"stale":true}'::jsonb,'a backfilled row for that day is refused as stale');
select is(pg_temp.day_in_history(6)->'recovery'->>'score','61','and the live row stands');
select ok(not (pg_temp.day_in_history(6) ? 'backfilled'),'unmarked');
select is(pg_temp.w(pg_temp.late(5,57,'moderate'))->>'written','true','a backfilled row can be replaced by a later backfilled one');
select is(pg_temp.w(pg_temp.live(5,66,'good'))->>'written','true','a live row for a day that held a backfilled one is written');
select is(pg_temp.day_in_history(5)->'recovery'->>'score','66','and replaces it');
select ok(not (pg_temp.day_in_history(5) ? 'backfilled'),'clearing the mark');

-- A zone change is read against live rows only.
delete from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1';
delete from waldo.health_context_basis where owner_id='e3000000-0000-0000-0000-0000000000e3';
select is(pg_temp.w(pg_temp.late(4,30,'low'))->>'written','true','with every row gone, a backfilled row is written');
select is(pg_temp.w(pg_temp.live(0,85,'high')),'{"written":true,"changed":[]}'::jsonb,'and the first live row after it is no change from it, whatever its zone');

-- The values the writer takes: backfilled is true or absent, and only for a day older than yesterday within ninety days.
select is((select count(*)::int from unnest(array['false','"true"','null','1','"yes"','{}','[true]']::jsonb[]) bad
  where pg_temp.refused(pg_temp.live(5,55,'moderate') || jsonb_build_object('backfilled',bad))),7,'a backfilled value other than true is refused');
select is((select count(*)::int from unnest(array[0,1,91,200]) n where pg_temp.refused(pg_temp.late(n,55,'moderate'))),4,'a backfilled row for today, yesterday or a day beyond ninety is refused');
select is(pg_temp.w(pg_temp.late(2,55,'moderate'))->>'written','true','while one for the day before yesterday is written');
select is(pg_temp.w(pg_temp.late(90,55,'moderate'))->>'written','true','and one ninety days back');
select is((select count(*)::int from unnest(array[
  pg_temp.late(7,55,'moderate') || jsonb_build_object('form',jsonb_build_object('score',60,'zone','good','algorithm_version','form.v9','activation','accepted','confidence',0.5)),
  pg_temp.late(7,55,'moderate') || jsonb_build_object('weight',jsonb_build_object('score',50,'zone','moderate','algorithm_version','weight.v5','activation','accepted','confidence',0.5)),
  pg_temp.late(7,55,'moderate') || jsonb_build_object('windows','[{"start":"09:00","end":"10:00","kind":"peak"}]'::jsonb,'windows_version','energy-windows.v1')
]) bad where pg_temp.refused(bad)),3,'a backfilled row carries no Form, no Weight and no windows');

-- Reads: the day read shows the row without the mark, and the reads that feed the app''s latest view, the model and the trigger skip it.
select ok(not (pg_temp.h('scores_read','bf-owner',jsonb_build_object('day',pg_temp.d(2)))->'scores' ? 'backfilled'),'the scores read of a backfilled day never carries the mark');
select is(pg_temp.h('scores_read','bf-owner')->'scores'->>'day',pg_temp.d(0),'the scores read of no day returns the newest live row');
select is(pg_temp.model_read('bf-owner')->'context'->>'day',pg_temp.d(0),'and so does the model''s read');
select is(pg_temp.model_read('bf-owner')->'previous','null'::jsonb,'whose previous row is none, the older rows being backfilled');
delete from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1' and day = (now() at time zone 'UTC')::date;
select is(pg_temp.h('scores_read','bf-owner'),'{"unavailable":"no_readings"}'::jsonb,'with only backfilled rows left, the scores read of no day has nothing to show');
select is(pg_temp.model_read('bf-owner'),null,'and neither has the model''s read');
select is(pg_temp.h('scores_read','bf-owner',jsonb_build_object('day',pg_temp.d(2)))->'scores'->>'day',pg_temp.d(2),'while a read of that day by name still returns it');

select * from finish();
rollback;
