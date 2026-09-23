-- An owner unlinks a presence from the console. Routing stops at once because route_presence reads only active rows.
create function waldo.unlink_presence(p_do_name text, p_provider text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('unlink.' || p_do_name || '.' || p_provider, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.presences p set state = 'unlinked', unlinked_at = now()
    from waldo.owners o where o.id = p.owner_id and o.do_name = p_do_name and p.provider = p_provider and p.state = 'active';
  return found;
end $$;
revoke all on function waldo.unlink_presence(text, text, bigint, text) from public;
grant execute on function waldo.unlink_presence(text, text, bigint, text) to anon;
