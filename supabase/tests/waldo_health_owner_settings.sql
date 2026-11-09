begin;
create extension if not exists pgtap with schema extensions;
select plan(23);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The owner's stated sleep need, a health-plane setting (ADR-0081 section 1, 27 October 2026: "Need is the owner-confirmed figure
-- if there is one"). Signed reads and writes only, one row per owner, gone with the account, kept through a source's withdrawal.
-- Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,body,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.need(owner text) returns jsonb language sql as $$ select pg_temp.h('settings_read',owner)->'sleep_need_minutes' $$;

insert into auth.users(id,email) values ('5e100000-0000-0000-0000-0000000000a1','need-a@example.invalid'),('5e100000-0000-0000-0000-0000000000b1','need-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('5e300000-0000-0000-0000-0000000000a3','5e100000-0000-0000-0000-0000000000a1','need-owner-a','need-a@example.invalid'),
  ('5e300000-0000-0000-0000-0000000000b3','5e100000-0000-0000-0000-0000000000b1','need-owner-b','need-b@example.invalid');

select is(array(select r from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.health_settings_read(text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.health_settings_write(text,text,bigint,text)','execute')),array['anon'],'only the runtime key may call them, and a signature is still required');
select is(array(select r from unnest(array['anon','authenticated','service_role']) r where has_table_privilege(r,'waldo.health_owner_settings','select')
  or has_table_privilege(r,'waldo.health_owner_settings','insert') or has_table_privilege(r,'waldo.health_owner_settings','update')),'{}'::text[],'no role reads or writes the table directly');
select throws_ok($$ select waldo.health_settings_read('need-owner-a','{}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged read is refused');
select throws_ok($$ select waldo.health_settings_write('need-owner-a','{"sleep_need_minutes":480}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged write is refused');
select throws_ok(format($$ select waldo.health_settings_write('need-owner-b','{"sleep_need_minutes":480}',%s,%L) $$,extract(epoch from now())::bigint,
  pg_temp.sig('health.settings_write.need-owner-a.'||md5('{"sleep_need_minutes":480}'),extract(epoch from now())::bigint)),'42501','unsigned router call','one owner''s signature never writes another''s setting');

select is(pg_temp.h('settings_read','need-owner-a'),'{"sleep_need_minutes":null,"updated_at":null}'::jsonb,'an owner who never stated one reads no need');
select is(pg_temp.h('settings_write','need-owner-a','{"sleep_need_minutes":480}')->'sleep_need_minutes','480'::jsonb,'a stated need is saved and answered back');
select ok(pg_temp.h('settings_read','need-owner-a')->>'updated_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$','and read back with when it changed');
select is(pg_temp.need('need-owner-a'),'480'::jsonb,'the read returns it');
select is(pg_temp.need('need-owner-b'),'null'::jsonb,'another owner never sees it');

select is((select count(*)::int from unnest(array[
  '{"sleep_need_minutes":359}', '{"sleep_need_minutes":601}', '{"sleep_need_minutes":450.5}', '{"sleep_need_minutes":"480"}',
  '{"sleep_need_minutes":true}', '{"sleep_need_minutes":[480]}', '{}', '{"sleep_need_minutes":480,"owner":"need-owner-b"}', '{"minutes":480}',
  '[]', 'null', '480', 'not json'
]) bad where pg_temp.h('settings_write','need-owner-a',bad)->>'error' = 'invalid_request'),13,'every write outside the closed shape is refused');
select is(pg_temp.need('need-owner-a'),'480'::jsonb,'and none of them touched the stored need');
-- JSON has one number type: a whole number written with a fraction or an exponent is that whole number, and a part minute is
-- still refused.
select is((select array_agg(pg_temp.h('settings_write','need-owner-a',body)->'sleep_need_minutes' order by n) from unnest(array[
  '{"sleep_need_minutes":450.0}', '{"sleep_need_minutes":4.2e2}', '{"sleep_need_minutes":6.00e2}'
]) with ordinality as t(body, n)),array['450','420','600']::jsonb[],'a whole number written with a fraction or an exponent is stored as that number');
select is((select count(*)::int from unnest(array[
  '{"sleep_need_minutes":480.5}', '{"sleep_need_minutes":4.805e2}', '{"sleep_need_minutes":6.001e2}', '{"sleep_need_minutes":3.59e2}', '{"sleep_need_minutes":1e400}'
]) bad where pg_temp.h('settings_write','need-owner-a',bad)->>'error' = 'invalid_request'),5,'a part minute, or a figure outside the bounds in any notation, is still refused');
select is(pg_temp.h('settings_write','need-owner-a','{"sleep_need_minutes":480}')->'sleep_need_minutes','480'::jsonb,'and the stored need is back where it was');
select is(pg_temp.h('settings_read','need-owner-a','{"day":"2026-03-30"}'),'{"error":"invalid_request"}'::jsonb,'the read takes no arguments');
select is(pg_temp.h('settings_read','nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');
select throws_ok($$ update waldo.health_owner_settings set sleep_need_minutes = 700 $$,'23514',null,'the table itself holds the engine''s bounds');

select ok((select r->'sleep_need_minutes' = 'null'::jsonb and r->>'updated_at' is not null from (select pg_temp.h('settings_write','need-owner-a','{"sleep_need_minutes":null}') r) w),
  'clearing it keeps no figure and records when');

-- The need is the owner's statement, not a source's reading: withdrawing a source leaves it, as it leaves health logs.
select pg_temp.h('settings_write','need-owner-a','{"sleep_need_minutes":420}');
select pg_temp.h('consent_grant','need-owner-a',jsonb_build_object('request_id','need-grant-store1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true)::text);
select is(pg_temp.h('consent_withdraw','need-owner-a',jsonb_build_object('request_id','need-withdraw-01','source','apple','purpose','storage_compute','expected_epoch',1)::text)->'consent'->>'status','withdrawn','the owner withdraws a source');
select is(pg_temp.need('need-owner-a'),'420'::jsonb,'and the stated need stays');

select ok(waldo.delete_owner('need-owner-a',extract(epoch from now())::bigint,pg_temp.sig('delown.need-owner-a',extract(epoch from now())::bigint)),'the account is deleted');
select is((select count(*)::int from waldo.health_owner_settings where owner_id='5e300000-0000-0000-0000-0000000000a3'),0,'and its setting goes with it');

select * from finish();
rollback;
