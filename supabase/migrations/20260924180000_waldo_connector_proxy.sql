-- Tokens never reach the runtime (brief hard line: no bearer tokens in the model or DO). Only the
-- connector-proxy Edge Function, holding the service role, stores and reads them.
drop function waldo.connection_store(text, text, text, text, text, bigint, text);
drop function waldo.connection_secret(text, uuid, bigint, text);
drop function waldo.connection_health(text, uuid, text, bigint, text);

create function waldo.proxy_store(p_do_name text, p_provider text, p_account text, p_scopes text, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.connections;
begin
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

create function waldo.proxy_secret(p_do_name text, p_connection uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select s.decrypted_secret into v_secret from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked';
  if v_secret is not null then update waldo.connections set last_used_at = now() where id = p_connection; end if;
  return v_secret;
end $$;

create function waldo.proxy_health(p_do_name text, p_connection uuid, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update waldo.connections set
    status = case when p_error = '' then 'active' else 'failing' end,
    last_error = nullif(p_error, ''),
    last_refresh_at = case when p_error = '' then now() else last_refresh_at end
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked';
  return found;
end $$;

revoke all on function waldo.proxy_store(text, text, text, text, text) from public, anon, authenticated;
revoke all on function waldo.proxy_secret(text, uuid) from public, anon, authenticated;
revoke all on function waldo.proxy_health(text, uuid, text) from public, anon, authenticated;
grant execute on function waldo.proxy_store(text, text, text, text, text) to service_role;
grant execute on function waldo.proxy_secret(text, uuid) to service_role;
grant execute on function waldo.proxy_health(text, uuid, text) to service_role;
