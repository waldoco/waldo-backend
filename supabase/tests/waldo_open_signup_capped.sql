begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.open(u uuid, e text, p text, s text, daily integer, total integer) returns jsonb language sql as $$
  select waldo.signup_owner_open(u, e, p, s, '', daily, total, pg_temp.at(),
    pg_temp.rsig('signup.open.' || u::text || '.' || lower(e) || '.' || p || '.' || s || '..' || daily::text || '.' || total::text)) $$;
create function pg_temp.room(daily integer, total integer) returns boolean language sql as $$
  select waldo.open_signup_room(daily, total, pg_temp.at(), pg_temp.rsig('signup.open.room.' || daily::text || '.' || total::text)) $$;
create function pg_temp.state(d text) returns text language sql as $$
  select waldo.open_owner_state(d, pg_temp.at(), pg_temp.rsig('openowner.state.' || d)) $$;
create function pg_temp.release(d text) returns boolean language sql as $$
  select waldo.release_open_owner(d, pg_temp.at(), pg_temp.rsig('openowner.release.' || d)) $$;
create function pg_temp.link(d text, provider text) returns boolean language sql as $$
  select waldo.issue_provider_link_code(d, provider, c, pg_temp.at(), pg_temp.rsig('link.' || provider || '.' || d || '.' || c))
  from (select encode(extensions.digest(d || provider || clock_timestamp()::text, 'sha256'), 'hex') as c) code $$;
create function pg_temp.throttle(k text, l integer) returns boolean language sql as $$
  select waldo.open_signup_throttle(k, l, pg_temp.at(), pg_temp.rsig('signup.open.throttle.' || k || '.' || l::text)) $$;
create function pg_temp.do_of(e text) returns text language sql as $$ select do_name from waldo.owners where email = e $$;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'ann@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'ben@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000c1', 'cat@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000d1', 'dan@test.invalid', now()),
  ('00000000-0000-0000-0000-0000000000e1', 'eve@test.invalid', null),
  ('00000000-0000-0000-0000-0000000000f1', 'fay@test.invalid', now()),
  ('00000000-0000-0000-0000-000000000011', 'gus@test.invalid', now()),
  ('00000000-0000-0000-0000-000000000012', 'hal@test.invalid', now());
insert into auth.identities (user_id, provider, provider_id, identity_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'google', 'google-ann', '{"sub": "google-ann"}');
insert into waldo.owners (auth_user_id, do_name, email, state) values
  ('00000000-0000-0000-0000-0000000000f1', 'do-fay', 'fay@test.invalid', 'suspended');
insert into waldo.owners (do_name, email) values ('do-gus-seeded', 'gus@test.invalid');
insert into waldo.owners (auth_user_id, do_name, email) values ('00000000-0000-0000-0000-000000000012', 'do-hal', 'hal@test.invalid');

-- The invite path is unchanged: with no invite, the invite join still creates no one.
select is(waldo.signup_owner_for_auth('00000000-0000-0000-0000-0000000000b1', 'ben@test.invalid', pg_temp.at(),
  pg_temp.rsig('signup.owner.00000000-0000-0000-0000-0000000000b1.ben@test.invalid..' || encode(extensions.digest('', 'sha256'), 'hex')), '',
  encode(extensions.digest('', 'sha256'), 'hex')), null, 'the invite join with an empty invite still creates no owner');

-- Joining openly through Google.
select is(pg_temp.open('00000000-0000-0000-0000-0000000000a1', 'Ann@test.invalid', 'google', 'google-ann', 2, 3) ->> 'created', 'true', 'an open join creates the owner');
select is((select admitted_via from waldo.owners where email = 'ann@test.invalid'), 'open', 'marked as an open owner');
select ok(exists (select 1 from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.email = 'ann@test.invalid'), 'with its settings row');
select ok(exists (select 1 from waldo.owner_signin_identities t join waldo.owners o on o.id = t.owner_id where o.email = 'ann@test.invalid' and t.subject = 'google-ann'), 'and the identity that joined trusted');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000a1', 'ann@test.invalid', 'google', 'google-ann', 2, 3),
  jsonb_build_object('do_name', pg_temp.do_of('ann@test.invalid'), 'created', false), 'a retry finds the owner and creates nothing');
select is((select admitted from waldo.open_signup_days), 1, 'a retry takes no second place');

-- Refusals that never create or rebind a tenant.
select is(pg_temp.open('00000000-0000-0000-0000-0000000000e1', 'eve@test.invalid', '', '', 2, 3), null, 'an unconfirmed Auth email joins no one');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000c1', 'eve@test.invalid', '', '', 2, 3), null, 'an email that is not the Auth user''s joins no one');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000f1', 'fay@test.invalid', '', '', 2, 3), '{"refused": "taken"}'::jsonb, 'a suspended owner''s address is refused, not rebuilt');
select is((select count(*)::int from waldo.owners where email = 'fay@test.invalid'), 1, 'and keeps its one row');
select is(pg_temp.open('00000000-0000-0000-0000-000000000011', 'gus@test.invalid', '', '', 2, 3), '{"refused": "taken"}'::jsonb, 'a seeded unbound row is never claimed by an open join');
select ok((select auth_user_id is null from waldo.owners where do_name = 'do-gus-seeded'), 'and stays unbound');
select is(pg_temp.open('00000000-0000-0000-0000-000000000012', 'hal@test.invalid', '', '', 2, 3),
  jsonb_build_object('do_name', 'do-hal', 'created', false), 'an invited owner signing in is only found');
