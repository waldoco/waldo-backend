begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.token_hash(token text) returns text language sql as $$ select encode(extensions.digest(convert_to(token,'UTF8'),'sha256'),'hex') $$;
create function pg_temp.register(name text,hash text,inst text,provider text,op text,token text) returns jsonb language sql as $$
  select waldo.app_push_register(name,hash,inst,provider,'production',0,op,token,pg_temp.at(),
    pg_temp.sig('app.push.register.'||name||'.'||hash||'.'||inst||'.'||provider||'.production.0.'||op||'.'||pg_temp.token_hash(token))) $$;
create function pg_temp.targets(name text) returns jsonb language sql as $$ select waldo.app_push_targets(name,pg_temp.at(),pg_temp.sig('app.push.targets.'||name)) $$;
create function pg_temp.retire(name text,inst text,epoch bigint) returns boolean language sql as $$
  select waldo.app_push_retire(name,inst,epoch,pg_temp.at(),pg_temp.sig('app.push.retire.'||name||'.'||inst||'.'||epoch)) $$;

insert into auth.users(id) values ('32000000-0000-0000-0000-000000000001'),('32000000-0000-0000-0000-000000000002');
insert into waldo.owners(id,do_name,auth_user_id) values
 ('12000000-0000-0000-0000-000000000001','expo-owner','32000000-0000-0000-0000-000000000001'),
 ('12000000-0000-0000-0000-000000000002','expo-foreign','32000000-0000-0000-0000-000000000002');
select waldo.console_session_open('expo-owner',repeat('a',64),pg_temp.at(),pg_temp.sig('consolesess.open.expo-owner.'||repeat('a',64)));
select waldo.console_session_open('expo-foreign',repeat('f',64),pg_temp.at(),pg_temp.sig('consolesess.open.expo-foreign.'||repeat('f',64)));

select is(pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000001','expo','op-expo-0001','ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]')->>'result','registered','an Expo token registers under the expo provider');
select throws_ok($$select pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000002','apns','op-expo-0002','ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]')$$,'42501',null,'an Expo token is refused under a native provider');
select throws_ok($$select pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000002','expo','op-expo-0003','plain-native-token-000000')$$,'42501',null,'a native token is refused under expo');
select throws_ok($$select pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000002','webpush','op-expo-0004','plain-native-token-000000')$$,'42501',null,'an unknown provider is refused');
select is(pg_temp.register('expo-foreign',repeat('f',64),'42000000-0000-0000-0000-000000000003','expo','op-expo-0005','ExponentPushToken[ffffffffffffffffffffff]')->>'result','registered','another owner registers their own device');

select is(pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000004','apns','op-expo-0007',repeat('n',64))->>'result','registered','a native token still registers');
select is(pg_temp.targets('expo-owner'),jsonb_build_array(jsonb_build_object('installation_id','42000000-0000-0000-0000-000000000001','device_epoch',1,'token','ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]')),'the owner''s object reads back only that owner''s active Expo tokens, never a native one');
select is(pg_temp.targets('nobody'),'[]'::jsonb,'an unknown owner has no targets');
select throws_ok($$select waldo.app_push_targets('expo-owner',pg_temp.at(),'forged')$$,'42501',null,'a forged read is denied');

select is(pg_temp.retire('expo-foreign','42000000-0000-0000-0000-000000000001',1),false,'one owner''s object cannot retire another owner''s device');
select is(pg_temp.retire('expo-owner','42000000-0000-0000-0000-000000000001',2),false,'a retire on an epoch the device has moved past changes nothing');
select throws_ok($$select waldo.app_push_retire('expo-owner','42000000-0000-0000-0000-000000000001',1,pg_temp.at(),'forged')$$,'42501',null,'a forged retire is denied');
select is(pg_temp.retire('expo-owner','42000000-0000-0000-0000-000000000003',1),false,'a retire names the owner''s own installation only');
select is((select count(*) from waldo.app_push_devices where state='active' and installation_id::text like '42000000-%'),3::bigint,'nothing was retired by the refused calls');
create temp table retired_secret as select secret_id from waldo.app_push_devices where installation_id='42000000-0000-0000-0000-000000000001';
select is(pg_temp.retire('expo-owner','42000000-0000-0000-0000-000000000001',1),true,'a device Expo no longer reaches is retired');
select is((select row(state,device_epoch,secret_id is null) from waldo.app_push_devices where installation_id='42000000-0000-0000-0000-000000000001'),row('revoked'::text,2::bigint,true),'the retired device is revoked and its epoch moves on');
select is((select count(*) from vault.secrets where id in (select secret_id from retired_secret)),0::bigint,'its token leaves Vault');
select is(pg_temp.retire('expo-owner','42000000-0000-0000-0000-000000000001',1),false,'retiring twice changes nothing');
select is(pg_temp.targets('expo-owner'),'[]'::jsonb,'a retired device is no longer a target');
select is(pg_temp.register('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000001','expo','op-expo-0008','ExponentPushToken[cccccccccccccccccccccc]')->>'result',null,'re-registering from the old epoch is a stale read');
update waldo.owners set state='suspended' where do_name='expo-foreign';
select is(pg_temp.targets('expo-foreign'),'[]'::jsonb,'a suspended account has no targets');
select is(has_function_privilege('anon','waldo.app_push_targets(text,bigint,text)','execute'),true,'the runtime key can read targets; the signature is still required');
select is(has_function_privilege('authenticated','waldo.app_push_targets(text,bigint,text)','execute'),false,'a signed-in client cannot');
select is(has_function_privilege('service_role','waldo.app_push_targets(text,bigint,text)','execute'),false,'nor can the service role');
select is(has_function_privilege('anon','waldo.app_push_retire(text,text,bigint,bigint,text)','execute'),true,'the runtime key can retire; the signature is still required');
select is(has_function_privilege('authenticated','waldo.app_push_retire(text,text,bigint,bigint,text)','execute'),false,'a signed-in client cannot retire');
select is(has_function_privilege('service_role','waldo.app_push_retire(text,text,bigint,bigint,text)','execute'),false,'nor can the service role');
select * from finish();
rollback;
