-- Source-only private binding read. Does not provision mappings or browser authority.
create function waldo.browser_owner_binding(
  p_environment text, p_namespace text, p_do_name text, p_do_id text,
  p_provider text, p_subject text, p_locator text, p_at bigint, p_sig text
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_locator::jsonb is distinct from jsonb_build_array(
    p_environment,p_namespace,p_do_name,p_do_id,p_provider,p_subject) then
    raise exception 'browser locator mismatch' using errcode = '42501';
  end if;
  if waldo.router_signed('browser.bind.' ||
    encode(extensions.digest(p_locator,'sha256'),'hex'),p_at,p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_environment is distinct from 'staging' or p_provider is distinct from 'telegram' then return null; end if;
  select jsonb_build_object('owner_id',o.id,'do_name',o.do_name,
    'state_version',o.state_version,'admission_revision',o.admission_revision::text,
    'presence_id',p.id,'provider',p.provider,'subject',p.subject)
  into v_result
  from waldo.owners o join waldo.presences p on p.owner_id=o.id
  join waldo.workspace_owner_mappings m on m.owner_id=o.id and m.do_name=o.do_name
  where o.do_name=p_do_name and o.state='active' and p.state='active'
    and p.provider=p_provider and p.subject=p_subject
    and m.environment=p_environment and m.namespace=p_namespace and m.do_id=p_do_id;
  return v_result;
end $$;
revoke all on function waldo.browser_owner_binding(text,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function waldo.browser_owner_binding(text,text,text,text,text,text,text,bigint,text) to anon;
