-- A Gmail push names only the mailbox address. Map it to the owners whose live connection holds that
-- account, so the Worker can wake each one. The address is already stored lower-cased on the
-- connection; this adds no column and stores nothing. Router-signed like the other connection calls.
create function waldo.gmail_push_route(p_account text, p_at bigint, p_sig text) returns table(do_name text, connection uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('gmailroute.' || lower(p_account), p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return query select o.do_name, c.id from waldo.connections c join waldo.owners o on o.id = c.owner_id
    where c.provider = 'google' and c.account = lower(p_account) and c.status <> 'revoked' and o.state = 'active';
end $$;

revoke all on function waldo.gmail_push_route(text, bigint, text) from public;
grant execute on function waldo.gmail_push_route(text, bigint, text) to anon;
