-- Account deletion, portable across hosted vault versions: 20260924190000 called
-- vault.delete_secret(uuid), which the hosted staging project does not expose (runtime
-- receipt 2026-09-28: owner directory 404, code 42883, "function vault.delete_secret(uuid)
-- does not exist"; account.delete 500'd before the DO storage wipe). create_secret exists
-- there, so the extension is present - the delete helper is what differs. Delete from
-- vault.secrets directly: it is the extension's own storage table, the same thing the
-- helper does, and the repo's pgTAP setup already writes/deletes vault.secrets rows
-- directly (supabase/tests/*). Behavior is otherwise unchanged.
create or replace function waldo.delete_owner(p_do_name text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_secret uuid;
begin
  if not waldo.router_signed('delown.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name;
  if v_owner is null then return false; end if;
  for v_secret in select secret_id from waldo.connections where owner_id = v_owner loop
    delete from vault.secrets where id = v_secret;
  end loop;
  delete from waldo.connections where owner_id = v_owner;
  delete from waldo.owners where id = v_owner;
  return true;
end $$;
