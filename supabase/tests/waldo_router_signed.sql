begin;
create extension if not exists pgtap with schema extensions;
select plan(15);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.now_at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'e@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values ('10000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000e', 'do-e');
insert into waldo.presences (owner_id, provider, subject) values ('10000000-0000-0000-0000-00000000000e', 'telegram', '555');
insert into waldo.health_logs (owner_id, kind, logged_at, source, payload)
  values ('10000000-0000-0000-0000-00000000000e', 'meal', now(), 'console', '{}');

-- A missing input must answer false, never NULL: callers guard with `if not router_signed(...)`.
select is(waldo.router_signed('route.telegram.555', null, pg_temp.sig('route.telegram.555', pg_temp.now_at())), false, 'a missing timestamp is unsigned');
select is(waldo.router_signed('route.telegram.555', pg_temp.now_at(), null), false, 'a missing signature is unsigned');
select is(waldo.router_signed(null, pg_temp.now_at(), pg_temp.sig('', pg_temp.now_at())), false, 'a missing message is unsigned');
select is(waldo.router_signed(null, null, null), false, 'all inputs missing is unsigned');
select is(waldo.router_signed('route.telegram.555', pg_temp.now_at(), pg_temp.sig('route.telegram.555', pg_temp.now_at())), true, 'a valid signature still verifies');
select is(has_function_privilege('anon', 'waldo.router_signed(text,bigint,text)', 'execute'), false, 'the publishable key cannot call the verifier directly');

set local role anon;
select throws_ok($$ select * from waldo.route_presence('telegram', '555', null, null) $$, '42501', 'unsigned router call', 'routing refuses a missing timestamp');
select throws_ok($$ select * from waldo.route_presence('telegram', '555', extract(epoch from now())::bigint, null) $$, '42501', 'unsigned router call', 'routing refuses a missing signature');
select throws_ok($$ select * from waldo.route_presence('telegram', null, extract(epoch from now())::bigint, 'forged') $$, '42501', 'unsigned router call', 'routing refuses a missing subject');
select throws_ok($$ select waldo.connection_list('do-e', null, null) $$, '42501', 'unsigned router call', 'connection listing refuses a missing timestamp');
select throws_ok($$ select * from waldo.health_log_recent('do-e', 10, null, null) $$, '42501', 'unsigned router call', 'health logs refuse a missing timestamp');
select throws_ok($$ select waldo.delete_owner('do-e', null, null) $$, '42501', 'unsigned router call', 'account deletion refuses a missing timestamp');
select throws_ok($$ select waldo.delete_owner('do-e', extract(epoch from now())::bigint, null) $$, '42501', 'unsigned router call', 'account deletion refuses a missing signature');
reset role;
select is((select count(*) from waldo.owners where do_name = 'do-e'), 1::bigint, 'the owner survives the unsigned deletes');

select is((select do_name from waldo.route_presence('telegram', '555', pg_temp.now_at(), pg_temp.sig('route.telegram.555', pg_temp.now_at()))), 'do-e', 'a signed route call still resolves the owner');
select * from finish();
rollback;
