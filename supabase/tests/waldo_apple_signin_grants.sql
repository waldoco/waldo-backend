begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.keep(d text, s text, c text, t text) returns boolean language sql as $$
  select waldo.apple_grant_keep(d, s, c, t, pg_temp.at(), pg_temp.rsig('applegrant.keep.' || d || '.' || s || '.' || c || '.'
    || encode(extensions.digest(convert_to(t, 'UTF8'), 'sha256'), 'hex'))) $$;
create function pg_temp.held(d text) returns jsonb language sql as $$
  select waldo.apple_grants_held(d, pg_temp.at(), pg_temp.rsig('applegrant.held.' || d)) $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@test.invalid', now());
insert into waldo.owners (auth_user_id, do_name, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'do-alice', 'alice@test.invalid'),
  ('00000000-0000-0000-0000-0000000000b1', 'do-bob', 'bob@test.invalid');
insert into waldo.owner_signin_identities (owner_id, provider, subject)
  select id, 'apple', 'apple-alice' from waldo.owners where do_name = 'do-alice'
  union all select id, 'google', 'google-alice' from waldo.owners where do_name = 'do-alice'
  union all select id, 'apple', 'apple-bob' from waldo.owners where do_name = 'do-bob';

select is(pg_temp.held('do-alice'), '[]'::jsonb, 'an owner with no Apple grant holds none');
select ok(pg_temp.keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'rtoken-alice-native-000001'), 'a trusted Apple identity''s token is kept');
select is((select count(*)::int from waldo.owner_apple_grants g join vault.secrets s on s.id = g.secret_id), 1, 'in Vault, behind the row');
select ok(not exists (select 1 from waldo.owner_apple_grants g join vault.secrets s on s.id = g.secret_id where s.secret = 'rtoken-alice-native-000001'), 'never as plaintext in Vault''s table');
select is(pg_temp.held('do-alice'), '[{"client_id": "com.heywaldo.app", "token": "rtoken-alice-native-000001"}]'::jsonb, 'and released to a signed read for revocation');

select ok(pg_temp.keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'rtoken-alice-native-000002'), 'a newer token for the same identity and client is kept');
select is((select count(*)::int from waldo.owner_apple_grants), 1, 'in place of the old one');
select is((select count(*)::int from vault.secrets where name is null or name <> 'waldo_router_hmac'), 1, 'leaving no orphaned secret');
select is(pg_temp.held('do-alice') -> 0 ->> 'token', 'rtoken-alice-native-000002', 'and the newer token is the one held');
select ok(pg_temp.keep('do-alice', 'apple-alice', 'in.heywaldo.console', 'rtoken-alice-web-0000001'), 'a token under another client is kept beside it');
select is(jsonb_array_length(pg_temp.held('do-alice')), 2, 'each under its own client id');

select ok(not pg_temp.keep('do-alice', 'apple-bob', 'com.heywaldo.app', 'rtoken-bob-under-alice-01'), 'an Apple identity another owner trusts is never kept for this owner');
select ok(not pg_temp.keep('do-alice', 'apple-unknown', 'com.heywaldo.app', 'rtoken-unknown-000000001'), 'nor one this owner never trusted');
select ok(not pg_temp.keep('do-alice', 'google-alice', 'com.heywaldo.app', 'rtoken-google-subject-01'), 'nor a Google identity''s subject');
select ok(not pg_temp.keep('do-nobody', 'apple-alice', 'com.heywaldo.app', 'rtoken-no-owner-0000001'), 'nor for an owner that does not exist');
select ok(not pg_temp.keep('do-alice', 'apple-alice', 'com.heywaldo.app/evil', 'rtoken-bad-client-000001'), 'nor under a malformed client id');
select is(jsonb_array_length(pg_temp.held('do-alice')), 2, 'so alice still holds only her own two');

select throws_ok($$ select waldo.apple_grant_keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'rtoken-alice-native-000003', pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned keep is refused');
select throws_ok($$ select waldo.apple_grant_keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'rtoken-alice-native-swapped', pg_temp.at(),
  pg_temp.rsig('applegrant.keep.do-alice.apple-alice.com.heywaldo.app.' || encode(extensions.digest(convert_to('rtoken-alice-native-000003', 'UTF8'), 'sha256'), 'hex'))) $$,
  '42501', null, 'a signature for one token never keeps another');
select throws_ok($$ select pg_temp.keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'short') $$, '42501', null, 'a token too short to be Apple''s is refused');
select throws_ok($$ select waldo.apple_grants_held('do-alice', pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned read is refused');
select throws_ok($$ select waldo.apple_grants_held('do-alice', pg_temp.at(), pg_temp.rsig('delown.do-alice')) $$, '42501', null, 'a deletion signature never reads tokens');

update waldo.owners set state = 'suspended' where do_name = 'do-alice';
select is(pg_temp.held('do-alice'), null, 'a suspended owner releases no token');
select ok(not pg_temp.keep('do-alice', 'apple-alice', 'com.heywaldo.app', 'rtoken-alice-native-000004'), 'and keeps none');
update waldo.owners set state = 'active' where do_name = 'do-alice';

select ok(not has_table_privilege('anon', 'waldo.owner_apple_grants', 'select'), 'anon cannot read the table');
select ok(not has_table_privilege('authenticated', 'waldo.owner_apple_grants', 'select'), 'a Supabase user session cannot read the table');
select ok(not has_function_privilege('authenticated', 'waldo.apple_grants_held(text, bigint, text)', 'execute'), 'a Supabase user session cannot read tokens');
select ok(not has_function_privilege('anon', 'waldo.owner_apple_grant_forget_secret()', 'execute'), 'the trigger function is not callable through the API');

select ok(pg_temp.keep('do-bob', 'apple-bob', 'com.heywaldo.app', 'rtoken-bob-native-0000001'), 'bob keeps his own');
select ok(waldo.delete_owner('do-alice', pg_temp.at(), pg_temp.rsig('delown.do-alice')), 'deleting alice');
select is((select count(*)::int from waldo.owner_apple_grants g join waldo.owners o on o.id = g.owner_id where o.do_name = 'do-alice'), 0, 'deletes her grants');
select is((select count(*)::int from vault.secrets where name is null or name <> 'waldo_router_hmac'), 1, 'and their Vault secrets, leaving only bob''s');
select is(pg_temp.held('do-bob') -> 0 ->> 'token', 'rtoken-bob-native-0000001', 'whose token is untouched');

select * from finish();
rollback;
