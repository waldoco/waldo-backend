-- Account deletion: the owner deletes their whole account from the console.
-- Deletes the vault secrets behind each connection first, then the connections,
-- then the owner row (cascades presences, owner_settings, link_codes; invites.used_by goes null).
create function waldo.delete_owner(p_do_name text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_secret uuid;
begin
  if not waldo.router_signed('delown.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name;
  if v_owner is null then return false; end if;
  for v_secret in select secret_id from waldo.connections where owner_id = v_owner loop
    perform vault.delete_secret(v_secret);
  end loop;
  delete from waldo.connections where owner_id = v_owner;
  delete from waldo.owners where id = v_owner;
  return true;
end $$;
revoke all on function waldo.delete_owner(text, bigint, text) from public;
grant execute on function waldo.delete_owner(text, bigint, text) to anon;
