-- The owner's own confirmed sign-in email, for the app's account view. Signed like the phone-state read; the address is the
-- one route_presence already trusts: the Auth user of this owner whose email still equals the owner's and is confirmed.
create function waldo.owner_account_email(p_do_name text, p_at bigint, p_sig text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('accountemail.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return (select lower(u.email)::text
    from waldo.owners o
    join auth.users u on u.id = o.auth_user_id and lower(u.email) = lower(o.email) and u.email_confirmed_at is not null
    where o.do_name = p_do_name and o.state = 'active' limit 1);
end $$;
revoke all on function waldo.owner_account_email(text, bigint, text) from public;
grant execute on function waldo.owner_account_email(text, bigint, text) to anon;
