begin;
create extension if not exists pgtap with schema extensions;
select plan(97);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.svc() returns text language sql as $$ select 'VA' || repeat('a', 32) $$;
create function pg_temp.sid(c text) returns text language sql as $$ select 'VE' || repeat(c, 32) $$;
create function pg_temp.op(c text) returns text language sql as $$ select repeat(c, 8) || '-' || repeat(c, 4) || '-4' || repeat(c, 3) || '-8' || repeat(c, 3) || '-' || repeat(c, 12) $$;
create function pg_temp.step(action text, payload jsonb) returns jsonb language sql as $$
  select waldo.phone_sms_transition(action, payload::text, pg_temp.at(), pg_temp.rsig('phonesms.' || action || '.' || payload::text)) $$;
create function pg_temp.send(o text, op text) returns text language sql as $$
  select pg_temp.step('reserve_send', jsonb_build_object('do_name', o, 'service', pg_temp.svc(), 'operation', op))->>'kind' $$;
create function pg_temp.sent(o text, op text, outcome text, sid text) returns text language sql as $$
  select pg_temp.step('finish_send', jsonb_build_object('do_name', o, 'service', pg_temp.svc(), 'operation', op, 'outcome', outcome, 'sid', sid))->>'kind' $$;
create function pg_temp.check(o text, op text) returns jsonb language sql as $$
  select pg_temp.step('reserve_check', jsonb_build_object('do_name', o, 'service', pg_temp.svc(), 'operation', op)) $$;
create function pg_temp.checked(o text, op text, outcome text, sid text) returns text language sql as $$
  select pg_temp.step('finish_check', jsonb_build_object('do_name', o, 'service', pg_temp.svc(), 'operation', op, 'outcome', outcome, 'sid', sid))->>'kind' $$;
create function pg_temp.state(o text) returns jsonb language sql as $$
  select waldo.owner_phone_state(o, pg_temp.at(), pg_temp.rsig('phonestate.' || o)) $$;
create function pg_temp.verified(o text) returns boolean language sql as $$
  select phone_verified_at is not null from waldo.owners where do_name = o $$;
create function pg_temp.challenge(o text) returns text language sql as $$
  select c.state from waldo.phone_sms_challenges c join waldo.owners w on w.id = c.owner_id where w.do_name = o $$;
create function pg_temp.age(o text, by interval) returns void language sql as $$
  update waldo.phone_sms_challenges set next_send = next_send - by, expires_at = expires_at - by,
    recipient_hold_until = recipient_hold_until - by where owner_id = (select id from waldo.owners where do_name = o) $$;

insert into waldo.owners (do_name, email, phone) values
  ('sms-asha', 'asha@test.invalid', '+919800000001'),
  ('sms-ben', 'ben@test.invalid', '+919800000001'),
  ('sms-cai', 'cai@test.invalid', null),
  ('sms-dev', 'dev@test.invalid', '+919800000004'),
  ('sms-eve', 'eve@test.invalid', '+919800000005');
update waldo.owners set phone_verified_at = now() where do_name = 'sms-dev';

