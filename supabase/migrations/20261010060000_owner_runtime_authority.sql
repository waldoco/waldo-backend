-- Account lifecycle is independent of Telegram/WhatsApp/iMessage presence.
-- The private router supplies the physical owner locator; surfaces retain their
-- existing session/presence admission and delivery checks.
create function waldo.owner_runtime_authority(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240
    or waldo.router_signed('owner.runtime.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid owner call' using errcode = '42501';
  end if;
  select jsonb_build_object('owner_id', o.id, 'auth_user_id', u.id, 'do_name', o.do_name,
    'state_version', o.state_version, 'admission_revision', o.admission_revision::text)
  into result from waldo.owners o join auth.users u on u.id = o.auth_user_id
  where o.do_name = p_do_name and o.state = 'active';
  return result;
end $$;
revoke all on function waldo.owner_runtime_authority(text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.owner_runtime_authority(text,bigint,text) to anon;
