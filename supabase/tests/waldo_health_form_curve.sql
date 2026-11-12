begin;
create extension if not exists pgtap with schema extensions;
select plan(27);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Today's measured Form curve on the derived row (ADR-0081 amendment of 27 October 2026, "Form through the day", sections 1
-- and 4): written through the current writer in its closed shape only, for the owner's own today, read back by the scores
-- read and by no other read. Synthetic values.
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
create function pg_temp.day(days_back int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD') $$;
create function pg_temp.form(score numeric default 71) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone','good','algorithm_version','form.v9','activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.day(days_back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',pg_temp.form(),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$ select pg_temp.h('context_write','curve-owner',pg_temp.ctx(extra,days_back)) $$;
create function pg_temp.point(minute int,score numeric,kind text default 'measured') returns jsonb language sql as $$
  select jsonb_build_object('at',pg_temp.day()||'T'||to_char(minute/60,'FM00')||':'||to_char(minute%60,'FM00')||':00.000Z','score',score,'kind',kind) $$;
-- A curve of the row's own Form: version form.v9, last point the row's score of 71.
create function pg_temp.curve(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5),pg_temp.point(495,64.5),pg_temp.point(540,71))) || extra $$;
create function pg_temp.refused(curve jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('form_curve',curve))->>'error' = 'invalid_request' $$;
create function pg_temp.stored(days_back int default 0) returns jsonb language sql as $$
  select form_curve from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000c1' and day=pg_temp.day(days_back)::date $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000c1','curve@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000c3','f1000000-0000-0000-0000-0000000000c1','curve-owner','curve@example.invalid');
select is(pg_temp.h('consent_grant','curve-owner',pg_temp.grant_body('grant-c-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','curve-owner',pg_temp.grant_body('grant-c-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','form_curve','jsonb','the derived row has a form_curve column');
select ok(not has_function_privilege('anon','waldo.health_form_curve_valid(jsonb,jsonb)','execute') and not has_function_privilege('authenticated','waldo.health_form_curve_valid(jsonb,jsonb)','execute')
  and not has_function_privilege('service_role','waldo.health_form_curve_valid(jsonb,jsonb)','execute'),'no client role may call the shape check');

select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve()))->>'written','true','today''s row is written with its measured curve');
select is(pg_temp.stored(),pg_temp.curve(),'and the row holds it as written');
select is(pg_temp.h('scores_read','curve-owner',jsonb_build_object('day',pg_temp.day()))->'scores'->'form_curve',pg_temp.curve(),'the scores read returns it for that day');
select ok(not (pg_temp.model_read('curve-owner')->'context' ? 'form_curve'),'the model''s read never returns it');
select ok(pg_temp.model_read('curve-owner')::text !~ '64\.5','and none of its points reach the model''s read');
select ok(pg_temp.h('scores_history','curve-owner','{"days":7}'::jsonb)::text !~ 'form_curve|64\.5','the history read never returns it');
select is(pg_temp.write()->>'written','true','a write for today without a curve lands');
select is(pg_temp.stored(),null,'and clears it, so no curve outlives the recompute that had none');

-- Everything outside the closed shape is refused whole.
select is((select count(*)::int from unnest(array[
  'null', '[]', '"form.v9"', '{}', '{"version":"form.v9"}', '{"version":"form.v9","points":[]}',
  pg_temp.curve('{"extra":1}')::text, pg_temp.curve('{"version":"Form V9"}')::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5),pg_temp.point(480,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(495,64.5),pg_temp.point(480,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,101),pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,-1),pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5,'projected'),pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5),pg_temp.point(540,71,'projected')))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5) || '{"zone":"good"}'::jsonb,pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5) - 'kind',pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(jsonb_build_object('at','08:00','score',64.5,'kind','measured'),pg_temp.point(540,71)))::text,
  jsonb_build_object('version','form.v9','points',jsonb_build_array(jsonb_build_object('at',pg_temp.day()||'T08:00:00Z','score','71','kind','measured')))::text
]::jsonb[]) bad where pg_temp.refused(bad)),18,'every curve outside its shape is refused');
select ok(pg_temp.refused(jsonb_build_object('version','form.v9','points',(select jsonb_agg(pg_temp.point(n,71) order by n) from generate_series(0,96) n))),'a curve of ninety-seven points is refused');
select is(pg_temp.write(jsonb_build_object('form_curve',jsonb_build_object('version','form.v9','points',(select jsonb_agg(pg_temp.point(n,71) order by n) from generate_series(1,96) n))))->>'written','true','and one of ninety-six is written');

-- The curve is the row's own Form or it is refused.
select ok(pg_temp.refused(pg_temp.curve('{"version":"form.candidate.v8"}')),'a curve in another version than the row''s Form is refused');
select ok(pg_temp.refused(jsonb_build_object('version','form.v9','points',jsonb_build_array(pg_temp.point(480,64.5),pg_temp.point(540,70.9)))),'a curve whose last point is not the row''s Form score is refused');
select ok(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(),'form',jsonb_build_object('reason','stale_inputs')))->>'error' = 'invalid_request','a curve on a row with no Form is refused');

-- Only the owner's own today takes a curve, or yesterday for a run that crossed midnight; another day keeps the one it held.
select ok(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve()),2)->>'error' = 'invalid_request','a curve on an older day''s row is refused');
select ok(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve()),-1)->>'error' = 'invalid_request','and on tomorrow''s');
select ok(pg_temp.h('context_write','curve-owner',pg_temp.ctx(jsonb_build_object('form_curve',pg_temp.curve(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'recovery',jsonb_build_object('reason','missing_sleep')),5))->>'error' = 'invalid_request',
  'a backfilled row never carries a curve');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve()))->>'written','true','today''s curve is written again');
update public.health_context_daily set day = day - 1 where user_id='f1000000-0000-0000-0000-0000000000c1' and day=pg_temp.day()::date;
update waldo.health_context_basis set day = day - 1 where owner_id='f3000000-0000-0000-0000-0000000000c3' and day=pg_temp.day()::date;
select is(pg_temp.write('{}'::jsonb,1)->>'written','true','that day, now yesterday, is rewritten without a curve');
select is(pg_temp.stored(1),pg_temp.curve(),'and keeps the curve it held');
select is(pg_temp.h('scores_read','curve-owner',jsonb_build_object('day',pg_temp.day(1)))->'scores'->'form_curve',pg_temp.curve(),'which the scores read returns for that day');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve('{"version":"form.v9"}')),1)->>'written','true','a run that crossed midnight still writes its row, with its curve, on what is now yesterday');

-- Withdrawing storage deletes the row, curve included.
select pg_temp.h('consent_withdraw','curve-owner',jsonb_build_object('request_id','withdraw-curve-1','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000c1'),0,'withdrawing storage deletes the row and its curve');

select * from finish();
rollback;
