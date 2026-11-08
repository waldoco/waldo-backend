begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.check(p_do text) returns boolean language sql as $$ select waldo.admin_check(p_do, pg_temp.at(), pg_temp.sig('admincheck.' || p_do)) $$;

insert into waldo.owners (do_name, email, is_admin) values ('do-check-admin', 'admin@test.invalid', true), ('do-check-user', 'user@test.invalid', false);
insert into waldo.owners (do_name, email, is_admin, state) values ('do-check-suspended', 'suspended@test.invalid', true, 'suspended');

select is(pg_temp.check('do-check-admin'), true, 'an active admin is an admin');
select is(pg_temp.check('do-check-user'), false, 'a normal owner is not');
select is(pg_temp.check('do-check-suspended'), false, 'a suspended admin is not');
select is(pg_temp.check('do-missing'), false, 'an unknown DO is not');
select throws_ok($$ select waldo.admin_check('do-check-admin', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged call is refused');
select throws_ok($$ select waldo.admin_check('do-check-admin', pg_temp.at(), pg_temp.sig('admin.do-check-admin')) $$, '42501', 'unsigned router call', 'the admin overview signature does not open the check');
select throws_ok($$ select waldo.admin_check('do-check-admin', pg_temp.at(), pg_temp.sig('admincheck.do-check-user')) $$, '42501', 'unsigned router call', 'a signature for another DO does not open the check');
select throws_ok($$ select waldo.admin_check('do-check-admin', pg_temp.at() - 301,
  encode(extensions.hmac((pg_temp.at() - 301)::text || '.admincheck.do-check-admin', 'test-router-secret', 'sha256'), 'hex')) $$,
  '42501', 'unsigned router call', 'a correctly signed call older than 300 seconds is refused');
select ok((select prosecdef from pg_proc where oid = 'waldo.admin_check(text,bigint,text)'::regprocedure), 'the check runs as security definer');
select is(has_function_privilege('anon', 'waldo.admin_check(text,bigint,text)', 'execute'), true, 'the signed runtime can call the check');
select is(has_function_privilege('authenticated', 'waldo.admin_check(text,bigint,text)', 'execute'), has_function_privilege('authenticated', 'waldo.admin_overview(text,bigint,text)', 'execute'), 'signed-in users hold the same grant on the check as on the admin overview');
select * from finish();
rollback;
