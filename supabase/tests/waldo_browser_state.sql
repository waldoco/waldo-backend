-- Source fixture only: run on separately approved disposable/staging DB after migration.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id) values ('30000000-0000-0000-0000-000000000091');
insert into waldo.owners(id,do_name,auth_user_id) values
 ('10000000-0000-0000-0000-000000000091','browser-fixture','30000000-0000-0000-0000-000000000091');
insert into waldo.presences(id,owner_id,provider,subject) values
 ('20000000-0000-0000-0000-000000000091','10000000-0000-0000-0000-000000000091','telegram','81191');
insert into waldo.workspace_owner_mappings(environment,namespace,do_name,do_id,owner_id)
 values('staging','browser-fixture','browser-fixture','physical-fixture','10000000-0000-0000-0000-000000000091');
-- Independent compact tuple construction corresponds to JS JSON.stringify's tuple.
create temporary table browser_scope_fixture as
 select jsonb_build_object('binding',jsonb_build_object('ownerId',o.id,'environment','staging','siteOrigin','https://synthetic.example','accountId','CaseSensitive','generation',1),
 'consentRevision','40000000-0000-0000-0000-000000000091','namespace','browser-fixture','doId','physical-fixture','subject',p.subject,
 'expiresAt',floor(extract(epoch from now())*1000)::bigint+600000,
 'sitePolicy',jsonb_build_object('origins',jsonb_build_array('https://synthetic.example'),'cookieDomains',jsonb_build_array('synthetic.example')),
 'custodyDigest',encode(extensions.digest(format('[%s,%s,%s,%s,%s,%s,%s,%s]',to_json(o.id),to_json(o.auth_user_id),to_json(o.do_name),to_json(p.id),to_json(p.provider),to_json(p.subject),to_json(o.state_version),to_json(o.admission_revision::text)),'sha256'),'hex')) scope
 from waldo.owners o join waldo.presences p on p.owner_id=o.id where o.do_name='browser-fixture';
create function pg_temp.browser(action text,state text default null,revision bigint default null) returns jsonb language sql as $$
 select waldo.proxy_browser_state('browser-fixture',(select scope from browser_scope_fixture),action,state,revision)
$$;
select ok(not has_function_privilege('anon','waldo.proxy_browser_state(text,jsonb,text,text,bigint)','EXECUTE'),'anon cannot call persistence RPC');
select ok(not has_function_privilege('authenticated','waldo.proxy_browser_state(text,jsonb,text,text,bigint)','EXECUTE'),'authenticated cannot call persistence RPC');
select ok(has_function_privilege('service_role','waldo.proxy_browser_state(text,jsonb,text,text,bigint)','EXECUTE'),'existing EF role can call RPC');
select is(pg_temp.browser('load'),'{"state":null,"revision":0}'::jsonb,'new scope has no state; compact custody digest accepted');
select is(pg_temp.browser('save','{"cookies":[],"origins":[]}',0),'{"saved":true,"revision":1}'::jsonb,'first save creates native Vault state');
select is(pg_temp.browser('save','{"cookies":[],"origins":[]}',0),null,'stale CAS cannot overwrite');
select is(pg_temp.browser('load')->>'state','{"cookies":[],"origins":[]}','load native state');
select is(waldo.proxy_secret('browser-fixture',(select id from waldo.connections where provider='browser_state' and owner_id='10000000-0000-0000-0000-000000000091')),null,'Google secret rail cannot decrypt browser state');
select is((select count(*) from waldo.proxy_access('browser-fixture',(select id from waldo.connections where provider='browser_state' and owner_id='10000000-0000-0000-0000-000000000091'))),0::bigint,'Google access rail excludes browser state');
select is(waldo.proxy_health('browser-fixture',(select id from waldo.connections where provider='browser_state' and owner_id='10000000-0000-0000-0000-000000000091'),''),false,'Google health cannot mutate browser state');
select is(waldo.proxy_store('browser-fixture','browser_state','CaseSensitive','','unexpected'),null,'generic store cannot create browser state');
select is(waldo.proxy_browser_state('browser-fixture',jsonb_set((select scope from browser_scope_fixture),'{doId}','"foreign"'),'load'),null,'foreign physical mapping denied');
select is(waldo.proxy_browser_state('browser-fixture',jsonb_set((select scope from browser_scope_fixture),'{custodyDigest}',to_jsonb(repeat('0',64))),'load'),null,'changed custody denied');
select is(pg_temp.browser('revoke')->>'revoked','true','revoke deletes state');
select is(pg_temp.browser('save','{"cookies":[],"origins":[]}',1),null,'delayed save cannot revive revoked generation');
select is((select count(*) from vault.decrypted_secrets s join waldo.connections c on c.secret_id=s.id where c.provider='browser_state' and c.owner_id='10000000-0000-0000-0000-000000000091'),0::bigint,'no Vault secret after revocation');
update browser_scope_fixture set scope=jsonb_set(scope,'{binding,generation}','2');
select is(pg_temp.browser('revoke')->>'revoked','true','revoke before first save retains tombstone');
select is(pg_temp.browser('save','{"cookies":[],"origins":[]}',0),null,'first save cannot revive tombstone');
update browser_scope_fixture set scope=jsonb_set(scope,'{binding,generation}','3');
select is(pg_temp.browser('save','{"cookies":[],"origins":[]}',0)->>'saved','true','renewed generation can save');
select is(waldo.proxy_browser_state('browser-fixture',jsonb_set((select scope from browser_scope_fixture),'{expiresAt}','1'),'load'),null,'expired state denied');
update waldo.presences set state='unlinked' where subject='81191';
select is(pg_temp.browser('load'),null,'unlink denies restore');
select is(pg_temp.browser('revoke')->>'revoked','true','cleanup still removes exact retained state after unlink');
select * from finish();
rollback;
