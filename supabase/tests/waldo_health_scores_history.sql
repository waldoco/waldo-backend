begin;
create extension if not exists pgtap with schema extensions;
select plan(35);
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
create function pg_temp.dz(tz text,back integer) returns text language sql as $$ select to_char((now() at time zone tz)::date - back,'YYYY-MM-DD') $$;
create function pg_temp.ctz(tz text,back integer,score numeric) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.dz(tz,back),'timezone',tz,
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',score,'zone','moderate','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),
    'freshness','fresh') $$;
create function pg_temp.ctx(back integer,score numeric) returns jsonb language sql as $$ select pg_temp.ctz('UTC',back,score) $$;
create function pg_temp.hist(owner text,days integer) returns jsonb language sql as $$ select pg_temp.h('scores_history',owner,jsonb_build_object('days',days)) $$;
create function pg_temp.listed(owner text,days integer) returns text[] language sql as $$
  select coalesce(array_agg(d->>'day' order by n),array[]::text[]) from jsonb_array_elements(pg_temp.hist(owner,days)->'history'->'days') with ordinality as x(d,n) $$;

-- Synthetic owners and synthetic values throughout.
insert into auth.users(id,email) values
  ('e1000000-0000-0000-0000-0000000000e1','history@example.invalid'), ('e2000000-0000-0000-0000-0000000000e2','other@example.invalid'),
  ('e4000000-0000-0000-0000-0000000000e4','full@example.invalid'), ('e7000000-0000-0000-0000-0000000000e7','east@example.invalid'), ('e8000000-0000-0000-0000-0000000000e8','west@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','history-owner','history@example.invalid'),
  ('e5000000-0000-0000-0000-0000000000e5','e2000000-0000-0000-0000-0000000000e2','other-owner','other@example.invalid'),
  ('e6000000-0000-0000-0000-0000000000e6','e4000000-0000-0000-0000-0000000000e4','full-owner','full@example.invalid'),
  ('e9000000-0000-0000-0000-0000000000e9','e7000000-0000-0000-0000-0000000000e7','east-owner','east@example.invalid'),
  ('ea000000-0000-0000-0000-0000000000ea','e8000000-0000-0000-0000-0000000000e8','west-owner','west@example.invalid');

select has_function('waldo','health_scores_history',array['text','text','bigint','text'],'the history read exists with the router-signed signature');
select ok(not has_function_privilege('authenticated','waldo.health_scores_history(text,text,bigint,text)','execute'),'a signed-in client cannot call it directly');
select ok(has_function_privilege('anon','waldo.health_scores_history(text,text,bigint,text)','execute'),'the Worker reaches it as its siblings are reached');
select throws_ok($$ select waldo.health_scores_history('history-owner','{"days":7}',extract(epoch from now())::bigint,'0') $$,'42501',null,'an unsigned call is refused');

