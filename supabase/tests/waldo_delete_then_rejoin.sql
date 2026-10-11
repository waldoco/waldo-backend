begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('rejoin-fixture-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'rejoin-fixture-secret', 'sha256'), 'hex')
$$;
create function pg_temp.invite(issuer text, email text, code_hash text) returns boolean language sql as $$
  select waldo.issue_member_invite(issuer, email, code_hash, pg_temp.at(), pg_temp.sig('memberinvite.' || issuer || '.' || lower(email) || '.' || code_hash))
$$;
create function pg_temp.signin_allowed(email text, code_hash text) returns boolean language sql as $$
  select waldo.signin_allowed(email, pg_temp.at(), pg_temp.sig('signin.' || lower(email) || '.' || code_hash), code_hash)
$$;
create function pg_temp.resolve(subject uuid, email text, code_hash text) returns text language sql as $$
  select waldo.owner_for_auth(subject, email, pg_temp.at(), pg_temp.sig('owner.' || subject::text || '.' || lower(email) || '..' || code_hash), '', code_hash)
$$;
create function pg_temp.join(subject uuid, email text, code_hash text) returns text language sql as $$
  select waldo.signup_owner_for_auth(subject, email, pg_temp.at(), pg_temp.sig('signup.owner.' || subject::text || '.' || lower(email) || '..' || code_hash), '', code_hash)
$$;

-- Deleting an account removes the directory owner but keeps the Auth user, so a returning person signs in with the same
-- Auth subject. The redeemed invite row also stays, carrying the email.
insert into auth.users(id, email, email_confirmed_at) values ('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', now());
insert into waldo.owners(do_name, email, bootstrap_claimable) values ('rejoin-issuer', 'issuer@test.invalid', false);

select is(pg_temp.invite('rejoin-issuer', 'returning@test.invalid', repeat('1', 64)), true, 'first invite is issued');
select ok(pg_temp.join('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', repeat('1', 64)) like 'owner-%', 'first signup creates an owner');
create temp table first_owner as select do_name from waldo.owners where auth_user_id = '20000000-0000-0000-0000-000000000001';

select is(waldo.delete_owner((select do_name from first_owner), pg_temp.at(), pg_temp.sig('delown.' || (select do_name from first_owner))), true, 'the owner deletes the account');
select is((select count(*)::int from waldo.invites where code_hash = repeat('1', 64) and used_at is not null and used_by is null), 1, 'the redeemed invite row stays, detached from the deleted owner');
select is(pg_temp.resolve('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', ''), null::text, 'the deleted account no longer resolves');
select is(pg_temp.join('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', repeat('1', 64)), null::text, 'the spent invite cannot reopen an account');

select is(pg_temp.invite('rejoin-issuer', 'returning@test.invalid', repeat('2', 64)), true, 'a new invite to the same email is issued despite the old redeemed row');
select is(pg_temp.signin_allowed('returning@test.invalid', repeat('2', 64)), true, 'the new invite lets an email code be sent');
create temp table second_owner as select pg_temp.join('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', repeat('2', 64)) as do_name;
select ok((select do_name from second_owner) like 'owner-%' and (select do_name from second_owner) <> (select do_name from first_owner), 'signing up again creates a new owner with a fresh Durable Object name');
select is(pg_temp.resolve('20000000-0000-0000-0000-000000000001', 'returning@test.invalid', ''), (select do_name from second_owner), 'the new owner resolves on later sign-ins');
select is((select used_by from waldo.invites where code_hash = repeat('2', 64)), (select id from waldo.owners where do_name = (select do_name from second_owner)), 'the new invite is spent by the new owner');

select * from finish();
rollback;
