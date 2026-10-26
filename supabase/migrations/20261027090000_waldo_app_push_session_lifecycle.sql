-- A push reaches a phone only while the owner's app session on it is live, and the phone belongs to the latest owner who
-- registers it.
-- - app_push_targets releases a device only while the session it was registered in, or the renewal it moved to
--   (app_session_rotate), is live by the same test every session check uses. A session that runs out without a sign-out is
--   never deleted, and nothing sweeps it, so its expiry is read where the push is sent rather than kept by a job.
-- - app_push_register takes over the phone from another owner only when it names both that binding's token and its
--   installation: the same app install with a new signer. That binding is revoked and its token copy leaves Vault, so
--   neither owner can receive the other's pushes. Naming only one of the two is refused as before: a token or an
--   installation id alone does not show the caller holds the phone. Registrations of one device take its token and
--   installation locks in a fixed order, so two at once settle one after the other.
-- - waldo.app_session_live is the one session-liveness test these two functions use.
create function waldo.app_session_live(p_session waldo.console_sessions) returns boolean
language sql stable set search_path = '' as $$
  select p_session.created_at > now() - p_session.lifetime and (p_session.idle_timeout is null or p_session.last_seen_at > now() - p_session.idle_timeout)
$$;
revoke all on function waldo.app_session_live(waldo.console_sessions) from public, anon, authenticated, service_role;

-- The bodies are those of 20261025140000 with only these changes. Apply before or after the Worker: neither function's
-- signature or answer shape changes. Forward-only.
create or replace function waldo.app_push_register(p_do_name text,p_session_hash text,p_installation_id text,p_provider text,p_environment text,p_expected_epoch bigint,p_operation_id text,p_token text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_hash text; v_intent text; v_prior waldo.app_push_operations; v_device waldo.app_push_devices; v_secret uuid; v_keys text[]; result jsonb;
begin
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  v_intent:='app.push.register.'||p_do_name||'.'||p_session_hash||'.'||p_installation_id||'.'||p_provider||'.'||p_environment||'.'||p_expected_epoch||'.'||p_operation_id||'.'||v_hash;
  if waldo.router_signed(v_intent,p_at,p_sig) is distinct from true or p_session_hash!~'^[a-f0-9]{64}$' or p_installation_id!~'^[a-f0-9-]{36}$'
    or p_provider not in ('apns','fcm','expo') or p_environment not in ('sandbox','production') or p_expected_epoch<0 or p_operation_id!~'^[A-Za-z0-9_-]{8,64}$'
    or length(p_token)<16 or length(p_token)>4096
    or (p_provider='expo' and p_token!~'^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$') or (p_provider<>'expo' and p_token!~'^[A-Za-z0-9:_-]+$')
    then raise exception 'unsigned or invalid call' using errcode='42501'; end if;
  -- Pin canonical session custody through the token mutation. Concurrent signout
  -- must either win admission or wait and revoke this settled registration.
  select o.id into v_owner from waldo.owners o join waldo.console_sessions s on s.owner_id=o.id join auth.users u on u.id=o.auth_user_id
    where o.do_name=p_do_name and o.state='active' and s.session_hash=p_session_hash and waldo.app_session_live(s) for update of o,s;
  if v_owner is null then return null; end if;
  select * into v_prior from waldo.app_push_operations where owner_id=v_owner and session_hash=p_session_hash and operation_id=p_operation_id;
  if found then
    if v_prior.intent_hash<>encode(extensions.digest(convert_to(v_intent,'UTF8'),'sha256'),'hex') then return null; end if;
    -- A previously accepted registration must never resurrect after signout/revoke.
    select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid;
    if not found or v_device.state<>'active' or v_device.session_hash<>p_session_hash or v_device.device_epoch<>(v_prior.result->'device'->>'device_epoch')::bigint then return null; end if;
    return jsonb_set(v_prior.result,'{result}','"already_recorded"');
  end if;
  -- One registration of a device at a time, whoever registers it: a second one waits, then finds the first settled.
  v_keys:=array['waldopush.token.'||v_hash,'waldopush.installation.'||p_installation_id];
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(least(v_keys[1],v_keys[2]),0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(greatest(v_keys[1],v_keys[2]),0));
  select * into v_device from waldo.app_push_devices where owner_id=v_owner and installation_id=p_installation_id::uuid for update;
  if coalesce(v_device.device_epoch,0)<>p_expected_epoch then return null; end if;
  -- The same app install with a new signer: another owner's binding of this token on this installation is revoked.
  for v_secret in select secret_id from waldo.app_push_devices
      where state='active' and token_hash=v_hash and installation_id=p_installation_id::uuid and owner_id<>v_owner order by owner_id, installation_id for update loop
    delete from vault.secrets where id=v_secret;
  end loop;
  update waldo.app_push_devices set secret_id=null,state='revoked',device_epoch=device_epoch+1
    where state='active' and token_hash=v_hash and installation_id=p_installation_id::uuid and owner_id<>v_owner;
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

create or replace function waldo.app_push_targets(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if waldo.router_signed('app.push.targets.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid call' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('installation_id', d.installation_id, 'device_epoch', d.device_epoch, 'token', v.decrypted_secret)
    order by d.registered_at desc), '[]'::jsonb) into result
  from (select d.* from waldo.app_push_devices d join waldo.owners o on o.id = d.owner_id
          join waldo.console_sessions s on s.owner_id = d.owner_id and s.session_hash = d.session_hash
        where o.do_name = p_do_name and o.state = 'active' and d.state = 'active' and d.provider = 'expo' and waldo.app_session_live(s)
        order by d.registered_at desc limit 10) d
  join vault.decrypted_secrets v on v.id = d.secret_id;
  return result;
end $$;
