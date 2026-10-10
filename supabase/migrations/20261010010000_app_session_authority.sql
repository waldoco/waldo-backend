-- Reuse the existing revocable session rail; an app session never requires a
-- Telegram presence. Only the signed router may inspect this private binding.
create function waldo.app_session_authority(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' or waldo.router_signed('app.session.' || p_do_name || '.' || p_session_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid session call' using errcode = '42501';
  end if;
  select jsonb_build_object('owner_id', o.id, 'do_name', o.do_name,
    'state_version', o.state_version, 'admission_revision', o.admission_revision::text,
    'session_hash', s.session_hash, 'expires_at', extract(epoch from s.created_at + interval '12 hours') * 1000)
  into result from waldo.owners o join waldo.console_sessions s on s.owner_id = o.id
    join auth.users u on u.id = o.auth_user_id
  where o.do_name = p_do_name and o.state = 'active' and s.session_hash = p_session_hash
    and s.created_at > now() - interval '12 hours';
  return result;
end $$;
revoke all on function waldo.app_session_authority(text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.app_session_authority(text,text,bigint,text) to anon;
