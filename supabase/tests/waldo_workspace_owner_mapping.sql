begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
insert into waldo.owners(id,do_name) values('10000000-0000-0000-0000-000000000001','workspace-owner');
create function pg_temp.bind(env text, ns text, name text, did text) returns jsonb language sql as $$
 select waldo.workspace_owner_binding(env,ns,name,did,jsonb_build_array(env,ns,name,did)::text,extract(epoch from now())::bigint,
 encode(extensions.hmac(extract(epoch from now())::bigint::text || '.workspace.bind.' || encode(extensions.digest(jsonb_build_array(env,ns,name,did)::text,'sha256'),'hex'),'fixture-router','sha256'),'hex'))
$$;
select is(pg_temp.bind('staging','ns','workspace-owner','did')->>'owner_id','10000000-0000-0000-0000-000000000001','signed bind resolves canonical UUID');
select is(pg_temp.bind('staging','ns','workspace-owner','did')->>'mapping_version','1','same binding replay is stable');
select is(pg_temp.bind('staging','ns','workspace-owner','other-id'),null,'changed DO id cannot reinterpret name');
select is(pg_temp.bind('staging','ns','other-owner','did'),null,'unknown owner cannot inherit locator');
select is(pg_temp.bind('production','ns','workspace-owner','did')->>'environment','production','separate environment map');
select is(pg_temp.bind('staging','ns2','workspace-owner','did'),null,'namespace replacement requires explicit reviewed relocation');
select throws_ok($q$select waldo.workspace_owner_binding('staging','ns','workspace-owner','did','["staging","ns","workspace-owner","did"]',extract(epoch from now())::bigint,'forged')$q$,'42501','unsigned router call','unsigned map rejected');
select throws_ok($q$select waldo.workspace_owner_binding('staging','ns','workspace-owner','did','["production","ns","workspace-owner","did"]',extract(epoch from now())::bigint,'forged')$q$,'42501','workspace locator mismatch','locator substitution rejected');
update waldo.owners set state='suspended' where do_name='workspace-owner';
select is(pg_temp.bind('staging','ns','workspace-owner','did'),null,'suspended binding refused');
update waldo.owners set state='active' where do_name='workspace-owner';
select is(pg_temp.bind('staging','ns','workspace-owner','did')->>'state_version','2','resume advances lifecycle epoch without moving map');
delete from waldo.owners where do_name='workspace-owner';
select is((select count(*) from waldo.workspace_owner_mappings),2::bigint,'all locator maps survive owner deletion');
insert into waldo.owners(id,do_name) values('10000000-0000-0000-0000-000000000002','workspace-owner');
select is(pg_temp.bind('staging','ns','workspace-owner','did'),null,'new owner cannot inherit deleted owner locator');
select * from finish();
rollback;
