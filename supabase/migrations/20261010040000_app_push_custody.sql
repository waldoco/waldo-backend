-- Candidate only: native push token custody uses the existing Vault and owner
-- session rail. Apply only with the reviewed migration receipt.
create table waldo.app_push_devices (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  installation_id uuid not null,
  session_hash text not null check (session_hash ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('apns','fcm')),
  environment text not null check (environment in ('sandbox','production')),
  device_epoch bigint not null check (device_epoch > 0),
  state text not null check (state in ('active','revoked')),
  secret_id uuid references vault.secrets(id) deferrable initially deferred,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz not null default now(),
  primary key (owner_id,installation_id),
  check ((state = 'active') = (secret_id is not null))
);
create unique index app_push_live_token on waldo.app_push_devices(provider,environment,token_hash) where state = 'active';
-- An installation cannot remain active for a prior owner after a token rotation.
-- Reuse requires canonical revocation first; an installation UUID alone is not
-- permission to revoke or reattribute a different owner's token.
create unique index app_push_live_installation on waldo.app_push_devices(provider,environment,installation_id) where state = 'active';
create table waldo.app_push_operations (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  session_hash text not null,
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  intent_hash text not null,
  result jsonb not null,
  primary key(owner_id,session_hash,operation_id)
);
alter table waldo.app_push_devices enable row level security;
alter table waldo.app_push_devices force row level security;
alter table waldo.app_push_operations enable row level security;
alter table waldo.app_push_operations force row level security;
revoke all on waldo.app_push_devices,waldo.app_push_operations from public,anon,authenticated,service_role;

create function waldo.app_push_view(p_device waldo.app_push_devices) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('installation_id',p_device.installation_id,'provider',p_device.provider,'environment',p_device.environment,
    'device_epoch',p_device.device_epoch,'state',p_device.state,'registered_at',floor(extract(epoch from p_device.registered_at)*1000),
    'delivery','native_ack_unverified')
$$;
revoke all on function waldo.app_push_view(waldo.app_push_devices) from public,anon,authenticated,service_role;

