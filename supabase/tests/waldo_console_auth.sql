begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(extract(epoch from now())::bigint::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'seeded@test.invalid'), ('00000000-0000-0000-0000-0000000000c2', 'invited@test.invalid'), ('00000000-0000-0000-0000-0000000000c3', 'stranger@test.invalid'), ('00000000-0000-0000-0000-0000000000c4', 'latephone@test.invalid'), ('00000000-0000-0000-0000-0000000000c6', 'unmarked@test.invalid');
insert into waldo.owners (do_name, email, bootstrap_claimable) values ('do-seeded', 'seeded@test.invalid', true);
insert into waldo.owners (do_name, email) values ('do-unmarked', 'unmarked@test.invalid');
insert into waldo.invites (code_hash, email) values ('inv-1', 'invited@test.invalid'), ('inv-2', 'latephone@test.invalid');
-- regression fixture: an older invite for the same address, already used, never attributed
insert into waldo.invites (code_hash, email, used_at) values ('inv-0', 'invited@test.invalid', now() - interval '1 day');

select is(waldo.signin_allowed('seeded@test.invalid', pg_temp.at(), pg_temp.sig('signin.seeded@test.invalid')), true, 'a seeded owner may sign in');
select is(waldo.signin_allowed('Invited@test.invalid', pg_temp.at(), pg_temp.sig('signin.invited@test.invalid')), true, 'an invited address may sign in');
select is(waldo.signin_allowed('stranger@test.invalid', pg_temp.at(), pg_temp.sig('signin.stranger@test.invalid')), true, 'open signup: a stranger may request a code');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c1', 'seeded@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c1.seeded@test.invalid.')), 'do-seeded', 'first sign-in binds the seeded owner and keeps its DO');
select matches(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c2', 'invited@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c2.invited@test.invalid.+91 9000000011'), '+91 9000000011'), '^owner-', 'an invite creates a new owner with its own DO');
select is((select count(*) from waldo.invites where used_at is not null and used_by is not null), 1::bigint, 'the invite is spent');
select is((select used_by from waldo.invites where code_hash = 'inv-0'), null::uuid, 'the older used invite keeps its null attribution');
select is((select used_by from waldo.invites where code_hash = 'inv-1'), (select id from waldo.owners where email = 'invited@test.invalid'), 'only the claimed invite is stamped with the new owner');
select matches(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c3', 'stranger@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c3.stranger@test.invalid.+91 9000000012'), '+91 9000000012'), '^owner-', 'open signup: a stranger gets their own owner');
select throws_ok($$ select waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c3', 'seeded@test.invalid', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged call cannot take over an owner');
-- The phone is signed canonical data: a sig over one phone cannot authorize a different one.
select throws_ok($$ select waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c2', 'invited@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c2.invited@test.invalid.+91 9000000099'), '+91 9000000011') $$, '42501', 'unsigned router call', 'a phone swap invalidates the signature');
-- A phone-less refusal never consumes the invite.
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c4', 'latephone@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c4.latephone@test.invalid.')), null, 'phone required: refusal without a phone');
select is((select used_at from waldo.invites where code_hash = 'inv-2'), null::timestamptz, 'the invite survives a phone-less refusal unconsumed');
select is((select bootstrap_claimable from waldo.owners where do_name = 'do-seeded'), false, 'the bootstrap mark is consumed by the claim');
-- Never match by email: an unmarked unbound row is not claimable, even with a signed call.
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c6', 'unmarked@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c6.unmarked@test.invalid.+91 9000000013'), '+91 9000000013'), null, 'an unmarked unbound owner row cannot be claimed by email');
select is((select auth_user_id from waldo.owners where do_name = 'do-unmarked'), null::uuid, 'the unmarked row stays unbound after the refused claim');
select is(waldo.issue_link_code('do-seeded', 'hash-1', pg_temp.at(), pg_temp.sig('link.do-seeded.hash-1')), true, 'an owner can issue a link code');
select * from finish();
rollback;
