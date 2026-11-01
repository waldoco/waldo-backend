-- Open sign-up behind the Worker's OPEN_SIGNUP: a person with a confirmed Auth email becomes an owner without an invite code,
-- under a server-wide daily cap and a lifetime cap the router signs into each call. Someone holding a live invite addressed
-- to that email joins as invited, without typing its code. The invite functions and their
-- signatures are untouched, so with the flag off nothing here is reached and joining still takes an invite.
--
-- An owner who joined this way is held until the owner object has seen the terms, the privacy notice and the 18+
-- attestation accepted. open_released_at records that release once. It is an admission event, not a copy of consent:
-- consent lives in the owner object's ledger, and a later change to the agreements copy does not hold the owner again,
-- the same as for every invited owner. While held, the owner is issued no link code and no messaging presence binds.

alter table waldo.owners add column admitted_via text check (admitted_via in ('open'));
comment on column waldo.owners.admitted_via is 'open: joined without an invite through signup_owner_open. NULL: invited, seeded, or created before open sign-up.';
alter table waldo.owners add column open_released_at timestamptz;
comment on column waldo.owners.open_released_at is 'When the owner object released an open owner after its agreements and 18+ were accepted. Written once, only by release_open_owner.';

-- Open joins per UTC day. No owner and no email, so deleting an account never gives its place back.
create table waldo.open_signup_days (
  day date primary key,
  admitted integer not null check (admitted >= 0)
);
-- Open-join attempts per hashed IP or hashed email per UTC day. Only this table's own rows are ever swept.
create table waldo.open_signup_attempts (
  key text not null check (key ~ '^(ip|email)\.[0-9a-f]{64}$'),
  day date not null,
  attempts integer not null,
  primary key (key, day)
);
alter table waldo.open_signup_days enable row level security;
alter table waldo.open_signup_days force row level security;
alter table waldo.open_signup_attempts enable row level security;
alter table waldo.open_signup_attempts force row level security;
revoke all on waldo.open_signup_days, waldo.open_signup_attempts from public, anon, authenticated, service_role;

-- Whether the active owner is an open owner still waiting for release. Not callable through the API.
create function waldo.open_owner_held(p_owner uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from waldo.owners where id = p_owner and admitted_via = 'open' and open_released_at is null)
$$;
revoke all on function waldo.open_owner_held(uuid) from public, anon, authenticated, service_role;

-- Whether one more open join fits today and in all. Caps are clamped so a mistyped var cannot open the doors wide.
create function waldo.open_signup_fits(p_daily_cap integer, p_total_cap integer) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select admitted from waldo.open_signup_days where day = (now() at time zone 'utc')::date), 0) < least(p_daily_cap, 200)
     and coalesce((select sum(admitted) from waldo.open_signup_days), 0) < least(p_total_cap, 200)
$$;
revoke all on function waldo.open_signup_fits(integer, integer) from public, anon, authenticated, service_role;

create function waldo.signup_owner_open(p_auth_user uuid, p_email text, p_provider text, p_subject text, p_phone text,
  p_daily_cap integer, p_total_cap integer, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_phone text := nullif(p_phone, ''); v_owner uuid; v_do text; v_invite text; v_day date := (now() at time zone 'utc')::date;
begin
  if waldo.router_signed('signup.open.' || p_auth_user::text || '.' || lower(p_email) || '.' || p_provider || '.' || p_subject
      || '.' || coalesce(v_phone, '') || '.' || p_daily_cap::text || '.' || p_total_cap::text, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_daily_cap is null or p_total_cap is null or p_daily_cap < 1 or p_total_cap < 1 then
    raise exception 'open sign-up requires positive caps' using errcode = '22023';
  end if;
  if p_email is null or length(p_email) > 254 or position('@' in p_email) < 2
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$')
     or p_provider is null or p_provider not in ('', 'apple', 'google')
     or (p_provider = '') <> (coalesce(p_subject, '') = '') then return null; end if;

  -- The same binding signup_owner_core makes: the subject is a confirmed Auth user holding this exact email. The row
  -- lock serializes this user's own repeated joins, and an invite join for the same user, ahead of every read below.
  perform 1 from auth.users where id = p_auth_user and lower(email) = lower(p_email) and email_confirmed_at is not null for update;
  if not found then return null; end if;
  select o.do_name into v_do from waldo.owners o where o.auth_user_id = p_auth_user and lower(o.email) = lower(p_email) and o.state = 'active';
  if v_do is not null then return jsonb_build_object('do_name', v_do, 'created', false); end if;

  -- A live invite addressed to this confirmed email admits its holder without the code: they join as invited, take no open
  -- place and are not held, and the invite records who joined. The confirmed email is the addressee proof the code stood for.
  select code_hash into v_invite from waldo.invites
    where lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()
    order by created_at limit 1 for update;
  if v_invite is null then
    -- One open join at a time across the server, so two joins can never both take the last place.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldo.open_signup', 0));
    if not waldo.open_signup_fits(p_daily_cap, p_total_cap) then return jsonb_build_object('refused', 'cap'); end if;
  end if;
  insert into waldo.owners (auth_user_id, do_name, email, phone, admitted_via)
    values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), v_phone, case when v_invite is null then 'open' end)
    on conflict do nothing returning id, do_name into v_owner, v_do;
  -- Another owner row for this person (suspended, seeded and unbound, or bound under another email) holds the email or
  -- the Auth user. It is never rebound or duplicated; the answer is a refusal the app shows, not an error it retries.
  if v_owner is null then return jsonb_build_object('refused', 'taken'); end if;
  insert into waldo.owner_settings (owner_id) values (v_owner);
  if p_provider in ('apple', 'google') and exists (
      select 1 from auth.identities where user_id = p_auth_user and provider = p_provider and provider_id = p_subject) then
    insert into waldo.owner_signin_identities (owner_id, provider, subject) values (v_owner, p_provider, p_subject);
  end if;
  if v_invite is not null then
    update waldo.invites set used_at = now(), used_by = v_owner where code_hash = v_invite;
  else
    insert into waldo.open_signup_days (day, admitted) values (v_day, 1)
      on conflict (day) do update set admitted = waldo.open_signup_days.admitted + 1;
  end if;
  return jsonb_build_object('do_name', v_do, 'created', true);
