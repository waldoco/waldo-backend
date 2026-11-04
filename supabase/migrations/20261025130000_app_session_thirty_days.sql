-- The app session lasts 30 days and renews, on the per-row lifetime of 20261023090000.
-- - waldo.console_sessions.rotated_to names the session a renewal issued in a row's place.
-- - waldo.console_sessions.signed_in_at is when the session's sign-in happened. A renewal carries it over unchanged, so
--   the two-hour step-up, which needs a recent email code, never counts a renewal as a sign-in. Rows from before this
--   migration take their created_at.
-- - app_session_rotate opens a fresh row with a 30-day lifetime and no idle limit. It caps the presented row the way
--   console_session_cap does, so it runs out 5 minutes later and the requests and a running turn that hold it can
--   finish. It moves the row's push devices to the new one. A row that was renewed cannot renew again.
-- - console_session_inventory lists each live row with its end, its successor and its sign-in time. console_session_list keeps its three
--   keys, so the Worker deployed before this migration still reads it.
-- - console_session_revoke also ends every row a renewal replaced with the one named.
-- - app_push_list, app_push_register and app_push_revoke follow the row's own lifetime instead of 12 hours from
--   created_at. Their bodies are those of 20261010040000 with only that test changed.
-- Every row opened before this migration keeps the lifetime it was opened with, so the Worker deployed before it is
-- unaffected: nothing it calls renews, and its app sessions still last 12 hours. Apply this migration before deploying
-- the Worker that calls app_session_rotate and console_session_inventory.
-- Forward-only, like every migration here: undoing it is a later migration, never an edit of this one.
alter table waldo.console_sessions add column rotated_to text check (rotated_to ~ '^[a-f0-9]{64}$');
alter table waldo.console_sessions add column signed_in_at timestamptz;
update waldo.console_sessions set signed_in_at = created_at;
alter table waldo.console_sessions alter column signed_in_at set default now(), alter column signed_in_at set not null;

create function waldo.console_session_inventory(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('consolesess.inventory.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'session', s.session_hash,
      'created_at', s.created_at,
      'last_seen_at', s.last_seen_at,
      'expires_at', least(s.created_at + s.lifetime, coalesce(s.last_seen_at + s.idle_timeout, s.created_at + s.lifetime)),
      'rotated_to', s.rotated_to,
      'signed_in_at', s.signed_in_at) order by s.last_seen_at desc)
    from waldo.console_sessions s where s.owner_id = v_owner
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout)
  ), '[]'::jsonb);
end $$;
revoke all on function waldo.console_session_inventory(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.console_session_inventory(text, bigint, text) to anon;

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

-- The caller names no duration: 30 days and the 5-minute cap live here.
create function waldo.app_session_rotate(p_do_name text, p_session_hash text, p_new_session_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_signed_in timestamptz;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' or p_new_session_hash !~ '^[a-f0-9]{64}$' or p_new_session_hash = p_session_hash
    or waldo.router_signed('appsess.rotate.' || p_do_name || '.' || p_session_hash || '.' || p_new_session_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid session call' using errcode = '42501';
  end if;
  select o.id, s.signed_in_at into v_owner, v_signed_in from waldo.owners o join waldo.console_sessions s on s.owner_id = o.id join auth.users u on u.id = o.auth_user_id
    where o.do_name = p_do_name and o.state = 'active' and s.session_hash = p_session_hash and s.rotated_to is null
      and s.created_at > now() - s.lifetime
      and (s.idle_timeout is null or s.last_seen_at > now() - s.idle_timeout)
    for update of o, s;
  if v_owner is null then return false; end if;
  insert into waldo.console_sessions (owner_id, session_hash, lifetime, signed_in_at) values (v_owner, p_new_session_hash, interval '30 days', v_signed_in);
  update waldo.console_sessions s
    set lifetime = least(s.lifetime, now() - s.created_at + interval '5 minutes'),
        idle_timeout = case when s.idle_timeout is null then null else least(s.idle_timeout, s.lifetime, now() - s.created_at + interval '5 minutes') end,
        rotated_to = p_new_session_hash
    where s.session_hash = p_session_hash;
  update waldo.app_push_devices set session_hash = p_new_session_hash where owner_id = v_owner and session_hash = p_session_hash and state = 'active';
  return true;
end $$;
revoke all on function waldo.app_session_rotate(text, text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.app_session_rotate(text, text, text, bigint, text) to anon;

create or replace function waldo.app_push_list(p_do_name text,p_session_hash text,p_at bigint,p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; result jsonb;
begin
  if waldo.router_signed('app.push.list.'||p_do_name||'.'||p_session_hash,p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-s.lifetime and (s.idle_timeout is null or s.last_seen_at>now()-s.idle_timeout);
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
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-s.lifetime and (s.idle_timeout is null or s.last_seen_at>now()-s.idle_timeout) for update of o,s;
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
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and s.created_at>now()-s.lifetime and (s.idle_timeout is null or s.last_seen_at>now()-s.idle_timeout) for update of o,s;
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

