begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.runtime(name text) returns jsonb language sql as $$ select waldo.owner_runtime_authority(name,pg_temp.at(),pg_temp.sig('owner.runtime.'||name)) $$;
insert into auth.users(id,email) values
 ('c1000000-0000-0000-0000-000000000001','runtime-a@example.invalid'),
 ('d1000000-0000-0000-0000-000000000001','runtime-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','runtime-owner-a','runtime-a@example.invalid'),
 ('d3000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','runtime-owner-b','runtime-b@example.invalid');

select is(pg_temp.runtime('runtime-owner-a')->>'owner_id','c3000000-0000-0000-0000-000000000001','an active Auth owner resolves its canonical owner id');
select is(pg_temp.runtime('runtime-owner-a')->>'auth_user_id','c1000000-0000-0000-0000-000000000001','authority names the Auth user');
select is(pg_temp.runtime('runtime-owner-a')->>'do_name','runtime-owner-a','authority echoes the locator it was asked about');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.runtime('runtime-owner-a')) k),array['admission_revision','auth_user_id','do_name','owner_id','state_version'],'authority carries exactly the five fenced fields');
select ok((pg_temp.runtime('runtime-owner-a')->>'state_version')::bigint>=0 and (pg_temp.runtime('runtime-owner-a')->>'admission_revision')::bigint>0,'authority carries the lifecycle and admission fences');
select is((select count(*)::int from waldo.presences where owner_id='c3000000-0000-0000-0000-000000000001'),0,'the authority does not need any Telegram, WhatsApp or native presence');

create temp table first_fence as select (pg_temp.runtime('runtime-owner-a')->>'admission_revision')::bigint as revision;
insert into waldo.presences(owner_id,provider,subject) values('c3000000-0000-0000-0000-000000000001','ios','synthetic-native-owner-a');
select is(pg_temp.runtime('runtime-owner-a')->>'owner_id','c3000000-0000-0000-0000-000000000001','linking a surface keeps the same owner identity');
select ok((pg_temp.runtime('runtime-owner-a')->>'admission_revision')::bigint>(select revision from first_fence),'linking a surface advances the admission fence');
update waldo.presences set state='unlinked',unlinked_at=now() where owner_id='c3000000-0000-0000-0000-000000000001';
select is(pg_temp.runtime('runtime-owner-a')->>'owner_id','c3000000-0000-0000-0000-000000000001','unlinking a surface keeps the owner authority');

update waldo.owners set state='suspended' where do_name='runtime-owner-a';
select is(pg_temp.runtime('runtime-owner-a'),null,'a suspended owner has no authority');
select is(pg_temp.runtime('runtime-owner-b')->>'owner_id','d3000000-0000-0000-0000-000000000001','another owner is unaffected');
update waldo.owners set state='active' where do_name='runtime-owner-a';
select is(pg_temp.runtime('runtime-owner-a')->>'owner_id','c3000000-0000-0000-0000-000000000001','a reactivated owner has authority again');

delete from auth.users where id='c1000000-0000-0000-0000-000000000001';
select is(pg_temp.runtime('runtime-owner-a'),null,'a removed Auth identity has no authority even though its owner row remains');
select is(pg_temp.runtime('runtime-owner-b')->>'do_name','runtime-owner-b','deleting one Auth user does not cross owners');
select is(pg_temp.runtime('missing-owner'),null,'an unprovisioned locator resolves to nothing');

select throws_ok($$select waldo.owner_runtime_authority('runtime-owner-b',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned or invalid owner call','a forged signature is refused');
select throws_ok($$select waldo.owner_runtime_authority(null,extract(epoch from now())::bigint,'forged')$$,'42501','unsigned or invalid owner call','a null locator is refused');
select throws_ok($$select waldo.owner_runtime_authority(repeat('x',241),extract(epoch from now())::bigint,'forged')$$,'42501','unsigned or invalid owner call','an oversized locator is refused');
select is(has_function_privilege('anon','waldo.owner_runtime_authority(text,bigint,text)','execute'),true,'the signed router call reaches the function as anon');
select is(has_function_privilege('authenticated','waldo.owner_runtime_authority(text,bigint,text)','execute'),false,'signed-in members cannot call it');
select is(has_function_privilege('service_role','waldo.owner_runtime_authority(text,bigint,text)','execute'),false,'the service role cannot call it');
select * from finish();
rollback;