-- Only the router may move the ledger or read the state, and every field it signs is bound.
select throws_ok($$ select waldo.phone_sms_transition('reserve_send', '{"do_name":"sms-asha"}', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged transition is refused');
select throws_ok($$ select waldo.owner_phone_state('sms-asha', pg_temp.at(), pg_temp.rsig('phonestate.sms-ben')) $$, '42501', 'unsigned router call', 'a state read signed for another owner is refused');
select is(pg_temp.step('drop_table', jsonb_build_object('do_name', 'sms-asha'))->>'kind', 'denied', 'an unknown action is denied');
select is(pg_temp.step('reserve_send', jsonb_build_object('do_name', 'sms-asha', 'service', 'VAnot', 'operation', pg_temp.op('a')))->>'kind', 'denied', 'a malformed service is denied');

-- The state the console and the app read: the number on file and whether it is proven.
select is(pg_temp.state('sms-asha'), '{"phone":"+919800000001","verified":false,"challenge":null}'::jsonb, 'asha reads her unverified number and no challenge');
select is(pg_temp.state('sms-nobody'), null, 'an unknown owner reads nothing');

-- Nothing reaches Twilio for a number that is absent, already proven, or proven by another owner.
select is(pg_temp.send('sms-cai', pg_temp.op('c')), 'no_number', 'an owner with no number on file is sent nothing');
select is(pg_temp.send('sms-dev', pg_temp.op('d')), 'verified', 'an owner whose number is verified is sent nothing');
select is(pg_temp.challenge('sms-cai'), null, 'and no challenge is recorded');

-- Asha asks for a code: the send is reserved before Twilio is called, then finished with the verification it returned.
select is(pg_temp.step('reserve_send', jsonb_build_object('do_name', 'sms-asha', 'service', pg_temp.svc(), 'operation', pg_temp.op('1'))),
  '{"kind":"reserved","phone":"+919800000001"}'::jsonb, 'asha''s first send is reserved for the number on file, which the router texts');
select is(pg_temp.challenge('sms-asha'), 'sending', 'the challenge is in flight before the provider answers');
select is(pg_temp.send('sms-asha', pg_temp.op('2')), 'busy', 'a second send while the first is in flight is refused');
select is(pg_temp.sent('sms-asha', pg_temp.op('9'), 'pending', pg_temp.sid('1')), 'denied', 'a finish with another operation is denied');
select is(pg_temp.sent('sms-asha', pg_temp.op('1'), 'pending', pg_temp.sid('1')), 'pending', 'the send finishes pending');
select is(pg_temp.state('sms-asha')->'challenge'->>'state', 'pending', 'the state shows the code is out');
select is((pg_temp.state('sms-asha')->'challenge'->>'retry_at')::bigint, (select extract(epoch from next_send)::bigint from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-asha'), 'and when she may ask again');
select is(pg_temp.state('sms-asha')->'challenge'->>'checks_left', '5', 'with five checks left');

-- The same number on another owner's account is held while asha's code is live: ben's typed copy is sent nothing.
select is(pg_temp.send('sms-ben', pg_temp.op('b')), 'held', 'another owner cannot send to a number held by a live challenge');

-- Resending waits 60 seconds, and a challenge sends at most three times.
select is(pg_temp.send('sms-asha', pg_temp.op('3')), 'throttled', 'a resend inside 60 seconds is throttled');
select pg_temp.age('sms-asha', interval '61 seconds');
select is(pg_temp.state('sms-asha')->'challenge'->'retry_at', 'null'::jsonb, 'after 60 seconds she may ask again now');
select is(pg_temp.send('sms-asha', pg_temp.op('3')), 'reserved', 'a resend after 60 seconds is reserved');
select is(pg_temp.sent('sms-asha', pg_temp.op('3'), 'pending', pg_temp.sid('1')), 'pending', 'it reuses the same verification');
select pg_temp.age('sms-asha', interval '61 seconds');
select is(pg_temp.send('sms-asha', pg_temp.op('4')), 'reserved', 'the third send is reserved');
select is(pg_temp.sent('sms-asha', pg_temp.op('4'), 'pending', pg_temp.sid('1')), 'pending', 'and finishes');
select pg_temp.age('sms-asha', interval '61 seconds');
select is(pg_temp.send('sms-asha', pg_temp.op('5')), 'throttled', 'a fourth send in one challenge is throttled');
select is((pg_temp.state('sms-asha')->'challenge'->>'retry_at')::bigint, (pg_temp.state('sms-asha')->'challenge'->>'expires_at')::bigint, 'and the state says the next code waits for this one to expire');

-- A wrong code keeps the challenge open; checks are bounded and the code itself is never stored.
select is(pg_temp.check('sms-asha', pg_temp.op('6')), jsonb_build_object('kind', 'reserved', 'reference', jsonb_build_object('service', pg_temp.svc(), 'sid', pg_temp.sid('1'), 'phone', '+919800000001')), 'a check is reserved with the verification it checks');
select is(pg_temp.check('sms-asha', pg_temp.op('5'))->>'kind', 'busy', 'a second check while one is in flight is refused');
select is(pg_temp.checked('sms-asha', pg_temp.op('6'), 'pending', pg_temp.sid('1')), 'pending', 'a wrong code leaves it pending');
select ok(not pg_temp.verified('sms-asha'), 'and verifies nothing');
select is((select count(*)::int from information_schema.columns where table_schema = 'waldo' and table_name = 'phone_sms_challenges' and column_name ilike '%code%'), 0, 'the ledger has no column for the code');
select is((select count(*)::int from waldo.phone_sms_daily where key like '+%'), 0, 'and the daily counters keep no number');

-- The right code proves the number on file, in the same transaction.
select is(pg_temp.check('sms-asha', pg_temp.op('7'))->>'kind', 'reserved', 'another check is reserved');
select is(pg_temp.checked('sms-asha', pg_temp.op('7'), 'approved', pg_temp.sid('2')), 'denied', 'an approval for another verification is denied');
select ok(not pg_temp.verified('sms-asha'), 'and verifies nothing');
select is(pg_temp.check('sms-asha', pg_temp.op('8'))->>'kind', 'reserved', 'a check is reserved again');
select is(pg_temp.checked('sms-asha', pg_temp.op('8'), 'approved', pg_temp.sid('1')), 'approved', 'the right code is approved');
select ok(pg_temp.verified('sms-asha'), 'asha''s number is verified');
select is(pg_temp.state('sms-asha')->>'verified', 'true', 'and reads verified');
select is((select count(*)::int from waldo.presences p join waldo.owners o on o.id = p.owner_id where o.do_name = 'sms-asha'), 0, 'proving the number links no channel');

-- Ben typed the same number: now that asha proved it, nothing is ever sent to it for him.
select pg_temp.age('sms-asha', interval '1 hour');
select is(pg_temp.send('sms-ben', pg_temp.op('b')), 'number_taken', 'a number another owner verified is sent nothing');
select ok(not pg_temp.verified('sms-ben'), 'and ben stays unverified');

-- Expiry: a check after the code's ten minutes is refused, and an approval that arrives after expiry proves nothing.
select is(pg_temp.send('sms-eve', pg_temp.op('e')), 'reserved', 'eve''s send is reserved');
select is(pg_temp.sent('sms-eve', pg_temp.op('e'), 'pending', pg_temp.sid('e')), 'pending', 'and goes out');
select is(pg_temp.check('sms-eve', pg_temp.op('f'))->>'kind', 'reserved', 'eve''s check is reserved');
select pg_temp.age('sms-eve', interval '11 minutes');
select is(pg_temp.checked('sms-eve', pg_temp.op('f'), 'approved', pg_temp.sid('e')), 'expired', 'an approval finishing after expiry proves nothing');
select ok(not pg_temp.verified('sms-eve'), 'eve stays unverified');
select is(pg_temp.check('sms-eve', pg_temp.op('0'))->>'kind', 'expired', 'a check after expiry is refused');

-- A new number on file between reserve and finish: the approval proves nothing.
select is(pg_temp.send('sms-eve', pg_temp.op('a')), 'reserved', 'a fresh challenge starts after expiry');
select is(pg_temp.sent('sms-eve', pg_temp.op('a'), 'pending', pg_temp.sid('f')), 'pending', 'and goes out');
select is(pg_temp.check('sms-eve', pg_temp.op('b'))->>'kind', 'reserved', 'a check is reserved');
update waldo.owners set phone = '+919800000055' where do_name = 'sms-eve';
select is(pg_temp.checked('sms-eve', pg_temp.op('b'), 'approved', pg_temp.sid('f')), 'denied', 'an approval for the old number proves nothing');
select ok(not pg_temp.verified('sms-eve'), 'eve stays unverified');
select is(pg_temp.state('sms-eve')->'challenge', 'null'::jsonb, 'and a code sent to her old number is not shown against the new one');

-- A code nobody entered within ten minutes cannot be checked.
insert into waldo.owners (do_name, email, phone) values ('sms-lee', 'lee@test.invalid', '+919800000011');
select is(pg_temp.send('sms-lee', pg_temp.op('a')), 'reserved', 'lee''s send is reserved');
select is(pg_temp.sent('sms-lee', pg_temp.op('a'), 'pending', pg_temp.sid('b')), 'pending', 'and goes out');
select pg_temp.age('sms-lee', interval '11 minutes');
select is(pg_temp.state('sms-lee')->'challenge'->>'state', 'expired', 'the state reads expired once ten minutes pass');
select is(pg_temp.check('sms-lee', pg_temp.op('b'))->>'kind', 'expired', 'and a check is refused');

-- An uncertain send holds the number for an hour and is never retried by itself.
update waldo.owners set phone = '+919800000006', phone_verified_at = null where do_name = 'sms-dev';
select is(pg_temp.send('sms-dev', pg_temp.op('d')), 'reserved', 'dev''s send is reserved');
select is(pg_temp.sent('sms-dev', pg_temp.op('d'), 'unknown', ''), 'unknown', 'a send with no clear answer finishes unknown');
select pg_temp.age('sms-dev', interval '61 seconds');
select is(pg_temp.send('sms-dev', pg_temp.op('e')), 'throttled', 'and holds further sends');
select ok((pg_temp.state('sms-dev')->'challenge'->>'retry_at')::bigint > pg_temp.at() + 3000, 'and the state says the owner may ask again in about an hour');
select pg_temp.age('sms-dev', interval '1 hour');
select is(pg_temp.send('sms-dev', pg_temp.op('e')), 'reserved', 'an hour later the owner may ask again');
select is(pg_temp.sent('sms-dev', pg_temp.op('e'), 'pending', pg_temp.sid('d')), 'pending', 'and the code goes out');

-- A suspended owner is sent nothing and proves nothing.
select is(pg_temp.check('sms-dev', pg_temp.op('f'))->>'kind', 'reserved', 'dev''s check is reserved');
update waldo.owners set state = 'suspended' where do_name = 'sms-dev';
select is(pg_temp.checked('sms-dev', pg_temp.op('f'), 'approved', pg_temp.sid('d')), 'denied', 'an approval for a suspended owner proves nothing');
select is(pg_temp.send('sms-dev', pg_temp.op('g')), 'denied', 'and a suspended owner is sent nothing');

-- Two owners typed one number: while ivy waits for her code, jon proves it by link code, so her approval proves nothing.
insert into waldo.owners (do_name, email, phone) values ('sms-ivy', 'ivy@test.invalid', '+919800000009'), ('sms-jon', 'jon@test.invalid', '+919800000009');
select is(pg_temp.send('sms-ivy', pg_temp.op('a')), 'reserved', 'ivy''s send is reserved');
select is(pg_temp.sent('sms-ivy', pg_temp.op('a'), 'pending', pg_temp.sid('9')), 'pending', 'and goes out');
select is(pg_temp.check('sms-ivy', pg_temp.op('b'))->>'kind', 'reserved', 'ivy''s check is reserved');
select ok(waldo.verify_owner_phone((select id from waldo.owners where do_name = 'sms-jon'), '+919800000009'), 'jon proves the number first');
select is(pg_temp.checked('sms-ivy', pg_temp.op('b'), 'approved', pg_temp.sid('9')), 'number_taken', 'ivy''s approval for a number jon proved is refused');
select ok(not pg_temp.verified('sms-ivy'), 'ivy stays unverified');
select is(pg_temp.state('sms-ivy')->'challenge'->>'state', 'expired', 'and her challenge is closed');

-- Five wrong codes close the door on that code: the sixth check is refused before Twilio is asked.
insert into waldo.owners (do_name, email, phone) values ('sms-kim', 'kim@test.invalid', '+919800000010');
select is(pg_temp.send('sms-kim', pg_temp.op('a')), 'reserved', 'kim''s send is reserved');
select is(pg_temp.sent('sms-kim', pg_temp.op('a'), 'pending', pg_temp.sid('a')), 'pending', 'and goes out');
select is(pg_temp.check('sms-kim', pg_temp.op(n::text))->>'kind' || pg_temp.checked('sms-kim', pg_temp.op(n::text), 'pending', pg_temp.sid('a')),
  'reservedpending', 'wrong code ' || n || ' is checked') from generate_series(1, 5) n;
select is(pg_temp.check('sms-kim', pg_temp.op('6'))->>'kind', 'throttled', 'a sixth check is refused');
select is(pg_temp.state('sms-kim')->'challenge'->>'checks_left', '0', 'and the state says no checks are left');

-- A resend that comes back as a new verification is checked against that one, within the first send's ten minutes.
insert into waldo.owners (do_name, email, phone) values ('sms-nia', 'nia@test.invalid', '+919800000013');
select is(pg_temp.send('sms-nia', pg_temp.op('a')), 'reserved', 'nia''s send is reserved');
select is(pg_temp.sent('sms-nia', pg_temp.op('a'), 'pending', pg_temp.sid('a')), 'pending', 'and goes out');
select pg_temp.age('sms-nia', interval '61 seconds');
select is(pg_temp.send('sms-nia', pg_temp.op('b')), 'reserved', 'her resend is reserved');
select is(pg_temp.sent('sms-nia', pg_temp.op('b'), 'pending', pg_temp.sid('c')), 'pending', 'and comes back as a new verification');
select is(pg_temp.check('sms-nia', pg_temp.op('c'))->'reference'->>'sid', pg_temp.sid('c'), 'which the next check asks about');
select is((select expires_at > now() + interval '8 minutes' and expires_at < now() + interval '9 minutes' from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-nia'), true, 'with the ten minutes still counted from the first send');

-- Daily caps per owner and per number bound what a typed number can receive, across every owner.
insert into waldo.owners (do_name, email, phone) values ('sms-fay', 'fay@test.invalid', '+919800000007');
insert into waldo.phone_sms_daily (scope, key, day, sends) values ('number', encode(sha256(convert_to('+919800000007', 'UTF8')), 'hex'), (now() at time zone 'utc')::date, 5);
select is(pg_temp.send('sms-fay', pg_temp.op('a')), 'throttled', 'a number already sent five codes today is sent no more');
insert into waldo.owners (do_name, email, phone) values ('sms-gus', 'gus@test.invalid', '+919800000008');
insert into waldo.phone_sms_daily (scope, key, day, sends) select 'owner', id::text, (now() at time zone 'utc')::date, 5 from waldo.owners where do_name = 'sms-gus';
select is(pg_temp.send('sms-gus', pg_temp.op('a')), 'throttled', 'an owner who asked five times today is sent no more');

-- The link-code path shares the same rule.
insert into waldo.owners (do_name, email, phone) values ('sms-hal', 'hal@test.invalid', '+919800000001');
select is(waldo.verify_owner_phone((select id from waldo.owners where do_name = 'sms-hal'), '+919800000001'), false, 'the shared rule refuses a number another owner verified');
select is(waldo.verify_owner_phone((select id from waldo.owners where do_name = 'sms-eve'), '+919800000055'), true, 'and proves an owner''s own unverified number');
insert into waldo.owners (do_name, email, phone, state) values ('sms-mo', 'mo@test.invalid', '+919800000012', 'suspended');
select is(waldo.verify_owner_phone((select id from waldo.owners where do_name = 'sms-mo'), '+919800000012'), false, 'and proves nothing for a suspended owner');
select ok(not pg_temp.verified('sms-mo'), 'whose number stays unverified');
set local role anon;
select throws_ok($$ select waldo.verify_owner_phone(gen_random_uuid(), '+919800000001') $$, '42501', null, 'the shared rule is not callable from outside');
reset role;

-- Deleting the owner deletes the challenge, the only row here that holds the number.
delete from waldo.owners where do_name = 'sms-asha';
select is((select count(*)::int from waldo.phone_sms_challenges where phone = '+919800000001' and owner_id not in (select id from waldo.owners)), 0, 'deleting an owner deletes their challenge');

select * from finish();
rollback;
