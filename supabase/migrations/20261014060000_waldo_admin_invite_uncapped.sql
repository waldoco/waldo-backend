-- The admin issues invites without a lifetime cap, so re-inviting people never runs out of codes.
-- Everything else is unchanged. Each code works once, only for its recipient email, and expires
-- in 14 days. Non-admins are refused, and so are active owners and emails that already hold a
-- live code. Members keep their cap of five (issue_member_invite).
create or replace function waldo.admin_invite(p_do_name text, p_email text, p_at bigint, p_sig text, p_code_hash text default '') returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('invite.' || p_do_name || '.' || lower(p_email) || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if position('@' in p_email) < 2 or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  -- The row lock checks admin status against a concurrent demotion, which waits for this commit.
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' and is_admin for update;
  if v_owner is null then return false; end if;
  -- Serialise same-email issuance across issuers, so one email never holds two live codes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(p_email), 0));
  if exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active')
    or exists (select 1 from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()) then return false; end if;
  insert into waldo.invites (code_hash, email, issued_by, expires_at)
    values (p_code_hash, lower(p_email), v_owner, now() + interval '14 days') on conflict do nothing;
  return found;
end $$;
revoke all on function waldo.admin_invite(text, text, bigint, text, text) from public;
grant execute on function waldo.admin_invite(text, text, bigint, text, text) to anon;
