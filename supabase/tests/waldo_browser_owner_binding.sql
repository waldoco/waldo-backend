begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
insert into waldo.owners(id,do_name) values('10000000-0000-0000-0000-000000000001','browser-owner');
insert into waldo.presences(id,owner_id,provider,subject) values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','telegram','81101');
create function pg_temp.bind(env text, ns text, name text, did text, provider text, subject text) returns jsonb language sql as $$
 select waldo.browser_owner_binding(env,ns,name,did,provider,subject,jsonb_build_array(env,ns,name,did,provider,subject)::text,extract(epoch from now())::bigint,
 encode(extensions.hmac(extract(epoch from now())::bigint::text || '.browser.bind.' || encode(extensions.digest(jsonb_build_array(env,ns,name,did,provider,subject)::text,'sha256'),'hex'),'fixture-router','sha256'),'hex'))
$$;
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101'),null,'missing mapping denied; read cannot provision it');
select is((select count(*) from waldo.workspace_owner_mappings),0::bigint,'read creates no mappings');
insert into waldo.workspace_owner_mappings(environment,namespace,do_name,do_id,owner_id) values('staging','ns','browser-owner','did','10000000-0000-0000-0000-000000000001');
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101')->>'owner_id','10000000-0000-0000-0000-000000000001','signed locator returns canonical owner');
select is((select count(*) from jsonb_object_keys(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101'))),7::bigint,'strict private binding projection');
select is(pg_temp.bind('production','ns','browser-owner','did','telegram','81101'),null,'production denied');
select is(pg_temp.bind('staging','foreign','browser-owner','did','telegram','81101'),null,'foreign namespace denied');
select is(pg_temp.bind('staging','ns','browser-owner','foreign','telegram','81101'),null,'foreign physical id denied');
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81102'),null,'foreign subject denied');
select is(pg_temp.bind('staging','ns','browser-owner','did','whatsapp','81101'),null,'foreign provider denied');
select throws_ok($q$select waldo.browser_owner_binding('staging','ns','browser-owner','did','telegram','81101','["staging","ns","browser-owner","did","telegram","81101"]',extract(epoch from now())::bigint,'forged')$q$,'42501','unsigned router call','forged signature denied');
select throws_ok($q$select waldo.browser_owner_binding('staging','ns','browser-owner','did','telegram','81101','["staging","ns","browser-owner","did","telegram","81101"]',null,null)$q$,'42501','unsigned router call','null signing values fail closed');
select throws_ok($q$select waldo.browser_owner_binding('staging','ns','browser-owner','did','telegram','81101','["staging","ns","browser-owner","foreign","telegram","81101"]',extract(epoch from now())::bigint,'forged')$q$,'42501','browser locator mismatch','signed tuple substitution denied');
update waldo.owners set state='suspended' where do_name='browser-owner';
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101'),null,'suspended owner denied');
update waldo.owners set state='active' where do_name='browser-owner';
update waldo.presences set state='unlinked' where subject='81101';
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101'),null,'unlinked presence denied');
create temporary table previous as select admission_revision from waldo.owners where do_name='browser-owner';
insert into waldo.presences(id,owner_id,provider,subject) values('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','telegram','81101');
select is(pg_temp.bind('staging','ns','browser-owner','did','telegram','81101')->>'presence_id','20000000-0000-0000-0000-000000000002','readded presence has new identity');
select ok((pg_temp.bind('staging','ns','browser-owner','did','telegram','81101')->>'admission_revision')::bigint > (select admission_revision from previous),'readded presence advances admission revision');
select * from finish();
rollback;
