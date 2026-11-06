begin;
create extension if not exists pgtap with schema extensions;
select plan(20);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The zones a personal experiment is judged on: each day's Recovery and Form zone words over a bounded range, for the model,
-- so only under live model-use consent, never a score and never a backfilled day. Synthetic owners and values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.d(back int) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.live(back int, score int, zone text) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.d(back),'timezone','UTC','basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',score,'zone',zone,'algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') $$;
create function pg_temp.zones(owner text,back_from int,back_to int) returns jsonb language sql as $$
  select pg_temp.h('zones_read',owner,jsonb_build_object('from',pg_temp.d(back_from),'to',pg_temp.d(back_to))) $$;
create function pg_temp.days(owner text,back_from int,back_to int) returns text[] language sql as $$
  select coalesce(array_agg((d->>'day') || ' ' || coalesce(d->>'recovery','none') || ' ' || coalesce(d->>'form','none') order by n),array[]::text[])
  from jsonb_array_elements(pg_temp.zones(owner,back_from,back_to)->'zones'->'days') with ordinality as x(d,n) $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000f1','zones@example.invalid'), ('f2000000-0000-0000-0000-0000000000f2','zones-other@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('f3000000-0000-0000-0000-0000000000f3','f1000000-0000-0000-0000-0000000000f1','zones-owner','zones@example.invalid'),
  ('f4000000-0000-0000-0000-0000000000f4','f2000000-0000-0000-0000-0000000000f2','zones-other','zones-other@example.invalid');

select has_function('waldo','health_zones_read',array['text','text','bigint','text'],'the zone read exists with the router-signed signature');
select ok(not has_function_privilege('authenticated','waldo.health_zones_read(text,text,bigint,text)','execute'),'a signed-in client cannot call it directly');
select ok(has_function_privilege('anon','waldo.health_zones_read(text,text,bigint,text)','execute'),'the Worker reaches it as its siblings are reached');
select throws_ok($$ select waldo.health_zones_read('zones-owner','{}',extract(epoch from now())::bigint,'0') $$,'42501',null,'an unsigned call is refused');
select is(pg_temp.zones('nobody',3,0),'{"error":"not_linked"}'::jsonb,'an unknown owner object is not linked');
select is((select count(*)::int from unnest(array[
  '{}'::jsonb, '"week"', jsonb_build_object('from',pg_temp.d(3)), jsonb_build_object('from',pg_temp.d(3),'to',pg_temp.d(0),'owner','zones-other'),
  jsonb_build_object('from',pg_temp.d(0),'to',pg_temp.d(3)), jsonb_build_object('from',pg_temp.d(56),'to',pg_temp.d(0)),
  '{"from":"2026-02-30","to":"2026-03-02"}', '{"from":"2026-1-1","to":"2026-01-02"}', '{"from":20260101,"to":"2026-01-02"}'
]) bad where pg_temp.h('zones_read','zones-owner',bad)->>'error' = 'invalid_request'),9,'a missing or extra key, a reversed range, more than 56 days and a malformed date are refused');

-- Storage alone holds the rows; the model reads them only once the owner grants model use.
select is(pg_temp.h('consent_grant','zones-owner',pg_temp.grant_body('grant-z-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is((select count(*)::int from unnest(array[pg_temp.live(0,72,'good'),pg_temp.live(1,45,'moderate'),pg_temp.live(3,30,'low'),pg_temp.live(9,85,'high')]) r
  where pg_temp.h('context_write','zones-owner',r)->>'written' = 'true'),4,'four live days are written');
select is(pg_temp.h('context_write','zones-owner',pg_temp.live(5,60,'good') || '{"backfilled":true}'::jsonb)->>'written','true','and one backfilled day');
select is(pg_temp.zones('zones-owner',9,0),jsonb_build_object('zones',jsonb_build_object('from',pg_temp.d(9),'to',pg_temp.d(0),'days','[]'::jsonb)),'without model use nothing is shown');
select is(pg_temp.h('consent_grant','zones-owner',pg_temp.grant_body('grant-z-model0001','model_processing'))->'consent'->>'status','granted','the owner grants model use');

select is(pg_temp.days('zones-owner',9,0),array[pg_temp.d(9)||' high none',pg_temp.d(3)||' low none',pg_temp.d(1)||' moderate none',pg_temp.d(0)||' good none'],
  'each live day in the range, oldest first, as its zone words; a pillar with no zone is null and a day with no row is absent');
select ok(not (pg_temp.d(5) = any(pg_temp.days('zones-owner',9,0))),'a backfilled day never reaches the model');
select is(pg_temp.days('zones-owner',3,1),array[pg_temp.d(3)||' low none',pg_temp.d(1)||' moderate none'],'the range bounds both ends');
select ok(pg_temp.zones('zones-owner',9,0)::text !~ 'score|72|85','no score reaches the answer');
select is((select array_agg(k order by k) from jsonb_array_elements(pg_temp.zones('zones-owner',9,0)->'zones'->'days') d, jsonb_object_keys(d) k where d->>'day' = pg_temp.d(0)),
  array['day','form','recovery'],'a day carries its date and its two zone words only');
select ok(pg_temp.zones('zones-owner',55,0)->'zones'->'days' is not null,'56 days, a 28-day trial and the 28 before it, is the widest range');

-- Another owner's days never appear, and withdrawing model use hides them again.
select is(pg_temp.days('zones-other',9,0),array[]::text[],'another owner sees none of these days');
select is(pg_temp.h('consent_withdraw','zones-owner',jsonb_build_object('request_id','withdraw-z-model01','source','apple','purpose','model_processing','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws model use');
select is(pg_temp.days('zones-owner',9,0),array[]::text[],'and the model reads none of their days again');
select * from finish();
rollback;
