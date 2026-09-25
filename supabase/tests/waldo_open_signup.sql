begin;
create extension if not exists pgtap with schema extensions;
select plan(18);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(extract(epoch from now())::bigint::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;

-- #156: open signup. A brand-new verified email self-provisions owner + settings, non-admin.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'new@test.invalid'),
  ('00000000-0000-0000-0000-0000000000d2', 'clone@test.invalid'),
  ('00000000-0000-0000-0000-0000000000d3', 'second@test.invalid'),
  ('00000000-0000-0000-0000-0000000000d4', 'fresh@test.invalid');

select is(waldo.signin_allowed('anyone@test.invalid', pg_temp.at(), pg_temp.sig('signin.anyone@test.invalid')), true, 'open signup: any address may request a code');
select matches(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d1', 'new@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d1.new@test.invalid'), '+91 9000000001'), '^owner-', 'an uninvited verified email creates its own owner + DO');
select is((select phone from waldo.owners where email = 'new@test.invalid'), '+91 9000000001', 'the signup phone lands on the owner row');
select is((select phone_verified_at from waldo.owners where email = 'new@test.invalid'), null, 'signup phone is stored UNVERIFIED (phone_verified_at null)');
select is((select count(*) from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.email = 'new@test.invalid'), 1::bigint, 'settings are provisioned in the same transaction');
select is((select is_admin from waldo.owners where email = 'new@test.invalid'), false, 'a fresh signup is never an admin');

-- Idempotency: a repeat verify for the same auth user returns the same DO, no duplicates.
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d1', 'new@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d1.new@test.invalid')), (select do_name from waldo.owners where auth_user_id = '00000000-0000-0000-0000-0000000000d1'), 'repeat verify returns the same DO');
select is((select count(*) from waldo.owners where auth_user_id = '00000000-0000-0000-0000-0000000000d1'), 1::bigint, 'no duplicate owner for one auth user');

-- One owner per email: a second auth identity for an already-owned email is refused, not duplicated.
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d3', 'new@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d3.new@test.invalid')), null, 'an already-owned email cannot mint a second owner');
select is((select count(*) from waldo.owners where lower(email) = 'new@test.invalid'), 1::bigint, 'still exactly one owner for that email');

-- No phone: open signup still works, phone stays null.
select matches(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d2', 'clone@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d2.clone@test.invalid'), '+91 9000000002'), '^owner-', 'signup with a phone creates an owner');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d5', 'nophone@test.invalid');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d5', 'nophone@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d5.nophone@test.invalid')), null, 'phone REQUIRED: the RPC refuses new-owner provisioning without a phone (edge is not the only enforcement)');
select is((select count(*) from waldo.owners where lower(email) = 'nophone@test.invalid'), 0::bigint, 'no owner row exists after a phone-less provisioning refusal');

-- Legacy telegram-only owner preservation (owner constraint 16:29): production has
-- exactly one active telegram-only owner with NO auth user, NO email, NO admin.
-- Signup must be structurally blind to it: no auto-claim, no clobber, no promotion.
insert into waldo.owners (id, auth_user_id, do_name, email)
values ('00000000-0000-0000-0000-0000000000e1', null, 'legacy-do', null);
insert into waldo.presences (owner_id, provider, subject)
values ('00000000-0000-0000-0000-0000000000e1', 'telegram', '44');
select matches(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d4', 'fresh@test.invalid', pg_temp.at(), pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d4.fresh@test.invalid'), '+91 9000000003'), '^owner-', 'signup beside a legacy telegram-only owner still creates a NEW owner');
select isnt((select do_name from waldo.owners where auth_user_id = '00000000-0000-0000-0000-0000000000d4'), 'legacy-do', 'the new signup never receives the legacy DO');
select is((select count(*) from waldo.owners where id = '00000000-0000-0000-0000-0000000000e1' and auth_user_id is null and email is null), 1::bigint, 'legacy owner row untouched: still no auth user, still no email');

-- Fail-closed: whatsapp presence cannot link while phone is unverified (any path).
select throws_matching(
  $$insert into waldo.presences (owner_id, provider, subject) values ((select id from waldo.owners where email = 'new@test.invalid'), 'whatsapp', '919876543210')$$,
  'whatsapp presence requires a verified phone',
  'whatsapp link refused while phone_verified_at is null'
);

-- Tenant isolation under RLS: the new owner sees only itself.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
select is((select count(*) from waldo.owners), 1::bigint, 'RLS: an owner reads only its own row');
select * from finish();
rollback;
