begin;
create extension if not exists pgtap with schema extensions;
select plan(51);
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

-- The app is a connect surface; any other channel is still refused by the check.
select lives_ok($$ select waldo.connect_session_issue('do-a', 'google', 'app', 'hash7', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.app.hash7')) $$, 'the app can issue a connect ticket');
select is((select channel from waldo.connect_sessions where ticket_hash = 'hash7'), 'app', 'the ticket records the app as its channel');
select throws_ok($$ select waldo.connect_session_issue('do-a', 'google', 'sms', 'hash8', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.sms.hash8')) $$, '23514', null, 'an unknown channel is still rejected');

-- The bearer hop names whose Waldo the account joins, masked, and its Continue runs once.
select is(has_function_privilege('anon', 'waldo.connect_session_begin(text, bigint, text)', 'execute'), true, 'the runtime key can begin (signature still required)');
select is(has_function_privilege('service_role', 'waldo.connect_session_begin(text, bigint, text)', 'execute'), false, 'service role is not granted the Continue');
select waldo.connect_session_issue('do-a', 'google', 'telegram', 'hash9', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.google.telegram.hash9'));
create temp table r9 as select waldo.connect_session_resolve('hash9', pg_temp.at(), pg_temp.sig('connsess.resolve.hash9')) as r;
select is((select r->>'owner_hint' from r9), 'a•••@test.invalid', 'resolve names the owner by a masked hint');
select is((select position('a@test.invalid' in r::text) from r9), 0, 'and never by the full address');
select is((select (r->>'begun')::boolean from r9), false, 'a ticket is not begun before its Continue');
select throws_ok($$ select waldo.connect_session_begin('hash9', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned Continue is rejected');
select is(waldo.connect_session_begin('hash9', pg_temp.at(), pg_temp.sig('connsess.begin.hash9'))->>'do_name', 'do-a', 'the first Continue begins the ticket');
select is(waldo.connect_session_begin('hash9', pg_temp.at(), pg_temp.sig('connsess.begin.hash9')), null, 'a replayed Continue finds it begun and starts nothing');
select is((waldo.connect_session_resolve('hash9', pg_temp.at(), pg_temp.sig('connsess.resolve.hash9'))->>'begun')::boolean, true, 'resolve reports the ticket begun');
select is(waldo.connect_session_complete('hash9', pg_temp.at(), pg_temp.sig('connsess.complete.hash9')), true, 'a begun ticket completes as a clicked one does');

-- A link handed to the app carries a one-time code: redeemed once, for its own ticket only, before Continue can run.
select is(has_function_privilege('anon', 'waldo.connect_session_issue_handoff(text, text, text, text, text, bigint, text)', 'execute'), true, 'the runtime key can issue a handed-off ticket (signature still required)');
select is(has_function_privilege('service_role', 'waldo.connect_session_issue_handoff(text, text, text, text, text, bigint, text)', 'execute'), false, 'service role is not granted the handed-off issue');
select is(has_function_privilege('anon', 'waldo.connect_session_hand_off(text, text, bigint, text)', 'execute'), true, 'the runtime key can redeem a code (signature still required)');
select is(has_function_privilege('service_role', 'waldo.connect_session_hand_off(text, text, bigint, text)', 'execute'), false, 'service role is not granted the redemption');
select throws_ok($$ select waldo.connect_session_issue_handoff('do-a', 'whoop', 'app', 'hashH1', 'codeA', pg_temp.at(), pg_temp.sig('connsess.issue.do-a.whoop.app.hashH1')) $$, '42501', 'unsigned router call', 'an issue signed without its code is rejected');
select isnt(waldo.connect_session_issue_handoff('do-a', 'whoop', 'app', 'hashH1', 'codeA', pg_temp.at(), pg_temp.sig('connsess.issue_handoff.do-a.whoop.app.hashH1.codeA')), null, 'a signed handed-off issue stores the ticket');
insert into waldo.owners (do_name, email) values ('do-b', 'b@test.invalid');
select waldo.connect_session_issue_handoff('do-b', 'whoop', 'app', 'hashH2', 'codeB', pg_temp.at(), pg_temp.sig('connsess.issue_handoff.do-b.whoop.app.hashH2.codeB'));
create temp table rh as select waldo.connect_session_resolve('hashH1', pg_temp.at(), pg_temp.sig('connsess.resolve.hashH1')) as r;
select is((select (r->>'handoff')::boolean from rh), true, 'resolve says the ticket needs its code');
select is((select position('codeA' in r::text) from rh), 0, 'and never returns the code hash');
select waldo.connect_session_issue('do-b', 'google', 'telegram', 'hashC1', pg_temp.at(), pg_temp.sig('connsess.issue.do-b.google.telegram.hashC1'));
select is((waldo.connect_session_resolve('hashC1', pg_temp.at(), pg_temp.sig('connsess.resolve.hashC1'))->>'handoff')::boolean, false, 'a chat ticket needs no code');
select is(waldo.connect_session_begin('hashH1', pg_temp.at(), pg_temp.sig('connsess.begin.hashH1')), null, 'Continue cannot run before the code is redeemed');
select throws_ok($$ select waldo.connect_session_hand_off('hashH1', 'codeA', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned redemption is rejected');
select is(waldo.connect_session_hand_off('hashH2', 'codeA', pg_temp.at(), pg_temp.sig('connsess.handoff.hashH2.codeA')), false, 'one owner''s code redeems no other owner''s ticket');
select is(waldo.connect_session_hand_off('hashH1', 'codeX', pg_temp.at(), pg_temp.sig('connsess.handoff.hashH1.codeX')), false, 'a wrong code redeems nothing');
select is(waldo.connect_session_hand_off('hashH1', 'codeA', pg_temp.at(), pg_temp.sig('connsess.handoff.hashH1.codeA')), true, 'the ticket''s own code redeems it');
select is(waldo.connect_session_hand_off('hashH1', 'codeA', pg_temp.at(), pg_temp.sig('connsess.handoff.hashH1.codeA')), false, 'a second redemption finds it spent');
select is(waldo.connect_session_begin('hashH1', pg_temp.at(), pg_temp.sig('connsess.begin.hashH1'))->>'do_name', 'do-a', 'after redemption Continue runs once');
select waldo.connect_session_issue_handoff('do-b', 'whoop', 'app', 'hashH3', 'codeC', pg_temp.at(), pg_temp.sig('connsess.issue_handoff.do-b.whoop.app.hashH3.codeC'));
select ok((select handoff_expires_at <= now() + interval '10 minutes' and expires_at > now() + interval '11 hours' from waldo.connect_sessions where ticket_hash = 'hashH3'), 'the code lives 10 minutes and the ticket its own 12 hours');
update waldo.connect_sessions set handoff_expires_at = now() - interval '1 second' where ticket_hash = 'hashH3';
select is(waldo.connect_session_hand_off('hashH3', 'codeC', pg_temp.at(), pg_temp.sig('connsess.handoff.hashH3.codeC')), false, 'a code past its 10 minutes redeems nothing');
select is(waldo.connect_session_begin('hashH3', pg_temp.at(), pg_temp.sig('connsess.begin.hashH3')), null, 'and its ticket never begins');

select * from finish();
rollback;
