begin;
create extension if not exists pgtap with schema extensions;
select plan(43);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The owner's medicines on the health plane (ADR-0081 amendment of 1 November 2026): a name as the owner says it, daily times,
-- an optional count and reorder point, and doses taken or skipped. Signed reads and writes only; no field holds a dose amount.
-- Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,body,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.sweep(body text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_retention_sweep(body,a,pg_temp.sig('health.retention_sweep.'||md5(body),a)); end $$;
create function pg_temp.w(owner text,body jsonb) returns jsonb language sql as $$ select pg_temp.h('medications_write',owner,body::text) $$;
create function pg_temp.meds(owner text) returns jsonb language sql as $$ select pg_temp.h('medications_read',owner)->'medications' $$;
create function pg_temp.at(hhmm text,days integer default 0) returns text language sql as $$
  select to_char((date_trunc('day',now() at time zone 'UTC') + (hhmm||':00')::time - make_interval(days => days)),'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.dose(owner text,id text,hhmm text,status text,days integer default 0) returns jsonb language sql as $$
  select pg_temp.w(owner,jsonb_build_object('op','dose','medication_id',id,'slot',hhmm,'due_at',pg_temp.at(hhmm,days),'status',status)) $$;

insert into auth.users(id,email) values ('6e100000-0000-0000-0000-0000000000a1','meds-a@example.invalid'),('6e100000-0000-0000-0000-0000000000b1','meds-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('6e300000-0000-0000-0000-0000000000a3','6e100000-0000-0000-0000-0000000000a1','meds-owner-a','meds-a@example.invalid'),
  ('6e300000-0000-0000-0000-0000000000b3','6e100000-0000-0000-0000-0000000000b1','meds-owner-b','meds-b@example.invalid');

select is(array(select r from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.health_medications_read(text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.health_medications_write(text,text,bigint,text)','execute')),array['anon'],'only the runtime key may call them, and a signature is still required');
select is(array(select r||'.'||t from unnest(array['anon','authenticated','service_role']) r, unnest(array['waldo.health_medications','waldo.health_medication_doses']) t
  where has_table_privilege(r,t,'select') or has_table_privilege(r,t,'insert') or has_table_privilege(r,t,'update') or has_table_privilege(r,t,'delete')),'{}'::text[],'no role reads or writes the tables directly');
select ok((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'waldo' and c.relname in ('health_medications','health_medication_doses')),'row-level security is forced on both');
select throws_ok($$ select waldo.health_medications_read('meds-owner-a','{}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged read is refused');
select throws_ok($$ select waldo.health_medications_write('meds-owner-a','{"op":"stop","medication_id":"6e900000-0000-0000-0000-000000000001"}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged write is refused');
select throws_ok(format($$ select waldo.health_medications_read('meds-owner-b','{}',%s,%L) $$,extract(epoch from now())::bigint,
  pg_temp.sig('health.medications_read.meds-owner-a.'||md5('{}'),extract(epoch from now())::bigint)),'42501','unsigned router call','one owner''s signature never reads another''s medicines');

select is(pg_temp.meds('meds-owner-a'),'[]'::jsonb,'an owner who tracks nothing reads an empty list');
-- The owner's label is kept as said, an amount included (owner ruling, 1 November 2026).
create temp table m as select pg_temp.w('meds-owner-a','{"op":"track","name":"Metformin 500 mg","times":["08:00","20:00"]}') as v;
select is((select v->>'name' from m),'Metformin 500 mg','a medicine is tracked under the owner''s own label, word for word');
select is((select v->'times' from m),'["08:00","20:00"]'::jsonb,'with its daily times');
select ok((select (v->>'id')::uuid is not null and v->'supply' = 'null'::jsonb and v->'doses' = '[]'::jsonb from m),'under an opaque id, with no count and no doses yet');
select is((select jsonb_agg(x->>'name') from jsonb_array_elements(pg_temp.meds('meds-owner-a')) x),'["Metformin 500 mg"]'::jsonb,'the read returns it');
select is(pg_temp.meds('meds-owner-b'),'[]'::jsonb,'another owner never sees it');

select is((select count(*)::int from unnest(array[
  '{"op":"track","name":"","times":["08:00"]}', '{"op":"track","name":"'||repeat('x',81)||'","times":["08:00"]}',
  '{"op":"track","name":"Two\nlines","times":["08:00"]}', '{"op":"track","name":"Vitamin D","times":[]}',
  '{"op":"track","name":"Vitamin D","times":["01:00","02:00","03:00","04:00","05:00","06:00","07:00"]}',
  '{"op":"track","name":"Vitamin D","times":["24:00"]}', '{"op":"track","name":"Vitamin D","times":["8:00"]}',
  '{"op":"track","name":"Vitamin D","times":["08:00","08:00"]}', '{"op":"track","name":"Vitamin D","times":"08:00"}',
  '{"op":"track","name":"Vitamin D","times":["08:00"],"dose":"2 tablets"}', '{"op":"track","name":"Vitamin D","times":["08:00"],"amount":2}',
  '{"op":"track","name":"Vitamin D","times":["08:00"],"instruction":"with food"}', '{"op":"track","name":"Vitamin D","times":["08:00"],"supply":-1}',
  '{"op":"track","name":"Vitamin D","times":["08:00"],"supply":2001}', '{"op":"track","name":"Vitamin D","times":["08:00"],"supply":1.5}',
  '{"op":"track","name":"Vitamin D","times":["08:00"],"refill_at":0}', '{"op":"track","name":"Vitamin D","times":["08:00"],"medication_id":"not-a-uuid"}',
  '{"op":"track","times":["08:00"]}', '{"op":"remind","name":"Vitamin D","times":["08:00"]}', '{"name":"Vitamin D","times":["08:00"]}',
  '[]', 'null', 'not json'
]) bad where pg_temp.h('medications_write','meds-owner-a',bad)->>'error' = 'invalid_request'),23,'every write outside the closed shape is refused, and none has a dose, amount or instruction field');
select is(jsonb_array_length(pg_temp.meds('meds-owner-a')),1,'and none of them stored anything');
select is(pg_temp.h('medications_read','meds-owner-a','{"medication_id":"x"}'),'{"error":"invalid_request"}'::jsonb,'the read takes no arguments');
select is(pg_temp.h('medications_read','nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');
select throws_ok($$ update waldo.health_medications set name = repeat('x', 81) $$,'23514',null,'the table itself holds the name''s bound');

-- Changing a medicine replaces its name and times and keeps what was not said.
select is(pg_temp.w('meds-owner-a',jsonb_build_object('op','track','medication_id',(select v->>'id' from m),'name','Metformin 500 mg','times',jsonb_build_array('08:00'),'supply',30,'refill_at',5))
  - 'supply_set_at' - 'created_at' - 'id' - 'doses','{"name":"Metformin 500 mg","times":["08:00"],"supply":30,"refill_at":5}'::jsonb,'a change by id replaces the times and sets the count and reorder point');
select is(pg_temp.w('meds-owner-a',jsonb_build_object('op','track','medication_id',(select v->>'id' from m),'name','Metformin 500 mg','times',jsonb_build_array('08:00')))->'supply','30'::jsonb,'a change that says no count keeps the one given');
select is(pg_temp.w('meds-owner-b',jsonb_build_object('op','track','medication_id',(select v->>'id' from m),'name','Other','times',jsonb_build_array('09:00'))),'{"error":"not_found"}'::jsonb,'another owner cannot change it');
select is(pg_temp.w('meds-owner-a','{"op":"track","medication_id":"6e900000-0000-0000-0000-000000000001","name":"X","times":["08:00"]}'),'{"error":"not_found"}'::jsonb,'an unknown id is not found');

-- Doses: taken or skipped, on one of the medicine's own times. A taken dose counts the supply down once; changing it back
-- gives it back. A dose from before the count was given does not touch it.
update waldo.health_medications set supply_set_at = now() - interval '2 days' where id = (select (v->>'id')::uuid from m);
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','taken')->'supply','29'::jsonb,'a dose taken counts the supply down');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','taken')->'supply','29'::jsonb,'saying so twice counts it once');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','skipped')->'supply','30'::jsonb,'changing it to skipped gives it back');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','taken',3)->'supply','30'::jsonb,'a dose from before the count was given leaves it');
select is((select jsonb_agg(d->>'status' order by d->>'due_at') from jsonb_array_elements(pg_temp.meds('meds-owner-a')->0->'doses') d),'["taken","skipped"]'::jsonb,'the read returns the doses said, oldest first');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'20:00','taken',1),'{"error":"invalid_request"}'::jsonb,'a dose at a time the medicine is not taken is refused');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','missed'),'{"error":"invalid_request"}'::jsonb,'missed is never stored: it is what nothing said means');
select is(pg_temp.dose('meds-owner-a',(select v->>'id' from m),'08:00','taken',9),'{"error":"invalid_request"}'::jsonb,'a dose more than eight days back is refused');
select is(pg_temp.w('meds-owner-a',jsonb_build_object('op','dose','medication_id',(select v->>'id' from m),'slot','08:00','due_at',to_char(now() + interval '13 hours','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'status','taken')),
  '{"error":"invalid_request"}'::jsonb,'a dose more than twelve hours ahead is refused');
select is(pg_temp.dose('meds-owner-b',(select v->>'id' from m),'08:00','taken'),'{"error":"not_found"}'::jsonb,'another owner cannot log a dose on it');

-- The owner's statement, not a source's reading: withdrawing a source and the source purge leave both tables.
select pg_temp.h('consent_grant','meds-owner-a',jsonb_build_object('request_id','meds-grant-store1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true)::text);
select is(pg_temp.h('consent_withdraw','meds-owner-a',jsonb_build_object('request_id','meds-withdraw-01','source','apple','purpose','storage_compute','expected_epoch',1)::text)->'consent'->>'status','withdrawn','the owner withdraws a source');
select is(pg_temp.h('purge','meds-owner-a')->>'state','completed','and the health purge runs');
select is((select jsonb_array_length(x->'doses') from jsonb_array_elements(pg_temp.meds('meds-owner-a')) x),2,'and the medicine and its doses stay');

-- Doses age out at 90 days through the retention sweep, which also finds an owner whose only expired rows are doses.
insert into waldo.health_medication_doses(medication_id,owner_id,due_at,slot,status,logged_at)
  values ((select (v->>'id')::uuid from m),'6e300000-0000-0000-0000-0000000000a3',now() - interval '91 days','08:00','taken',now() - interval '91 days');
select is((select count(*)::int from waldo.health_samples s where s.owner_id = '6e300000-0000-0000-0000-0000000000a3'),0,'the owner holds no reading the sweep would find');
select is(pg_temp.sweep('{"limit":10}')->>'owners','1','the sweep ages out the owner whose only expired row is a dose');
select is((select count(*)::int from waldo.health_medication_doses where owner_id = '6e300000-0000-0000-0000-0000000000a3'),2,'the sweep removes the dose older than 90 days and keeps the recent ones');

-- Stopping a medicine deletes it and its doses.
select is(pg_temp.w('meds-owner-a',jsonb_build_object('op','stop','medication_id',(select v->>'id' from m))),'{"stopped":true}'::jsonb,'stopping a medicine says so');
select is((select count(*)::int from waldo.health_medication_doses where medication_id = (select (v->>'id')::uuid from m)),0,'and its doses are gone');
select is(pg_temp.w('meds-owner-a',jsonb_build_object('op','stop','medication_id',(select v->>'id' from m))),'{"stopped":false}'::jsonb,'stopping it again finds nothing');

-- At most 20 medicines per owner.
select pg_temp.w('meds-owner-b',jsonb_build_object('op','track','name','Med '||n,'times',jsonb_build_array('09:00'))) from generate_series(1,20) n;
select is(pg_temp.w('meds-owner-b','{"op":"track","name":"One more","times":["09:00"]}'),'{"error":"limit_reached"}'::jsonb,'a 21st medicine is refused');

select ok(waldo.delete_owner('meds-owner-b',extract(epoch from now())::bigint,pg_temp.sig('delown.meds-owner-b',extract(epoch from now())::bigint)),'the account is deleted');
select is((select count(*)::int from waldo.health_medications where owner_id='6e300000-0000-0000-0000-0000000000b3'),0,'and its medicines go with it');

select * from finish();
rollback;
