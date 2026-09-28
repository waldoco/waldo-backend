-- Browser cookies live for 12 hours. Enforce the same absolute lifetime in the
-- server-side session record so a copied or retained cookie cannot outlive it.
create or replace function waldo.console_session_touch(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.touch.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  update waldo.console_sessions s set last_seen_at = now()
    from waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name
      and s.created_at > now() - interval '12 hours';
  return found;
end $$;

-- Do not present expired sessions as revocable active browser sessions.
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
      and s.created_at > now() - interval '12 hours'
  ), '[]'::jsonb);
end $$;
