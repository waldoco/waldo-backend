-- Bug fix: owner_for_auth stamped used_by on EVERY used invite for the email with used_by null,
-- not the invite just claimed. Capture the claimed invite and stamp that row only.
create or replace function waldo.owner_for_auth(p_auth_user uuid, p_email text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_owner uuid; v_invite text;
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
    returning code_hash into v_invite;
  if v_invite is null then return null; end if;
  insert into waldo.owners (auth_user_id, do_name, email) values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email))
    returning id, do_name into v_owner, v_do;
  update waldo.invites set used_by = v_owner where code_hash = v_invite;
  insert into waldo.owner_settings (owner_id) values (v_owner);
  return v_do;
end $$;

revoke all on function waldo.owner_for_auth(uuid, text, bigint, text) from public;
grant execute on function waldo.owner_for_auth(uuid, text, bigint, text) to anon;
