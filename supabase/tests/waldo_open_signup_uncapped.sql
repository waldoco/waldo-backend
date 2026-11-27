begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.open(u uuid, e text, p text, s text, phone text default '') returns jsonb language sql as $$
  select waldo.signup_owner_open_uncapped(u, e, p, s, phone, pg_temp.at(),
    pg_temp.rsig('signup.open.uncapped.' || u::text || '.' || lower(e) || '.' || p || '.' || s || '.' || phone)) $$;
create function pg_temp.capped(u uuid, e text) returns jsonb language sql as $$
  select waldo.signup_owner_open(u, e, '', '', '', 1, 1, pg_temp.at(),
    pg_temp.rsig('signup.open.' || u::text || '.' || lower(e) || '....1.1')) $$;
create function pg_temp.throttle(k text, l integer) returns boolean language sql as $$
  select waldo.open_signup_throttle(k, l, pg_temp.at(), pg_temp.rsig('signup.open.throttle.' || k || '.' || l::text)) $$;
create function pg_temp.state(d text) returns text language sql as $$
  select waldo.open_owner_state(d, pg_temp.at(), pg_temp.rsig('openowner.state.' || d)) $$;
create function pg_temp.do_of(e text) returns text language sql as $$ select do_name from waldo.owners where email = e $$;

insert into auth.users (id, email, email_confirmed_at)
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'member' || n || '@test.invalid', now() from generate_series(1, 250) n;
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'ann@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000e1', 'eve@test.invalid', null),
  ('00000000-0000-0000-0000-0000000000f1', 'fay@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', now());
insert into auth.identities (user_id, provider, provider_id, identity_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'apple', 'apple-ann', '{"sub": "apple-ann"}');
insert into waldo.owners (auth_user_id, do_name, email, state) values
  ('00000000-0000-0000-0000-0000000000f1', 'do-fay', 'fay@test.invalid', 'suspended');
insert into waldo.owners (auth_user_id, do_name, email) values ('00000000-0000-0000-0000-000000000250', 'do-inviter', 'member250@test.invalid');

-- No cap, of any size: a gym cohort past the old lifetime ceiling of 200 all join on one day.
select is((select count(*)::int from generate_series(1, 249) n
  where pg_temp.open(('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'member' || n || '@test.invalid', '', '') ->> 'created' = 'true'), 249,
  'every one of 249 joins on one day is admitted');
select is((select admitted from waldo.open_signup_days where day = (now() at time zone 'utc')::date), 249, 'and each is counted for operators');
select is(pg_temp.capped('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid'), '{"refused": "cap"}'::jsonb, 'the capped function is unchanged, for a rolled-back Worker');

-- The join itself, as signup_owner_open made it.
select is(pg_temp.open('00000000-0000-0000-0000-0000000000a1', 'Ann@test.invalid', 'apple', 'apple-ann', '+919876543210') ->> 'created', 'true', 'an Apple join creates the owner');
select is((select admitted_via from waldo.owners where email = 'ann@test.invalid'), 'open', 'as an open owner');
select is(pg_temp.state(pg_temp.do_of('ann@test.invalid')), 'held', 'held for their agreements');
select is((select phone from waldo.owners where email = 'ann@test.invalid'), '+919876543210', 'with the phone it joined with');
select ok(exists (select 1 from waldo.owner_signin_identities t join waldo.owners o on o.id = t.owner_id where o.email = 'ann@test.invalid' and t.provider = 'apple'), 'trusting the identity that joined');
select ok(exists (select 1 from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.email = 'ann@test.invalid'), 'with its settings row');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000a1', 'ann@test.invalid', 'apple', 'apple-ann', '+919876543210'),
  jsonb_build_object('do_name', pg_temp.do_of('ann@test.invalid'), 'created', false), 'a retry finds the owner and creates nothing');

-- Refusals that never create or rebind a tenant.
select is(pg_temp.open('00000000-0000-0000-0000-0000000000e1', 'eve@test.invalid', '', ''), null, 'an unconfirmed Auth email joins no one');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000a1', 'eve@test.invalid', '', ''), null, 'an email that is not the Auth user''s joins no one');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000f1', 'fay@test.invalid', '', ''), '{"refused": "taken"}'::jsonb, 'a suspended owner''s address is refused, not rebuilt');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', 'google', ''), null, 'a provider with no subject is refused');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', '', '', '98765'), null, 'a phone that is not E.164 is refused');
select throws_ok($$ select waldo.signup_owner_open_uncapped('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', '', '', '', pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned join is refused');
select throws_ok($$ select waldo.signup_owner_open_uncapped('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', '', '', '', pg_temp.at(),
  pg_temp.rsig('signup.open.00000000-0000-0000-0000-0000000000b1.ivy@test.invalid....1.1')) $$, '42501', null, 'a capped join''s signature does not sign an uncapped one');

-- An invite addressed to the confirmed email still admits its holder as invited.
insert into waldo.invites (code_hash, email, issued_by, expires_at) values (repeat('1', 64), 'ivy@test.invalid', (select id from waldo.owners where do_name = 'do-inviter'), now() + interval '1 day');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000b1', 'ivy@test.invalid', '', '') ->> 'created', 'true', 'an invited person joins');
select ok((select admitted_via is null from waldo.owners where email = 'ivy@test.invalid'), 'as an invited owner, never held');
select is((select used_by from waldo.invites where code_hash = repeat('1', 64)), (select id from waldo.owners where email = 'ivy@test.invalid'), 'spending their invite');

-- The attempt throttle carries a cohort on one network, and still stops past its limit.
select is((select count(*)::int from generate_series(1, 300) where pg_temp.throttle('ip.' || repeat('5', 64), 300)), 300, 'a limit of 300 a day is honoured');
select ok(not pg_temp.throttle('ip.' || repeat('5', 64), 300), 'the 301st attempt is refused');
select ok(pg_temp.throttle('email.' || repeat('6', 64), 1000), 'a limit of 1000 is accepted');
select ok(not pg_temp.throttle('email.' || repeat('7', 64), 1001), 'a limit above 1000 is refused');
select ok(not pg_temp.throttle('ip.' || repeat('8', 64), 0), 'a zero limit is refused');

-- Privileges.
select ok(not has_function_privilege('authenticated', 'waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text)', 'execute'), 'a user session cannot join openly');
select ok(not has_function_privilege('service_role', 'waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text)', 'execute'), 'nor the service role');
select ok(has_function_privilege('anon', 'waldo.signup_owner_open_uncapped(uuid, text, text, text, text, bigint, text)', 'execute'), 'the router calls it as anon, signed');

select * from finish();
rollback;
