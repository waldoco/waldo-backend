-- A validated request stamps its session's last_seen_at at most once every five minutes. The app checks its credential on
-- every request through console_session_touch, so each request rewrote the row (a dead tuple and its WAL) for a column
-- that drives only the console's 7-day idle limit and the session lists' order. Liveness is still decided on every call,
-- with the same predicate as before; only the write is skipped while the stamp is fresh, so an idle limit can end at most
-- five minutes early.
--
-- Rollback: a forward migration restoring the body from 20261023090000. The signature and result are unchanged, so any
-- deployed Worker reads either body the same way.
create or replace function waldo.console_session_touch(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.touch.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  update waldo.console_sessions s set last_seen_at = now()
    from waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout)
      and s.last_seen_at <= now() - interval '5 minutes';
  if found then return true; end if;
  return exists (select 1 from waldo.console_sessions s join waldo.owners o on o.id = s.owner_id
    where s.session_hash = p_session_hash and o.do_name = p_do_name
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout));
end $$;
