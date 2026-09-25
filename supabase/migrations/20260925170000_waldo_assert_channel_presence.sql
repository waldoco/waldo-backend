-- Outbound sends re-check ownership at send time: a DO only sends to a channel subject
-- while an active presence still binds that subject to this owner. A rebind tombstones the
-- old row, and the old owner's next send attempt then fails closed instead of crossing the
-- ownership boundary.
create function waldo.assert_channel_presence(p_do_name text, p_provider text, p_subject text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('presence.' || p_do_name || '.' || p_provider || '.' || p_subject, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return exists (
    select 1 from waldo.presences p join waldo.owners o on o.id = p.owner_id
    where o.do_name = p_do_name and o.state = 'active'
      and p.provider = p_provider and p.subject = p_subject and p.state = 'active'
  );
end $$;
revoke all on function waldo.assert_channel_presence(text, text, text, bigint, text) from public;
grant execute on function waldo.assert_channel_presence(text, text, text, bigint, text) to anon;
