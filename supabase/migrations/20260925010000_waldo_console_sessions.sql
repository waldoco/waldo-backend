-- D1 console sessions: console cookies become stateful so the owner gets a session list and
-- sign-out-everywhere. The cookie carries doName + a random session id + HMAC; only the session
-- hash is stored, mirroring the link-code pattern.
create table waldo.console_sessions (
  owner_id uuid not null references waldo.owners (id),
  session_hash text primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table waldo.console_sessions enable row level security;
alter table waldo.console_sessions force row level security;

-- Open a session at sign-in. Idempotent on the hash so a retried mint is harmless.
create function waldo.console_session_open(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('consolesess.open.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_session_hash = '' then return false; end if;
  insert into waldo.console_sessions (owner_id, session_hash) values (v_owner, p_session_hash)
    on conflict (session_hash) do nothing;
  return true;
end $$;

-- Validate a cookie's session and stamp last-seen. One call per console request.
create function waldo.console_session_touch(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.touch.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  update waldo.console_sessions s set last_seen_at = now()
    from waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name;
  return found;
end $$;

-- The owner's session list. The hash is not a credential (the cookie carries the raw id), so
-- the list can return it whole as the revoke handle.
create function waldo.console_session_list(p_do_name text, p_at bigint, p_sig text) returns jsonb
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
  ), '[]'::jsonb);
end $$;

-- Revoke one session (the list's handle).
create function waldo.console_session_revoke(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.revoke.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  delete from waldo.console_sessions s using waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name;
  return found;
end $$;

-- Sign out everywhere: drop every session; all live cookies die at their next touch.
create function waldo.console_signout_all(p_do_name text, p_at bigint, p_sig text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_count integer;
begin
  if not waldo.router_signed('consolesess.signout.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return 0; end if;
  delete from waldo.console_sessions where owner_id = v_owner;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The runtime calls these as the publishable (anon) key with an HMAC signature, same as the
-- connect-session router functions. service_role stays out.
grant execute on function waldo.console_session_open(text, text, bigint, text) to anon;
grant execute on function waldo.console_session_touch(text, text, bigint, text) to anon;
grant execute on function waldo.console_session_list(text, bigint, text) to anon;
grant execute on function waldo.console_session_revoke(text, text, bigint, text) to anon;
grant execute on function waldo.console_signout_all(text, bigint, text) to anon;
