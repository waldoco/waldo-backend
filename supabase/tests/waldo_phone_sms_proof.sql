begin;
create extension if not exists pgtap with schema extensions;
select plan(153);
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
-- The router signs in the country codes it may text and the server's daily cap; the tests default to India and a cap
-- high enough to stay out of the way.
create function pg_temp.send_as(o text, op text, countries jsonb, daily_limit jsonb) returns text language sql as $$
  select pg_temp.step('reserve_send', jsonb_build_object('do_name', o, 'service', pg_temp.svc(), 'operation', op,
    'countries', countries, 'daily_limit', daily_limit))->>'kind' $$;
create function pg_temp.send(o text, op text) returns text language sql as $$
  select pg_temp.send_as(o, op, '["+91"]', '200') $$;
create function pg_temp.nkey(n text) returns text language sql as $$
  select encode(extensions.hmac('phonecap.' || n, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'utc')::date $$;
create function pg_temp.owner_sends(o text, d date default null) returns int language sql as $$
  select coalesce(sum(sends), 0)::int from waldo.phone_sms_daily
    where owner_id = (select id from waldo.owners where do_name = o) and day = coalesce(d, pg_temp.today()) $$;
create function pg_temp.number_sends(n text) returns int language sql as $$
  select coalesce(sum(sends), 0)::int from waldo.phone_sms_daily where number_key = pg_temp.nkey(n) and day = pg_temp.today() $$;
create function pg_temp.global(d date default null) returns int language sql as $$
  select coalesce((select sends from waldo.phone_sms_sends where day = coalesce(d, pg_temp.today())), 0) $$;
create function pg_temp.locks(n text) returns int language sql as $$
  select count(*)::int from pg_locks where locktype = 'advisory' and objsubid = 1
    and ((classid::bigint << 32) | objid::bigint) = hashtextextended('waldophone.' || n, 0) $$;
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
select is(pg_temp.step('reserve_send', jsonb_build_object('do_name', 'sms-asha', 'service', 'VAnot', 'operation', pg_temp.op('a'), 'countries', '["+91"]'::jsonb, 'daily_limit', 200))->>'kind', 'denied', 'a malformed service is denied');

-- The state the console and the app read: the number on file and whether it is proven.
select is(pg_temp.state('sms-asha'), '{"phone":"+919800000001","verified":false,"challenge":null}'::jsonb, 'asha reads her unverified number and no challenge');
select is(pg_temp.state('sms-nobody'), null, 'an unknown owner reads nothing');

-- Nothing reaches Twilio for a number that is absent, already proven, or proven by another owner.
select is(pg_temp.send('sms-cai', pg_temp.op('c')), 'no_number', 'an owner with no number on file is sent nothing');
select is(pg_temp.send('sms-dev', pg_temp.op('d')), 'verified', 'an owner whose number is verified is sent nothing');
select is(pg_temp.challenge('sms-cai'), null, 'and no challenge is recorded');
insert into waldo.owners (do_name, email, phone) values ('sms-old', 'old@test.invalid', '98000 00001');
select is(pg_temp.state('sms-old'), '{"phone":null,"verified":false,"challenge":null}'::jsonb, 'a number on file that is not E.164 reads as none');
select is(pg_temp.send('sms-old', pg_temp.op('c')), 'no_number', 'and is sent nothing');

-- Asha asks for a code: the send is reserved before Twilio is called, then finished with the verification it returned.
select is(pg_temp.step('reserve_send', jsonb_build_object('do_name', 'sms-asha', 'service', pg_temp.svc(), 'operation', pg_temp.op('1'), 'countries', '["+91"]'::jsonb, 'daily_limit', 200)),
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
select is((select array_agg(number_key || ':' || sends) from waldo.phone_sms_daily d join waldo.owners o on o.id = d.owner_id where o.do_name = 'sms-asha'),
  array[pg_temp.nkey('+919800000001') || ':3'], 'her three sends are counted against her, the number keyed by a hash under the server''s key');

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
select is(((pg_temp.state('sms-eve')->'challenge') - 'expires_at'::text) - 'retry_at'::text, jsonb_build_object('state', 'expired', 'checks_left', 0),
  'and a code sent to her old number is not shown against the new one: nothing to check, only the wait it leaves');

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
-- Gus had five codes texted today to the number fay has now typed.
insert into waldo.owners (do_name, email, phone) values ('sms-fay', 'fay@test.invalid', '+919800000007'), ('sms-gus', 'gus@test.invalid', '+919800000008');
insert into waldo.phone_sms_daily (owner_id, number_key, day, sends) select id, pg_temp.nkey('+919800000007'), pg_temp.today(), 5 from waldo.owners where do_name = 'sms-gus';
select is(pg_temp.send('sms-fay', pg_temp.op('a')), 'throttled', 'a number already sent five codes today, for any owner, is sent no more');
select is(pg_temp.send('sms-gus', pg_temp.op('a')), 'throttled', 'an owner who asked five times today is sent no more');

-- The server's daily cap bounds every send, and a send refused at the cap charges and records nothing else.
insert into waldo.owners (do_name, email, phone) values ('sms-oak', 'oak@test.invalid', '+919800000014'), ('sms-pia', 'pia@test.invalid', '+919800000015');
select is(pg_temp.send_as('sms-oak', pg_temp.op('a'), '["+91"]', to_jsonb(pg_temp.global() + 1)), 'reserved', 'a send under the server''s daily cap is reserved');
select is(pg_temp.sent('sms-oak', pg_temp.op('a'), 'pending', pg_temp.sid('4')), 'pending', 'and goes out');
select is(pg_temp.send_as('sms-pia', pg_temp.op('a'), '["+91"]', to_jsonb(pg_temp.global())), 'throttled', 'a send at the cap is throttled');
select is(pg_temp.owner_sends('sms-pia') + (select count(*)::int from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-pia'), 0,
  'and charges and records nothing for that owner');
create temp table held_global as select pg_temp.global() as sends;
update waldo.phone_sms_sends set sends = 200 where day = pg_temp.today();
select is(pg_temp.send_as('sms-pia', pg_temp.op('b'), '["+91"]', '5000'), 'throttled', 'a cap the router signs above 200 is held to 200');
select is(pg_temp.send_as('sms-pia', pg_temp.op('b'), '["+91"]', '0'), 'denied', 'a cap below one is denied');
select is(pg_temp.send_as('sms-pia', pg_temp.op('b'), '["+91"]', 'null'), 'denied', 'and so is a reservation without one');
update waldo.phone_sms_sends set sends = (select sends from held_global) where day = pg_temp.today();
select is((select array_agg(column_name::text order by column_name) from information_schema.columns where table_schema = 'waldo' and table_name = 'phone_sms_sends'),
  array['day', 'sends'], 'the server''s count holds no owner and no number');

-- Only numbers under a country code the router lists are texted, and an empty list texts none.
insert into waldo.owners (do_name, email, phone) values ('sms-uma', 'uma@test.invalid', '+447700900001');
select is(pg_temp.send('sms-uma', pg_temp.op('a')), 'unsupported', 'a number outside the listed country codes is sent nothing');
select is(pg_temp.send_as('sms-uma', pg_temp.op('a'), '[]', '200'), 'unsupported', 'an empty list texts no country');
select is(pg_temp.send_as('sms-uma', pg_temp.op('a'), 'null', '200'), 'denied', 'a reservation without the list is denied');
select is(pg_temp.send_as('sms-uma', pg_temp.op('a'), '["44"]', '200'), 'denied', 'and so is an entry that is not a country code');
select is(pg_temp.owner_sends('sms-uma'), 0, 'none of these is charged');
select is(pg_temp.send_as('sms-uma', pg_temp.op('a'), '["+91", "+44"]', '200'), 'reserved', 'a number under a listed code is reserved');
select is(pg_temp.owner_sends('sms-uma'), 1, 'and charged once');

-- Twilio refusing the request means no text went out: nothing is charged and nothing is held, but sends stay paced.
insert into waldo.owners (do_name, email, phone) values ('sms-quin', 'quin@test.invalid', '+919800000016'), ('sms-ray', 'ray@test.invalid', '+919800000016');
create temp table before_refusal as select pg_temp.global() as sends;
select is(pg_temp.send('sms-quin', pg_temp.op('a')), 'reserved', 'quin''s send is reserved');
select is(pg_temp.sent('sms-quin', pg_temp.op('a'), 'refused', ''), 'refused', 'and Twilio refuses it');
select is(pg_temp.owner_sends('sms-quin') + pg_temp.number_sends('+919800000016'), 0, 'neither quin nor the number is charged');
select is(pg_temp.global(), (select sends from before_refusal), 'nor the server''s cap');
select is(pg_temp.state('sms-quin')->'challenge'->>'state', 'expired', 'no code is waiting');
select is((pg_temp.state('sms-quin')->'challenge'->>'retry_at')::bigint, (select extract(epoch from next_send)::bigint from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-quin'),
  'and the next send waits the usual 60 seconds');
select is(pg_temp.send('sms-quin', pg_temp.op('b')), 'throttled', 'so an immediate retry is throttled');
select is(pg_temp.send('sms-ray', pg_temp.op('a')), 'reserved', 'and the number is not held from another owner');
select is(pg_temp.sent('sms-ray', pg_temp.op('a'), 'pending', pg_temp.sid('5')), 'pending', 'whose code goes out');

-- A refused resend leaves the code already sent working, and charges only the send that went out.
insert into waldo.owners (do_name, email, phone) values ('sms-sol', 'sol@test.invalid', '+919800000017');
select is(pg_temp.send('sms-sol', pg_temp.op('a')), 'reserved', 'sol''s send is reserved');
select is(pg_temp.sent('sms-sol', pg_temp.op('a'), 'pending', pg_temp.sid('3')), 'pending', 'and goes out');
select pg_temp.age('sms-sol', interval '61 seconds');
select is(pg_temp.send('sms-sol', pg_temp.op('b')), 'reserved', 'her resend is reserved');
select is(pg_temp.sent('sms-sol', pg_temp.op('b'), 'refused', ''), 'refused', 'and Twilio refuses it');
select is(pg_temp.state('sms-sol')->'challenge'->>'state', 'pending', 'the first code still works');
select is(pg_temp.owner_sends('sms-sol'), 1, 'and only the first send is charged');
select is((select sends from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-sol'), 1,
  'or counted against the code''s three sends');
select is((pg_temp.state('sms-sol')->'challenge'->>'retry_at')::bigint, (select extract(epoch from next_send)::bigint from waldo.phone_sms_challenges c join waldo.owners o on o.id = c.owner_id where o.do_name = 'sms-sol'),
  'with the next resend paced from the refused one');

-- A check Twilio refused checked nothing: the try is given back.
select is(pg_temp.check('sms-sol', pg_temp.op('c'))->'reference'->>'sid', pg_temp.sid('3'), 'sol''s check asks about the first code');
select is(pg_temp.checked('sms-sol', pg_temp.op('c'), 'refused', ''), 'refused', 'and Twilio refuses it');
select is(pg_temp.state('sms-sol')->'challenge', jsonb_build_object('state', 'pending', 'expires_at', pg_temp.state('sms-sol')->'challenge'->'expires_at',
  'retry_at', pg_temp.state('sms-sol')->'challenge'->'retry_at', 'checks_left', 5), 'the code still waits with all five checks');

-- Reserved before UTC midnight and refused after it: the refund goes to the day the send was charged.
insert into waldo.owners (do_name, email, phone) values ('sms-tao', 'tao@test.invalid', '+919800000018');
select is(pg_temp.send('sms-tao', pg_temp.op('a')), 'reserved', 'tao''s send is reserved');
update waldo.phone_sms_daily set day = day - 1 where owner_id = (select id from waldo.owners where do_name = 'sms-tao');
update waldo.phone_sms_challenges set send_day = send_day - 1 where owner_id = (select id from waldo.owners where do_name = 'sms-tao');
update waldo.phone_sms_sends set sends = sends - 1 where day = pg_temp.today();
insert into waldo.phone_sms_sends (day, sends) values (pg_temp.today() - 1, 1);
create temp table before_midnight as select pg_temp.global() as sends;
select is(pg_temp.sent('sms-tao', pg_temp.op('a'), 'refused', ''), 'refused', 'Twilio refuses it after midnight');
select is(pg_temp.owner_sends('sms-tao', pg_temp.today() - 1) || '/' || pg_temp.global(pg_temp.today() - 1), '0/0', 'yesterday''s charge is refunded');
select is(pg_temp.global(), (select sends from before_midnight), 'and today''s count is untouched');

-- A resend is charged on its own day: the first send was yesterday, the resend today, and a refusal refunds today.
insert into waldo.owners (do_name, email, phone) values ('sms-xia', 'xia@test.invalid', '+919800000022');
select is(pg_temp.send('sms-xia', pg_temp.op('a')), 'reserved', 'xia''s send is reserved');
select is(pg_temp.sent('sms-xia', pg_temp.op('a'), 'pending', pg_temp.sid('6')), 'pending', 'and goes out');
update waldo.phone_sms_challenges set send_day = send_day - 1 where owner_id = (select id from waldo.owners where do_name = 'sms-xia');
select pg_temp.age('sms-xia', interval '61 seconds');
create temp table before_resend as select pg_temp.global() as sends;
select is(pg_temp.send('sms-xia', pg_temp.op('b')), 'reserved', 'her resend is reserved');
select is(pg_temp.sent('sms-xia', pg_temp.op('b'), 'refused', ''), 'refused', 'and Twilio refuses it');
select is(pg_temp.owner_sends('sms-xia') || '/' || pg_temp.global(), '1/' || (select sends from before_resend), 'today''s charge for the resend is refunded');

-- Every path that texts or proves a number takes one lock on it, so two owners proving a number take turns. CI and the
-- local runner execute this file in one transaction on one connection, so a second session cannot wait on the lock
-- here; the test shows that both paths hold the same lock, and Postgres makes the second holder wait.
insert into waldo.owners (do_name, email, phone) values ('sms-vik', 'vik@test.invalid', '+919800000019'), ('sms-wen', 'wen@test.invalid', '+919800000021');
select is(pg_temp.locks('+919800000019'), 0, 'nothing holds a lock on a number nobody has touched');
select is(pg_temp.send('sms-vik', pg_temp.op('a')), 'reserved', 'vik''s send is reserved');
select is(pg_temp.locks('+919800000019'), 1, 'and holds the number''s lock until its transaction ends');
insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) select 'sms-wen-code', id, 'whatsapp', now() + interval '10 minutes' from waldo.owners where do_name = 'sms-wen';
select is(pg_temp.locks('+919800000021'), 0, 'wen''s number is not locked yet');
select is(waldo.redeem_link_code('sms-wen-code', 'whatsapp', '919800000021'), (select id from waldo.owners where do_name = 'sms-wen'), 'wen redeems a link code from her number');
select ok(pg_temp.verified('sms-wen'), 'which proves it');
select is(pg_temp.locks('+919800000021'), 1, 'under the same lock');

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

-- Deleting the account deletes every row that holds or keys the number: the challenge and the daily counts.
create temp table gone as select id from waldo.owners where do_name = 'sms-asha';
select is(waldo.delete_owner('sms-asha', pg_temp.at(), pg_temp.rsig('delown.sms-asha')), true, 'asha deletes her account');
select is((select count(*)::int from waldo.phone_sms_challenges where owner_id in (select id from gone) or phone = '+919800000001'), 0, 'her challenge is gone');
select is((select count(*)::int from waldo.phone_sms_daily where owner_id in (select id from gone) or number_key = pg_temp.nkey('+919800000001')), 0,
  'and so are her daily counts, by owner and by number');
select is((select count(*)::int from waldo.phone_sms_daily where number_key in (select encode(sha256(convert_to(n, 'UTF8')), 'hex')
    from (select phone from waldo.owners where phone is not null union select '+919800000001') numbers (n))), 0,
  'no count is keyed by a bare hash of a number, which anyone could reverse');

select * from finish();
rollback;
