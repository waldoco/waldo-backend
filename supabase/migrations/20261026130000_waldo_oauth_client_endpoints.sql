-- Pre-registered OAuth clients: a client the operator registered with the provider by hand (an MCP server
-- without dynamic registration or client metadata documents, or a provider's developer app), entered once
-- per environment with the endpoints its secret may be sent to. The edge reads a confidential client's
-- secret only for one of those endpoints, so a request that names another token or revocation endpoint
-- for the same issuer never gets the secret. A row without pinned endpoints (a dynamic registration, or
-- a client entered before this migration) keeps the older behaviour until it is seeded again.
alter table waldo.oauth_clients
  add column token_endpoint text check (token_endpoint like 'https://%'),
  add column revocation_endpoint text check (revocation_endpoint like 'https://%'),
  add constraint oauth_clients_revocation_needs_token check (revocation_endpoint is null or token_endpoint is not null);

-- Entered by the operator with the service role. Seeding again replaces the client id, endpoints and
-- secret in place, so a secret regenerated at the provider is rotated without a second row.
create function waldo.oauth_client_seed(p_issuer text, p_redirect_uri text, p_client_id text, p_client_auth text, p_secret text, p_token_endpoint text, p_revocation_endpoint text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_old uuid;
  v_secret uuid;
begin
  if coalesce(p_issuer, '') not like 'https://%' or coalesce(p_redirect_uri, '') not like 'https://%' or coalesce(p_token_endpoint, '') not like 'https://%'
    or (p_revocation_endpoint is not null and p_revocation_endpoint not like 'https://%')
    or coalesce(p_client_id, '') = '' or coalesce(p_client_auth, '') not in ('none', 'client_secret_post', 'client_secret_basic')
    or ((p_client_auth = 'none') <> (coalesce(p_secret, '') = '')) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_issuer || ' ' || p_redirect_uri, 0));
  select secret_id into v_old from waldo.oauth_clients where issuer = p_issuer and redirect_uri = p_redirect_uri for update;
  if p_client_auth = 'none' then
    v_secret := null;
  elsif v_old is not null then
    perform vault.update_secret(v_old, p_secret);
    v_secret := v_old;
  else
    v_secret := vault.create_secret(p_secret);
  end if;
  insert into waldo.oauth_clients (issuer, redirect_uri, client_id, client_auth, secret_id, token_endpoint, revocation_endpoint)
    values (p_issuer, p_redirect_uri, p_client_id, p_client_auth, v_secret, p_token_endpoint, p_revocation_endpoint)
    on conflict (issuer, redirect_uri) do update set client_id = excluded.client_id, client_auth = excluded.client_auth, secret_id = excluded.secret_id,
      token_endpoint = excluded.token_endpoint, revocation_endpoint = excluded.revocation_endpoint;
  -- A client seeded again as public no longer has a secret; its old one leaves Vault.
  if v_old is not null and v_secret is null then delete from vault.secrets where id = v_old; end if;
  return true;
end $$;

-- The client the owner's object signs in with at a pre-registered issuer: its id and authentication, never
-- its secret. Only seeded rows answer, so a dynamic registration is never mistaken for a pre-registered one.
create function waldo.oauth_client_registered(p_issuer text, p_redirect_uri text) returns table(client_id text, client_auth text)
language sql stable security definer set search_path = '' as $$
  select m.client_id, m.client_auth from waldo.oauth_clients m
    where m.issuer = p_issuer and m.redirect_uri = p_redirect_uri and m.token_endpoint is not null
$$;

-- A confidential client's secret, for the endpoint the edge is about to send it to: the client id must
-- match, and a seeded row answers only for its own token or revocation endpoint.
create function waldo.oauth_client_secret(p_issuer text, p_redirect_uri text, p_client_id text, p_endpoint text) returns text
language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from waldo.oauth_clients m join vault.decrypted_secrets s on s.id = m.secret_id
    where m.issuer = p_issuer and m.redirect_uri = p_redirect_uri and m.client_id = p_client_id
      and (m.token_endpoint is null or p_endpoint = m.token_endpoint or p_endpoint = m.revocation_endpoint)
$$;

-- The older client read keeps naming the client for the edge's registration path, but no longer returns its
-- secret: every secret now leaves Vault through oauth_client_secret, bound to the endpoint it is sent to. An edge
-- deployed before this migration reads secrets here, so this migration and the oauth-proxy deploy go together.
drop function waldo.oauth_client_get(text, text);
create function waldo.oauth_client_get(p_issuer text, p_redirect_uri text) returns table(client_id text, client_auth text)
language sql stable security definer set search_path = '' as $$
  select m.client_id, m.client_auth from waldo.oauth_clients m where m.issuer = p_issuer and m.redirect_uri = p_redirect_uri
$$;

revoke all on function waldo.oauth_client_get(text, text) from public, anon, authenticated;
grant execute on function waldo.oauth_client_get(text, text) to service_role;
revoke all on function waldo.oauth_client_seed(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function waldo.oauth_client_registered(text, text) from public, anon, authenticated;
revoke all on function waldo.oauth_client_secret(text, text, text, text) from public, anon, authenticated;
grant execute on function waldo.oauth_client_seed(text, text, text, text, text, text, text) to service_role;
grant execute on function waldo.oauth_client_registered(text, text) to service_role;
grant execute on function waldo.oauth_client_secret(text, text, text, text) to service_role;
