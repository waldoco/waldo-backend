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
create function pg_temp.join(u uuid, e text, p text, s text, c text) returns jsonb language sql as $$
  select waldo.signup_owner_with_signin_identity(u, e, p, s, '', c, pg_temp.at(),
    pg_temp.rsig('signinid.signup.' || u::text || '.' || lower(e) || '.' || p || '.' || s || '..' || c)) $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000d1', 'dave@test.invalid', now());
insert into auth.identities (user_id, provider, provider_id, identity_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'google', 'google-alice', '{"sub": "google-alice", "email": "alice@test.invalid"}'),
  ('00000000-0000-0000-0000-0000000000a1', 'apple', 'apple-alice', '{"sub": "apple-alice"}'),
  ('00000000-0000-0000-0000-0000000000a1', 'google', 'google-alice-2', '{"sub": "google-alice-2", "email": "alice@test.invalid"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'google', 'google-bob', '{"sub": "google-bob", "email": "bob@test.invalid"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'apple', 'apple-carol', '{"sub": "apple-carol"}'),
  ('00000000-0000-0000-0000-0000000000d1', 'google', 'google-dave', '{"sub": "google-dave", "email": "dave@test.invalid"}');
insert into waldo.invites (code_hash, email, expires_at) values
  (repeat('c', 64), 'carol@test.invalid', now() + interval '14 days'),
  (repeat('a', 64), 'alice@test.invalid', now() + interval '14 days');
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
select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'mallory@test.invalid', 'google', 'google-alice'), 'nor does the same Auth user under an email that is not the owner''s');

-- Joining through an identity: only the transaction that creates the owner trusts the identity that joined.
select is(pg_temp.join('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', 'apple', 'apple-carol', repeat('c', 64)) ->> 'created', 'true', 'an invite creates the owner');
select ok(pg_temp.trusted('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', 'apple', 'apple-carol'), 'and trusts the identity that joined, in the same transaction');
select ok((select used_at is not null from waldo.invites where code_hash = repeat('c', 64)), 'spending the invite');
select is(pg_temp.join('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', 'apple', 'apple-carol', repeat('c', 64)),
  jsonb_build_object('do_name', (select do_name from waldo.owners where email = 'carol@test.invalid'), 'created', false), 'a retry finds the owner it made, and created nothing');
-- The member's own redemption committed first: their owner exists, so a second identity on their Auth user is only found.
select is(pg_temp.join('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice-2', repeat('a', 64)) ->> 'created', 'false', 'an identity reaching an owner that already exists creates nothing');
select ok(not pg_temp.trusted('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', 'google', 'google-alice-2'), 'and is not trusted');
select ok((select used_at is null from waldo.invites where code_hash = repeat('a', 64)), 'nor spends an invite');
select is(pg_temp.join('00000000-0000-0000-0000-0000000000d1', 'dave@test.invalid', 'google', 'google-dave', repeat('d', 64)), null, 'no invite, no owner: nothing');
select ok(not exists (select 1 from waldo.owner_signin_identities t join waldo.owners o on o.id = t.owner_id where o.email = 'dave@test.invalid'), 'and nothing trusted');
select is(waldo.signup_owner_for_auth('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', pg_temp.at(),
  pg_temp.rsig('signup.owner.00000000-0000-0000-0000-0000000000c1.carol@test.invalid..' || repeat('c', 64)), '', repeat('c', 64)),
  (select do_name from waldo.owners where email = 'carol@test.invalid'), 'the email-code join keeps its answer');
select throws_ok($$ select waldo.signup_owner_with_signin_identity('00000000-0000-0000-0000-0000000000c1', 'carol@test.invalid', 'apple', 'apple-carol', '', repeat('c', 64), pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned join is refused');
select ok(not has_function_privilege('anon', 'waldo.signup_owner_core(uuid, text, text, text)', 'execute'), 'the join core is not callable through the API');

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
select is((select count(*)::int from waldo.owner_signin_identities where subject like '%-alice%'), 0, 'deleting the owner deletes its trusted identities');
select is((select count(*)::int from waldo.owner_signin_identities), 1, 'and only its own');

select * from finish();
rollback;
