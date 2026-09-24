begin;
create extension if not exists pgtap with schema extensions;
select plan(10);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (do_name, email) values ('do-a', 'a@test.invalid');

select is(has_function_privilege('anon', 'waldo.console_session_open(text, text, bigint, text)', 'execute'), true, 'the runtime key can open sessions (signature still required)');
select is(has_function_privilege('service_role', 'waldo.console_session_open(text, text, bigint, text)', 'execute'), false, 'service role is not granted the session RPCs');

select throws_ok($$ select waldo.console_session_open('do-a', 'hash1', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned open is rejected');
select is(waldo.console_session_open('do-a', 'hash1', pg_temp.at(), pg_temp.sig('consolesess.open.do-a.hash1')), true, 'a signed open stores the session');
select is((select count(*)::int from waldo.console_sessions where session_hash = 'hash1'), 1, 'only the session hash is stored');

select is(waldo.console_session_touch('do-a', 'hash1', pg_temp.at(), pg_temp.sig('consolesess.touch.do-a.hash1')), true, 'a live session validates');
select is(waldo.console_session_touch('do-a', 'nope', pg_temp.at(), pg_temp.sig('consolesess.touch.do-a.nope')), false, 'an unknown session does not validate');

select is((select count(*)::int from waldo.console_session_list('do-a', pg_temp.at(), pg_temp.sig('consolesess.list.do-a'))), 1, 'the session list shows the open session');

select is(waldo.console_signout_all('do-a', pg_temp.at(), pg_temp.sig('consolesess.signout.do-a')), 1, 'sign-out-everywhere drops every session');
select is(waldo.console_session_touch('do-a', 'hash1', pg_temp.at(), pg_temp.sig('consolesess.touch.do-a.hash1')), false, 'a signed-out session no longer validates');
select * from finish();
rollback;
