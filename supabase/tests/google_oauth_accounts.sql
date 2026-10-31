begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""']::text[]
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_google_oauth_account'),
  'save_google_oauth_account is a security definer with an empty search_path'
);

select ok(
  has_function_privilege('service_role',
    'public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[])', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[])', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.save_google_oauth_account(uuid, text, text, text, text, text, timestamptz, text[])', 'EXECUTE'),
  'only the service role can save Google connections'
);

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2');
insert into public.users (id, auth_id, name, email) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'Sam', 'sam@example.invalid'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'Ari', 'ari@example.invalid');

create temp table saved (account text, connection_id uuid, created boolean) on commit drop;
grant all on saved to service_role;

set local role service_role;

insert into saved
select 'work', * from public.save_google_oauth_account(
  '10000000-0000-0000-0000-0000000000a1', 'google-sub-work', 'sam@work.example', 'work',
  'access-work-1', 'refresh-work-1', '2026-10-31T13:00:00Z', array['openid', 'email']);
insert into saved
select 'personal', * from public.save_google_oauth_account(
  '10000000-0000-0000-0000-0000000000a1', 'google-sub-personal', 'sam@gmail.example', 'personal',
  'access-personal-1', 'refresh-personal-1', '2026-10-31T13:00:00Z', array['openid', 'email']);

select is(
  (select array_agg(created order by account) from saved),
  array[true, true],
  'two different Google accounts create two connections for one user'
);

select is(
  (select count(*) from public.oauth_tokens
   where user_id = '10000000-0000-0000-0000-0000000000a1' and provider = 'google'),
  2::bigint,
  'both Google accounts are stored side by side'
);

select is_empty(
  $$select id from public.oauth_tokens
    where access_token_enc like 'access-%' or refresh_token_enc like 'refresh-%'$$,
  'token plaintext is never stored in oauth_tokens'
);

reset role;

select is(
  (select array[access.decrypted_secret, refresh.decrypted_secret]
   from public.oauth_tokens t
   join vault.decrypted_secrets access on access.id::text = t.access_token_enc
   join vault.decrypted_secrets refresh on refresh.id::text = t.refresh_token_enc
   where t.provider_account_id = 'google-sub-work'),
  array['access-work-1', 'refresh-work-1'],
  'tokens are recoverable from Vault through the stored secret ids'
);

create temp table secrets_before on commit drop as select count(*) as n from vault.secrets;

set local role service_role;

insert into saved
select 'work-again', * from public.save_google_oauth_account(
  '10000000-0000-0000-0000-0000000000a1', 'google-sub-work', 'sam@new-work.example', null,
  'access-work-2', 'refresh-work-2', '2026-10-31T14:00:00Z', array['openid', 'email', 'calendar']);

select is(
  (select row(connection_id, created)::text from saved where account = 'work-again'),
  (select row(connection_id, false)::text from saved where account = 'work'),
  'reconnecting the same Google account reuses its connection'
);

select is(
  (select row(account_email, account_label, scopes)::text from public.oauth_tokens
   where provider_account_id = 'google-sub-work'),
  row('sam@new-work.example', 'work', array['openid', 'email', 'calendar'])::text,
  'reconnecting refreshes email and scopes and keeps the label when none is given'
);

reset role;

select is(
  (select array[access.decrypted_secret, refresh.decrypted_secret]
   from public.oauth_tokens t
   join vault.decrypted_secrets access on access.id::text = t.access_token_enc
   join vault.decrypted_secrets refresh on refresh.id::text = t.refresh_token_enc
   where t.provider_account_id = 'google-sub-work'),
  array['access-work-2', 'refresh-work-2'],
  'reconnecting rotates the stored tokens in place'
);

select is(
  (select count(*) from vault.secrets),
  (select n from secrets_before),
  'rotation creates no new Vault secrets'
);

set local role service_role;

select lives_ok(
  $$select * from public.save_google_oauth_account(
      '20000000-0000-0000-0000-0000000000b2', 'google-sub-work', 'sam@work.example', null,
      'access-other', 'refresh-other', '2026-10-31T13:00:00Z', array['openid'])$$,
  'a different Waldo user connecting the same Google account gets a separate connection'
);

select lives_ok(
  $$select * from public.save_google_oauth_account(
      '10000000-0000-0000-0000-0000000000a1', 'google-sub-recycled', 'sam@gmail.example', null,
      'access-r', 'refresh-r', '2026-10-31T13:00:00Z', array['openid'])$$,
  'an email already used by another connected Google account does not block a new account'
);

select throws_ok(
  $$select * from public.save_google_oauth_account(
      '10000000-0000-0000-0000-0000000000a1', 'google-sub-x', 'x@example.invalid', null,
      'access-x', null, '2026-10-31T13:00:00Z', array['openid'])$$,
  '22004'::char(5), null,
  'a connection without a refresh token is refused'
);

select throws_ok(
  $$select * from public.save_google_oauth_account(
      '30000000-0000-0000-0000-0000000000c3', 'google-sub-y', 'y@example.invalid', null,
      'access-y', 'refresh-y', '2026-10-31T13:00:00Z', array['openid'])$$,
  '23503'::char(5), null,
  'a connection for an unknown Waldo user is refused'
);

reset role;

create temp table personal_secrets on commit drop as
select access_token_enc, refresh_token_enc from public.oauth_tokens
where provider_account_id = 'google-sub-personal';

delete from public.oauth_tokens where provider_account_id = 'google-sub-personal';

select is(
  (select count(*) from vault.secrets
   where id::text in (select access_token_enc from personal_secrets
                      union all select refresh_token_enc from personal_secrets)),
  0::bigint,
  'deleting a connection deletes its Vault secrets'
);

create temp table remaining_secrets on commit drop as
select user_id, access_token_enc, refresh_token_enc from public.oauth_tokens;

delete from public.users where id = '10000000-0000-0000-0000-0000000000a1';

select is(
  (select array_agg(r.user_id::text order by r.user_id)
   from remaining_secrets r
   where exists (select 1 from vault.secrets s where s.id::text = r.access_token_enc)
     and exists (select 1 from vault.secrets s where s.id::text = r.refresh_token_enc)),
  array['20000000-0000-0000-0000-0000000000b2'],
  'deleting a user removes their Vault secrets and keeps other users'' secrets'
);

select is(
  (select count(*) from public.oauth_tokens where user_id = '20000000-0000-0000-0000-0000000000b2'),
  1::bigint,
  'other users'' connections survive the cascade'
);

select * from finish();

rollback;
