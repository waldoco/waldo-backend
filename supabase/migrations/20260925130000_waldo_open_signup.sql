-- Open signup (issue #156): anyone with a verified email gets an owner; the form also collects a
-- phone (required at signup, stored UNVERIFIED; verification is an account-bound SMS OTP at
-- WhatsApp connect - pairing alone never verifies the number - owner decision 16:39)
-- decision 16:26). The HMAC-signed call shape stays the abuse boundary; invites remain for
-- attribution only, no longer a gate.

alter table waldo.owners add column phone text;
comment on column waldo.owners.phone is 'Contact phone (E.164) required at signup. UNVERIFIED until the account-bound SMS OTP at WhatsApp connect succeeds.';
alter table waldo.owners add column phone_verified_at timestamptz;
comment on column waldo.owners.phone_verified_at is 'Set exactly once, when the account-bound SMS OTP at WhatsApp connect verifies the stored phone. NULL = unverified; no whatsapp presence may link while NULL.';

-- One owner per email, defensively: the real flow can never verify one email into two auth
-- users (auth.users emails are unique), but a race or replay must degrade to a refusal, not a
-- duplicate tenant.
create unique index owners_live_email on waldo.owners (lower(email)) where email is not null;

-- Open gate: signed callers may send a code to any address. Enumeration is moot once signup is
-- open; the function remains so the signed-call contract and its rate-limit hooks stay in one place.
create or replace function waldo.signin_allowed(p_email text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('signin.' || lower(p_email), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return true;
end $$;

-- v3: open fallback. After the existing-owner fast path, the seeded-email claim and the invite
-- claim, an unknown verified email creates its own owner + settings in the same transaction.
-- Concurrent first-verifies for one auth user collapse onto the unique keys instead of erroring.
create or replace function waldo.owner_for_auth(p_auth_user uuid, p_email text, p_at bigint, p_sig text, p_phone text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_owner uuid; v_invite text;
begin
  if not waldo.router_signed('owner.' || p_auth_user::text || '.' || lower(p_email), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select do_name into v_do from waldo.owners where auth_user_id = p_auth_user and state = 'active';
  if v_do is not null then return v_do; end if;
  update waldo.owners set auth_user_id = p_auth_user, phone = coalesce(nullif(p_phone, ''), phone)
    where lower(email) = lower(p_email) and auth_user_id is null and state = 'active' returning do_name into v_do;
  if v_do is not null then return v_do; end if;
  update waldo.invites set used_at = now()
    where code_hash = (select code_hash from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null limit 1)
    returning code_hash into v_invite;
  insert into waldo.owners (auth_user_id, do_name, email, phone) values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), nullif(p_phone, ''))
    on conflict do nothing
    returning id, do_name into v_owner, v_do;
  if v_owner is null then
    -- Lost a race (concurrent same-auth verify) or hit the one-owner-per-email guard: re-select by
    -- auth user; a caller holding a verified email already owned by another tenant gets null.
    select do_name into v_do from waldo.owners where auth_user_id = p_auth_user and state = 'active';
    return v_do;
  end if;
  if v_invite is not null then update waldo.invites set used_by = v_owner where code_hash = v_invite; end if;
  insert into waldo.owner_settings (owner_id) values (v_owner) on conflict (owner_id) do nothing;
  return v_do;
end $$;
-- Retire the invite-gated 4-arg predecessor so exactly one entry path exists.
drop function waldo.owner_for_auth(uuid, text, bigint, text);
revoke all on function waldo.owner_for_auth(uuid, text, bigint, text, text) from public;
grant execute on function waldo.owner_for_auth(uuid, text, bigint, text, text) to anon;

-- Fail-closed until the account-bound SMS OTP slice lands (owner decision 16:39): no
-- whatsapp presence may link while the owner's phone is unverified, on ANY path
-- (link-code redeem, admin tooling, or a future bug). The SMS-OTP slice owns removal.
create or replace function waldo.require_verified_phone_for_whatsapp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider = 'whatsapp' and (select phone_verified_at from waldo.owners where id = new.owner_id) is null then
    raise exception 'whatsapp presence requires a verified phone (phone_verified_at is null)';
  end if;
  return new;
end $$;
create trigger presences_whatsapp_verified_phone before insert on waldo.presences
  for each row execute function waldo.require_verified_phone_for_whatsapp();
