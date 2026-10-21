-- Owner-connected MCP servers. Their OAuth tokens live in Vault and are read only by the mcp-proxy Edge
-- Function through these service-role wrappers. pins holds the non-secret values recorded when the owner
-- connected (resource, issuer, token and revocation endpoints, client id): the edge sends a token, a code
-- or a client secret nowhere else.
alter table waldo.connections drop constraint connections_provider_check;
alter table waldo.connections add constraint connections_provider_check check (provider in ('google', 'mcp'));
alter table waldo.connections add column pins jsonb;
alter table waldo.connections add constraint connections_mcp_pins check ((provider = 'mcp') = (pins is not null));

-- The Google proxy reads Google grants only, so an MCP connection id can never put an MCP token in a
-- request to Google. Same bodies as before plus the provider filter; CREATE OR REPLACE keeps the grants.
create or replace function waldo.proxy_access(p_do_name text, p_connection uuid) returns table(secret text, scopes text[])
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select s.decrypted_secret, c.scopes from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'google';
  if found then update waldo.connections set last_used_at = now() where id = p_connection; end if;
end $$;

create or replace function waldo.proxy_secret(p_do_name text, p_connection uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select s.decrypted_secret into v_secret from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'google';
  if v_secret is not null then update waldo.connections set last_used_at = now() where id = p_connection; end if;
  return v_secret;
end $$;

-- One client registration per authorization server and redirect URI in this environment. The MCP spec
-- keys client credentials by issuer; registering once per environment keeps a single client at each
-- authorization server instead of one per owner. A confidential client's secret sits in Vault.
create table waldo.mcp_clients (
  issuer text not null,
  redirect_uri text not null,
  client_id text not null,
  client_auth text not null check (client_auth in ('none', 'client_secret_post', 'client_secret_basic')),
  secret_id uuid,
  created_at timestamptz not null default now(),
  primary key (issuer, redirect_uri),
  check ((client_auth = 'none') = (secret_id is null))
);
alter table waldo.mcp_clients enable row level security;
alter table waldo.mcp_clients force row level security;

-- Reconnecting the same server (issuer + resource) updates the row in place, like proxy_store.
create function waldo.mcp_store(p_do_name text, p_account text, p_scopes text, p_pins jsonb, p_secret text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.connections;
begin
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_secret is null or p_secret = '' or p_pins is null or jsonb_typeof(p_pins) <> 'object' then return null; end if;
  select * into v_row from waldo.connections where owner_id = v_owner and provider = 'mcp' and account = lower(p_account) and status <> 'revoked' for update;
  if found then
    perform vault.update_secret(v_row.secret_id, p_secret);
    update waldo.connections set scopes = string_to_array(p_scopes, ' '), pins = p_pins, status = 'active', last_error = null, last_refresh_at = now() where id = v_row.id;
    return v_row.id;
  end if;
  insert into waldo.connections (owner_id, provider, account, scopes, secret_id, pins, last_refresh_at)
    values (v_owner, 'mcp', lower(p_account), string_to_array(p_scopes, ' '), vault.create_secret(p_secret), p_pins, now())
    returning id into v_row.id;
  return v_row.id;
end $$;

create function waldo.mcp_access(p_do_name text, p_connection uuid) returns table(secret text, scopes text[], pins jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select s.decrypted_secret, c.scopes, c.pins from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'mcp';
  if found then update waldo.connections set last_used_at = now() where id = p_connection; end if;
end $$;

-- Compare-and-set for a rotated refresh token: the write lands only if the stored secret is still the
-- one the caller refreshed from (sha256 hex). A caller that lost the race reads the winner's tokens.
create function waldo.mcp_rotate(p_do_name text, p_connection uuid, p_expect text, p_secret text, p_scopes text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_secret_id uuid; v_current text;
begin
  if p_secret is null or p_secret = '' or p_expect is null then return false; end if;
  select c.secret_id into v_secret_id from waldo.connections c
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked' and c.provider = 'mcp' for update;
  if v_secret_id is null then return false; end if;
  select decrypted_secret into v_current from vault.decrypted_secrets where id = v_secret_id;
  if encode(extensions.digest(v_current, 'sha256'), 'hex') <> p_expect then return false; end if;
  perform vault.update_secret(v_secret_id, p_secret);
  update waldo.connections set scopes = coalesce(string_to_array(nullif(p_scopes, ''), ' '), scopes), status = 'active', last_error = null, last_refresh_at = now()
    where id = p_connection;
  return true;
end $$;

-- Disconnect, after the edge has asked the provider to revoke: the row is marked revoked and its secret
-- deleted, whatever the provider answered.
create function waldo.mcp_revoke(p_do_name text, p_connection uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  update waldo.connections set status = 'revoked', revoked_at = now()
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked' and provider = 'mcp' returning secret_id into v_secret;
  if v_secret is null then return false; end if;
  delete from vault.secrets where id = v_secret;
  return true;
end $$;

create function waldo.mcp_client_get(p_issuer text, p_redirect_uri text) returns table(client_id text, client_auth text, client_secret text)
language sql stable security definer set search_path = '' as $$
  select m.client_id, m.client_auth, s.decrypted_secret from waldo.mcp_clients m left join vault.decrypted_secrets s on s.id = m.secret_id
    where m.issuer = p_issuer and m.redirect_uri = p_redirect_uri
$$;

-- First registration wins; a concurrent second one is dropped and both callers read the stored row.
create function waldo.mcp_client_put(p_issuer text, p_redirect_uri text, p_client_id text, p_client_auth text, p_secret text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_client_id is null or p_client_id = '' or (p_client_auth <> 'none' and (p_secret is null or p_secret = '')) then return false; end if;
  -- Serialised per issuer and redirect, so a losing registration never leaves a Vault secret behind.
  perform pg_advisory_xact_lock(hashtextextended(p_issuer || ' ' || p_redirect_uri, 0));
  if exists (select 1 from waldo.mcp_clients where issuer = p_issuer and redirect_uri = p_redirect_uri) then return false; end if;
  insert into waldo.mcp_clients (issuer, redirect_uri, client_id, client_auth, secret_id)
    values (p_issuer, p_redirect_uri, p_client_id, p_client_auth, case when p_client_auth = 'none' then null else vault.create_secret(p_secret) end);
  return true;
end $$;

-- An MCP write whose request the server provably refused before running it (an auth challenge, a rate
-- limit, a redirect) releases its pending claim, so the one retry after a token refresh can claim it
-- again. Any other failure leaves the claim pending: the outcome is unknown and nothing re-runs it.
create function waldo.mcp_idem_release(p_do_name text, p_connection uuid, p_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from waldo.proxy_idempotency p using waldo.connections c
    where p.owner_id = waldo.owner_id_for(p_do_name) and p.connection = p_connection and p.pkey = p_key and p.status = 'pending'
      and c.id = p.connection and c.owner_id = p.owner_id and c.provider = 'mcp';
  return found;
end $$;

revoke all on function waldo.mcp_store(text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function waldo.mcp_access(text, uuid) from public, anon, authenticated;
revoke all on function waldo.mcp_rotate(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function waldo.mcp_revoke(text, uuid) from public, anon, authenticated;
revoke all on function waldo.mcp_client_get(text, text) from public, anon, authenticated;
revoke all on function waldo.mcp_client_put(text, text, text, text, text) from public, anon, authenticated;
revoke all on function waldo.mcp_idem_release(text, uuid, text) from public, anon, authenticated;
grant execute on function waldo.mcp_store(text, text, text, jsonb, text) to service_role;
grant execute on function waldo.mcp_access(text, uuid) to service_role;
grant execute on function waldo.mcp_rotate(text, uuid, text, text, text) to service_role;
grant execute on function waldo.mcp_revoke(text, uuid) to service_role;
grant execute on function waldo.mcp_client_get(text, text) to service_role;
grant execute on function waldo.mcp_client_put(text, text, text, text, text) to service_role;
grant execute on function waldo.mcp_idem_release(text, uuid, text) to service_role;
