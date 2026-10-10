-- Only the isolated rights fixture database. All synthetic owner/token rows rollback.
begin;
insert into auth.users(id,email) values('a1000000-0000-0000-0000-000000000001','push-a@example.invalid'),('b1000000-0000-0000-0000-000000000001','push-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','push-owner-a','push-a@example.invalid'),('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','push-owner-b','push-b@example.invalid');
insert into waldo.console_sessions(owner_id,session_hash,created_at,last_seen_at) values
 ('a3000000-0000-0000-0000-000000000001',repeat('a',64),now(),now()),('a3000000-0000-0000-0000-000000000001',repeat('c',64),now(),now()),('b3000000-0000-0000-0000-000000000001',repeat('b',64),now(),now());
select vault.create_secret('synthetic-push-router-secret-only','waldo_router_hmac');
create function pg_temp.sig(p_message text) returns text language sql as $$
 select encode(extensions.hmac(extract(epoch from now())::bigint::text||'.'||p_message,'synthetic-push-router-secret-only','sha256'),'hex')
$$;
create function pg_temp.register(p_owner text,p_session text,p_epoch bigint,p_operation text,p_token text) returns jsonb language plpgsql as $$
declare v_id text:='a4000000-0000-0000-0000-000000000001'; v_message text;
begin
 v_message:='app.push.register.'||p_owner||'.'||p_session||'.'||v_id||'.apns.sandbox.'||p_epoch||'.'||p_operation||'.'||encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
 return waldo.app_push_register(p_owner,p_session,v_id,'apns','sandbox',p_epoch,p_operation,p_token,extract(epoch from now())::bigint,pg_temp.sig(v_message));