select ok((select admitted_via is null from waldo.owners where do_name = 'do-hal'), 'and stays a member');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000c1', 'cat@test.invalid', 'google', '', 2, 3), null, 'a provider with no subject is refused');
select throws_ok($$ select waldo.signup_owner_open('00000000-0000-0000-0000-0000000000c1', 'cat@test.invalid', '', '', '', 2, 3, pg_temp.at(), 'bad') $$, '42501', null, 'an unsigned join is refused');
select throws_ok($$ select pg_temp.open('00000000-0000-0000-0000-0000000000c1', 'cat@test.invalid', '', '', 0, 3) $$, '22023', null, 'a zero cap is refused, not read as open');
select is((select admitted from waldo.open_signup_days), 1, 'refusals take no place');

-- The daily cap.
select ok(pg_temp.room(2, 3), 'room while today has a place');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000c1', 'cat@test.invalid', '', '', 2, 3) ->> 'created', 'true', 'the second join of the day fits');
select ok(not pg_temp.room(2, 3), 'no room once today is full');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000d1', 'dan@test.invalid', '', '', 2, 3), '{"refused": "cap"}'::jsonb, 'past the daily cap: refused');
select ok(not exists (select 1 from waldo.owners where email = 'dan@test.invalid'), 'and no owner written');

-- The lifetime cap counts earlier days, and a deleted account gives no place back.
update waldo.open_signup_days set day = day - 1;
select ok(not pg_temp.room(2, 2), 'the lifetime cap counts earlier days');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000d1', 'dan@test.invalid', '', '', 2, 2), '{"refused": "cap"}'::jsonb, 'past the lifetime cap: refused');
select ok(waldo.delete_owner(pg_temp.do_of('cat@test.invalid'), pg_temp.at(), pg_temp.rsig('delown.' || pg_temp.do_of('cat@test.invalid'))), 'an open owner deletes their account');
select is((select sum(admitted)::int from waldo.open_signup_days), 2, 'and the count keeps their place');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000d1', 'dan@test.invalid', '', '', 2, 2), '{"refused": "cap"}'::jsonb, 'so a new join is still refused');
select is(pg_temp.open('00000000-0000-0000-0000-0000000000d1', 'dan@test.invalid', '', '', 2, 3) ->> 'created', 'true', 'a raised lifetime cap admits the next join');

-- An invite addressed to the confirmed email is spent without its code: an invited person, not an open owner, and no place taken.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000021', 'ivy@test.invalid', now()),
  ('00000000-0000-0000-0000-000000000022', 'jay@test.invalid', now()),
  ('00000000-0000-0000-0000-000000000023', 'kim@test.invalid', now());
insert into waldo.invites (code_hash, email, issued_by, expires_at) values
  (repeat('1', 64), 'ivy@test.invalid', (select id from waldo.owners where do_name = 'do-hal'), now() + interval '1 day'),
  (repeat('2', 64), 'jay@test.invalid', (select id from waldo.owners where do_name = 'do-hal'), now() - interval '1 day'),
  (repeat('3', 64), 'kim@test.invalid', (select id from waldo.owners where do_name = 'do-hal'), now() + interval '1 day');
update waldo.invites set revoked_at = now() where code_hash = repeat('3', 64);
select ok(not pg_temp.room(2, 3), 'every open place is taken');
select is(pg_temp.open('00000000-0000-0000-0000-000000000021', 'ivy@test.invalid', '', '', 2, 3) ->> 'created', 'true', 'an invited person joins without the code, even with no open place left');
select ok((select admitted_via is null from waldo.owners where email = 'ivy@test.invalid'), 'as an invited owner, never held');
select is((select used_by from waldo.invites where code_hash = repeat('1', 64)), (select id from waldo.owners where email = 'ivy@test.invalid'), 'spending their invite, which names the one who sent it');
select is((select sum(admitted)::int from waldo.open_signup_days where day > current_date - 5), 3, 'and taking no open place');
select is(pg_temp.open('00000000-0000-0000-0000-000000000022', 'jay@test.invalid', '', '', 2, 3), '{"refused": "cap"}'::jsonb, 'an expired invite admits no one past the cap');
select is(pg_temp.open('00000000-0000-0000-0000-000000000023', 'kim@test.invalid', '', '', 2, 3), '{"refused": "cap"}'::jsonb, 'nor a revoked one');
select ok((select used_at is null from waldo.invites where code_hash in (repeat('2', 64), repeat('3', 64)) group by used_at is null), 'and neither is spent');

