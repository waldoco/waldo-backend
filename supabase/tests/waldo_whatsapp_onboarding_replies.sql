begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.allowed(h text) returns boolean language sql as $$
  select waldo.whatsapp_onboarding_allowed(h, pg_temp.at(), pg_temp.sig('waonboard.' || h))
$$;

select is(pg_temp.allowed(repeat('a', 64)), true, 'the first reply to a hidden-number sender is allowed');
select is(pg_temp.allowed(repeat('a', 64)), false, 'a second reply within 30 days is refused');
select is((select array_agg(subject_hash) from waldo.whatsapp_onboarding_replies), array[repeat('a', 64)], 'only the hash is stored');

-- The shared console_auth_throttle cleanup runs on every sign-in call; it must not touch this store.
select is(waldo.console_auth_throttle('send:someone@test.invalid', 5, 900, pg_temp.at(), pg_temp.sig('throttle.send:someone@test.invalid.5.900')), true, 'a sign-in send runs in between');
select is(pg_temp.allowed(repeat('a', 64)), false, 'the sign-in call did not reset the 30-day limit');

update waldo.whatsapp_onboarding_replies set last_sent_at = clock_timestamp() - interval '30 days 1 minute' where subject_hash = repeat('a', 64);
select is(pg_temp.allowed(repeat('a', 64)), true, 'a reply after 30 days is allowed again');

-- 20 replies an hour across all senders: the sender above plus 19 more fill the hour.
insert into waldo.whatsapp_onboarding_replies (subject_hash, last_sent_at)
  select lpad(to_hex(n), 64, '0'), clock_timestamp() from generate_series(1, 19) as n;
select is(pg_temp.allowed(repeat('b', 64)), false, 'the 21st reply in an hour is refused');
select is(pg_temp.allowed('not-a-hash'), false, 'a value that is not a SHA-256 hex is refused');
select throws_ok($$ select waldo.whatsapp_onboarding_allowed(repeat('c', 64), pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged signature is refused');
select is((select relforcerowsecurity from pg_class where oid = 'waldo.whatsapp_onboarding_replies'::regclass), true, 'row-level security is forced');
select is(has_table_privilege('anon', 'waldo.whatsapp_onboarding_replies', 'select'), false, 'anon cannot read the store');

select * from finish();
rollback;
