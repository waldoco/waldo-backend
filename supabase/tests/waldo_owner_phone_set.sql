begin;
create extension if not exists pgtap with schema extensions;
select plan(45);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.rsig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.raw(payload text) returns text language sql as $$
  select waldo.owner_phone_set(payload, pg_temp.at(), pg_temp.rsig('phoneset.' || payload))->>'kind' $$;
create function pg_temp.set_as(o text, n text, countries jsonb) returns text language sql as $$
  select pg_temp.raw(jsonb_build_object('do_name', o, 'phone', n, 'countries', countries)::text) $$;
create function pg_temp.set(o text, n text) returns text language sql as $$ select pg_temp.set_as(o, n, '["+91"]') $$;
create function pg_temp.phone(o text) returns text language sql as $$ select phone from waldo.owners where do_name = o $$;
create function pg_temp.verified(o text) returns boolean language sql as $$
  select phone_verified_at is not null from waldo.owners where do_name = o $$;
create function pg_temp.attempts(o text) returns int language sql as $$
  select coalesce((select attempts from waldo.phone_set_daily d join waldo.owners w on w.id = d.owner_id where w.do_name = o), 0) $$;
create function pg_temp.locks(n text) returns int language sql as $$
  select count(*)::int from pg_locks where locktype = 'advisory' and objsubid = 1
    and ((classid::bigint << 32) | objid::bigint) = hashtextextended('waldophone.' || n, 0) $$;

insert into waldo.owners (do_name, email, phone) values
  ('set-asha', 'asha@test.invalid', null),
  ('set-ben', 'ben@test.invalid', '+919800000002'),
  ('set-cai', 'cai@test.invalid', '+919800000003'),
  ('set-dev', 'dev@test.invalid', '+919800000004'),
  ('set-eve', 'eve@test.invalid', '98000 00005'),
  ('set-fay', 'fay@test.invalid', '+919800000006'),
  ('set-gus', 'gus@test.invalid', '+919800000007');
update waldo.owners set phone_verified_at = now() where do_name in ('set-ben', 'set-cai', 'set-gus');
update waldo.owners set state = 'suspended' where do_name = 'set-gus';

-- Only the router may call it, and the signature binds the whole payload.
select throws_ok($$ select waldo.owner_phone_set('{"do_name":"set-asha","phone":"+919800000001","countries":["+91"]}', pg_temp.at(), 'forged') $$,
  '42501', 'unsigned router call', 'a forged call is refused');
select throws_ok($$ select waldo.owner_phone_set('{"do_name":"set-asha","phone":"+919800000001","countries":["+91"]}', pg_temp.at(),
  pg_temp.rsig('phoneset.{"do_name":"set-asha","phone":"+919800000009","countries":["+91"]}')) $$,
  '42501', 'unsigned router call', 'a signature for another number is refused');
select ok(not has_function_privilege('authenticated', 'waldo.owner_phone_set(text,bigint,text)', 'execute'), 'a signed-in Supabase user cannot call it');
select ok(has_function_privilege('anon', 'waldo.owner_phone_set(text,bigint,text)', 'execute'), 'the router reaches it as anon, behind its signature');
select ok(not has_table_privilege('anon', 'waldo.phone_set_daily', 'select') and not has_table_privilege('authenticated', 'waldo.phone_set_daily', 'select'),
  'nobody reads the attempt counts directly');

-- Malformed payloads, unknown and suspended owners are denied before anything is read or counted.
select is(pg_temp.raw('not json'), 'denied', 'a payload that is not JSON is denied');
select is(pg_temp.raw('["set-asha"]'), 'denied', 'a payload that is not an object is denied');
select is(pg_temp.raw('{"do_name":"set-asha","phone":919800000001,"countries":["+91"]}'), 'denied', 'a number that is not a string is denied');
select is(pg_temp.set_as('set-asha', '+919800000001', '"+91"'), 'denied', 'a country list that is not an array is denied');
select is(pg_temp.set_as('set-asha', '+919800000001', '["91"]'), 'denied', 'a malformed country code is denied');
select is(pg_temp.set('set-nobody', '+919800000001'), 'denied', 'an unknown owner is denied');
select is(pg_temp.set('set-gus', '+919800000017'), 'denied', 'a suspended owner is denied');
select is(pg_temp.phone('set-gus'), '+919800000007', 'and their number is left as it was');

