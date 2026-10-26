begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.trusted(u uuid, e text, p text, s text) returns boolean language sql as $$
  select waldo.signin_identity_trusted(u, e, p, s, pg_temp.at(), pg_temp.rsig('signinid.trusted.' || u::text || '.' || lower(e) || '.' || p || '.' || s)) $$;
create function pg_temp.trust(u uuid, e text, p text, s text) returns boolean language sql as $$
  select waldo.trust_signin_identity(u, e, p, s, pg_temp.at(), pg_temp.rsig('signinid.trust.' || u::text || '.' || lower(e) || '.' || p || '.' || s)) $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@test.invalid', now());
insert into auth.identities (user_id, provider, provider_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'google', 'google-alice'),
  ('00000000-0000-0000-0000-0000000000a1', 'apple', 'apple-alice'),
  ('00000000-0000-0000-0000-0000000000b1', 'google', 'google-bob');
insert into waldo.owners (auth_user_id, do_name, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'do-alice', 'alice@test.invalid'),
  ('00000000-0000-0000-0000-0000000000b1', 'do-bob', 'bob@test.invalid');

select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice'), 'an identity is not trusted until it is recorded');
select ok(pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'Alice@test.invalid', 'google', 'google-alice'), 'the owner''s own linked identity is recorded');
select ok(pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice'), 'and is then trusted');
select ok(pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice'), 'recording it again is harmless');
select is((select count(*)::int from waldo.owner_signin_identities), 1, 'one row per identity');
select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'apple', 'apple-alice'), 'trusting one identity trusts no other identity of the owner');

select ok(not pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-bob'), 'a subject Supabase links to another Auth user is never recorded');
select ok(not pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-unknown'), 'a subject Supabase does not hold is never recorded');
select ok(not pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'apple', 'google-alice'), 'a subject under another provider is never recorded');
select ok(not pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'bob@test.invalid', 'apple', 'apple-alice'), 'an email that is not this Auth user''s owner records nothing');
select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000b1', 'bob@test.invalid', 'google', 'google-alice'), 'another owner never reads alice''s trust');

update waldo.owners set state = 'suspended' where do_name = 'do-alice';
select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice'), 'a suspended owner signs in with no identity');
select ok(not pg_temp.trust('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'apple', 'apple-alice'), 'and has none recorded');
update waldo.owners set state = 'active' where do_name = 'do-alice';

select throws_ok($$ select waldo.signin_identity_trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice', pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned read is refused');
select throws_ok($$ select waldo.trust_signin_identity('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice', pg_temp.at(), pg_temp.rsig('signinid.trusted.00000000-0000-0000-0000-0000000000a1.alice@test.invalid.google.google-alice')) $$, '42501', null, 'a read signature never authorizes a write');

select ok(not has_table_privilege('anon', 'waldo.owner_signin_identities', 'select'), 'anon cannot read the table');
select ok(not has_table_privilege('authenticated', 'waldo.owner_signin_identities', 'select'), 'a Supabase user session cannot read the table');
select ok(not has_function_privilege('authenticated', 'waldo.trust_signin_identity(uuid, text, text, text, bigint, text)', 'execute'), 'a Supabase user session cannot record trust');

delete from waldo.owners where do_name = 'do-alice';
select is((select count(*)::int from waldo.owner_signin_identities), 0, 'deleting the owner deletes its trusted identities');

select * from finish();
rollback;
