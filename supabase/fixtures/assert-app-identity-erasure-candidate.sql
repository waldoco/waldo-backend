-- Only a dedicated, network-isolated synthetic rights fixture database.
-- Apply reviewed candidate migrations first. Every test row is rolled back.
begin;
insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-000000000001','erase-a@example.invalid'),
 ('b1000000-0000-0000-0000-000000000001','erase-b@example.invalid');
insert into public.users(id,auth_id,name,email) values
 ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Synthetic A','erase-a@example.invalid'),
 ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Synthetic B','erase-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','erase-owner-a','erase-a@example.invalid'),
 ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','erase-owner-b','erase-b@example.invalid');
insert into waldo.owner_settings(owner_id) values
 ('a3000000-0000-0000-0000-000000000001'),('b3000000-0000-0000-0000-000000000001');
insert into waldo.presences(owner_id,provider,subject) values
 ('a3000000-0000-0000-0000-000000000001','telegram','800000001'),
 ('b3000000-0000-0000-0000-000000000001','telegram','800000002');
insert into waldo.console_sessions(owner_id,session_hash,created_at,last_seen_at) values
 ('a3000000-0000-0000-0000-000000000001',repeat('a',64),now(),now()),
 ('b3000000-0000-0000-0000-000000000001',repeat('b',64),now(),now());
insert into auth.sessions(id,user_id) values
 ('a5000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001'),
 ('b5000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001');
insert into auth.refresh_tokens(token,user_id) values
 ('synthetic-refresh-a-only','a1000000-0000-0000-0000-000000000001'),
 ('synthetic-refresh-b-only','b1000000-0000-0000-0000-000000000001');
insert into waldo.connections(owner_id,provider,account,scopes,secret_id) values
 ('a3000000-0000-0000-0000-000000000001','google','a@example.invalid','{}',vault.create_secret('synthetic-google-token-a-only')),
 ('b3000000-0000-0000-0000-000000000001','google','b@example.invalid','{}',vault.create_secret('synthetic-google-token-b-only'));
insert into waldo.app_push_devices(owner_id,installation_id,session_hash,provider,environment,device_epoch,state,secret_id,token_hash) values
 ('a3000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000001',repeat('a',64),'apns','sandbox',1,'active',vault.create_secret('synthetic-push-token-a-only'),repeat('a',64)),
 ('b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001',repeat('b',64),'apns','sandbox',1,'active',vault.create_secret('synthetic-push-token-b-only'),repeat('b',64));
insert into waldo.workspace_owner_mappings(environment,namespace,do_name,do_id,owner_id) values
 ('test','owner','erase-owner-a',repeat('a',64),'a3000000-0000-0000-0000-000000000001'),
 ('test','owner','erase-owner-b',repeat('b',64),'b3000000-0000-0000-0000-000000000001');
select vault.create_secret('synthetic-identity-router-secret-only','waldo_router_hmac');
create function pg_temp.erase(p_owner text,p_receipt text) returns jsonb language sql as $$
 select waldo.app_identity_erase(p_owner,p_receipt,extract(epoch from now())::bigint,
   encode(extensions.hmac(extract(epoch from now())::bigint::text||'.app.identity.erase.'||p_owner||'.'||p_receipt,'synthetic-identity-router-secret-only','sha256'),'hex'))
$$;
do $$
declare r jsonb; first_receipt jsonb; checks integer:=0;
  receipt_id text:='a6000000-0000-4000-8000-000000000001';
