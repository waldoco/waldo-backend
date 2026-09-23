-- Owner settings live in waldo.owner_settings; the owner's DO keeps an executing copy. The console writes here first.
create function waldo.set_owner_settings(p_do_name text, p_timezone text, p_quiet_start text, p_quiet_end text, p_volume text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('settings.' || p_do_name || '.' || p_timezone || '.' || coalesce(p_quiet_start, '') || '.' || coalesce(p_quiet_end, '') || '.' || p_volume, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then return false; end if;
  update waldo.owner_settings s set timezone = p_timezone, quiet_start = nullif(p_quiet_start, '')::time, quiet_end = nullif(p_quiet_end, '')::time,
    volume = p_volume, updated_at = now()
    from waldo.owners o where o.id = s.owner_id and o.do_name = p_do_name and o.state = 'active';
  return found;
end $$;
revoke all on function waldo.set_owner_settings(text, text, text, text, text, bigint, text) from public;
grant execute on function waldo.set_owner_settings(text, text, text, text, text, bigint, text) to anon;
