-- Account deletion left the owner's derived health rows behind. public.health_context_daily is keyed on the auth user and
-- cascades only from auth.users; delete_owner removes the directory owner, not the auth user, so those rows (scores,
-- zones, drivers) stayed stored with no way to read them. Raw readings, consent, anchors, receipts and the basis row
-- cascade from the owner and were already removed. The owner row is locked first, the same lock the signed health
-- writes take, so a write already in flight finishes before the delete and a later one finds no owner. Grants carry over.
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
  for v_secret in select secret_id from waldo.connections where owner_id = v_owner loop
    delete from vault.secrets where id = v_secret;
  end loop;
  delete from waldo.connections where owner_id = v_owner;
  delete from waldo.connect_sessions where owner_id = v_owner;
  delete from waldo.console_sessions where owner_id = v_owner;
  delete from waldo.health_logs where owner_id = v_owner;
  delete from public.health_context_daily where user_id = v_auth;
  delete from waldo.owners where id = v_owner;
  return true;
end $$;
