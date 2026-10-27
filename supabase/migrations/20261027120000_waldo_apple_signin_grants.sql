-- Apple's refresh token for a trusted Sign in with Apple identity, kept in Vault so account deletion can revoke the grant
-- with Apple (App Store Review Guideline 5.1.1(v)). One row per owner, Apple subject and client id: a token is revoked
-- under the client it was issued to (the app's bundle id, or the console's Services ID). The row's Vault secret goes when
-- the row goes, including through the owner cascade in delete_owner.
create table waldo.owner_apple_grants (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  subject text not null check (length(subject) between 1 and 255),
  client_id text not null check (client_id ~ '^[A-Za-z0-9.-]{1,255}$'),
  secret_id uuid not null,
  granted_at timestamptz not null default now(),
  primary key (owner_id, subject, client_id)
);
alter table waldo.owner_apple_grants enable row level security;
alter table waldo.owner_apple_grants force row level security;
revoke all on waldo.owner_apple_grants from public, anon, authenticated, service_role;

create function waldo.owner_apple_grant_forget_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end $$;
revoke all on function waldo.owner_apple_grant_forget_secret() from public, anon, authenticated, service_role;
create trigger owner_apple_grant_forget_secret after delete on waldo.owner_apple_grants
  for each row execute function waldo.owner_apple_grant_forget_secret();

-- Keeps the token for an identity this owner already trusts (it created the owner, or an email code confirmed it), so a
-- token for any other Apple account is never stored against the owner. The signature covers the token's SHA-256, never
-- the token. A newer token for the same identity and client replaces the old one and its secret.
create function waldo.apple_grant_keep(p_do_name text, p_subject text, p_client_id text, p_token text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_old uuid;
begin
  if p_token is null or length(p_token) not between 16 and 4096 or p_token !~ '^[A-Za-z0-9._-]+$'
     or waldo.router_signed('applegrant.keep.' || p_do_name || '.' || p_subject || '.' || p_client_id || '.'
       || encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex'), p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid call' using errcode = '42501';
  end if;
  if p_client_id !~ '^[A-Za-z0-9.-]{1,255}$' then return false; end if;
  select o.id into v_owner from waldo.owners o join waldo.owner_signin_identities t on t.owner_id = o.id
    where o.do_name = p_do_name and o.state = 'active' and t.provider = 'apple' and t.subject = p_subject
    for update of o;
  if v_owner is null then return false; end if;
  select secret_id into v_old from waldo.owner_apple_grants where owner_id = v_owner and subject = p_subject and client_id = p_client_id for update;
  if v_old is not null then
    perform vault.update_secret(v_old, p_token);
    update waldo.owner_apple_grants set granted_at = now() where owner_id = v_owner and subject = p_subject and client_id = p_client_id;
  else
    insert into waldo.owner_apple_grants (owner_id, subject, client_id, secret_id) values (v_owner, p_subject, p_client_id, vault.create_secret(p_token));
  end if;
  return true;
end $$;

-- Every token held for this owner, decrypted, for the router to revoke with Apple just before delete_owner. Null when no
-- active owner has that name.
create function waldo.apple_grants_held(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; result jsonb;
begin
  if waldo.router_signed('applegrant.held.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('client_id', g.client_id, 'token', s.decrypted_secret) order by g.client_id, g.subject), '[]'::jsonb)
    into result
    from waldo.owner_apple_grants g join vault.decrypted_secrets s on s.id = g.secret_id
    where g.owner_id = v_owner;
  return result;
end $$;

revoke all on function waldo.apple_grant_keep(text, text, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.apple_grants_held(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.apple_grant_keep(text, text, text, text, bigint, text) to anon;
grant execute on function waldo.apple_grants_held(text, bigint, text) to anon;