-- The number must be E.164 and in a country the router allows.
select is(pg_temp.set('set-asha', '98000 00001'), 'invalid', 'a number that is not E.164 is invalid');
select is(pg_temp.set('set-asha', '+0919800000001'), 'invalid', 'a number starting +0 is invalid');
select is(pg_temp.set('set-asha', '+91980'), 'invalid', 'a number too short is invalid');
select is(pg_temp.set('set-asha', '+14155550100'), 'unsupported', 'a number outside the allowed countries is unsupported');
select is(pg_temp.set_as('set-asha', '+919800000001', '[]'), 'unsupported', 'an empty country list allows no number');
select is(pg_temp.attempts('set-asha'), 0, 'refusals before the lookup count no attempt');
select ok(pg_temp.phone('set-asha') is null, 'and store nothing');

-- A first number is stored unverified.
select is(pg_temp.set('set-asha', '+919800000001'), 'set', 'an owner with no number sets one');
select is(pg_temp.phone('set-asha'), '+919800000001', 'the number is on file');
select ok(not pg_temp.verified('set-asha'), 'unverified');
select is(pg_temp.attempts('set-asha'), 1, 'and it counts one attempt');
select is(pg_temp.locks('+919800000001'), 1, 'the new number was locked');

-- The same number again changes nothing, keeps a proof and counts nothing.
select is(pg_temp.set('set-ben', '+919800000002'), 'unchanged', 'the number already on file is unchanged');
select ok(pg_temp.verified('set-ben'), 'and its proof stands');
select is(pg_temp.attempts('set-ben'), 0, 'and no attempt is counted');

-- A change clears the proof of the old number.
select is(pg_temp.set('set-ben', '+919800000012'), 'set', 'a verified owner changes their number');
select ok(not pg_temp.verified('set-ben'), 'the new number starts unverified');
select is(pg_temp.locks('+919800000002') + pg_temp.locks('+919800000012'), 2, 'both the old and the new number were locked');
select is(waldo.owner_phone_state('set-ben', pg_temp.at(), pg_temp.rsig('phonestate.set-ben')),
  jsonb_build_object('phone', '+919800000012', 'verified', false, 'challenge', null), 'the phone view shows the new number, unproven');

-- A number another active owner has verified is taken; one held unverified, or by a suspended owner, is not.
select is(pg_temp.set('set-dev', '+919800000003'), 'taken', 'a number another owner verified is taken');
select is(pg_temp.phone('set-dev'), '+919800000004', 'and the number on file is left as it was');
select is(pg_temp.attempts('set-dev'), 1, 'a taken answer counts an attempt');
select is(pg_temp.set('set-dev', '+919800000006'), 'set', 'a number another owner holds unverified can be set');
select is(pg_temp.set('set-fay', '+919800000007'), 'set', 'a number a suspended owner verified can be set');

-- A legacy row whose number is not E.164 can be given a real one.
select is(pg_temp.set('set-eve', '+919800000005'), 'set', 'a legacy number that is not E.164 is replaced');

-- Five attempts a UTC day, taken answers included; the next day starts again.
select is(pg_temp.set('set-dev', '+919800000003'), 'taken', 'a second taken attempt');
select is(pg_temp.set('set-dev', '+919800000021'), 'set', 'a fourth attempt');
select is(pg_temp.set('set-dev', '+919800000022'), 'set', 'a fifth attempt');
select is(pg_temp.set('set-dev', '+919800000003'), 'throttled', 'the sixth is throttled before the lookup');
select is(pg_temp.set('set-dev', '+919800000023'), 'throttled', 'and so is a sixth change');
select is(pg_temp.phone('set-dev'), '+919800000022', 'leaving the last number set');
update waldo.phone_set_daily set day = day - 1 where owner_id = (select id from waldo.owners where do_name = 'set-dev');
select is(pg_temp.set('set-dev', '+919800000023'), 'set', 'a new UTC day allows a change again');

select * from finish();
rollback;