-- Holding and releasing.
select is(pg_temp.state(pg_temp.do_of('ann@test.invalid')), 'held', 'a new open owner is held');
select is(pg_temp.state('do-hal'), 'member', 'an invited owner is a member');
select is(pg_temp.state('do-nobody'), null, 'an unknown name has no state');
select is(pg_temp.state('do-fay'), null, 'nor does a suspended owner');
select ok(not pg_temp.link(pg_temp.do_of('ann@test.invalid'), 'whatsapp'), 'a held owner is issued no WhatsApp code');
select ok(not pg_temp.link(pg_temp.do_of('ann@test.invalid'), 'imessage'), 'nor an iMessage code');
select ok(not waldo.issue_link_code(pg_temp.do_of('ann@test.invalid'), repeat('e', 64), pg_temp.at(), pg_temp.rsig('link.' || pg_temp.do_of('ann@test.invalid') || '.' || repeat('e', 64))), 'nor a Telegram code');
select ok(not exists (select 1 from waldo.link_codes l join waldo.owners o on o.id = l.owner_id where o.email = 'ann@test.invalid'), 'and no code row exists');
select throws_ok(format($$ insert into waldo.presences (owner_id, provider, subject) values ('%s', 'telegram', 'tg-ann') $$, (select id from waldo.owners where email = 'ann@test.invalid')),
  '42501', null, 'no messaging presence binds to a held owner by any path');
select ok(pg_temp.link('do-hal', 'whatsapp'), 'a member is issued codes as before');
select ok(waldo.issue_link_code('do-hal', repeat('f', 64), pg_temp.at(), pg_temp.rsig('link.do-hal.' || repeat('f', 64))), 'Telegram codes too');
insert into waldo.presences (owner_id, provider, subject) values ((select id from waldo.owners where do_name = 'do-hal'), 'telegram', 'tg-hal');
select pass('a member binds a presence as before');

select ok(not pg_temp.release('do-hal'), 'releasing a member does nothing');
select ok((select open_released_at is null from waldo.owners where do_name = 'do-hal'), 'and writes nothing');
select ok(pg_temp.release(pg_temp.do_of('ann@test.invalid')), 'an open owner is released');
select is(pg_temp.state(pg_temp.do_of('ann@test.invalid')), 'released', 'and reads released');
select is(pg_temp.release(pg_temp.do_of('ann@test.invalid')), true, 'a repeated release is harmless');
select ok(pg_temp.link(pg_temp.do_of('ann@test.invalid'), 'whatsapp'), 'a released owner is issued codes');
insert into waldo.presences (owner_id, provider, subject) values ((select id from waldo.owners where email = 'ann@test.invalid'), 'telegram', 'tg-ann');
select pass('and binds a presence');
select throws_ok($$ select waldo.release_open_owner('do-hal', pg_temp.at(), pg_temp.rsig('openowner.state.do-hal')) $$, '42501', null, 'a read signature never releases');

-- Per-key attempt limits.
select ok(pg_temp.throttle('ip.' || repeat('1', 64), 2), 'first attempt');
select ok(pg_temp.throttle('ip.' || repeat('1', 64), 2), 'second attempt');
select ok(not pg_temp.throttle('ip.' || repeat('1', 64), 2), 'third attempt past the limit');
select ok(pg_temp.throttle('email.' || repeat('1', 64), 2), 'another key counts apart');
select ok(not pg_temp.throttle('raw-ip-1.2.3.4', 2), 'an unhashed key is refused');
select ok(not pg_temp.throttle('ip.' || repeat('2', 64), 0), 'a zero limit is refused');
insert into waldo.open_signup_attempts (key, day, attempts) values ('ip.' || repeat('3', 64), current_date - 3, 9);
select ok(pg_temp.throttle('ip.' || repeat('4', 64), 2), 'an attempt');
select ok(not exists (select 1 from waldo.open_signup_attempts where day < current_date - 1), 'sweeps only stale attempt rows');
select ok(exists (select 1 from waldo.open_signup_days), 'and never the join count');

-- A mistyped cap cannot open the doors wide.
insert into waldo.open_signup_days (day, admitted) values (current_date - 10, 197);
select ok(not pg_temp.room(100000, 100000), 'caps above 200 are read as 200');

-- Privileges.
select ok(not has_table_privilege('anon', 'waldo.open_signup_days', 'select'), 'anon cannot read the join count');
select ok(not has_table_privilege('authenticated', 'waldo.open_signup_attempts', 'select'), 'a user session cannot read attempts');
select ok(not has_function_privilege('anon', 'waldo.open_owner_held(uuid)', 'execute'), 'the held check is not callable through the API');
select ok(not has_function_privilege('anon', 'waldo.open_signup_fits(integer, integer)', 'execute'), 'nor the cap check');
select ok(not has_function_privilege('authenticated', 'waldo.signup_owner_open(uuid, text, text, text, text, integer, integer, bigint, text)', 'execute'), 'a user session cannot join openly');

select * from finish();
rollback;
