-- console_auth_throttle swept the whole table on the caller's bucket scale: a 900 s call deleted
-- every row of a longer window, so any limit longer than the shortest window in use reset on the
-- next short-window call anywhere. Each row now records its window and expires on that window
-- alone. Every row written before this migration came from a 900 s caller, so those take 900.
alter table waldo.console_auth_attempts add column window_seconds integer not null default 900 check (window_seconds >= 1);
alter table waldo.console_auth_attempts alter column window_seconds drop default;

-- Unchanged apart from the per-row sweep and the stored window: same signature, signed message,
-- argument checks, definer rights, empty search_path and grants.
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
  delete from waldo.console_auth_attempts where bucket < p_at / window_seconds - 1;
  insert into waldo.console_auth_attempts (key, bucket, window_seconds, attempts) values (p_key, v_bucket, p_window_seconds, 1)
    on conflict (key, bucket) do update set attempts = waldo.console_auth_attempts.attempts + 1, updated_at = now()
    returning attempts into v_attempts;
  return v_attempts <= p_limit;
end $$;
revoke all on function waldo.console_auth_throttle(text, integer, integer, bigint, text) from public;
grant execute on function waldo.console_auth_throttle(text, integer, integer, bigint, text) to anon;
