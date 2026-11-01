-- The Google identity this owner signs in with, for connecting Google with that same account. Google's consent page takes
-- the identity's subject as login_hint; the email is the owner's own confirmed address, the one owner_account_email serves,
-- shown back to the owner in their own app. Only an identity Waldo trusts and Supabase still links to the owner's Auth
-- user counts; with several, the most recently trusted. Null when there is none. Signed like owner_account_email.
create function waldo.owner_google_signin(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('googlesignin.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return (select jsonb_build_object('subject', t.subject, 'email', lower(u.email))
    from waldo.owners o
    join auth.users u on u.id = o.auth_user_id and lower(u.email) = lower(o.email) and u.email_confirmed_at is not null
    join waldo.owner_signin_identities t on t.owner_id = o.id and t.provider = 'google'
    join auth.identities i on i.user_id = o.auth_user_id and i.provider = 'google' and i.provider_id = t.subject
    where o.do_name = p_do_name and o.state = 'active'
    order by t.trusted_at desc, t.subject limit 1);
end $$;
revoke all on function waldo.owner_google_signin(text, bigint, text) from public, anon, authenticated;
grant execute on function waldo.owner_google_signin(text, bigint, text) to anon;
