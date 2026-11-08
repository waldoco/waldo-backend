-- Whether the asking DO's owner is an active admin, and nothing more. The runtime gates its admin-only commands on this
-- answer instead of reading every owner's email and invites through admin_overview. As there, only a signed router call
-- names the asking DO.
create function waldo.admin_check(p_do_name text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('admincheck.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return waldo.is_admin(p_do_name);
end $$;

revoke all on function waldo.admin_check(text, bigint, text) from public;
grant execute on function waldo.admin_check(text, bigint, text) to anon;
