-- Several Google accounts per Waldo user. One oauth_tokens row per connected Google account,
-- keyed by Google's stable account id (`sub`), because a Google account's email can change.
-- The *_enc columns hold Supabase Vault secret ids; token plaintext never sits in the table.

create extension if not exists supabase_vault with schema vault;

alter table public.oauth_tokens add column provider_account_id text;
alter table public.oauth_tokens
  add constraint oauth_tokens_provider_account_key unique (user_id, provider, provider_account_id);
-- Email uniqueness now only guards rows without a provider account id; for keyed rows the
-- email is display data and may move between accounts.
alter table public.oauth_tokens drop constraint oauth_tokens_user_id_provider_account_email_key;
create unique index oauth_tokens_unkeyed_email_key
  on public.oauth_tokens (user_id, provider, account_email) nulls not distinct
  where provider_account_id is null;

-- The one writer for Google connections. Runs from the google-connect Edge Function (service
-- role) after the OAuth code exchange, so no external I/O happens inside this transaction.
-- Reconnecting an already connected Google account rotates its tokens in place.
create function public.save_google_oauth_account(
  p_user_id uuid,
  p_provider_account_id text,
  p_account_email text,
  p_account_label text,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_scopes text[]
)
returns table (connection_id uuid, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing public.oauth_tokens%rowtype;
begin
  if p_user_id is null or coalesce(p_provider_account_id, '') = '' or coalesce(p_account_email, '') = ''
    or coalesce(p_access_token, '') = '' or coalesce(p_refresh_token, '') = '' or p_expires_at is null then
    raise exception 'save_google_oauth_account: missing required argument' using errcode = '22004';
  end if;

  select * into existing
  from public.oauth_tokens
  where user_id = p_user_id and provider = 'google' and provider_account_id = p_provider_account_id
  for update;

  if found then
    perform vault.update_secret(existing.access_token_enc::uuid, p_access_token);
    perform vault.update_secret(existing.refresh_token_enc::uuid, p_refresh_token);
    update public.oauth_tokens
    set account_email = p_account_email,
        account_label = coalesce(p_account_label, existing.account_label),
        expires_at = p_expires_at,
        scopes = p_scopes,
        is_active = true,
        sync_error = null,
        sync_error_since = null
    where id = existing.id;
    return query select existing.id, false;
    return;
  end if;

  return query
  insert into public.oauth_tokens (
    user_id, provider, provider_account_id, account_label, account_email,
    access_token_enc, refresh_token_enc, expires_at, scopes, is_active
  ) values (
    p_user_id, 'google', p_provider_account_id, p_account_label, p_account_email,
    vault.create_secret(p_access_token)::text, vault.create_secret(p_refresh_token)::text,
    p_expires_at, p_scopes, true
  )
  returning id, true;
end;
$function$;

revoke all on function public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[])
  to service_role;

-- Deleting a connection, directly or through the users cascade, also deletes its Vault secrets
-- so no credential outlives the row that referenced it.
create function public.delete_oauth_token_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  delete from vault.secrets
  where id::text in (old.access_token_enc, old.refresh_token_enc);
  return old;
end;
$function$;

revoke all on function public.delete_oauth_token_secrets() from public, anon, authenticated, service_role;

create trigger oauth_tokens_delete_secrets
  after delete on public.oauth_tokens
  for each row execute function public.delete_oauth_token_secrets();
