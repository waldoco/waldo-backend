-- Supabase-compat shim for local pgTAP harness (plain PG15, no Supabase image).
-- Mirrors the semantics the repo relies on: roles, extensions schema + pgcrypto,
-- auth schema stubs, vault secrets store, supabase_migrations bookkeeping.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), created_at timestamptz default now(), updated_at timestamptz, not_after timestamptz, refreshed_at timestamptz);
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(auth.jwt() ->> 'sub', '')), '')::uuid $$;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text not null, created_at timestamptz default now());
create or replace function vault.create_secret(p_secret text, p_name text default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name) values (encode(extensions.pgp_sym_encrypt(p_secret, 'lane-vault-key'), 'base64'), p_name) returning id into v_id;
  return v_id;
end $$;
create or replace function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $$ update vault.secrets set secret = encode(extensions.pgp_sym_encrypt(p_secret, 'lane-vault-key'), 'base64') where id = p_id $$;
create or replace function vault.delete_secret(p_id uuid) returns void language sql as $$ delete from vault.secrets where id = p_id $$;
create view vault.decrypted_secrets as select id, name, extensions.pgp_sym_decrypt(decode(secret, 'base64'), 'lane-vault-key') as decrypted_secret, created_at from vault.secrets;

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
alter role postgres set search_path = public, extensions;
grant usage on schema extensions, auth, vault to public;
grant execute on all functions in schema extensions, auth, vault to public;
alter default privileges in schema extensions grant execute on functions to public;
