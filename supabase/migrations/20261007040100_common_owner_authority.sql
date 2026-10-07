-- Truthful message-presence authority for the existing common task root.
-- No session or standing grant is manufactured from a webhook occurrence.
create function waldo.common_owner_authority(
  p_provider text, p_subject text, p_do_name text, p_locator text, p_at bigint, p_sig text
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_locator::jsonb is distinct from jsonb_build_array(p_provider,p_subject,p_do_name)
    or waldo.router_signed('common.owner.' || p_locator,p_at,p_sig) is distinct from true then
    raise exception 'unsigned or mismatched common owner locator' using errcode = '42501';
  end if;
  if p_provider not in ('telegram','whatsapp') then return null; end if;
  select jsonb_build_object('owner_id',o.id,'auth_user_id',o.auth_user_id,
    'do_name',o.do_name,'presence_id',p.id,'provider',p.provider,'subject',p.subject,
    'state_version',o.state_version,'admission_revision',o.admission_revision::text)
    into result
    from waldo.owners o join waldo.presences p on p.owner_id=o.id
    join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and p.state='active'
      and p.provider=p_provider and p.subject=p_subject;
  return result;
end $$;
revoke all on function waldo.common_owner_authority(text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function waldo.common_owner_authority(text,text,text,text,bigint,text) to anon;
