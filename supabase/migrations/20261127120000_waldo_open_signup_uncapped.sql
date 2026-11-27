-- Open sign-up without join caps (owner ruling, 27 Nov 2026): every confirmed Auth email may become an owner while the Worker's
-- OPEN_SIGNUP is on. The abuse throttles stay, with a ceiling high enough for a cohort joining from one network.
--
-- Additive: signup_owner_open and open_signup_room keep their capped definitions, so a Worker rolled back to the capped build still
-- works. A Worker on this build calls signup_owner_open_uncapped, which is signup_owner_open without the caps and their lock. The
-- day's joins are still counted in open_signup_days, so operators can see how many joined, but nothing is refused for it.

create function waldo.signup_owner_open_uncapped(p_auth_user uuid, p_email text, p_provider text, p_subject text, p_phone text,
  p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_phone text := nullif(p_phone, ''); v_owner uuid; v_do text; v_invite text; v_day date := (now() at time zone 'utc')::date;
begin
  if waldo.router_signed('signup.open.uncapped.' || p_auth_user::text || '.' || lower(p_email) || '.' || p_provider || '.' || p_subject
      || '.' || coalesce(v_phone, ''), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_email is null or length(p_email) > 254 or position('@' in p_email) < 2
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$')
     or p_provider is null or p_provider not in ('', 'apple', 'google')
     or (p_provider = '') <> (coalesce(p_subject, '') = '') then return null; end if;

  -- The binding signup_owner_open makes: the subject is a confirmed Auth user holding this exact email, row-locked so this user's
  -- repeated joins, and an invite join for the same user, run one at a time.
  perform 1 from auth.users where id = p_auth_user and lower(email) = lower(p_email) and email_confirmed_at is not null for update;
  if not found then return null; end if;
  select o.do_name into v_do from waldo.owners o where o.auth_user_id = p_auth_user and lower(o.email) = lower(p_email) and o.state = 'active';
  if v_do is not null then return jsonb_build_object('do_name', v_do, 'created', false); end if;

  -- A live invite addressed to this confirmed email still admits its holder as invited: not held, and the invite names who joined.
  select code_hash into v_invite from waldo.invites
    where lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()
    order by created_at limit 1 for update;
  insert into waldo.owners (auth_user_id, do_name, email, phone, admitted_via)
    values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), v_phone, case when v_invite is null then 'open' end)
    on conflict do nothing returning id, do_name into v_owner, v_do;
  -- Another owner row for this person (suspended, seeded and unbound, or bound under another email) holds the email or the Auth
  -- user. It is never rebound or duplicated.
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
revoke all on function waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text) to anon;

-- The attempt throttle, re-created whole from 20261101060000 with one change: a limit up to 1000 a day, so one network can carry a
-- cohort of joins. Signature, canonical string, security definer, search_path and grants are kept.
create or replace function waldo.open_signup_throttle(p_key text, p_limit integer, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_day date; v_attempts integer;
begin
  if waldo.router_signed('signup.open.throttle.' || p_key || '.' || p_limit::text, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^(ip|email)\.[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 1000 then return false; end if;
  v_day := (to_timestamp(p_at) at time zone 'utc')::date;
  delete from waldo.open_signup_attempts where day < v_day - 1;
  insert into waldo.open_signup_attempts (key, day, attempts) values (p_key, v_day, 1)
    on conflict (key, day) do update set attempts = waldo.open_signup_attempts.attempts + 1
    returning attempts into v_attempts;
  return v_attempts <= p_limit;
end $$;