end $$;
do $$
declare r jsonb; v_secret uuid; checks integer:=0; v_at bigint:=extract(epoch from now())::bigint;
begin
 r:=pg_temp.register('push-owner-a',repeat('a',64),0,'register-a-0001','synthetic-token-apns-aaaaaaaa');
 assert r->>'result'='registered' and r->'device'->>'device_epoch'='1','registration creates epoch1'; checks:=checks+1;
 assert not r::text like '%synthetic-token%','public receipt excludes token'; checks:=checks+1;
 assert (select count(*) from vault.decrypted_secrets where decrypted_secret='synthetic-token-apns-aaaaaaaa')=1,'token uses Vault'; checks:=checks+1;
 r:=pg_temp.register('push-owner-a',repeat('a',64),0,'register-a-0001','synthetic-token-apns-aaaaaaaa');
 assert r->>'result'='already_recorded','same operation replays one registration'; checks:=checks+1;
 r:=pg_temp.register('push-owner-a',repeat('a',64),0,'register-a-0001','changed-token-apns-aaaaaaaaaa');
 assert r is null,'operation substitution rejected'; checks:=checks+1;
 r:=pg_temp.register('push-owner-a',repeat('a',64),0,'register-a-0002','changed-token-apns-aaaaaaaaaa');
 assert r is null,'stale epoch rejected'; checks:=checks+1;
 r:=pg_temp.register('push-owner-b',repeat('b',64),0,'register-b-0001','synthetic-token-apns-aaaaaaaa');
 assert r is null,'same active token cannot cross owners'; checks:=checks+1;
 r:=pg_temp.register('push-owner-b',repeat('b',64),0,'register-b-other-token','synthetic-token-apns-bbbbbbbb');
 assert r is null,'changed token cannot reuse another active owners installation'; checks:=checks+1;
 assert (select count(*) from waldo.app_push_devices where installation_id='a4000000-0000-0000-0000-000000000001' and state='active')=1,'changed token denial preserves one admitted owner'; checks:=checks+1;
 r:=waldo.app_push_list('push-owner-b',repeat('b',64),v_at,pg_temp.sig('app.push.list.push-owner-b.'||repeat('b',64)));
 assert r='[]'::jsonb,'other owner cannot list token metadata'; checks:=checks+1;
 r:=waldo.app_push_revoke('push-owner-a',repeat('c',64),'a4000000-0000-0000-0000-000000000001',1,'revoke-other-0001',v_at,pg_temp.sig('app.push.revoke.push-owner-a.'||repeat('c',64)||'.a4000000-0000-0000-0000-000000000001.1.revoke-other-0001'));
 assert r is null,'other session cannot revoke current installation'; checks:=checks+1;
 select secret_id into v_secret from waldo.app_push_devices where owner_id='a3000000-0000-0000-0000-000000000001';
 r:=pg_temp.register('push-owner-a',repeat('a',64),1,'register-a-0003','rotated-token-apns-aaaaaaaaaa');
 assert r->'device'->>'device_epoch'='2','rotation increments epoch'; checks:=checks+1;
 assert not exists(select 1 from vault.secrets where id=v_secret),'rotation removes old Vault token'; checks:=checks+1;
 r:=waldo.app_push_revoke('push-owner-a',repeat('a',64),'a4000000-0000-0000-0000-000000000001',2,'revoke-a-0001',v_at,pg_temp.sig('app.push.revoke.push-owner-a.'||repeat('a',64)||'.a4000000-0000-0000-0000-000000000001.2.revoke-a-0001'));
 assert r->>'result'='revoked' and r->'device'->>'device_epoch'='3','explicit revoke records epoch3'; checks:=checks+1;
 r:=waldo.app_push_revoke('push-owner-a',repeat('a',64),'a4000000-0000-0000-0000-000000000001',2,'revoke-a-0001',v_at,pg_temp.sig('app.push.revoke.push-owner-a.'||repeat('a',64)||'.a4000000-0000-0000-0000-000000000001.2.revoke-a-0001'));
 assert r->>'result'='already_recorded','same revoked epoch replays settled operation'; checks:=checks+1;
 r:=pg_temp.register('push-owner-a',repeat('a',64),3,'register-a-0004','rotated-token-apns-aaaaaaaaaa');
 assert r->'device'->>'device_epoch'='4','new registration advances the revoked epoch'; checks:=checks+1;
 r:=waldo.app_push_revoke('push-owner-a',repeat('a',64),'a4000000-0000-0000-0000-000000000001',2,'revoke-a-0001',v_at,pg_temp.sig('app.push.revoke.push-owner-a.'||repeat('a',64)||'.a4000000-0000-0000-0000-000000000001.2.revoke-a-0001'));
 assert r is null,'old revoke receipt cannot claim current new registration revoked'; checks:=checks+1;
 assert waldo.app_push_revoke_session('push-owner-a',repeat('a',64),v_at,pg_temp.sig('app.push.revoke-session.push-owner-a.'||repeat('a',64)))=1,'signout revokes exact session'; checks:=checks+1;
 assert not exists(select 1 from vault.decrypted_secrets where decrypted_secret='rotated-token-apns-aaaaaaaaaa'),'signout removes Vault token'; checks:=checks+1;
 assert waldo.app_push_revoke_session('push-owner-a',repeat('a',64),v_at,pg_temp.sig('app.push.revoke-session.push-owner-a.'||repeat('a',64)))=0,'signout replay idempotent'; checks:=checks+1;
 r:=pg_temp.register('push-owner-a',repeat('a',64),1,'register-a-0003','rotated-token-apns-aaaaaaaaaa');
 assert r is null,'old successful registration cannot resurrect after revoke'; checks:=checks+1;
 delete from waldo.console_sessions where session_hash=repeat('a',64);
 r:=pg_temp.register('push-owner-a',repeat('a',64),5,'register-a-0005','late-token-apns-aaaaaaaaaaaa');
 assert r is null,'revoked directory session cannot register'; checks:=checks+1;
 r:=waldo.app_push_list('push-owner-a',repeat('a',64),v_at,pg_temp.sig('app.push.list.push-owner-a.'||repeat('a',64)));
 assert r is null,'revoked session cannot obtain push routing metadata'; checks:=checks+1;
 -- JS may lose its bearer before calling the push-specific revoke. Canonical
 -- session deletion must still settle the old installation without that call.
 r:=pg_temp.register('push-owner-a',repeat('c',64),5,'register-a-local-loss','synthetic-token-before-js-loss');
 assert r->>'result'='registered' and r->'device'->>'device_epoch'='6','live remaining session can register after prior revocation'; checks:=checks+1;
 delete from waldo.console_sessions where owner_id='a3000000-0000-0000-0000-000000000001' and session_hash=repeat('c',64);
 assert not exists(select 1 from waldo.app_push_devices where owner_id='a3000000-0000-0000-0000-000000000001' and state='active'),'canonical signout settles prior installation when JS cannot call push revoke'; checks:=checks+1;
 assert not exists(select 1 from vault.decrypted_secrets where decrypted_secret='synthetic-token-before-js-loss'),'canonical signout removes prior provider token despite local bearer loss'; checks:=checks+1;
 r:=pg_temp.register('push-owner-b',repeat('b',64),0,'register-b-0002','synthetic-token-apns-bbbbbbbb');
 assert r->>'result'='registered','other owner reuses installation only after prior canonical revocation'; checks:=checks+1;
 assert not exists(select 1 from waldo.app_push_devices where owner_id='a3000000-0000-0000-0000-000000000001' and state='active'),'prior owner has no active delivery custody after switch'; checks:=checks+1;
 assert (select count(*) from waldo.app_push_devices where installation_id='a4000000-0000-0000-0000-000000000001' and state='active')=1,'new owner exclusively owns active installation'; checks:=checks+1;
 assert waldo.app_push_revoke_all('push-owner-a',v_at,pg_temp.sig('app.push.revoke-all.push-owner-a'))=0,'revoked owner no active token'; checks:=checks+1;
 assert exists(select 1 from waldo.app_push_devices where owner_id='b3000000-0000-0000-0000-000000000001' and state='active'),'ownerA revoke preservesB'; checks:=checks+1;
 -- Canonical session revocation must remove push even without the app call site.
 delete from waldo.console_sessions where owner_id='b3000000-0000-0000-0000-000000000001';
 assert not exists(select 1 from waldo.app_push_devices where owner_id='b3000000-0000-0000-0000-000000000001' and state='active'),'canonical signout trigger revokes push'; checks:=checks+1;
 assert not exists(select 1 from vault.decrypted_secrets where decrypted_secret='synthetic-token-apns-bbbbbbbb'),'canonical signout trigger erases Vault token'; checks:=checks+1;
 assert not has_table_privilege('anon','waldo.app_push_devices','select') and not has_table_privilege('authenticated','waldo.app_push_operations','select'),'no direct reads'; checks:=checks+1;
 assert not has_function_privilege('anon','waldo.app_push_view(waldo.app_push_devices)','execute'),'helper not publicly executable'; checks:=checks+1;
 begin perform waldo.app_push_revoke_all('push-owner-b',v_at,'unsigned'); raise exception 'allowed unsigned'; exception when insufficient_privilege then checks:=checks+1; end;
 raise notice 'app push custody: % assertions PASS',checks;
end $$;
rollback;
