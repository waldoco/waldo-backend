begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.token_hash(token text) returns text language sql as $$ select encode(extensions.digest(convert_to(token,'UTF8'),'sha256'),'hex') $$;
create function pg_temp.register(name text,hash text,inst text,epoch bigint,op text,token text) returns jsonb language sql as $$
  select waldo.app_push_register(name,hash,inst,'apns','sandbox',epoch,op,token,pg_temp.at(),
    pg_temp.sig('app.push.register.'||name||'.'||hash||'.'||inst||'.apns.sandbox.'||epoch||'.'||op||'.'||pg_temp.token_hash(token))) $$;
create function pg_temp.revoke(name text,hash text,inst text,epoch bigint,op text) returns jsonb language sql as $$
  select waldo.app_push_revoke(name,hash,inst,epoch,op,pg_temp.at(),pg_temp.sig('app.push.revoke.'||name||'.'||hash||'.'||inst||'.'||epoch||'.'||op)) $$;
create function pg_temp.list(name text,hash text) returns jsonb language sql as $$
  select waldo.app_push_list(name,hash,pg_temp.at(),pg_temp.sig('app.push.list.'||name||'.'||hash)) $$;

insert into auth.users(id) values ('31000000-0000-0000-0000-000000000001'),('31000000-0000-0000-0000-000000000002');
insert into waldo.owners(id,do_name,auth_user_id) values
 ('11000000-0000-0000-0000-000000000001','push-owner','31000000-0000-0000-0000-000000000001'),
 ('11000000-0000-0000-0000-000000000002','push-foreign','31000000-0000-0000-0000-000000000002');
select waldo.console_session_open('push-owner',repeat('a',64),pg_temp.at(),pg_temp.sig('consolesess.open.push-owner.'||repeat('a',64)));
select waldo.console_session_open('push-foreign',repeat('f',64),pg_temp.at(),pg_temp.sig('consolesess.open.push-foreign.'||repeat('f',64)));

-- register
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',0,'op-register-1','apns-token-0001-synthetic')->>'result','registered','a signed registration on a live session is recorded');
select is((select device_epoch from waldo.app_push_devices where installation_id='41000000-0000-0000-0000-000000000001'),1::bigint,'first registration starts at epoch 1');
select is((select count(*)::int from vault.secrets s join waldo.app_push_devices d on d.secret_id=s.id where d.installation_id='41000000-0000-0000-0000-000000000001'),1,'the token is held in Vault');
select is((select token_hash from waldo.app_push_devices where installation_id='41000000-0000-0000-0000-000000000001'),pg_temp.token_hash('apns-token-0001-synthetic'),'only the token hash is stored on the device row');
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',0,'op-register-1','apns-token-0001-synthetic')->>'result','already_recorded','an identical replay returns the recorded receipt');
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',0,'op-register-1','apns-token-0002-synthetic'),null,'the same operation id with a different token is refused');
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',5,'op-register-2','apns-token-0003-synthetic'),null,'a stale expected epoch is refused');
select is(pg_temp.register('push-foreign',repeat('a',64),'41000000-0000-0000-0000-000000000009',0,'op-register-3','apns-token-0004-synthetic'),null,'another owner cannot register with this session');
select is(pg_temp.register('push-foreign',repeat('f',64),'41000000-0000-0000-0000-000000000009',0,'op-register-4','apns-token-0001-synthetic'),null,'a token live for one owner cannot be claimed by another');
select throws_ok($$select waldo.app_push_register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000002','apns','sandbox',0,'op-register-5','apns-token-0005-synthetic',pg_temp.at(),'forged')$$,'42501',null,'a forged registration signature is denied');
select throws_ok($$select pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000002',0,'op-register-6','bad token!')$$,'42501',null,'a malformed token is denied');

-- list
select is(jsonb_array_length(pg_temp.list('push-owner',repeat('a',64))),1,'the owner lists one device');
select is(pg_temp.list('push-owner',repeat('a',64))->0 ? 'token',false,'the listing never carries the token');
select is(pg_temp.list('push-owner',repeat('a',64))->0 ? 'token_hash',false,'the listing never carries the token hash');
select is(pg_temp.list('push-foreign',repeat('a',64)),null,'another owner cannot list with this session');
select is(jsonb_array_length(pg_temp.list('push-foreign',repeat('f',64))),0,'the other owner sees none of these devices');

-- revoke
select is(pg_temp.revoke('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',1,'op-revoke-1')->>'result','revoked','a signed revoke at the current epoch revokes');
select is((select state='revoked' and secret_id is null and device_epoch=2 from waldo.app_push_devices where installation_id='41000000-0000-0000-0000-000000000001'),true,'revoke drops the Vault secret and advances the epoch');
select is(pg_temp.revoke('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',1,'op-revoke-1')->>'result','already_recorded','a revoke replay returns the recorded receipt');
select is(pg_temp.revoke('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',1,'op-revoke-2'),null,'a revoke at a stale epoch is refused');

-- re-register, then the old revoke receipt cannot project over the new registration
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',2,'op-register-7','apns-token-0006-synthetic')->>'result','registered','re-registration at the advanced epoch is recorded');
select is(pg_temp.revoke('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',1,'op-revoke-1'),null,'an old revoke receipt does not resurface after re-registration');
select is(pg_temp.register('push-owner',repeat('a',64),'41000000-0000-0000-0000-000000000001',0,'op-register-1','apns-token-0001-synthetic'),null,'an old registration receipt does not resurface after revoke and re-registration');

-- revoke all
select is(pg_temp.register('push-foreign',repeat('f',64),'41000000-0000-0000-0000-000000000009',0,'op-register-8','apns-token-0007-synthetic')->>'result','registered','the other owner registers its own device');
select is(waldo.app_push_revoke_all('push-owner',pg_temp.at(),pg_temp.sig('app.push.revoke-all.push-owner')),1::bigint,'revoke-all revokes every active device of the owner');
select is((select count(*)::int from waldo.app_push_devices where owner_id='11000000-0000-0000-0000-000000000001' and state='active'),0,'no device of the owner stays active');
select is((select state from waldo.app_push_devices where owner_id='11000000-0000-0000-0000-000000000002'),'active','revoke-all leaves another owner untouched');
select throws_ok($$select waldo.app_push_revoke_all('push-owner',pg_temp.at(),'forged')$$,'42501',null,'a forged revoke-all signature is denied');

-- deleting the session row (console signout) revokes its push custody through the trigger
create temp table held_push_secrets as select secret_id from waldo.app_push_devices where owner_id='11000000-0000-0000-0000-000000000002' and secret_id is not null;
select is((select count(*)::int from held_push_secrets),1,'the other owner holds one secret');
select is(waldo.console_session_revoke('push-foreign',repeat('f',64),pg_temp.at(),pg_temp.sig('consolesess.revoke.push-foreign.'||repeat('f',64))),true,'the other owner signs out');
select is((select state from waldo.app_push_devices where owner_id='11000000-0000-0000-0000-000000000002'),'revoked','signout revokes that session''s device');
select is((select count(*)::int from vault.secrets where id in (select secret_id from held_push_secrets)),0,'signout deletes the push secret from Vault');

select * from finish();
rollback;
