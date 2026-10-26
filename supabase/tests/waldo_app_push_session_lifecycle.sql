begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.token_hash(token text) returns text language sql as $$ select encode(extensions.digest(convert_to(token,'UTF8'),'sha256'),'hex') $$;
create function pg_temp.register(name text,hash text,inst text,env text,epoch bigint,op text,token text) returns jsonb language sql as $$
  select waldo.app_push_register(name,hash,inst,'expo',env,epoch,op,token,pg_temp.at(),
    pg_temp.sig('app.push.register.'||name||'.'||hash||'.'||inst||'.expo.'||env||'.'||epoch||'.'||op||'.'||pg_temp.token_hash(token))) $$;
create function pg_temp.targets(name text) returns jsonb language sql as $$ select waldo.app_push_targets(name,pg_temp.at(),pg_temp.sig('app.push.targets.'||name)) $$;
create function pg_temp.tokens(name text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(t->'token' order by t->>'token'),'[]'::jsonb) from jsonb_array_elements(pg_temp.targets(name)) t $$;
create function pg_temp.device(name text,inst text) returns waldo.app_push_devices language sql as $$
  select d.* from waldo.app_push_devices d join waldo.owners o on o.id=d.owner_id where o.do_name=name and d.installation_id=inst::uuid $$;
create function pg_temp.expire(hash text) returns void language sql as $$
  update waldo.console_sessions set created_at=now()-lifetime-interval '1 minute' where session_hash=hash $$;
create function pg_temp.locks(key text) returns int language sql as $$
  select count(*)::int from pg_locks where locktype='advisory' and objsubid=1
    and ((classid::bigint << 32) | objid::bigint)=hashtextextended(key,0) $$;

insert into auth.users(id) values ('33000000-0000-0000-0000-000000000001'),('33000000-0000-0000-0000-000000000002'),('33000000-0000-0000-0000-000000000003');
insert into waldo.owners(id,do_name,auth_user_id) values
 ('13000000-0000-0000-0000-000000000001','life-asha','33000000-0000-0000-0000-000000000001'),
 ('13000000-0000-0000-0000-000000000002','life-ben','33000000-0000-0000-0000-000000000002'),
 ('13000000-0000-0000-0000-000000000003','life-cai','33000000-0000-0000-0000-000000000003');
select waldo.console_session_open('life-asha',repeat('a',64),pg_temp.at(),pg_temp.sig('consolesess.open.life-asha.'||repeat('a',64)));
select waldo.console_session_open('life-ben',repeat('b',64),pg_temp.at(),pg_temp.sig('consolesess.open.life-ben.'||repeat('b',64)));
select waldo.console_session_open('life-cai',repeat('c',64),pg_temp.at(),pg_temp.sig('consolesess.open.life-cai.'||repeat('c',64)));

-- 1. A device is a push target only while the session it was registered in, or that session's renewal, is live.
select is(pg_temp.register('life-asha',repeat('a',64),'43000000-0000-0000-0000-000000000001','production',0,'op-life-0001','ExponentPushToken[asha-phone-0000000000]')->>'result','registered','the owner registers a phone on a live session');
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[asha-phone-0000000000]"]'::jsonb,'that phone is a push target');
select pg_temp.expire(repeat('a',64));
select is(pg_temp.targets('life-asha'),'[]'::jsonb,'once the session runs out without a sign-out, the phone gets no push');

select waldo.console_session_open('life-asha',repeat('d',64),pg_temp.at(),pg_temp.sig('consolesess.open.life-asha.'||repeat('d',64)));
select is(pg_temp.register('life-asha',repeat('d',64),'43000000-0000-0000-0000-000000000001','production',1,'op-life-0002','ExponentPushToken[asha-phone-0000000000]')->>'result','registered','signing in again on the same phone registers it to the new session');
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[asha-phone-0000000000]"]'::jsonb,'and it is a target again');
update waldo.console_sessions set idle_timeout=interval '1 hour', last_seen_at=now()-interval '2 hours' where session_hash=repeat('d',64);
select is(pg_temp.targets('life-asha'),'[]'::jsonb,'a session past its idle limit sends no push either');
update waldo.console_sessions set idle_timeout=null where session_hash=repeat('d',64);

select is(waldo.app_session_rotate('life-asha',repeat('d',64),repeat('e',64),pg_temp.at(),pg_temp.sig('appsess.rotate.life-asha.'||repeat('d',64)||'.'||repeat('e',64))),true,'the app renews its session');
select pg_temp.expire(repeat('d',64));
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[asha-phone-0000000000]"]'::jsonb,'a renewed session keeps its phone''s pushes after the replaced session runs out');
select pg_temp.expire(repeat('e',64));
select is(pg_temp.targets('life-asha'),'[]'::jsonb,'and stops them when the renewal itself runs out');

