-- Invited membership requires verified email. A phone is optional unverified contact
-- data; it grants no presence, linking authority or phone verification.
-- Keep the existing sign-in RPC unchanged: only this dedicated completion path
-- may provision an owner without a phone, and it never claims a seeded email row.
create function waldo.signup_owner_for_auth(
  p_auth_user uuid,
  p_email text,
  p_at bigint,
  p_sig text,
  p_phone text default null,
  p_code_hash text default ''
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_owner uuid; v_invite text; v_phone text;
begin
  if waldo.router_signed('signup.owner.' || p_auth_user::text || '.' || lower(p_email) || '.'
      || coalesce(nullif(p_phone, ''), '') || '.' || p_code_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_phone := nullif(p_phone, '');
  if p_email is null or length(p_email) > 254 or position('@' in p_email) < 2
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$') then return null; end if;

  -- The runtime verifies the OTP response; the database independently binds its
  -- subject to the matching confirmed Auth email. Locking this identity also
  -- serializes repeated completions before the owner/invite reads and keeps an
  -- Auth email change from racing this transaction.
  perform 1 from auth.users
    where id = p_auth_user and lower(email) = lower(p_email) and email_confirmed_at is not null
    for update;
  if not found then return null; end if;

  -- A retry after a lost response/session grant resolves only the already-bound
  -- active canonical identity. It cannot update contacts or spend another invite.
  select do_name into v_do from waldo.owners
    where auth_user_id = p_auth_user and lower(email) = lower(p_email) and state = 'active'
    for update;
  if v_do is not null then return v_do; end if;
  if p_code_hash !~ '^[0-9a-f]{64}$' then return null; end if;

  -- The exact recipient-bound invite is the only new-member admission authority.
  -- This row lock and every following write belong to the same transaction.
  update waldo.invites set used_at = now()
    where code_hash = p_code_hash and lower(email) = lower(p_email)
      and used_at is null and revoked_at is null and expires_at > now()
    returning code_hash into v_invite;
  if v_invite is null then return null; end if;
  insert into waldo.owners (auth_user_id, do_name, email, phone)
    values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), v_phone)
    on conflict do nothing returning id, do_name into v_owner, v_do;
  if v_owner is null then
    -- Collisions include seeded/unbound and suspended identities. Raising rolls
    -- back invite consumption instead of rebinding a different owner by email.
    raise exception 'owner already exists' using errcode = '23505';
  end if;
  update waldo.invites set used_by = v_owner where code_hash = v_invite;
  insert into waldo.owner_settings (owner_id) values (v_owner);
  return v_do;
end $$;

revoke all on function waldo.signup_owner_for_auth(uuid, text, bigint, text, text, text) from public, anon, authenticated, service_role;
grant execute on function waldo.signup_owner_for_auth(uuid, text, bigint, text, text, text) to anon;
comment on column waldo.owners.phone is 'Optional contact phone (E.164). UNVERIFIED until an account-bound phone verification flow succeeds; signup never sets phone_verified_at.';
