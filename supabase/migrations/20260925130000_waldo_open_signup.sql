-- Open signup: anyone with a verified email gets an owner; the form also collects a phone
-- (required at signup, stored UNVERIFIED; verification is an account-bound SMS OTP at
-- WhatsApp connect - pairing alone never verifies the number). The HMAC-signed call shape
-- stays the abuse boundary; invites remain for attribution only, no longer a gate.

alter table waldo.owners add column phone text;
comment on column waldo.owners.phone is 'Contact phone (E.164) required at signup. UNVERIFIED until the account-bound SMS OTP at WhatsApp connect succeeds.';
alter table waldo.owners add column bootstrap_claimable boolean not null default false;
comment on column waldo.owners.bootstrap_claimable is 'One-use bootstrap mark, set only by hand on a manually seeded owner row. The bind-by-email path requires it and clears it atomically on use; every other row can never be claimed by email match. Never set by application code.';
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
  -- The phone is part of the signed canonical data: this function stores it on the owner row,
  -- so an unsigned phone swap would be a tampered write.
  if not waldo.router_signed('owner.' || p_auth_user::text || '.' || lower(p_email) || '.' || coalesce(nullif(p_phone, ''), ''), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select do_name into v_do from waldo.owners where auth_user_id = p_auth_user and state = 'active';
  if v_do is not null then return v_do; end if;
  -- Phone is required for EVERY bind-or-provision branch below, the bootstrap claim included:
  -- the edge normalizes to E.164 and the RPC enforces presence so the edge is not the only
  -- enforcement. The refusal comes BEFORE any claim or invite consumption: a malformed call
  -- must never burn the one-use mark or attribution.
  if nullif(p_phone, '') is null then return null; end if;
  -- Bootstrap claim: the ONLY email-match bind, gated on a hand-set one-use mark that this same
  -- statement consumes. Without the mark an unbound row is never claimed by email.
  update waldo.owners set auth_user_id = p_auth_user, phone = nullif(p_phone, ''), bootstrap_claimable = false
    where lower(email) = lower(p_email) and auth_user_id is null and state = 'active' and bootstrap_claimable
    returning do_name into v_do;
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

-- Fail-closed until the account-bound SMS OTP slice lands: no whatsapp presence may link
-- while the owner's phone is unverified, on ANY path
-- (link-code redeem, admin tooling, or a future bug). The SMS-OTP slice owns removal.
create or replace function waldo.require_verified_phone_for_whatsapp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider = 'whatsapp' and (select phone_verified_at from waldo.owners where id = new.owner_id) is null then
    raise exception 'whatsapp presence requires a verified phone (phone_verified_at is null)';
  end if;
  return new;
end $$;
-- INSERT and UPDATE of the two columns that carry the invariant: a provider flip or an owner
-- swap must pass the same check, so the guard cannot be bypassed by editing an existing row.
create trigger presences_whatsapp_verified_phone before insert or update of provider, owner_id on waldo.presences
  for each row execute function waldo.require_verified_phone_for_whatsapp();

-- Auth-specific fixed-window throttle: the wrangler rate-limit binding only expresses 10s/60s
-- periods per location, so the strict per-email and per-IP OTP limits live here, global and
-- durable. p_at is signed, so the bucket cannot be rolled forward by a forged call.
create table waldo.console_auth_attempts (
  key text not null,
  bucket bigint not null,
  attempts integer not null,
  updated_at timestamptz not null default now(),
  primary key (key, bucket)
);

alter table waldo.console_auth_attempts enable row level security;
alter table waldo.console_auth_attempts force row level security;

create or replace function waldo.console_auth_throttle(p_key text, p_limit integer, p_window_seconds integer, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_bucket bigint; v_attempts integer;
begin
  if not waldo.router_signed('throttle.' || p_key || '.' || p_limit::text || '.' || p_window_seconds::text, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'throttle requires a positive limit and window' using errcode = '22023';
  end if;
  v_bucket := p_at / p_window_seconds;
  delete from waldo.console_auth_attempts where bucket < v_bucket - 1;
  insert into waldo.console_auth_attempts (key, bucket, attempts) values (p_key, v_bucket, 1)
    on conflict (key, bucket) do update set attempts = waldo.console_auth_attempts.attempts + 1, updated_at = now()
    returning attempts into v_attempts;
  return v_attempts <= p_limit;
end $$;
revoke all on function waldo.console_auth_throttle(text, integer, integer, bigint, text) from public;
grant execute on function waldo.console_auth_throttle(text, integer, integer, bigint, text) to anon;