-- 2. The phone belongs to the latest owner who signs in on it: their registration revokes the previous owner's binding.
select waldo.console_session_open('life-asha',repeat('9',64),pg_temp.at(),pg_temp.sig('consolesess.open.life-asha.'||repeat('9',64)));
select is(pg_temp.register('life-asha',repeat('9',64),'43000000-0000-0000-0000-000000000001','production',2,'op-life-0003','ExponentPushToken[shared-phone-00000000]')->>'result','registered','Asha registers the phone');
create temp table asha_secret as select secret_id from pg_temp.device('life-asha','43000000-0000-0000-0000-000000000001');
select is(pg_temp.register('life-ben',repeat('b',64),'43000000-0000-0000-0000-000000000001','production',0,'op-life-0004','ExponentPushToken[shared-phone-00000000]')->>'result','registered','Ben signs in on the same phone and registers it');
select is((select row(state,secret_id is null,device_epoch) from pg_temp.device('life-asha','43000000-0000-0000-0000-000000000001')),row('revoked'::text,true,4::bigint),'Asha''s binding is revoked and its epoch moves on');
select is((select count(*) from vault.secrets where id in (select secret_id from asha_secret)),0::bigint,'Asha''s copy of the token leaves Vault');
select is(pg_temp.targets('life-asha'),'[]'::jsonb,'Asha''s pushes no longer reach the phone');
select is(pg_temp.tokens('life-ben'),'["ExponentPushToken[shared-phone-00000000]"]'::jsonb,'Ben''s do');
select is(pg_temp.locks('waldopush.token.'||pg_temp.token_hash('ExponentPushToken[shared-phone-00000000]')),1,'the registration held the token''s lock');
select is(pg_temp.locks('waldopush.installation.43000000-0000-0000-0000-000000000001'),1,'and the installation''s lock');
select is(pg_temp.register('life-asha',repeat('9',64),'43000000-0000-0000-0000-000000000001','production',2,'op-life-0003','ExponentPushToken[shared-phone-00000000]'),null,'Asha''s earlier receipt does not bring her binding back');

select is(pg_temp.register('life-asha',repeat('9',64),'43000000-0000-0000-0000-000000000001','production',4,'op-life-0005','ExponentPushToken[shared-phone-00000000]')->>'result','registered','Asha signs back in on the phone and takes it back');
select is(pg_temp.targets('life-ben'),'[]'::jsonb,'Ben''s pushes stop reaching it');
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[shared-phone-00000000]"]'::jsonb,'Asha''s reach it again');
select is((select count(*) from waldo.app_push_devices where token_hash=pg_temp.token_hash('ExponentPushToken[shared-phone-00000000]') and state='active'),1::bigint,'one owner holds the token at a time');

-- The device is matched by its token or its installation, whatever the environment.
select is(pg_temp.register('life-ben',repeat('b',64),'43000000-0000-0000-0000-000000000002','production',0,'op-life-0006','ExponentPushToken[shared-phone-00000000]')->>'result','registered','the same token under a reinstalled app''s new installation');
select is(pg_temp.targets('life-asha'),'[]'::jsonb,'takes the token from Asha');
select is(pg_temp.register('life-asha',repeat('9',64),'43000000-0000-0000-0000-000000000002','sandbox',0,'op-life-0007','ExponentPushToken[rotated-token-0000000]')->>'result','registered','the same installation with a rotated token, under the other environment');
select is(pg_temp.targets('life-ben'),'[]'::jsonb,'takes the phone from Ben');
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[rotated-token-0000000]"]'::jsonb,'Asha reaches it on the rotated token only');

-- 3. The same owner registering the same phone again changes no one else and keeps one binding.
select is(pg_temp.register('life-cai',repeat('c',64),'43000000-0000-0000-0000-000000000003','production',0,'op-life-0008','ExponentPushToken[cai-phone-00000000000]')->>'result','registered','Cai registers his own phone');
select is(pg_temp.register('life-cai',repeat('c',64),'43000000-0000-0000-0000-000000000003','production',0,'op-life-0008','ExponentPushToken[cai-phone-00000000000]')->>'result','already_recorded','the same request again is the recorded receipt');
select is(pg_temp.register('life-cai',repeat('c',64),'43000000-0000-0000-0000-000000000003','production',1,'op-life-0009','ExponentPushToken[cai-phone-00000000000]')->>'result','registered','a fresh registration of the unchanged phone is recorded');
select is((select row(state,device_epoch) from pg_temp.device('life-cai','43000000-0000-0000-0000-000000000003')),row('active'::text,2::bigint),'it stays the one active binding');
select is(pg_temp.tokens('life-cai'),'["ExponentPushToken[cai-phone-00000000000]"]'::jsonb,'Cai still gets his pushes');
select is(pg_temp.tokens('life-asha'),'["ExponentPushToken[rotated-token-0000000]"]'::jsonb,'and nobody else''s binding moved');
select is((select count(*) from waldo.app_push_devices where state='active' and owner_id in (select id from waldo.owners where do_name like 'life-%')),2::bigint,'two phones, two active bindings');

select * from finish();
rollback;
