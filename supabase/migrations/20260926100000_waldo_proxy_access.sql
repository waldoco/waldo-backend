-- Scope-gated token access for the connector-proxy: returns the decrypted token AND the stored
-- scopes in one owner-checked read, so the Edge Function can refuse a method the grant never
-- covered before spending the token on it. Same owner gate and last_used_at touch as
-- proxy_secret; the old function stays for one deploy overlap.
create function waldo.proxy_access(p_do_name text, p_connection uuid) returns table(secret text, scopes text[])
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select s.decrypted_secret, c.scopes from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked';
  if found then update waldo.connections set last_used_at = now() where id = p_connection; end if;
end $$;

revoke all on function waldo.proxy_access(text, uuid) from public, anon, authenticated;
grant execute on function waldo.proxy_access(text, uuid) to service_role;
