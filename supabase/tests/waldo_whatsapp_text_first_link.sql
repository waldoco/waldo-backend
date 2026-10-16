begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.h(c text) returns text language sql as $$ select repeat(c, 64) $$;
create function pg_temp.open(subj text, tok text) returns text language sql as $$
  select waldo.open_presence_link_request('whatsapp', subj, tok, pg_temp.at(), pg_temp.rsig('linkreq.open.whatsapp.' || subj || '.' || tok)) $$;
create function pg_temp.view(o text, tok text) returns text language sql as $$
  select waldo.presence_link_request_subject(o, tok, pg_temp.at(), pg_temp.rsig('linkreq.view.' || o || '.' || tok)) $$;
create function pg_temp.consume(o text, tok text, subj text) returns text language sql as $$
  select waldo.consume_presence_link_request(o, tok, subj, pg_temp.at(), pg_temp.rsig('linkreq.consume.' || o || '.' || tok || '.' || subj)) $$;
create function pg_temp.active(o text) returns text language sql as $$
  select p.subject from waldo.presences p join waldo.owners w on w.id = p.owner_id where w.do_name = o and p.provider = 'whatsapp' and p.state = 'active' $$;

insert into waldo.owners (do_name, email, phone) values
  ('do-alice', 'alice@test.invalid', '+15550001111'),
  ('do-mallory', 'mallory@test.invalid', '+15550002222'),
  ('do-twin-a', 'twin-a@test.invalid', '+15550003333'),
  ('do-twin-b', 'twin-b@test.invalid', '+15550003333');

-- Who gets a link at all.
select is(pg_temp.open('15550009999', pg_temp.h('0')), 'waitlist', 'a sender whose number no owner has on file gets the waitlist');
select is(pg_temp.open('15550003333', pg_temp.h('0')), 'waitlist', 'a number on file for two owners is ambiguous and gets the waitlist');
select is(pg_temp.open('not-digits', pg_temp.h('0')), 'waitlist', 'a malformed sender is refused');
select is((select count(*)::int from waldo.presence_link_requests), 0, 'no request is stored for any of them');
select is(pg_temp.open('15550001111', pg_temp.h('a')), 'opened', 'the one owner with this number on file gets a request');
select is((select owner_id from waldo.presence_link_requests where token_hash = pg_temp.h('a')), (select id from waldo.owners where do_name = 'do-alice'), 'the request names that owner');
select throws_ok($$ select waldo.open_presence_link_request('whatsapp', '15550001111', repeat('b', 64), extract(epoch from now())::bigint, repeat('0', 64)) $$, '42501', null, 'an unsigned open is refused');

-- Bound to the owner: a forwarded link is useless to anyone else who signs in.
select is(pg_temp.view('do-alice', pg_temp.h('a')), '15550001111', 'the named owner sees the full number to confirm');
select is(pg_temp.view('do-mallory', pg_temp.h('a')), null, 'another signed-in owner cannot even see the request');
select is(pg_temp.consume('do-mallory', pg_temp.h('a'), '15550001111'), 'rejected', 'another signed-in owner cannot consume it');
select is(pg_temp.active('do-mallory'), null, 'and gains no presence');

-- Bound to the exact sender.
select is(pg_temp.consume('do-alice', pg_temp.h('a'), '15550002222'), 'rejected', 'a confirm naming a different number is refused');
select is(pg_temp.active('do-alice'), null, 'and links nothing');

-- The bind, and the phone verification it carries.
select is((select phone_verified_at from waldo.owners where do_name = 'do-alice'), null, 'the phone starts unverified');
select is(pg_temp.consume('do-alice', pg_temp.h('a'), '15550001111'), 'linked', 'the named owner confirming the shown number links it');
select is(pg_temp.active('do-alice'), '15550001111', 'the presence is active for that owner');
select isnt((select phone_verified_at from waldo.owners where do_name = 'do-alice'), null, 'the confirm verified the phone, so the presence trigger admits it');

-- Single use.
select is(pg_temp.consume('do-alice', pg_temp.h('a'), '15550001111'), 'rejected', 'the same link cannot be used twice');
select is(pg_temp.view('do-alice', pg_temp.h('a')), null, 'a used link no longer shows a number');
select is(pg_temp.open('15550001111', pg_temp.h('c')), 'linked', 'a linked sender is not offered another link');

-- Short-lived.
update waldo.presences set state = 'unlinked', unlinked_at = now() where subject = '15550001111';
select is(pg_temp.open('15550001111', pg_temp.h('d')), 'opened', 'an unlinked sender can ask again');
update waldo.presence_link_requests set expires_at = now() - interval '1 second' where token_hash = pg_temp.h('d');
select is(pg_temp.view('do-alice', pg_temp.h('d')), null, 'an expired link shows nothing');
select is(pg_temp.consume('do-alice', pg_temp.h('d'), '15550001111'), 'rejected', 'an expired link cannot be used');

-- A newer link replaces an older unused one.
select is(pg_temp.open('15550001111', pg_temp.h('e')), 'opened', 'first of two links');
select is(pg_temp.open('15550001111', pg_temp.h('f')), 'opened', 'second of two links');
select is(pg_temp.consume('do-alice', pg_temp.h('e'), '15550001111'), 'rejected', 'the replaced link is dead');

-- The number on file must still match at confirm time.
update waldo.owners set phone = '+15550007777' where do_name = 'do-alice';
select is(pg_temp.consume('do-alice', pg_temp.h('f'), '15550001111'), 'rejected', 'a confirm after the owner changed their number is refused');
select is(pg_temp.consume('do-alice', pg_temp.h('f'), '15550001111'), 'rejected', 'and that link was spent by the attempt');
update waldo.owners set phone = '+15550001111' where do_name = 'do-alice';

-- Claimed meanwhile by another owner: nothing changes.
select is(pg_temp.open('15550001111', pg_temp.h('g')), 'opened', 'a fresh link');
update waldo.owners set phone_verified_at = now() where do_name = 'do-mallory';
insert into waldo.presences (owner_id, provider, subject) select id, 'whatsapp', '15550001111' from waldo.owners where do_name = 'do-mallory';
select is(pg_temp.consume('do-alice', pg_temp.h('g'), '15550001111'), 'claimed', 'a sender that became active elsewhere is reported claimed');
select is(pg_temp.active('do-mallory'), '15550001111', 'the other owner keeps it');
select is(pg_temp.active('do-alice'), null, 'and this owner gains nothing');

-- Relinking replaces the owner's earlier number.
update waldo.presences set state = 'unlinked', unlinked_at = now() where subject = '15550001111';
select is(pg_temp.open('15550001111', pg_temp.h('i')), 'opened', 'a link for the first number');
select is(pg_temp.consume('do-alice', pg_temp.h('i'), '15550001111'), 'linked', 'linked once');
update waldo.owners set phone = '+15550008888' where do_name = 'do-alice';
select is(pg_temp.open('15550008888', pg_temp.h('j')), 'opened', 'a link for the new number');
select is(pg_temp.consume('do-alice', pg_temp.h('j'), '15550008888'), 'linked', 'the new number links');
select is((select count(*)::int from waldo.presences p join waldo.owners w on w.id = p.owner_id where w.do_name = 'do-alice' and p.provider = 'whatsapp' and p.state = 'active'), 1, 'only one WhatsApp presence stays active');
select is(pg_temp.active('do-alice'), '15550008888', 'and it is the new number');

-- Table access.
select is((select has_table_privilege('anon', 'waldo.presence_link_requests', 'select')), false, 'anon cannot read link requests directly');

select * from finish();
rollback;