create function waldo.app_push_list(p_do_name text,p_session_hash text,p_at bigint,p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; result jsonb;
begin
  if waldo.router_signed('app.push.list.'||p_do_name||'.'||p_session_hash,p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-interval '12 hours';
  if v_owner is null then return null; end if;
  select coalesce(jsonb_agg(waldo.app_push_view(d) order by d.registered_at),'[]'::jsonb) into result from waldo.app_push_devices d where d.owner_id=v_owner;
  return result;
end $$;

create function waldo.app_push_register(p_do_name text,p_session_hash text,p_installation_id text,p_provider text,p_environment text,p_expected_epoch bigint,p_operation_id text,p_token text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_hash text; v_intent text; v_prior waldo.app_push_operations; v_device waldo.app_push_devices; result jsonb;
begin
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  v_intent:='app.push.register.'||p_do_name||'.'||p_session_hash||'.'||p_installation_id||'.'||p_provider||'.'||p_environment||'.'||p_expected_epoch||'.'||p_operation_id||'.'||v_hash;
  if waldo.router_signed(v_intent,p_at,p_sig) is distinct from true or p_session_hash!~'^[a-f0-9]{64}$' or p_installation_id!~'^[a-f0-9-]{36}$'
    or p_provider not in ('apns','fcm') or p_environment not in ('sandbox','production') or p_expected_epoch<0 or p_operation_id!~'^[A-Za-z0-9_-]{8,64}$'
    or length(p_token)<16 or length(p_token)>4096 or p_token!~'^[A-Za-z0-9:_-]+$' then raise exception 'unsigned or invalid call' using errcode='42501'; end if;
  -- Pin canonical session custody through the token mutation. Concurrent signout
  -- must either win admission or wait and revoke this settled registration.
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-interval '12 hours' for update of o,s;
  if v_owner is null then return null; end if;
  select * into v_prior from waldo.app_push_operations where owner_id=v_owner and session_hash=p_session_hash and operation_id=p_operation_id;
  if found then
    if v_prior.intent_hash<>encode(extensions.digest(convert_to(v_intent,'UTF8'),'sha256'),'hex') then return null; end if;
    -- A previously accepted registration must never resurrect after signout/revoke.
    select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid;
    if not found or v_device.state<>'active' or v_device.session_hash<>p_session_hash or v_device.device_epoch<>(v_prior.result->'device'->>'device_epoch')::bigint then return null; end if;
    return jsonb_set(v_prior.result,'{result}','"already_recorded"');
  end if;
  select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid for update;
  if coalesce(v_device.device_epoch,0)<>p_expected_epoch then return null; end if;
  if exists(select 1 from waldo.app_push_devices where provider=p_provider and environment=p_environment and state='active' and ((token_hash=v_hash and (owner_id<>v_owner or installation_id<>p_installation_id::uuid)) or (installation_id=p_installation_id::uuid and owner_id<>v_owner))) then return null; end if;
  if v_device.secret_id is not null then delete from vault.secrets where id=v_device.secret_id; end if;
  insert into waldo.app_push_devices(owner_id,installation_id,session_hash,provider,environment,device_epoch,state,secret_id,token_hash,registered_at)
    values(v_owner,p_installation_id::uuid,p_session_hash,p_provider,p_environment,p_expected_epoch+1,'active',vault.create_secret(p_token),v_hash,now())
    on conflict(owner_id,installation_id) do update set session_hash=excluded.session_hash,provider=excluded.provider,environment=excluded.environment,
      device_epoch=excluded.device_epoch,state=excluded.state,secret_id=excluded.secret_id,token_hash=excluded.token_hash,registered_at=excluded.registered_at returning * into v_device;
  result:=jsonb_build_object('device',waldo.app_push_view(v_device),'result','registered');
  insert into waldo.app_push_operations values(v_owner,p_session_hash,p_operation_id,encode(extensions.digest(convert_to(v_intent,'UTF8'),'sha256'),'hex'),result);
  return result;
end $$;

create function waldo.app_push_revoke(p_do_name text,p_session_hash text,p_installation_id text,p_expected_epoch bigint,p_operation_id text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_intent text; v_prior waldo.app_push_operations; v_device waldo.app_push_devices; result jsonb;
begin
  v_intent:='app.push.revoke.'||p_do_name||'.'||p_session_hash||'.'||p_installation_id||'.'||p_expected_epoch||'.'||p_operation_id;
  if waldo.router_signed(v_intent,p_at,p_sig) is distinct from true or p_installation_id!~'^[a-f0-9-]{36}$' or p_expected_epoch<1 or p_operation_id!~'^[A-Za-z0-9_-]{8,64}$' then raise exception 'unsigned or invalid call' using errcode='42501'; end if;
  -- Pin canonical session custody through the token mutation. Concurrent signout
  -- must either win admission or wait and revoke this settled registration.
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-interval '12 hours' for update of o,s;
  if v_owner is null then return null; end if;
  select * into v_prior from waldo.app_push_operations where owner_id=v_owner and session_hash=p_session_hash and operation_id=p_operation_id;
  if found then
    if v_prior.intent_hash<>encode(extensions.digest(convert_to(v_intent,'UTF8'),'sha256'),'hex') then return null; end if;
    -- A prior revocation is an operation receipt, never authority to project an
    -- old revoked epoch after this installation was registered again.
    select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid;
    if not found or v_device.state<>'revoked' or v_device.session_hash<>p_session_hash or v_device.device_epoch<>(v_prior.result->'device'->>'device_epoch')::bigint then return null; end if;
    return jsonb_set(v_prior.result,'{result}','"already_recorded"');
  end if;
  select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid for update;
  if not found or v_device.session_hash<>p_session_hash or v_device.device_epoch<>p_expected_epoch then return null; end if;
  if v_device.secret_id is not null then delete from vault.secrets where id=v_device.secret_id; end if;
  update waldo.app_push_devices set secret_id=null,state='revoked',device_epoch=device_epoch+1 where owner_id=v_owner and installation_id=p_installation_id::uuid returning * into v_device;
  result:=jsonb_build_object('device',waldo.app_push_view(v_device),'result','revoked');
  insert into waldo.app_push_operations values(v_owner,p_session_hash,p_operation_id,encode(extensions.digest(convert_to(v_intent,'UTF8'),'sha256'),'hex'),result);
  return result;
end $$;

create function waldo.app_push_revoke_session(p_do_name text,p_session_hash text,p_at bigint,p_sig text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_secret uuid; count_revoked bigint;
begin
  if waldo.router_signed('app.push.revoke-session.'||p_do_name||'.'||p_session_hash,p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select id into v_owner from waldo.owners where do_name=p_do_name for update;
  if v_owner is null then return 0; end if;
  -- Revocation remains callable after the session expires. It grants no reads.
  for v_secret in select secret_id from waldo.app_push_devices where owner_id=v_owner and session_hash=p_session_hash and state='active' loop delete from vault.secrets where id=v_secret; end loop;
  update waldo.app_push_devices set secret_id=null,state='revoked',device_epoch=device_epoch+1 where owner_id=v_owner and session_hash=p_session_hash and state='active';
  get diagnostics count_revoked=row_count; return count_revoked;
end $$;
create function waldo.app_push_revoke_all(p_do_name text,p_at bigint,p_sig text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_secret uuid; count_revoked bigint;
begin
  if waldo.router_signed('app.push.revoke-all.'||p_do_name,p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select id into v_owner from waldo.owners where do_name=p_do_name for update;
  if v_owner is null then return 0; end if;
  for v_secret in select secret_id from waldo.app_push_devices where owner_id=v_owner and state='active' loop delete from vault.secrets where id=v_secret; end loop;
  update waldo.app_push_devices set secret_id=null,state='revoked',device_epoch=device_epoch+1 where owner_id=v_owner and state='active';
  get diagnostics count_revoked=row_count; return count_revoked;
end $$;
revoke all on function waldo.app_push_list(text,text,bigint,text),waldo.app_push_register(text,text,text,text,text,bigint,text,text,bigint,text),waldo.app_push_revoke(text,text,text,bigint,text,bigint,text),waldo.app_push_revoke_session(text,text,bigint,text),waldo.app_push_revoke_all(text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.app_push_list(text,text,bigint,text),waldo.app_push_register(text,text,text,text,text,bigint,text,text,bigint,text),waldo.app_push_revoke(text,text,text,bigint,text,bigint,text),waldo.app_push_revoke_session(text,text,bigint,text),waldo.app_push_revoke_all(text,bigint,text) to anon;

-- Canonical session deletion revokes push for console/app signout and owner deletion.
create function waldo.app_push_session_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  for v_secret in select secret_id from waldo.app_push_devices where owner_id=old.owner_id and session_hash=old.session_hash and state='active' loop delete from vault.secrets where id=v_secret; end loop;
  update waldo.app_push_devices set secret_id=null,state='revoked',device_epoch=device_epoch+1 where owner_id=old.owner_id and session_hash=old.session_hash and state='active';
  return old;
end $$;
revoke all on function waldo.app_push_session_delete() from public,anon,authenticated,service_role;
create trigger app_push_session_delete before delete on waldo.console_sessions for each row execute function waldo.app_push_session_delete();
create function waldo.app_push_owner_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  for v_secret in select secret_id from waldo.app_push_devices where owner_id=old.id and state='active' loop delete from vault.secrets where id=v_secret; end loop;
  return old;
end $$;
revoke all on function waldo.app_push_owner_delete() from public,anon,authenticated,service_role;
create trigger app_push_owner_delete before delete on waldo.owners for each row execute function waldo.app_push_owner_delete();
