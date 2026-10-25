begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
insert into auth.users(id) values ('31000000-0000-0000-0000-000000000001');
insert into waldo.owners(id,do_name,auth_user_id) values ('11000000-0000-0000-0000-000000000001','renew-owner','31000000-0000-0000-0000-000000000001');
create function pg_temp.authority(hash text) returns jsonb language sql as $$ select waldo.app_session_authority('renew-owner',hash,pg_temp.at(),pg_temp.sig('app.session.renew-owner.'||hash)) $$;
create function pg_temp.renew(name text,old text,fresh text) returns boolean language sql as $$ select waldo.app_session_rotate(name,old,fresh,pg_temp.at(),pg_temp.sig('appsess.rotate.'||name||'.'||old||'.'||fresh)) $$;
create function pg_temp.inventory() returns jsonb language sql as $$ select waldo.console_session_inventory('renew-owner',pg_temp.at(),pg_temp.sig('consolesess.inventory.renew-owner')) $$;
create function pg_temp.listed() returns jsonb language sql as $$ select waldo.console_session_list('renew-owner',pg_temp.at(),pg_temp.sig('consolesess.list.renew-owner')) $$;
create function pg_temp.push_list(hash text) returns jsonb language sql as $$ select waldo.app_push_list('renew-owner',hash,pg_temp.at(),pg_temp.sig('app.push.list.renew-owner.'||hash)) $$;

select is(waldo.console_session_open('renew-owner',repeat('a',64),pg_temp.at(),pg_temp.sig('consolesess.open.renew-owner.'||repeat('a',64))),true,'a session opens');
select is((select lifetime from waldo.console_sessions where session_hash=repeat('a',64)),interval '12 hours','an opened session lasts 12 hours until it is renewed');
insert into waldo.app_push_devices(owner_id,installation_id,session_hash,provider,environment,device_epoch,state,secret_id,token_hash)
 values('11000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001',repeat('a',64),'apns','sandbox',1,'active',vault.create_secret('synthetic-push-token'),repeat('c',64));

select is(pg_temp.renew('renew-owner',repeat('a',64),repeat('b',64)),true,'a live session renews');
select is((select lifetime from waldo.console_sessions where session_hash=repeat('b',64)),interval '30 days','the renewed session lasts 30 days');
select is((select idle_timeout from waldo.console_sessions where session_hash=repeat('b',64)),null,'with no idle limit, like every app session');
select is((select created_at+lifetime from waldo.console_sessions where session_hash=repeat('a',64)),now()+interval '5 minutes','the presented session runs out 5 minutes later, as a capped console session does');
select is((pg_temp.authority(repeat('b',64))->>'expires_at')::numeric,(extract(epoch from now()+interval '30 days')*1000)::numeric,'the authority reports the renewed expiry');
select is(pg_temp.authority(repeat('a',64))->>'owner_id','11000000-0000-0000-0000-000000000001','the presented session still admits work for its 5 minutes');
select is((select session_hash from waldo.app_push_devices where owner_id='11000000-0000-0000-0000-000000000001'),repeat('b',64),'push custody moves to the renewed session');
select is((select jsonb_object_agg(e->>'session',e->'rotated_to') from jsonb_array_elements(pg_temp.inventory()) e),jsonb_build_object(repeat('a',64),repeat('b',64),repeat('b',64),null),'the inventory names the session a renewal replaced each one with');
select is((select (e->>'expires_at')::timestamptz from jsonb_array_elements(pg_temp.inventory()) e where e->>'session'=repeat('b',64)),now()+interval '30 days','the inventory carries each session''s end');
select is((select (e->>'expires_at')::timestamptz from jsonb_array_elements(pg_temp.inventory()) e where e->>'session'=repeat('a',64)),now()+interval '5 minutes','including the capped one');
select is((select array_agg(k order by k) from jsonb_array_elements(pg_temp.listed()) e, jsonb_object_keys(e) k where e->>'session'=repeat('b',64)),array['created_at','last_seen_at','session'],'console_session_list keeps its three keys for a Worker deployed before this migration');
select is(pg_temp.renew('renew-owner',repeat('a',64),repeat('7',64)),false,'a session renews once: the one a renewal replaced cannot renew again');
select is((select count(*)::int from waldo.console_sessions where session_hash=repeat('7',64)),0,'and opens no session');
select is((select rotated_to from waldo.console_sessions where session_hash=repeat('a',64)),repeat('b',64),'and keeps its successor');

