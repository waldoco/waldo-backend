begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('identity-fixture-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'identity-fixture-secret', 'sha256'), 'hex')
$$;

-- Two owners, each with an Auth identity, a legacy public.users row, a refresh token (no FK to auth.users), a redeemed
-- invite carrying the member's email, and a push token held in Vault. Only the first is deleted.
insert into auth.users (id, email) values
  ('30000000-0000-0000-0000-00000000000a', 'gone@test.invalid'),
  ('30000000-0000-0000-0000-00000000000b', 'stays@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name, email) values
  ('31000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a', 'identity-a', 'gone@test.invalid'),
  ('31000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-00000000000b', 'identity-b', 'stays@test.invalid');
insert into public.users (auth_id, name, email) values
  ('30000000-0000-0000-0000-00000000000a', 'Gone', 'gone@test.invalid'),
  ('30000000-0000-0000-0000-00000000000b', 'Stays', 'stays@test.invalid');
insert into auth.refresh_tokens (token, user_id) values
  ('identity-token-a', '30000000-0000-0000-0000-00000000000a'),
  ('identity-token-b', '30000000-0000-0000-0000-00000000000b');
insert into auth.sessions (user_id) values
  ('30000000-0000-0000-0000-00000000000a'),
  ('30000000-0000-0000-0000-00000000000b');
insert into waldo.invites (code_hash, email, used_by, used_at) values
  (repeat('a', 64), 'gone@test.invalid', '31000000-0000-0000-0000-00000000000a', now()),
  (repeat('b', 64), 'stays@test.invalid', '31000000-0000-0000-0000-00000000000b', now());
select vault.create_secret('push-token-a', 'identity_push_a');
select vault.create_secret('push-token-b', 'identity_push_b');
insert into waldo.app_push_devices (owner_id, installation_id, session_hash, provider, environment, device_epoch, state, secret_id, token_hash)
  select '31000000-0000-0000-0000-00000000000a', '32000000-0000-0000-0000-00000000000a', repeat('a', 64), 'apns', 'sandbox', 1, 'active', id, repeat('c', 64)
    from vault.secrets where name = 'identity_push_a';
insert into waldo.app_push_devices (owner_id, installation_id, session_hash, provider, environment, device_epoch, state, secret_id, token_hash)
  select '31000000-0000-0000-0000-00000000000b', '32000000-0000-0000-0000-00000000000b', repeat('b', 64), 'apns', 'sandbox', 1, 'active', id, repeat('d', 64)
    from vault.secrets where name = 'identity_push_b';

select is(waldo.delete_owner('identity-a', pg_temp.at(), pg_temp.sig('delown.identity-a')), true, 'the signed delete succeeds');
select is((select count(*)::int from auth.users where id = '30000000-0000-0000-0000-00000000000a'), 0, 'the Auth identity is gone');
select is((select count(*)::int from public.users where auth_id = '30000000-0000-0000-0000-00000000000a')
        + (select count(*)::int from auth.refresh_tokens where user_id = '30000000-0000-0000-0000-00000000000a')
        + (select count(*)::int from auth.sessions where user_id = '30000000-0000-0000-0000-00000000000a'), 0,
  'the legacy user row, refresh tokens and Auth sessions are gone');
select is((select count(*)::int from waldo.invites where code_hash = repeat('a', 64) and email is null and used_at is not null and used_by is null), 1,
  'the redeemed invite keeps its spent state but no longer carries the email');
select is((select count(*)::int from vault.secrets where name = 'identity_push_a'), 0, 'the push token held in Vault is gone');
select is((select count(*)::int from auth.users where id = '30000000-0000-0000-0000-00000000000b')
        + (select count(*)::int from public.users where auth_id = '30000000-0000-0000-0000-00000000000b')
        + (select count(*)::int from auth.refresh_tokens where user_id = '30000000-0000-0000-0000-00000000000b')
        + (select count(*)::int from auth.sessions where user_id = '30000000-0000-0000-0000-00000000000b')
        + (select count(*)::int from waldo.owners where id = '31000000-0000-0000-0000-00000000000b')
        + (select count(*)::int from waldo.invites where code_hash = repeat('b', 64) and email = 'stays@test.invalid')
        + (select count(*)::int from vault.secrets where name = 'identity_push_b'), 7,
  'another owner''s identity, invite email and push token are untouched');
select is(waldo.delete_owner('identity-a', pg_temp.at(), pg_temp.sig('delown.identity-a')), false, 'a second delete finds no owner');
select is((select count(*)::int from auth.users where id = '30000000-0000-0000-0000-00000000000b'), 1, 'the second delete touched nothing else');

select * from finish();
rollback;
