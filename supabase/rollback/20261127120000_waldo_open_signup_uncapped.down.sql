-- Rolls back 20261127120000: drops the uncapped open join and restores the throttle's ceiling of 100 (as of 20261101060000).
-- Run only after the Worker is back on a build that calls signup_owner_open with caps, or open joins fail closed. Joins already
-- made stay; open_signup_days keeps their count.
drop function if exists waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text);
create or replace function waldo.open_signup_throttle(p_key text, p_limit integer, p_at bigint, p_sig text) returns boolean
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