select is(waldo.console_session_open('renew-owner',repeat('9',64),pg_temp.at(),pg_temp.sig('consolesess.open.renew-owner.'||repeat('9',64))),true,'a second device signs in');
select is(pg_temp.renew('renew-owner',repeat('9',64),repeat('8',64)),true,'and renews');
select is(waldo.console_session_revoke('renew-owner',repeat('8',64),pg_temp.at(),pg_temp.sig('consolesess.revoke.renew-owner.'||repeat('8',64))),true,'revoking that device''s session');
select is((select count(*)::int from waldo.console_sessions where session_hash in (repeat('8',64),repeat('9',64))),0,'ends the session it replaced too');
select is(pg_temp.authority(repeat('b',64))->>'owner_id','11000000-0000-0000-0000-000000000001','and leaves the other device signed in');

-- Thirteen hours in, the 30-day session still holds its push: the push functions follow the row's own lifetime.
update waldo.console_sessions set created_at=now()-interval '13 hours',last_seen_at=now()-interval '13 hours' where session_hash=repeat('b',64);
select is(pg_temp.authority(repeat('b',64))->>'owner_id','11000000-0000-0000-0000-000000000001','a renewed session admits work past 12 hours');
select is(jsonb_array_length(pg_temp.push_list(repeat('b',64))),1,'and still lists its push devices');
select is(waldo.console_session_touch('renew-owner',repeat('b',64),pg_temp.at(),pg_temp.sig('consolesess.touch.renew-owner.'||repeat('b',64))),true,'and its credential still validates');

update waldo.console_sessions set created_at=now()-interval '6 minutes' where session_hash=repeat('a',64);
select is(pg_temp.authority(repeat('a',64)),null,'after its 5 minutes the presented session stops');
select is((select count(*)::int from jsonb_array_elements(pg_temp.inventory()) e where e->>'session'=repeat('a',64)),0,'and leaves the inventory');
select is(waldo.console_session_touch('renew-owner',repeat('a',64),pg_temp.at(),pg_temp.sig('consolesess.touch.renew-owner.'||repeat('a',64))),false,'and its credential no longer validates');
select is(pg_temp.push_list(repeat('a',64)),null,'and it reads no push devices');
select is(pg_temp.renew('renew-owner',repeat('a',64),repeat('d',64)),false,'an expired session cannot renew');
select is(pg_temp.renew('renew-owner',repeat('e',64),repeat('f',64)),false,'an unknown session cannot renew');
select is(pg_temp.renew('other-owner',repeat('b',64),repeat('f',64)),false,'a session renews only under its own owner');
select throws_ok($$select waldo.app_session_rotate('renew-owner',repeat('b',64),repeat('f',64),pg_temp.at(),'forged')$$,'42501','unsigned or invalid session call','a forged renewal is denied');
select throws_ok($$select pg_temp.renew('renew-owner',repeat('b',64),repeat('b',64))$$,'42501','unsigned or invalid session call','a renewal to the same hash is denied');
select throws_ok($$select pg_temp.renew('renew-owner',repeat('b',64),'short')$$,'42501','unsigned or invalid session call','a malformed new hash is denied');
select throws_ok($$select waldo.console_session_inventory('renew-owner',pg_temp.at(),'forged')$$,'42501','unsigned router call','a forged inventory read is denied');
select is(waldo.console_session_inventory('nobody',pg_temp.at(),pg_temp.sig('consolesess.inventory.nobody')),'[]'::jsonb,'an unknown owner has an empty inventory');
update waldo.owners set state='suspended' where do_name='renew-owner';
select is(pg_temp.renew('renew-owner',repeat('b',64),repeat('f',64)),false,'a suspended account cannot renew');
update waldo.owners set state='active' where do_name='renew-owner';
select is(has_function_privilege('anon','waldo.app_session_rotate(text,text,text,bigint,text)','execute'),true,'the runtime key can renew; the signature is still required');
select is(has_function_privilege('authenticated','waldo.app_session_rotate(text,text,text,bigint,text)','execute'),false,'a signed-in client cannot call it directly');
select is(has_function_privilege('service_role','waldo.app_session_rotate(text,text,text,bigint,text)','execute'),false,'nor can the service role');
select is(has_function_privilege('anon','waldo.console_session_inventory(text,bigint,text)','execute'),true,'the runtime key can read the inventory; the signature is still required');
select is(has_function_privilege('authenticated','waldo.console_session_inventory(text,bigint,text)','execute'),false,'a signed-in client cannot read it directly');
select is(has_function_privilege('service_role','waldo.console_session_inventory(text,bigint,text)','execute'),false,'nor can the service role');
select * from finish();
rollback;
