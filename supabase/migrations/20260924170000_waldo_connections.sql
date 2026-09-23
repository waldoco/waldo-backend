-- W3: OAuth refresh tokens live in Supabase Vault. The runtime and the model hold only a connection id.
create table waldo.connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id),
  provider text not null check (provider in ('google')),
  account text not null,
  scopes text[] not null default '{}',
  secret_id uuid not null,
  status text not null default 'active' check (status in ('active', 'failing', 'revoked')),
  last_used_at timestamptz,
  last_refresh_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index connections_live_account on waldo.connections (owner_id, provider, account) where status <> 'revoked';
alter table waldo.connections enable row level security;
alter table waldo.connections force row level security;

create function waldo.owner_id_for(p_do_name text) returns uuid language sql stable security definer set search_path = '' as
$$ select id from waldo.owners where do_name = p_do_name and state = 'active' $$;
revoke all on function waldo.owner_id_for(text) from public, anon, authenticated;

-- The signature covers a hash of the token, so a replayed call cannot swap in another token.
create function waldo.connection_store(p_do_name text, p_provider text, p_account text, p_scopes text, p_secret text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.connections;
begin
  if not waldo.router_signed('connstore.' || p_do_name || '.' || p_provider || '.' || lower(p_account) || '.' || p_scopes || '.' || encode(extensions.digest(p_secret, 'sha256'), 'hex'), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
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

create function waldo.connection_secret(p_do_name text, p_connection uuid, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if not waldo.router_signed('connsecret.' || p_do_name || '.' || p_connection, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select s.decrypted_secret into v_secret from waldo.connections c join vault.decrypted_secrets s on s.id = c.secret_id
    where c.id = p_connection and c.owner_id = waldo.owner_id_for(p_do_name) and c.status <> 'revoked';
  if v_secret is not null then update waldo.connections set last_used_at = now() where id = p_connection; end if;
  return v_secret;
end $$;

create function waldo.connection_health(p_do_name text, p_connection uuid, p_error text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connhealth.' || p_do_name || '.' || p_connection || '.' || p_error, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connections set
    status = case when p_error = '' then 'active' else 'failing' end,
    last_error = nullif(p_error, ''),
    last_refresh_at = case when p_error = '' then now() else last_refresh_at end
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked';
  return found;
end $$;

create function waldo.connection_list(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connlist.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'provider', provider, 'account', account, 'scopes', scopes, 'status', status,
    'last_used_at', last_used_at, 'last_refresh_at', last_refresh_at, 'last_error', last_error) order by created_at)
    from waldo.connections where owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked'), '[]'::jsonb);
end $$;

create function waldo.connection_revoke(p_do_name text, p_connection uuid, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  if not waldo.router_signed('connrevoke.' || p_do_name || '.' || p_connection, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connections set status = 'revoked', revoked_at = now()
    where id = p_connection and owner_id = waldo.owner_id_for(p_do_name) and status <> 'revoked' returning secret_id into v_secret;
  if v_secret is null then return false; end if;
  delete from vault.secrets where id = v_secret;
  return true;
end $$;

revoke all on function waldo.connection_store(text, text, text, text, text, bigint, text) from public;
revoke all on function waldo.connection_secret(text, uuid, bigint, text) from public;
revoke all on function waldo.connection_health(text, uuid, text, bigint, text) from public;
revoke all on function waldo.connection_list(text, bigint, text) from public;
revoke all on function waldo.connection_revoke(text, uuid, bigint, text) from public;
grant execute on function waldo.connection_store(text, text, text, text, text, bigint, text) to anon;
grant execute on function waldo.connection_secret(text, uuid, bigint, text) to anon;
grant execute on function waldo.connection_health(text, uuid, text, bigint, text) to anon;
grant execute on function waldo.connection_list(text, bigint, text) to anon;
grant execute on function waldo.connection_revoke(text, uuid, bigint, text) to anon;
