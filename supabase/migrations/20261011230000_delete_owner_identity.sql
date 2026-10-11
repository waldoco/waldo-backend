-- Account deletion removed the directory owner but left the person's Auth identity (email, sign-in history, refresh
-- tokens), the email on the invite they redeemed, and the push token held in Vault. This closes those, in the same
-- transaction and the same signed call. The owner row is locked first, so a signed write already in flight finishes
-- before the delete and a later one finds no owner. Grants carry over.
-- Order matters: the invite is redacted while used_by still names the owner (the owner delete nulls it), and the legacy
-- public.users row goes before auth.users because its foreign key has no delete action. Refresh tokens carry no foreign
-- key to auth.users, so they are removed by user id; sessions are removed explicitly so the delete does not depend on
-- the Auth schema's cascade. Left behind on purpose: the Auth audit log and waldo.workspace_owner_mappings (identifiers
-- only, custody closes under a separately authorised purge).
create or replace function waldo.delete_owner(p_do_name text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_auth uuid;
  v_secret uuid;
begin
  if not waldo.router_signed('delown.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select id, auth_user_id into v_owner, v_auth from waldo.owners where do_name = p_do_name for update;
  if v_owner is null then return false; end if;
  for v_secret in
    select secret_id from waldo.connections where owner_id = v_owner and secret_id is not null
    union
    select secret_id from waldo.app_push_devices where owner_id = v_owner and secret_id is not null
  loop
    delete from vault.secrets where id = v_secret;
  end loop;
  delete from waldo.connections where owner_id = v_owner;
  delete from waldo.connect_sessions where owner_id = v_owner;
  delete from waldo.console_sessions where owner_id = v_owner;
  delete from waldo.health_logs where owner_id = v_owner;
  update waldo.invites set email = null where used_by = v_owner;
  if v_auth is not null then
    delete from public.health_context_daily where user_id = v_auth;
    delete from public.users where auth_id = v_auth;
    delete from auth.refresh_tokens where user_id = v_auth::text;
    delete from auth.sessions where user_id = v_auth;
  end if;
  delete from waldo.owners where id = v_owner;
  if v_auth is not null then
    delete from auth.users where id = v_auth;
    if exists (select 1 from auth.users where id = v_auth) then raise exception 'identity erasure unconfirmed'; end if;
  end if;
  return true;
end $$;
