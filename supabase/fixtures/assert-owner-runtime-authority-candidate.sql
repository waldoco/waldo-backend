-- Dedicated synthetic database only. Auth and owner fixtures always roll back.
begin;
insert into auth.users(id,email) values
 ('c1000000-0000-0000-0000-000000000001','runtime-a@example.invalid'),
 ('d1000000-0000-0000-0000-000000000001','runtime-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','runtime-owner-a','runtime-a@example.invalid'),
 ('d3000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','runtime-owner-b','runtime-b@example.invalid');
insert into waldo.console_sessions(owner_id,session_hash,created_at,last_seen_at) values
 ('c3000000-0000-0000-0000-000000000001',repeat('c',64),now(),now()),
 ('c3000000-0000-0000-0000-000000000001',repeat('e',64),now()-interval '13 hours',now()),
 ('d3000000-0000-0000-0000-000000000001',repeat('d',64),now(),now());
select vault.create_secret('synthetic-owner-runtime-secret-only','waldo_router_hmac');
create function pg_temp.runtime_authority(p_owner text) returns jsonb language plpgsql as $$
declare v_at bigint:=extract(epoch from now())::bigint;
begin
 return waldo.owner_runtime_authority(p_owner,v_at,encode(extensions.hmac(v_at::text||'.owner.runtime.'||p_owner,'synthetic-owner-runtime-secret-only','sha256'),'hex'));
end $$;
create function pg_temp.app_authority(p_owner text,p_session text) returns jsonb language plpgsql as $$
declare v_at bigint:=extract(epoch from now())::bigint;
begin
 return waldo.app_session_authority(p_owner,p_session,v_at,encode(extensions.hmac(v_at::text||'.app.session.'||p_owner||'.'||p_session,'synthetic-owner-runtime-secret-only','sha256'),'hex'));
end $$;
do $$
declare r jsonb; checks integer:=0; first_revision text;
begin
 r:=pg_temp.runtime_authority('runtime-owner-a');
 assert r->>'owner_id'='c3000000-0000-0000-0000-000000000001' and r->>'auth_user_id'='c1000000-0000-0000-0000-000000000001','active Auth owner has physical authority without any channel'; checks:=checks+1;
 assert pg_temp.app_authority('runtime-owner-a',repeat('c',64))->>'owner_id'='c3000000-0000-0000-0000-000000000001','current app session has authority without presence'; checks:=checks+1;
 assert pg_temp.app_authority('runtime-owner-a',repeat('e',64)) is null,'expired app session has no authority'; checks:=checks+1;
 assert pg_temp.app_authority('runtime-owner-a',repeat('d',64)) is null,'second owner session cannot enter first owner'; checks:=checks+1;
 assert not exists(select 1 from waldo.presences where owner_id='c3000000-0000-0000-0000-000000000001'),'fixture has no Telegram or other presence'; checks:=checks+1;
 assert (r->>'state_version')::bigint>=0 and (r->>'admission_revision')::bigint>0,'authority carries canonical lifecycle/admission fences'; checks:=checks+1;
 first_revision:=r->>'admission_revision';
 insert into waldo.presences(owner_id,provider,subject) values('c3000000-0000-0000-0000-000000000001','ios','synthetic-native-owner-a');
 r:=pg_temp.runtime_authority('runtime-owner-a');
 assert r->>'owner_id'='c3000000-0000-0000-0000-000000000001' and (r->>'admission_revision')::bigint>first_revision::bigint,'native linking preserves owner identity with fresh admission fence'; checks:=checks+1;
 update waldo.presences set state='unlinked',unlinked_at=now() where owner_id='c3000000-0000-0000-0000-000000000001';
 assert pg_temp.runtime_authority('runtime-owner-a')->>'owner_id'='c3000000-0000-0000-0000-000000000001','unlinking a surface preserves physical owner authority'; checks:=checks+1;
 update waldo.owners set state='suspended' where do_name='runtime-owner-a';
 assert (select state_version>0 from waldo.owners where do_name='runtime-owner-a'),'lifecycle change advances canonical zero-based state fence'; checks:=checks+1;
 assert pg_temp.app_authority('runtime-owner-a',repeat('c',64)) is null,'suspended owner cannot admit app turns'; checks:=checks+1;
 assert pg_temp.runtime_authority('runtime-owner-a') is null,'suspended owner cannot execute general capabilities'; checks:=checks+1;
 assert pg_temp.runtime_authority('runtime-owner-b')->>'owner_id'='d3000000-0000-0000-0000-000000000001','second owner remains independent after first lifecycle change'; checks:=checks+1;
 update waldo.owners set state='active' where do_name='runtime-owner-a';
 delete from waldo.console_sessions where session_hash=repeat('c',64);
 assert pg_temp.app_authority('runtime-owner-a',repeat('c',64)) is null,'revoked app session cannot admit old turns'; checks:=checks+1;
 assert pg_temp.runtime_authority('runtime-owner-a') is not null,'app signout preserves autonomous physical owner authority'; checks:=checks+1;
 delete from auth.users where id='c1000000-0000-0000-0000-000000000001';
 assert pg_temp.runtime_authority('runtime-owner-a') is null,'removed Auth identity cannot execute despite retained owner locator'; checks:=checks+1;
 assert pg_temp.app_authority('runtime-owner-a',repeat('e',64)) is null,'removed Auth identity cannot admit app turns'; checks:=checks+1;
 assert pg_temp.runtime_authority('missing-owner') is null,'unprovisioned identity is not invented'; checks:=checks+1;
 assert pg_temp.runtime_authority('runtime-owner-b')->>'do_name'='runtime-owner-b','Auth deletion cannot cross owners'; checks:=checks+1;
 begin perform waldo.owner_runtime_authority('runtime-owner-b',extract(epoch from now())::bigint,'unsigned'); raise exception 'unsigned accepted'; exception when insufficient_privilege then checks:=checks+1; end;
 begin perform waldo.owner_runtime_authority(null,extract(epoch from now())::bigint,'unsigned'); raise exception 'null accepted'; exception when insufficient_privilege then checks:=checks+1; end;
 begin perform waldo.app_session_authority('runtime-owner-b',repeat('d',64),extract(epoch from now())::bigint,'unsigned'); raise exception 'unsigned app accepted'; exception when insufficient_privilege then checks:=checks+1; end;
 assert not has_function_privilege('authenticated','waldo.owner_runtime_authority(text,bigint,text)','execute') and not has_function_privilege('service_role','waldo.owner_runtime_authority(text,bigint,text)','execute'),'only the canonical signed rail invokes authority'; checks:=checks+1;
 raise notice 'owner-runtime authority: % synthetic SQL assertions PASS',checks;
end $$;
rollback;
