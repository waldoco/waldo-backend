-- SOURCE ONLY. Application/privileged API activation require separate coordination.
-- Native state is encrypted directly by existing Vault; no second key or DO ciphertext.
alter table waldo.connections drop constraint if exists connections_provider_check;
alter table waldo.connections add constraint connections_provider_check check(provider in ('google','browser_state'));
alter table waldo.connections add column if not exists browser_scope jsonb;
alter table waldo.connections add column if not exists browser_revision bigint not null default 0;

create or replace function waldo.proxy_browser_state(p_do_name text,p_scope jsonb,p_action text,p_state text default null,p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b jsonb; owner_row waldo.owners; presence_row waldo.presences; connection_row waldo.connections;
 slot text; account_key text; current_digest text; native_state text; generation bigint; current_ms bigint;
begin
 b:=p_scope->'binding'; generation:=(b->>'generation')::bigint;
 if p_action not in ('load','save','revoke') or b->>'environment' is distinct from 'staging' or generation<1
   or b->>'accountId' is null or b->>'accountId'='' or p_scope->>'consentRevision' is null
   or (p_scope->>'expiresAt')::bigint<1 then return null; end if;
 -- An absent row is not a lock. Serialize the stable account slot, including first save/revoke.
 slot:=encode(extensions.digest((b-'generation')::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('browser-state:'||slot,0));
 select * into owner_row from waldo.owners where id=(b->>'ownerId')::uuid and do_name=p_do_name for share;
 if not found or b->>'ownerId' is distinct from owner_row.id::text then return null; end if;
 if not exists(select 1 from auth.users where id=owner_row.auth_user_id) then return null; end if;
 perform 1 from waldo.workspace_owner_mappings where owner_id=owner_row.id and environment=b->>'environment'
   and namespace=p_scope->>'namespace' and do_name=p_do_name and do_id=p_scope->>'doId' for share;
 if not found then return null; end if;
 select * into presence_row from waldo.presences where owner_id=owner_row.id and provider='telegram' and subject=p_scope->>'subject' for share;
 if not found then return null; end if;
 current_ms:=floor(extract(epoch from clock_timestamp())*1000);
 if p_action<>'revoke' then
   if owner_row.state<>'active' or presence_row.state<>'active' or current_ms>=(p_scope->>'expiresAt')::bigint then return null; end if;
   -- array_to_json(json[]) emits compact JSON matching the existing CommonOwnerAuthority tuple.
   current_digest:=encode(extensions.digest(array_to_json(array[to_json(owner_row.id),to_json(owner_row.auth_user_id),to_json(owner_row.do_name),
     to_json(presence_row.id),to_json(presence_row.provider),to_json(presence_row.subject),to_json(owner_row.state_version),to_json(owner_row.admission_revision::text)])::text,'sha256'),'hex');
   if current_digest is distinct from p_scope->>'custodyDigest' then return null; end if;
 end if;
 account_key:='browser:'||encode(extensions.digest(b::text,'sha256'),'hex');
 select * into connection_row from waldo.connections where owner_id=owner_row.id and provider='browser_state' and account=account_key order by created_at limit 1 for update;
 if found and connection_row.browser_scope is distinct from p_scope then return null; end if;
 if p_action='revoke' then
   if connection_row.id is null then
     -- Same shape as an ordinary revoked connection: no live Vault secret, retained tombstone.
     insert into waldo.connections(owner_id,provider,account,scopes,secret_id,status,revoked_at,browser_scope)
       values(owner_row.id,'browser_state',account_key,'{}',gen_random_uuid(),'revoked',now(),p_scope) returning * into connection_row;
   else
     update waldo.connections set status='revoked',revoked_at=coalesce(revoked_at,now()) where id=connection_row.id;
     delete from vault.secrets where id=connection_row.secret_id;
   end if;
   return jsonb_build_object('revoked',true,'revision',connection_row.browser_revision);
 end if;
 if connection_row.status='revoked' or exists(select 1 from waldo.connections where owner_id=owner_row.id and provider='browser_state'
   and (browser_scope->'binding')-'generation'=b-'generation' and (browser_scope->'binding'->>'generation')::bigint>generation) then return null; end if;
 if p_action='load' then
   if connection_row.id is null then return jsonb_build_object('state',null,'revision',0); end if;
   select decrypted_secret into native_state from vault.decrypted_secrets where id=connection_row.secret_id;
   if native_state is null then return null; end if;
   update waldo.connections set last_used_at=now() where id=connection_row.id;
   return jsonb_build_object('state',native_state,'revision',connection_row.browser_revision);
 end if;
 if p_state is null or octet_length(p_state)>1048576 or p_expected_revision is null or p_expected_revision<0
   or p_expected_revision<>coalesce(connection_row.browser_revision,0) then return null; end if;
 -- EF filters native state to the pinned site policy. No plaintext outside Vault is persisted.
 if connection_row.id is null then
   insert into waldo.connections(owner_id,provider,account,scopes,secret_id,browser_scope,browser_revision)
     values(owner_row.id,'browser_state',account_key,'{}',vault.create_secret(p_state),p_scope,1) returning * into connection_row;
 else
   perform vault.update_secret(connection_row.secret_id,p_state);
   update waldo.connections set browser_revision=browser_revision+1,last_used_at=now() where id=connection_row.id returning * into connection_row;
 end if;
 return jsonb_build_object('saved',true,'revision',connection_row.browser_revision);
end $$;
revoke all on function waldo.proxy_browser_state(text,jsonb,text,text,bigint) from public,anon,authenticated;
grant execute on function waldo.proxy_browser_state(text,jsonb,text,text,bigint) to service_role;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.proxy_store(p_do_name text, p_provider text, p_account text, p_scopes text, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.connections;
begin
  if p_provider is distinct from 'google' then return null; end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_secret = '' then return null; end if;
  select * into v_row from waldo.connections where owner_id = v_owner and provider = p_provider and account = lower(p_account) and status <> 'revoked';
  if found then
    perform vault.update_secret(v_row.secret_id, p_secret);
    update waldo.connections set scopes = string_to_array(p_scopes, ' '), status = 'active', last_error = null, last_refresh_at = now() where id = v_row.id;
    return v_row.id;
  end if;
  insert into waldo.connections (owner_id, provider, account, scopes, secret_id, last_refresh_at)
    values (v_owner, p_provider, lower(p_account), string_to_array(p_scopes, ' '), vault.create_secret(p_secret), now())
    returning id into v_row.id;
  return v_row.id;
end $$;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.proxy_secret(p_do_name text, p_connection uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select s.decrypted_secret into v_secret from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'google';
  if v_secret is not null then update waldo.connections set last_used_at = now() where id = p_connection; end if;
  return v_secret;
end $$;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.proxy_health(p_do_name text, p_connection uuid, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update waldo.connections set
    status = case when p_error = '' then 'active' else 'failing' end,
    last_error = nullif(p_error, ''),
    last_refresh_at = case when p_error = '' then now() else last_refresh_at end
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked' and provider = 'google';
  return found;
end $$;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.proxy_access(p_do_name text, p_connection uuid) returns table(secret text, scopes text[])
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select s.decrypted_secret, c.scopes from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'google';
  if found then update waldo.connections set last_used_at = now() where id = p_connection; end if;
end $$;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.connection_list(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connlist.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'provider', provider, 'account', account, 'scopes', scopes, 'status', status,
    'last_used_at', last_used_at, 'last_refresh_at', last_refresh_at, 'last_error', last_error) order by created_at)
    from waldo.connections where owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked' and provider = 'google'), '[]'::jsonb);
end $$;

-- Browser connections never enter generic Google token/list/revoke rails.
create or replace function waldo.connection_revoke(p_do_name text, p_connection uuid, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  if not waldo.router_signed('connrevoke.' || p_do_name || '.' || p_connection, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connections set status = 'revoked', revoked_at = now()
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked' and provider = 'google' returning secret_id into v_secret;
  if v_secret is null then return false; end if;
  delete from vault.secrets where id = v_secret;
  return true;
end $$;
