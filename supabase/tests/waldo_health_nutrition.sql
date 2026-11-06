begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 7: a food entry from the phone's health store. Every value here is synthetic.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.food(id text,kcal numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',0,'signal','nutrition','unit','kilocalories','value',kcal,'day',((now()-interval '180 minutes') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(now()-interval '180 minutes'),'end_at',pg_temp.iso(now()-interval '180 minutes'),'utc_offset_minutes',0) || extra $$;
create function pg_temp.batch(rid text,samples jsonb,deletions jsonb default '[]',per_sample boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions',deletions)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.rejected(idx int) returns jsonb language sql as $$ select jsonb_build_object('change','sample','index',idx,'signal','nutrition','reason','invalid_sample') $$;
create function pg_temp.stored(sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='food-owner' and s.sample_id=sid $$;
create function pg_temp.series() returns jsonb language sql as $$
  select pg_temp.h('series_read','food-owner',jsonb_build_object('from',((now() at time zone 'UTC')::date-3)::text,'to',((now() at time zone 'UTC')::date+1)::text,'signals','["nutrition"]'::jsonb)) $$;
insert into auth.users(id,email) values ('7f100000-0000-0000-0000-0000000000f1','food@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('7f300000-0000-0000-0000-0000000000f3','7f100000-0000-0000-0000-0000000000f1','food-owner','food@example.invalid');
select pg_temp.h('consent_grant','food-owner',jsonb_build_object('request_id','grant-food-st1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true));

select is(pg_temp.h('ingest','food-owner',pg_temp.batch('food-all-000001',jsonb_build_array(
  pg_temp.food('HK:lunch',612.4,'{"protein_g":38.5,"carbohydrate_g":64,"fat_g":21.2,"meal":"lunch","origin":{"read_api":"healthkit","source_bundle_id":"com.example.foodlog"}}'),
  pg_temp.food('HK:snack',180)))) ->>'accepted','2','a food entry with its grams and meal, and one with energy alone, are stored');
select is(pg_temp.stored('HK:lunch')->>'protein_g','38.5','an entry keeps its grams as sent');
select is(pg_temp.h('ingest','food-owner',pg_temp.batch('food-again-0001',jsonb_build_array(pg_temp.food('HK:snack',180))))->>'ignored','1','the same entry again is ignored, keyed by its store id');

-- Per sample: each bad entry is named, and none is stored.
create temp table mixed as select pg_temp.h('ingest','food-owner',pg_temp.batch('food-mixed-0001',jsonb_build_array(
  pg_temp.food('kj',612,'{"unit":"kilojoules"}'),
  pg_temp.food('huge',10001),
  pg_temp.food('mg',600,'{"protein_g":38500}'),
  pg_temp.food('text-g',600,'{"fat_g":"21g"}'),
  pg_temp.food('brunch',600,'{"meal":"brunch"}'),
  pg_temp.food('named',600,'{"name":"Chicken salad"}'),
  pg_temp.food('ok',350,'{"meal":"dinner"}')),'[]',true)) as r;
select is((select r->>'accepted' from mixed),'1','a per-sample batch stores its one good entry');
select is((select r->'rejected' from mixed),jsonb_build_array(pg_temp.rejected(0),pg_temp.rejected(1),pg_temp.rejected(2),pg_temp.rejected(3),pg_temp.rejected(4),pg_temp.rejected(5)),
  'and refuses kilojoules, a day''s worth in one entry, milligrams as grams, grams as text, a meal outside the five words and a food''s name');
select ok(pg_temp.stored('named') is null and pg_temp.stored('mg') is null,'no refused entry is stored');
select ok((select r from mixed)::text !~ 'Chicken|38500','the receipt carries no value or text of a refused entry');

-- The series read returns an entry's grams and meal, and never its origin.
select is((select s->'nutrition' from jsonb_array_elements(pg_temp.series()->'sources'->0->'samples') s where s->>'value' = '612.4'),
  '{"protein_g":38.5,"carbohydrate_g":64,"fat_g":21.2,"meal":"lunch"}'::jsonb,'the read returns an entry''s grams and meal');
select ok(pg_temp.series()::text !~ 'foodlog|healthkit','and never the app that wrote it');
select is((select count(*)::int from jsonb_array_elements(pg_temp.series()->'sources'->0->'samples') s where s ? 'nutrition'),2,'an entry with energy alone carries no nutrition key');

-- A deletion removes an entry, and withdrawing storage removes every one.
select is(pg_temp.h('ingest','food-owner',pg_temp.batch('food-del-000001','[]',jsonb_build_array(jsonb_build_object('sample_id','HK:snack','signal','nutrition','revision',1))))->>'deleted','1','a deletion of a food entry removes it');
select pg_temp.h('consent_withdraw','food-owner',jsonb_build_object('request_id','withdraw-food-1','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='food-owner' and s.signal='nutrition'),0,'withdrawing storage removes every food entry');
select * from finish();
rollback;
