-- Canonical workspace custody. No provider secret or service role is exposed to Workers.
alter table waldo.owners add column state_version bigint not null default 0;
create function waldo.owner_lifecycle_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.state is distinct from old.state then new.state_version := old.state_version + 1;
  elsif new.state_version is distinct from old.state_version then
    raise exception 'owner lifecycle version is host managed';
  end if;
  return new;
end $$;
create trigger owner_lifecycle_version before update on waldo.owners
  for each row execute function waldo.owner_lifecycle_version();

-- Deliberately no owner FK: retained locator ownership survives owner/DO deletion
-- until a separately authorized export/purge/relocation process closes custody.
create table waldo.workspace_owner_mappings (
  environment text not null,
  namespace text not null,
  do_name text not null,
  do_id text not null,
  owner_id uuid not null,
  mapping_version bigint not null default 1 check (mapping_version > 0),
  created_at timestamptz not null default now(),
  primary key (environment, namespace, do_id),
  unique (environment, namespace, do_name),
  unique (environment, namespace, owner_id),
  check (length(environment) between 1 and 120 and length(namespace) between 1 and 240 and length(do_name) between 1 and 240 and length(do_id) between 1 and 240)
);
alter table waldo.workspace_owner_mappings enable row level security;
alter table waldo.workspace_owner_mappings force row level security;
revoke all on waldo.workspace_owner_mappings from public, anon, authenticated;
grant select, insert, update, delete on waldo.workspace_owner_mappings to service_role;

create function waldo.workspace_owner_binding(p_environment text, p_namespace text, p_do_name text, p_do_id text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner waldo.owners; v_map waldo.workspace_owner_mappings;
begin
  -- Caller transmits its canonical JSON tuple and signs its digest. Verify tuple
  -- contents independently instead of depending on Postgres JSON whitespace.
  if p_locator::jsonb is distinct from jsonb_build_array(p_environment, p_namespace, p_do_name, p_do_id) then
    raise exception 'workspace locator mismatch' using errcode = '42501';
  end if;
  if not waldo.router_signed('workspace.bind.' || encode(extensions.digest(p_locator, 'sha256'), 'hex'), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_environment is null or p_namespace is null or p_do_name is null or p_do_id is null
    or p_environment = '' or p_namespace = '' or p_do_name = '' or p_do_id = '' then return null; end if;
  select * into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for share;
  if not found then return null; end if;
  insert into waldo.workspace_owner_mappings(environment,namespace,do_name,do_id,owner_id)
    values(p_environment,p_namespace,p_do_name,p_do_id,v_owner.id) on conflict do nothing;
  select * into v_map from waldo.workspace_owner_mappings
    where environment = p_environment and namespace = p_namespace and do_name = p_do_name;
  if not found or v_map.do_id is distinct from p_do_id or v_map.owner_id is distinct from v_owner.id then return null; end if;
  return jsonb_build_object('owner_id',v_owner.id,'environment',v_map.environment,'namespace',v_map.namespace,
    'do_name',v_map.do_name,'do_id',v_map.do_id,'state_version',v_owner.state_version,'mapping_version',v_map.mapping_version);
end $$;
revoke all on function waldo.workspace_owner_binding(text,text,text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function waldo.workspace_owner_binding(text,text,text,text,text,bigint,text) to anon;