begin
  begin
    perform waldo.app_identity_erase('erase-owner-a',receipt_id,extract(epoch from now())::bigint,'unsigned');
    raise exception 'unsigned erasure was allowed';
  exception when insufficient_privilege then checks:=checks+1;
  end;
  assert exists(select 1 from auth.users where id='a1000000-0000-0000-0000-000000000001'),'unsigned rejection preserves owner'; checks:=checks+1;
  r:=pg_temp.erase('erase-owner-a',receipt_id); first_receipt:=r;
  assert r->>'state'='completed' and r->>'auth_absent'='true' and r->>'directory_absent'='true','actual identity erasure reports confirmed absence'; checks:=checks+1;
  assert r->>'public_identities_deleted'='1' and r->>'auth_sessions_deleted'='1','receipt counts mapped rows only'; checks:=checks+1;
  assert not exists(select 1 from auth.users where id='a1000000-0000-0000-0000-000000000001') and not exists(select 1 from public.users where auth_id='a1000000-0000-0000-0000-000000000001'),'mapped Auth and public identities are absent'; checks:=checks+1;
  assert not exists(select 1 from waldo.owners where id='a3000000-0000-0000-0000-000000000001'),'owner directory is absent'; checks:=checks+1;
  assert not exists(select 1 from auth.sessions where user_id='a1000000-0000-0000-0000-000000000001') and not exists(select 1 from auth.refresh_tokens where user_id='a1000000-0000-0000-0000-000000000001'),'mapped Auth sessions and orphan-compatible refresh tokens are absent'; checks:=checks+1;
  assert not exists(select 1 from waldo.console_sessions where owner_id='a3000000-0000-0000-0000-000000000001') and not exists(select 1 from waldo.presences where owner_id='a3000000-0000-0000-0000-000000000001') and not exists(select 1 from waldo.owner_settings where owner_id='a3000000-0000-0000-0000-000000000001'),'owner runtime admission directory rows cascade'; checks:=checks+1;
  assert not exists(select 1 from waldo.app_push_devices where owner_id='a3000000-0000-0000-0000-000000000001') and not exists(select 1 from waldo.connections where owner_id='a3000000-0000-0000-0000-000000000001'),'mapped connector and push metadata are absent'; checks:=checks+1;
  assert not exists(select 1 from vault.decrypted_secrets where decrypted_secret in ('synthetic-google-token-a-only','synthetic-push-token-a-only')),'mapped Vault credentials are physically absent'; checks:=checks+1;
  assert exists(select 1 from auth.users where id='b1000000-0000-0000-0000-000000000001') and exists(select 1 from public.users where auth_id='b1000000-0000-0000-0000-000000000001') and exists(select 1 from waldo.owners where id='b3000000-0000-0000-0000-000000000001'),'second owner identity stays active'; checks:=checks+1;
  assert exists(select 1 from auth.sessions where user_id='b1000000-0000-0000-0000-000000000001') and exists(select 1 from auth.refresh_tokens where user_id='b1000000-0000-0000-0000-000000000001'),'second owner Auth credentials survive'; checks:=checks+1;
  assert exists(select 1 from vault.decrypted_secrets where decrypted_secret='synthetic-google-token-b-only') and exists(select 1 from vault.decrypted_secrets where decrypted_secret='synthetic-push-token-b-only'),'second owner Vault credentials survive'; checks:=checks+1;
  r:=pg_temp.erase('erase-owner-a',receipt_id);
  assert r=first_receipt,'lost acknowledgment replays after directory and Auth deletion'; checks:=checks+1;
  r:=pg_temp.erase('erase-owner-b',receipt_id);
  assert r is null and exists(select 1 from waldo.owners where id='b3000000-0000-0000-0000-000000000001'),'receipt cannot move to another owner'; checks:=checks+1;
  r:=pg_temp.erase('erase-owner-a','a6000000-0000-4000-8000-000000000002');
  assert r is null,'new receipt cannot manufacture erasure for absent owner'; checks:=checks+1;
  assert not first_receipt::text like '%synthetic-%' and not first_receipt::text like '%erase-owner%' and not first_receipt::text like '%@example.invalid%','public erasure receipt contains no credentials or owner locator'; checks:=checks+1;
  assert exists(select 1 from waldo.workspace_owner_mappings where owner_id='a3000000-0000-0000-0000-000000000001'),'retired workspace mapping audit is explicitly retained'; checks:=checks+1;
  assert not has_table_privilege('anon','waldo.app_identity_erasure_receipts','select') and not has_table_privilege('authenticated','waldo.app_identity_erasure_receipts','select'),'no direct erasure receipt reads'; checks:=checks+1;
  raise notice 'app identity erasure: % synthetic assertions PASS',checks;
end $$;
rollback;
