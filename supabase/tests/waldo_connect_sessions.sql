begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
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
select * from finish();
rollback;
