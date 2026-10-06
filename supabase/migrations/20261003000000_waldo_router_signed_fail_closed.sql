-- Every caller guards with `if not waldo.router_signed(...)`, and `not NULL` is NULL, so a NULL answer skipped the
-- rejection. A missing message, timestamp, signature or secret must answer false.
create or replace function waldo.router_signed(p_message text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_secret text;
begin
  if p_message is null or p_at is null or p_sig is null then return false; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'waldo_router_hmac';
  if v_secret is null or abs(extract(epoch from now()) - p_at) > 300 then return false; end if;
  return coalesce(encode(extensions.hmac(p_at::text || '.' || p_message, v_secret, 'sha256'), 'hex') = p_sig, false);
end $$;
revoke all on function waldo.router_signed(text, bigint, text) from public, anon, authenticated;
