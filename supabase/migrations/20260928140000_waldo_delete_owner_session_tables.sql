-- Account deletion follow-up, live receipt 2026-09-28: after the vault-portable fix
-- (20260928130000) the hosted staging delete still failed - owner directory 409, code 23503,
-- 'update or delete on table "owners" violates foreign key ... still referenced from table
-- "connect_sessions"'. connect_sessions, console_sessions and health_logs all reference
-- waldo.owners with no on delete cascade, and delete_owner never touched them. Delete those
-- rows explicitly before the owner row goes. Grants carry over (create or replace).
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
  delete from waldo.connect_sessions where owner_id = v_owner;
  delete from waldo.console_sessions where owner_id = v_owner;
  delete from waldo.health_logs where owner_id = v_owner;
  delete from waldo.owners where id = v_owner;
  return true;
end $$;