select is(pg_temp.hist('history-owner',7),'{"unavailable":"consent_required"}'::jsonb,'before any grant it says consent is required');
select is(pg_temp.h('consent_grant','history-owner',pg_temp.grant_body('grant-h-storage1'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.hist('history-owner',7),'{"unavailable":"no_readings"}'::jsonb,'with no rows it says there are no readings, never a zero');

-- Seven rows with gaps, and another owner's row on one of the same days.
select is((select count(*)::int from unnest(array[pg_temp.ctx(6,51),pg_temp.ctx(4,58),pg_temp.ctx(2,60),pg_temp.ctx(0,64),pg_temp.ctx(9,40),pg_temp.ctx(29,45),pg_temp.ctx(40,30)]) c where pg_temp.h('context_write','history-owner',c)->>'written' = 'true'),7,'seven derived rows are written');
select is(pg_temp.h('consent_grant','other-owner',pg_temp.grant_body('grant-o-storage1'))->'consent'->>'status','granted','another owner grants storage');
select is(pg_temp.h('context_write','other-owner',pg_temp.ctx(4,99))->>'written','true','and has a row on one of the same days');

select is(pg_temp.listed('history-owner',7),array[pg_temp.d(6),pg_temp.d(4),pg_temp.d(2),pg_temp.d(0)],'seven days lists only the days that have a row, oldest first, gaps left out');
select is((pg_temp.hist('history-owner',7)->'history'->>'from') || ' ' || (pg_temp.hist('history-owner',7)->'history'->>'to'),pg_temp.d(6) || ' ' || pg_temp.d(0),'and names the window it covers');
select is((select array_agg((d->'recovery'->>'score')::numeric order by n) from jsonb_array_elements(pg_temp.hist('history-owner',7)->'history'->'days') with ordinality as x(d,n)),array[51,58,60,64]::numeric[],'with this owner''s values, never the other owner''s');
select is(pg_temp.hist('history-owner',7)->'history'->'days'->1,
  (select jsonb_build_object('day',s->>'day','recovery',s->'recovery','form',s->'form','weight',s->'weight') from (select pg_temp.h('scores_read','history-owner',jsonb_build_object('day',pg_temp.d(4)))->'scores' as s) q),'each day is the pillars the day read returns for it');
select is(pg_temp.listed('history-owner',30),array[pg_temp.d(29),pg_temp.d(9),pg_temp.d(6),pg_temp.d(4),pg_temp.d(2),pg_temp.d(0)],'thirty days reaches the older rows, oldest first');
select is(pg_temp.listed('history-owner',90),array[pg_temp.d(40),pg_temp.d(29),pg_temp.d(9),pg_temp.d(6),pg_temp.d(4),pg_temp.d(2),pg_temp.d(0)],'ninety days reaches all seven');

-- A hundred consecutive days: the window is the cap.
select is(pg_temp.h('consent_grant','full-owner',pg_temp.grant_body('grant-f-storage1'))->'consent'->>'status','granted','a third owner grants storage');
select is((select count(*)::int from generate_series(0,99) g where pg_temp.h('context_write','full-owner',pg_temp.ctx(g,50))->>'written' = 'true'),100,'and has a hundred days of rows');
select is(cardinality(pg_temp.listed('full-owner',90)),90,'ninety days returns ninety entries of the hundred stored');
select is((pg_temp.listed('full-owner',90))[1] || ' ' || (pg_temp.listed('full-owner',90))[90],pg_temp.d(89) || ' ' || pg_temp.d(0),'the newest ninety, oldest first');
select is(cardinality(pg_temp.listed('full-owner',30)) || '/' || cardinality(pg_temp.listed('full-owner',7)),'30/7','thirty and seven days return thirty and seven');

select is((select count(*)::int from unnest(array[
  '{}'::jsonb, '{"days":14}', '{"days":"7"}', '{"days":7,"owner":"other-owner"}', '"week"', '{"days":null}', '{"days":90.5}', '{"days":0}', '{"days":7.0}', '{"days":[7]}', '{"days":true}'
]) bad where pg_temp.h('scores_history','history-owner',bad)->>'error' = 'invalid_request'),11,'every window but 7, 30 and 90, and every malformed body, is refused');
select is(pg_temp.hist('nobody',7),'{"error":"not_linked"}'::jsonb,'an unknown owner object is not linked');

-- The window ends on the owner's own today. One of these two zones is on a different date from UTC at any moment.
select is(pg_temp.h('consent_grant','east-owner',pg_temp.grant_body('grant-e-storage1'))->'consent'->>'status','granted','an owner far east of UTC grants storage');
select is((select count(*)::int from unnest(array[pg_temp.ctz('Pacific/Kiritimati',0,61),pg_temp.ctz('Pacific/Kiritimati',6,62),pg_temp.ctz('Pacific/Kiritimati',7,63)]) c where pg_temp.h('context_write','east-owner',c)->>'written' = 'true'),3,'with rows today, six days ago and seven days ago by their own clock');
select is(pg_temp.listed('east-owner',7) || array[pg_temp.hist('east-owner',7)->'history'->>'to'],array[pg_temp.dz('Pacific/Kiritimati',6),pg_temp.dz('Pacific/Kiritimati',0),pg_temp.dz('Pacific/Kiritimati',0)],'seven days is their own seven, ending on their own today');
select is(pg_temp.h('consent_grant','west-owner',pg_temp.grant_body('grant-w-storage1'))->'consent'->>'status','granted','an owner far west of UTC grants storage');
select is((select count(*)::int from unnest(array[pg_temp.ctz('Pacific/Pago_Pago',0,61),pg_temp.ctz('Pacific/Pago_Pago',6,62),pg_temp.ctz('Pacific/Pago_Pago',7,63)]) c where pg_temp.h('context_write','west-owner',c)->>'written' = 'true'),3,'with the same three rows by their own clock');
select is(pg_temp.listed('west-owner',7) || array[pg_temp.hist('west-owner',7)->'history'->>'to'],array[pg_temp.dz('Pacific/Pago_Pago',6),pg_temp.dz('Pacific/Pago_Pago',0),pg_temp.dz('Pacific/Pago_Pago',0)],'seven days is their own seven too');

-- A day carries only its pillars, and backfilled when the row says so.
select ok((select bool_and((select array_agg(k order by k) from jsonb_object_keys(d) k) = array['day','form','recovery','weight']) from jsonb_array_elements(pg_temp.hist('history-owner',90)->'history'->'days') d),'every day carries its pillars and nothing else: no readings, drivers, windows, sleep debt or freshness');
alter table public.health_context_daily add column backfilled boolean;
update public.health_context_daily set backfilled = true where user_id = 'e1000000-0000-0000-0000-0000000000e1' and day = (now() at time zone 'UTC')::date - 4;
update public.health_context_daily set backfilled = false where user_id = 'e1000000-0000-0000-0000-0000000000e1' and day = (now() at time zone 'UTC')::date - 2;
select is((select array_agg(d->>'day' order by n) from jsonb_array_elements(pg_temp.hist('history-owner',7)->'history'->'days') with ordinality as x(d,n) where d ? 'backfilled'),array[pg_temp.d(4)],'once the row has a backfilled column, only a true one is returned, and it is returned as true');
select is(pg_temp.hist('history-owner',7)->'history'->'days'->1->'backfilled','true'::jsonb,'as the boolean true');

-- Withdrawing storage deletes the rows, so the history goes with them, and another owner's stays.
select is(pg_temp.h('consent_withdraw','history-owner',jsonb_build_object('request_id','withdraw-h-store1','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is(pg_temp.hist('history-owner',90),'{"unavailable":"consent_withdrawn"}'::jsonb,'and every window then says so, with no row beside it');
select is(pg_temp.listed('other-owner',7),array[pg_temp.d(4)],'while the other owner still has their own day');

select * from finish();
rollback;
