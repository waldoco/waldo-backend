begin;

create function waldo.owner_message_binding(
  p_environment text, p_namespace text, p_do_name text, p_do_id text,
  p_provider text, p_subject text, p_locator text, p_at bigint, p_sig text
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_binding jsonb;
begin
  if p_locator::jsonb is distinct from jsonb_build_array(p_environment,p_namespace,p_do_name,p_do_id,p_provider,p_subject)
    or p_environment is distinct from 'staging' or p_provider is distinct from 'telegram'
    or p_namespace is null or length(p_namespace) not between 1 and 240
    or p_do_name is null or length(p_do_name) not between 1 and 240
    or p_do_id is null or length(p_do_id) not between 1 and 240
    or p_subject is null or p_subject !~ '^[0-9]{1,32}$' then
    raise exception 'owner admission locator rejected' using errcode='42501';
  end if;
  if waldo.router_signed('owneradmit.' || encode(extensions.digest(p_locator,'sha256'),'hex'),p_at,p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode='42501';
  end if;
  select jsonb_build_object('owner_id',o.id,'do_name',o.do_name,'state_version',o.state_version,
    'admission_revision',o.admission_revision::text,
    'presence_id',p.id,'provider',p.provider,'subject',p.subject) into v_binding
    from waldo.owners o join waldo.presences p on p.owner_id=o.id
    where o.do_name=p_do_name and o.state='active' and p.provider=p_provider
      and p.subject=p_subject and p.state='active';
  return v_binding;
end $$;
revoke all on function waldo.owner_message_binding(text,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;

rollback;
