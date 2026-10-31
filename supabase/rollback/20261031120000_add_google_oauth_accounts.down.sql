-- DOWN for 20261031120000_add_google_oauth_accounts.sql. Not run by `supabase db push`;
-- apply manually via psql if reverting. Google connections are removed first so the delete
-- trigger also removes their Vault secrets; nothing else references those secrets.
delete from public.oauth_tokens where provider_account_id is not null;
drop trigger if exists oauth_tokens_delete_secrets on public.oauth_tokens;
drop function if exists public.delete_oauth_token_secrets();
drop function if exists public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[]);
drop index if exists public.oauth_tokens_unkeyed_email_key;
alter table public.oauth_tokens
  add constraint oauth_tokens_user_id_provider_account_email_key
  unique nulls not distinct (user_id, provider, account_email);
alter table public.oauth_tokens drop constraint if exists oauth_tokens_provider_account_key;
alter table public.oauth_tokens drop column if exists provider_account_id;
