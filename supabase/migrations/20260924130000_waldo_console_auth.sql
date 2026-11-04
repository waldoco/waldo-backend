-- Console sign-in: invite-gated email OTP. Same signed-call rule as the router functions.
create function waldo.signin_allowed(p_email text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('signin.' || lower(p_email), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active')
    or exists (select 1 from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null);
end $$;

-- Maps a verified Supabase Auth user to their owner. First sign-in binds an owner row seeded with the email,
-- or claims an open invite and creates the owner. Returns the owner's Durable Object name, or null.
create function waldo.owner_for_auth(p_auth_user uuid, p_email text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_owner uuid;
begin
  if not waldo.router_signed('owner.' || p_auth_user::text || '.' || lower(p_email), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select do_name into v_do from waldo.owners where auth_user_id = p_auth_user and state = 'active';
  if v_do is not null then return v_do; end if;
  update waldo.owners set auth_user_id = p_auth_user
    where lower(email) = lower(p_email) and auth_user_id is null and state = 'active' returning do_name into v_do;
  if v_do is not null then return v_do; end if;
  update waldo.invites set used_at = now()
    where code_hash = (select code_hash from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null limit 1)
    returning code_hash into v_do;
  if v_do is null then return null; end if;
  insert into waldo.owners (auth_user_id, do_name, email) values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email))
    returning id, do_name into v_owner, v_do;
  update waldo.invites set used_by = v_owner where used_by is null and lower(email) = lower(p_email) and used_at is not null;
  insert into waldo.owner_settings (owner_id) values (v_owner);
  return v_do;
end $$;

create function waldo.issue_link_code(p_do_name text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('link.' || p_do_name || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return false; end if;
  delete from waldo.link_codes where owner_id = v_owner and used_at is null;
  insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values (p_code_hash, v_owner, 'telegram', now() + interval '10 minutes');
  return true;
end $$;

revoke all on function waldo.signin_allowed(text, bigint, text) from public;
revoke all on function waldo.owner_for_auth(uuid, text, bigint, text) from public;
revoke all on function waldo.issue_link_code(text, text, bigint, text) from public;
grant execute on function waldo.signin_allowed(text, bigint, text) to anon;
grant execute on function waldo.owner_for_auth(uuid, text, bigint, text) to anon;
grant execute on function waldo.issue_link_code(text, text, bigint, text) to anon;
