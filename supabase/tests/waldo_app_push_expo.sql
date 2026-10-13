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

select is(pg_temp.targets('expo-owner'),jsonb_build_array(jsonb_build_object('installation_id','42000000-0000-0000-0000-000000000001','provider','expo','token','ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]')),'the owner''s object reads back only that owner''s active tokens');
select is(pg_temp.targets('nobody'),'[]'::jsonb,'an unknown owner has no targets');
select throws_ok($$select waldo.app_push_targets('expo-owner',pg_temp.at(),'forged')$$,'42501',null,'a forged read is denied');
select is(waldo.app_push_revoke('expo-owner',repeat('a',64),'42000000-0000-0000-0000-000000000001',1,'op-expo-0006',pg_temp.at(),pg_temp.sig('app.push.revoke.expo-owner.'||repeat('a',64)||'.42000000-0000-0000-0000-000000000001.1.op-expo-0006'))->>'result','revoked','the device is revoked');
select is(pg_temp.targets('expo-owner'),'[]'::jsonb,'a revoked device is no longer a target');
update waldo.owners set state='suspended' where do_name='expo-foreign';
select is(pg_temp.targets('expo-foreign'),'[]'::jsonb,'a suspended account has no targets');
select is(has_function_privilege('anon','waldo.app_push_targets(text,bigint,text)','execute'),true,'the runtime key can read targets; the signature is still required');
select is(has_function_privilege('authenticated','waldo.app_push_targets(text,bigint,text)','execute'),false,'a signed-in client cannot');
select is(has_function_privilege('service_role','waldo.app_push_targets(text,bigint,text)','execute'),false,'nor can the service role');
select * from finish();
rollback;
