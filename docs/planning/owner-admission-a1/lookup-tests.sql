begin;
create extension if not exists pgtap with schema extensions;
select plan(18);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('synthetic-admission-router','waldo_router_hmac');
insert into waldo.owners(id,do_name) values('10000000-0000-0000-0000-000000000001','owner-a1');
insert into waldo.presences(id,owner_id,provider,subject) values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','telegram','1001');
create function pg_temp.binding() returns jsonb language sql as $$
select waldo.owner_message_binding('staging','fixture-ns','owner-a1','fixture-do','telegram','1001',
  '["staging","fixture-ns","owner-a1","fixture-do","telegram","1001"]',extract(epoch from now())::bigint,
  encode(extensions.hmac(extract(epoch from now())::bigint::text || '.owneradmit.' ||
    encode(extensions.digest('["staging","fixture-ns","owner-a1","fixture-do","telegram","1001"]','sha256'),'hex'),
    'synthetic-admission-router','sha256'),'hex'))
$$;
select is(pg_temp.binding()->>'owner_id','10000000-0000-0000-0000-000000000001','canonical UUID admitted');
select is(pg_temp.binding()->>'presence_id','20000000-0000-0000-0000-000000000001','exact presence row admitted');
select is(pg_temp.binding()->>'state_version','0','current lifecycle version admitted');
select is((select count(*) from waldo.workspace_owner_mappings),0::bigint,'lookup creates no workspace mapping');
select throws_ok($q$select waldo.owner_message_binding('staging','fixture-ns','owner-a1','fixture-do','telegram','1001','["staging","fixture-ns","owner-a1","fixture-do","telegram","1001"]',extract(epoch from now())::bigint,'forged')$q$,'42501','unsigned router call','unsigned lookup denied');
select throws_ok($q$select waldo.owner_message_binding('staging','fixture-ns','owner-a1','fixture-do','telegram','1001','["staging","fixture-ns","owner-a1","fixture-do","telegram","1001"]',extract(epoch from now())::bigint,null)$q$,'42501','unsigned router call','NULL signature denied');
select throws_ok($q$select waldo.owner_message_binding('staging','fixture-ns','owner-a1','fixture-do','telegram','1001','["staging","fixture-ns","owner-a1","fixture-do","telegram","1001"]',null,'forged')$q$,'42501','unsigned router call','NULL timestamp denied');
select throws_ok($q$select waldo.owner_message_binding('production','fixture-ns','owner-a1','fixture-do','telegram','1001','["production","fixture-ns","owner-a1","fixture-do","telegram","1001"]',extract(epoch from now())::bigint,'forged')$q$,'42501','owner admission locator rejected','production denied');
select throws_ok($q$select waldo.owner_message_binding('staging','fixture-ns','owner-a1','fixture-do','telegram','1001','["staging","fixture-ns","owner-a1","OTHER","telegram","1001"]',extract(epoch from now())::bigint,'forged')$q$,'42501','owner admission locator rejected','changed signed tuple denied');
update waldo.owners set state='suspended' where do_name='owner-a1';
select is(pg_temp.binding(),null,'suspended owner denied');
update waldo.owners set state='active' where do_name='owner-a1';
select is(pg_temp.binding()->>'state_version','2','reactivation changes lifecycle receipt');
update waldo.presences set state='unlinked',unlinked_at=now() where subject='1001';
select is(pg_temp.binding(),null,'unlinked presence denied');
insert into waldo.presences(id,owner_id,provider,subject) values('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','telegram','1001');
select is(pg_temp.binding()->>'presence_id','20000000-0000-0000-0000-000000000002','relink has new receipt');
select is((select count(*) from waldo.owners),1::bigint,'lookup does not provision owner');
select is(has_function_privilege('anon','waldo.owner_message_binding(text,text,text,text,text,text,text,bigint,text)','execute'),false,'proposal grants no anon execution');
select is(has_function_privilege('authenticated','waldo.owner_message_binding(text,text,text,text,text,text,text,bigint,text)','execute'),false,'proposal grants no authenticated execution');
delete from waldo.owners where do_name='owner-a1';
select is(pg_temp.binding(),null,'deleted owner denied');
insert into waldo.owners(id,do_name) values('10000000-0000-0000-0000-000000000002','owner-a1');
insert into waldo.presences(owner_id,provider,subject) values('10000000-0000-0000-0000-000000000002','telegram','1001');
select is(pg_temp.binding()->>'owner_id','10000000-0000-0000-0000-000000000002','reused locator returns new canonical owner receipt');
select * from finish();
rollback;
