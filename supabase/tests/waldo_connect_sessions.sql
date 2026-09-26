begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (do_name, email) values ('do-a', 'a@test.invalid');

select is(has_function_privilege('anon', 'waldo.connect_session_issue(text, text, text, text, bigint, text)', 'execute'), true, 'the runtime key can issue (signature still required)');
select is(has_function_privilege('service_role', 'waldo.connect_session_issue(text, text, text, text, bigint, text)', 'execute'), false, 'service role is not granted the ticket RPCs');

select throws_ok($$ select waldo.connect_session_issue('do-a', 'google', 'telegram', 'hash1', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned issue is rejected');
create temp table s as select waldo.connect_session_issue('do-a', 'google', 'telegram', 'hash1', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.telegram.hash1')) as id;
select isnt((select id from s), null, 'a signed issue stores the session');
select is((select count(*)::int from waldo.connect_sessions where ticket_hash = 'hash1' and status = 'issued'), 1, 'only the hash is stored, status issued');

select is(waldo.connect_session_resolve('hash1', pg_temp.at(), pg_temp.sig('connsess.resolve.hash1'))->>'do_name', 'do-a', 'resolving a live ticket returns the owner handle');
select is((select status from waldo.connect_sessions where ticket_hash = 'hash1'), 'clicked', 'the first resolve marks it clicked');

select is(waldo.connect_session_complete('hash1', pg_temp.at(), pg_temp.sig('connsess.complete.hash1')), true, 'a clicked session completes once');
select is(waldo.connect_session_complete('hash1', pg_temp.at(), pg_temp.sig('connsess.complete.hash1')), false, 'a completed session cannot complete again');
select is(waldo.connect_session_resolve('hash1', pg_temp.at(), pg_temp.sig('connsess.resolve.hash1'))->>'status', 'completed', 'a completed ticket reports completed, never ok again');

create temp table s2 as select waldo.connect_session_issue('do-a', 'google', 'telegram', 'hash2', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.telegram.hash2')) as id;
select waldo.connect_session_issue('do-a', 'google', 'telegram', 'hash3', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.telegram.hash3'));
select is((select status from waldo.connect_sessions where ticket_hash = 'hash2'), 'revoked', 're-issuing revokes the previous live ticket');
select is((select count(*)::int from waldo.connect_sessions where owner_id in (select id from waldo.owners where do_name = 'do-a') and provider = 'google' and status in ('issued', 'clicked')), 1, 'exactly one live ticket per owner+provider');
-- #215 boundary tests across both clocks (owner release-blocking review): the ticket lifetime
-- is 12 hours, and a CLICKED ticket completes even after its resolve window closes.
create temp table s3 as select waldo.connect_session_issue('do-a', 'google', 'console', 'hash4', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.console.hash4')) as id;
select ok((select expires_at > now() + interval '11 hours 59 minutes' and expires_at <= now() + interval '12 hours' from waldo.connect_sessions where ticket_hash = 'hash4'), 'an issued ticket lives about 12 hours, not 30 minutes');

-- issued but never clicked, past expiry: resolve reports expired and complete refuses.
update waldo.connect_sessions set expires_at = now() - interval '1 second' where ticket_hash = 'hash4';
select is(waldo.connect_session_resolve('hash4', pg_temp.at(), pg_temp.sig('connsess.resolve.hash4'))->>'status', 'expired', 'a ticket past its 12-hour window resolves expired');
select is(waldo.connect_session_complete('hash4', pg_temp.at(), pg_temp.sig('connsess.complete.hash4')), false, 'an expired ticket that was never clicked cannot complete');

-- clicked near expiry, callback lands after the window: completion must still record (the
-- single-use OAuth state nonce governs the callback, not the ticket window).
select waldo.connect_session_issue('do-a', 'google', 'console', 'hash5', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.console.hash5'));
select waldo.connect_session_resolve('hash5', pg_temp.at(), pg_temp.sig('connsess.resolve.hash5'));
update waldo.connect_sessions set expires_at = now() - interval '1 second' where ticket_hash = 'hash5';
select is(waldo.connect_session_complete('hash5', pg_temp.at(), pg_temp.sig('connsess.complete.hash5')), true, 'a clicked ticket completes even after its resolve window closes');

-- crossed-clock (owner re-review): click near expiry, REOPEN the link after the window, then the
-- in-flight callback lands. The second resolve reads expired to the owner but leaves the row
-- clicked, so the pending flow still settles.
select waldo.connect_session_issue('do-a', 'google', 'console', 'hash6', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.console.hash6'));
select waldo.connect_session_resolve('hash6', pg_temp.at(), pg_temp.sig('connsess.resolve.hash6'));
update waldo.connect_sessions set expires_at = now() - interval '1 second' where ticket_hash = 'hash6';
select is(waldo.connect_session_resolve('hash6', pg_temp.at(), pg_temp.sig('connsess.resolve.hash6'))->>'status', 'expired', 'a reopened clicked ticket past its window reads expired to the owner');
select is((select status from waldo.connect_sessions where ticket_hash = 'hash6'), 'clicked', 'the crossed-clock resolve leaves the row clicked, not expired');
select is(waldo.connect_session_complete('hash6', pg_temp.at(), pg_temp.sig('connsess.complete.hash6')), true, 'the in-flight flow still completes after the crossed-clock resolve');

select * from finish();
rollback;
