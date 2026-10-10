-- Candidate only: owner-confirmed final identity erasure uses the existing signed
-- router rail after the owner DO has closed health, file and runtime custody.
create table waldo.app_identity_erasure_receipts (
  receipt_id uuid primary key,
  owner_locator_hash text not null check (owner_locator_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  completed_at timestamptz not null default now()
);
alter table waldo.app_identity_erasure_receipts enable row level security;
revoke all on waldo.app_identity_erasure_receipts from public,anon,authenticated,service_role;
create function waldo.app_identity_erase(p_do_name text,p_receipt_id text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_hash text; v_prior waldo.app_identity_erasure_receipts;
  v_secret uuid; v_result jsonb; v_public_count bigint; v_session_count bigint;
begin
  if p_receipt_id!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or length(p_do_name)>256
    or waldo.router_signed('app.identity.erase.'||p_do_name||'.'||p_receipt_id,p_at,p_sig) is distinct from true then
    raise exception 'unsigned or invalid call' using errcode='42501';
  end if;
  v_hash:=encode(extensions.digest(convert_to(p_do_name,'UTF8'),'sha256'),'hex');
  -- Receipt-level serialization makes a lost response replayable even after the
  -- owner/Auth mapping is erased. A receipt can never move to a different owner.
  perform pg_advisory_xact_lock(hashtextextended('app.identity.erase.'||p_receipt_id,0));
  select * into v_prior from waldo.app_identity_erasure_receipts where receipt_id=p_receipt_id::uuid;
  if found then
    if v_prior.owner_locator_hash<>v_hash then return null; end if;
    return v_prior.result;
  end if;
  select id,auth_user_id into v_owner,v_auth from waldo.owners where do_name=p_do_name for update;
  if v_owner is null or v_auth is null then return null; end if;
  -- This existing lifecycle trigger also bumps admission and workspace epochs.
  update waldo.owners set state='suspended' where id=v_owner;
  for v_secret in select secret_id from waldo.connections where owner_id=v_owner union select secret_id from waldo.app_push_devices where owner_id=v_owner and secret_id is not null loop
    delete from vault.secrets where id=v_secret;
  end loop;
  delete from waldo.connections where owner_id=v_owner;
  delete from waldo.connect_sessions where owner_id=v_owner;
  delete from waldo.console_sessions where owner_id=v_owner;
  delete from waldo.health_logs where owner_id=v_owner;
  -- All public product rows bound through this exact Auth mapping cascade from
  -- public.users. Unknown future restrictive FKs fail the transaction closed.
  select count(*) into v_public_count from public.users where auth_id=v_auth;
  delete from public.users where auth_id=v_auth;
  -- GoTrue refresh_tokens historically has no Auth FK. Remove only this mapped
  -- UUID's exact string identity; credentials never appear in the receipt.
  delete from auth.refresh_tokens where user_id::text=v_auth::text;
  delete from auth.sessions where user_id=v_auth;
  get diagnostics v_session_count=row_count;
  delete from waldo.owners where id=v_owner;
  delete from auth.users where id=v_auth;
  if exists(select 1 from auth.users where id=v_auth) or exists(select 1 from public.users where auth_id=v_auth) or exists(select 1 from waldo.owners where id=v_owner) or exists(select 1 from auth.sessions where user_id=v_auth) or exists(select 1 from auth.refresh_tokens where user_id::text=v_auth::text) then
    raise exception 'identity erasure unconfirmed';
  end if;
  -- Retain only no-content receipt custody and existing workspace mapping audit.
  -- Neither can authorize runtime access without an active owner/Auth row.
  v_result:=jsonb_build_object('version','identity-erasure.v1','receipt_id',p_receipt_id,'state','completed','auth_absent',true,'directory_absent',true,
    'public_identities_deleted',v_public_count,'auth_sessions_deleted',v_session_count,'retained','receipt_and_workspace_custody_only');
  insert into waldo.app_identity_erasure_receipts(receipt_id,owner_locator_hash,result) values(p_receipt_id::uuid,v_hash,v_result);
  return v_result;
end $$;
revoke all on function waldo.app_identity_erase(text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.app_identity_erase(text,text,bigint,text) to anon;
