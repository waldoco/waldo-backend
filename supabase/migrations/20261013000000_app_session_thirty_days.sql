-- The app session lasts 30 days and renews. app_session_rotate opens a fresh 30-day row and leaves the presented one
-- 20 minutes, so requests and a running turn that hold it can finish; push devices move with it. The presented row
-- records what replaced it: the list names that successor, revoking the new session ends it too, and it cannot renew
-- again. A session opened through console_session_open, the web console's included, keeps 12 hours. Every lifetime
-- check reads the row's own expires_at instead of adding 12 hours to created_at.
-- Forward-only, like every migration here: undoing it is a later migration, never an edit of this one.
alter table waldo.console_sessions add column rotated_to text check (rotated_to ~ '^[a-f0-9]{64}$');
alter table waldo.console_sessions add column expires_at timestamptz;
update waldo.console_sessions set expires_at = created_at + interval '12 hours';
alter table waldo.console_sessions alter column expires_at set default now() + interval '12 hours', alter column expires_at set not null;

create or replace function waldo.console_session_touch(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.touch.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  update waldo.console_sessions s set last_seen_at = now()
    from waldo.owners o
    where s.session_hash = p_session_hash and s.owner_id = o.id and o.do_name = p_do_name
      and s.expires_at > now();
  return found;
end $$;

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
      'last_seen_at', s.last_seen_at,
      'expires_at', s.expires_at,
      'rotated_to', s.rotated_to) order by s.last_seen_at desc)
    from waldo.console_sessions s where s.owner_id = v_owner
      and s.expires_at > now()
  ), '[]'::jsonb);
end $$;

create or replace function waldo.console_session_revoke(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('consolesess.revoke.' || p_do_name || '.' || p_session_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  delete from waldo.console_sessions s using waldo.owners o
    where (s.session_hash = p_session_hash or s.rotated_to = p_session_hash) and s.owner_id = o.id and o.do_name = p_do_name;
  return found;
end $$;

create or replace function waldo.app_session_authority(p_do_name text, p_session_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' or waldo.router_signed('app.session.' || p_do_name || '.' || p_session_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid session call' using errcode = '42501';
  end if;
  select jsonb_build_object('owner_id', o.id, 'do_name', o.do_name,
    'state_version', o.state_version, 'admission_revision', o.admission_revision::text,
    'session_hash', s.session_hash, 'expires_at', extract(epoch from s.expires_at) * 1000)
  into result from waldo.owners o join waldo.console_sessions s on s.owner_id = o.id
    join auth.users u on u.id = o.auth_user_id
  where o.do_name = p_do_name and o.state = 'active' and s.session_hash = p_session_hash
    and s.expires_at > now();
  return result;
end $$;

create function waldo.app_session_rotate(p_do_name text, p_session_hash text, p_new_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' or p_new_session_hash !~ '^[a-f0-9]{64}$' or p_new_session_hash = p_session_hash
    or waldo.router_signed('appsess.rotate.' || p_do_name || '.' || p_session_hash || '.' || p_new_session_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid session call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id = o.id join auth.users u on u.id = o.auth_user_id
    where o.do_name = p_do_name and o.state = 'active' and s.session_hash = p_session_hash and s.expires_at > now() and s.rotated_to is null
    for update of o, s;
  if v_owner is null then return false; end if;
  insert into waldo.console_sessions(owner_id, session_hash, expires_at) values (v_owner, p_new_session_hash, now() + interval '30 days');
  update waldo.console_sessions set expires_at = least(expires_at, now() + interval '20 minutes'), rotated_to = p_new_session_hash where session_hash = p_session_hash;
  update waldo.app_push_devices set session_hash = p_new_session_hash where owner_id = v_owner and session_hash = p_session_hash and state = 'active';
  return true;
end $$;
revoke all on function waldo.app_session_rotate(text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.app_session_rotate(text,text,text,bigint,text) to anon;

create or replace function waldo.app_push_list(p_do_name text,p_session_hash text,p_at bigint,p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; result jsonb;
begin
  if waldo.router_signed('app.push.list.'||p_do_name||'.'||p_session_hash,p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.expires_at>now();
  if v_owner is null then return null; end if;
  select coalesce(jsonb_agg(waldo.app_push_view(d) order by d.registered_at),'[]'::jsonb) into result from waldo.app_push_devices d where d.owner_id=v_owner;
  return result;
end $$;

create or replace function waldo.app_push_register(p_do_name text,p_session_hash text,p_installation_id text,p_provider text,p_environment text,p_expected_epoch bigint,p_operation_id text,p_token text,p_at bigint,p_sig text) returns jsonb
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
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.expires_at>now() for update of o,s;
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

create or replace function waldo.app_push_revoke(p_do_name text,p_session_hash text,p_installation_id text,p_expected_epoch bigint,p_operation_id text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_intent text; v_prior waldo.app_push_operations; v_device waldo.app_push_devices; result jsonb;
begin
  v_intent:='app.push.revoke.'||p_do_name||'.'||p_session_hash||'.'||p_installation_id||'.'||p_expected_epoch||'.'||p_operation_id;
  if waldo.router_signed(v_intent,p_at,p_sig) is distinct from true or p_installation_id!~'^[a-f0-9-]{36}$' or p_expected_epoch<1 or p_operation_id!~'^[A-Za-z0-9_-]{8,64}$' then raise exception 'unsigned or invalid call' using errcode='42501'; end if;
  -- Pin canonical session custody through the token mutation. Concurrent signout
  -- must either win admission or wait and revoke this settled registration.
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.expires_at>now() for update of o,s;
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