end $$;
revoke all on function waldo.signup_owner_open(uuid, text, text, text, text, integer, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.signup_owner_open(uuid, text, text, text, text, integer, integer, bigint, text) to anon;

-- Whether a code may be emailed to an address that is not yet an owner: only while a join could still fit.
create function waldo.open_signup_room(p_daily_cap integer, p_total_cap integer, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if waldo.router_signed('signup.open.room.' || p_daily_cap::text || '.' || p_total_cap::text, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_daily_cap is null or p_total_cap is null or p_daily_cap < 1 or p_total_cap < 1 then return false; end if;
  return waldo.open_signup_fits(p_daily_cap, p_total_cap);
end $$;
revoke all on function waldo.open_signup_room(integer, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.open_signup_room(integer, integer, bigint, text) to anon;

-- Counts one open-join attempt for a hashed IP or email in the signed call's UTC day; false once past the limit.
create function waldo.open_signup_throttle(p_key text, p_limit integer, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_day date; v_attempts integer;
begin
  if waldo.router_signed('signup.open.throttle.' || p_key || '.' || p_limit::text, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^(ip|email)\.[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 100 then return false; end if;
  v_day := (to_timestamp(p_at) at time zone 'utc')::date;
  delete from waldo.open_signup_attempts where day < v_day - 1;
  insert into waldo.open_signup_attempts (key, day, attempts) values (p_key, v_day, 1)
    on conflict (key, day) do update set attempts = waldo.open_signup_attempts.attempts + 1
    returning attempts into v_attempts;
  return v_attempts <= p_limit;
end $$;
revoke all on function waldo.open_signup_throttle(text, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.open_signup_throttle(text, integer, bigint, text) to anon;

-- What the owner object needs to know about its owner's admission: held (open, not yet released), released (open and
-- released), member (any other active owner), or null when no active owner has this name.
create function waldo.open_owner_state(p_do_name text, p_at bigint, p_sig text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if waldo.router_signed('openowner.state.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return (select case when admitted_via is null then 'member' when open_released_at is null then 'held' else 'released' end
    from waldo.owners where do_name = p_do_name and state = 'active');
end $$;
revoke all on function waldo.open_owner_state(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.open_owner_state(text, bigint, text) to anon;

-- Called by the owner object once it holds the owner's accepted agreements and 18+. Repeating it changes nothing.
-- True when the owner is an open owner now released; false for any other owner.
create function waldo.release_open_owner(p_do_name text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('openowner.release.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  update waldo.owners set open_released_at = coalesce(open_released_at, now())
    where do_name = p_do_name and state = 'active' and admitted_via = 'open';
  return found;
end $$;
revoke all on function waldo.release_open_owner(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.release_open_owner(text, bigint, text) to anon;

-- Link codes: re-created whole from their last definitions (both 20261014120000) with one change, a held
-- open owner is refused. Signatures, canonical strings, security definer, search_path and grants are kept.
create or replace function waldo.issue_link_code(p_do_name text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('link.' || p_do_name || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null or waldo.open_owner_held(v_owner) then return false; end if;
  delete from waldo.link_codes where owner_id = v_owner and provider = 'telegram' and used_at is null;
  insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values (p_code_hash, v_owner, 'telegram', now() + interval '10 minutes');
  return true;
end $$;

create or replace function waldo.issue_provider_link_code(p_do_name text, p_provider text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('link.' || p_provider || '.' || p_do_name || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('telegram', 'whatsapp', 'imessage') or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null or waldo.open_owner_held(v_owner) then return false; end if;
  delete from waldo.link_codes where owner_id = v_owner and provider = p_provider and used_at is null;
  insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values (p_code_hash, v_owner, p_provider, now() + interval '10 minutes');
  return true;
end $$;

-- Every other way a messaging presence binds (text-first confirm, a texted code, a bridge, admin tooling) meets the
-- same refusal here, on insert and on a change of owner or provider.
create function waldo.require_released_open_owner_for_presence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider in ('telegram', 'whatsapp', 'imessage') and waldo.open_owner_held(new.owner_id) then
    raise exception 'messaging presence requires a released open owner' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function waldo.require_released_open_owner_for_presence() from public, anon, authenticated, service_role;
create trigger presences_open_owner_released before insert or update of provider, owner_id on waldo.presences
  for each row execute function waldo.require_released_open_owner_for_presence();
