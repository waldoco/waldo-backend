-- A console sign-in stays signed in while it is used. Each session row carries its own absolute lifetime, counted
-- from created_at, and an optional idle limit, counted from last_seen_at, which every validated request stamps.
-- Rows opened through console_session_open (the app bearer and today's Worker) default to 12 hours with no idle
-- limit, so the app and an un-upgraded Worker behave exactly as before. Console sign-ins open their rows through
-- console_session_open_for, whose signed message names the lifetimes; the database refuses anything past 30 days.
-- console_session_list keeps its three keys, so the Worker deployed before this migration still reads it.
--
-- A sign-in in a browser that presents a live session caps that session through console_session_cap instead of ending
-- it: 5 more minutes of ordinary access, so a console chat turn running or queued under it finishes.
--
-- Rollback: a forward migration restoring the three function bodies from 20261010010000 and 20260929030000
-- (created_at > now() - interval '12 hours') ends every long session at its 12th hour, and drops console_session_cap,
-- which an older Worker never calls. The columns can stay.
alter table waldo.console_sessions
  add column lifetime interval not null default interval '12 hours',
  add column idle_timeout interval;
alter table waldo.console_sessions
  add constraint console_sessions_lifetime_bounds check (lifetime > interval '0' and lifetime <= interval '30 days'),
  add constraint console_sessions_idle_bounds check (idle_timeout is null or (idle_timeout > interval '0' and idle_timeout <= lifetime));

create function waldo.console_session_open_for(p_do_name text, p_session_hash text, p_lifetime_seconds integer, p_idle_seconds integer, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('consolesess.openfor.' || p_do_name || '.' || p_session_hash || '.' || p_lifetime_seconds || '.' || p_idle_seconds, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_lifetime_seconds is null or p_idle_seconds is null or p_lifetime_seconds < 1 or p_lifetime_seconds > 2592000
    or p_idle_seconds < 1 or p_idle_seconds > p_lifetime_seconds then
    raise exception 'console session lifetime out of range' using errcode = '22023';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_session_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  insert into waldo.console_sessions (owner_id, session_hash, lifetime, idle_timeout)
    values (v_owner, p_session_hash, make_interval(secs => p_lifetime_seconds), make_interval(secs => p_idle_seconds))
    on conflict (session_hash) do nothing;
  return true;
end $$;

-- A refused session is not stamped: the liveness test sits in the update's own filter.
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
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout);
  return found;
end $$;

create or replace function waldo.console_session_list(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('consolesess.list.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session', s.session_hash,
      'created_at', s.created_at,
      'last_seen_at', s.last_seen_at) order by s.last_seen_at desc)
    from waldo.console_sessions s where s.owner_id = v_owner
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout)
  ), '[]'::jsonb);
end $$;

-- Console chat runs under the console session through this check, so it follows the row's own lifetime.
create or replace function waldo.app_session_authority(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' or waldo.router_signed('app.session.' || p_do_name || '.' || p_session_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid session call' using errcode = '42501';
  end if;
  select jsonb_build_object('owner_id', o.id, 'do_name', o.do_name,
    'state_version', o.state_version, 'admission_revision', o.admission_revision::text,
    'session_hash', s.session_hash,
    'expires_at', extract(epoch from least(s.created_at + s.lifetime, coalesce(s.last_seen_at + s.idle_timeout, s.created_at + s.lifetime))) * 1000)
  into result from waldo.owners o join waldo.console_sessions s on s.owner_id = o.id
    join auth.users u on u.id = o.auth_user_id
  where o.do_name = p_do_name and o.state = 'active' and s.session_hash = p_session_hash
    and s.created_at > now() - s.lifetime
    and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout);
  return result;
end $$;

-- The caller names no duration: the 5 minutes live here, and the cap only ever shortens. The idle limit is cut to fit, so
-- the row keeps idle_timeout <= lifetime; a row with no idle limit keeps none. Sign-out (console_session_revoke) still
-- ends a session at once.
create function waldo.console_session_cap(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.cap.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_session_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  update waldo.console_sessions s
    set lifetime = least(s.lifetime, now() - s.created_at + interval '5 minutes'),
        idle_timeout = case when s.idle_timeout is null then null else least(s.idle_timeout, s.lifetime, now() - s.created_at + interval '5 minutes') end
    from waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout);
  return found;
end $$;

revoke all on function waldo.console_session_cap(text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.console_session_cap(text, text, bigint, text) to anon;
revoke all on function waldo.console_session_open_for(text, text, integer, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.console_session_open_for(text, text, integer, integer, bigint, text) to anon;
