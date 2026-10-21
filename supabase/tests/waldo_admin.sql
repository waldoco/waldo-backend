begin;
create extension if not exists pgtap with schema extensions;
select plan(22);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.invite(p_do text, p_email text, p_hash text) returns boolean language sql as
  $$ select waldo.admin_invite(p_do, p_email, pg_temp.at(), pg_temp.sig('invite.' || p_do || '.' || lower(p_email) || '.' || p_hash), p_hash) $$;
insert into waldo.owners (do_name, email, is_admin) values ('do-admin', 'admin@test.invalid', true), ('do-user', 'user@test.invalid', false);
select is(waldo.admin_overview('do-user', pg_temp.at(), pg_temp.sig('admin.do-user')), null, 'a normal owner sees no admin data');
select is(waldo.admin_invite('do-user', 'x@test.invalid', pg_temp.at(), pg_temp.sig('invite.do-user.x@test.invalid.'||repeat('b',64)), repeat('b',64)), false, 'a normal owner cannot invite');
select is(waldo.admin_invite('do-admin', 'New@test.invalid', pg_temp.at(), pg_temp.sig('invite.do-admin.new@test.invalid.'||repeat('a',64)), repeat('a',64)), true, 'the admin can invite');
select is(jsonb_array_length(waldo.admin_overview('do-admin', pg_temp.at(), pg_temp.sig('admin.do-admin'))->'owners'), 2, 'the admin sees every owner');
select is((select revoked_at is null from waldo.invites where email = 'new@test.invalid'), true, 'the invite is open');
select is(waldo.admin_revoke('do-admin', (select code_hash from waldo.invites where email = 'new@test.invalid'), pg_temp.at(), pg_temp.sig('revoke.do-admin.' || (select code_hash from waldo.invites where email = 'new@test.invalid'))), true, 'the admin can revoke');
select throws_ok($$ select waldo.admin_overview('do-admin', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged admin call is refused');
-- The admin has no lifetime cap. Issued codes count in any state, so the revoked code above is the
-- first of five, and the capped function refused the sixth.
select is((select count(*) from generate_series(2, 5) n where pg_temp.invite('do-admin', 'n' || n || '@test.invalid', lpad(n::text, 64, '0'))), 4::bigint, 'the admin issues codes two to five');
select is((select count(*) from waldo.invites where issued_by = (select id from waldo.owners where do_name = 'do-admin')), 5::bigint, 'the admin has issued five codes, the revoked one included');
select is(pg_temp.invite('do-admin', 'N6@Test.invalid', lpad('6', 64, '0')), true, 'the admin''s sixth code is issued');
select is((select count(*) from generate_series(7, 12) n where pg_temp.invite('do-admin', 'n' || n || '@test.invalid', lpad(n::text, 64, '0'))), 6::bigint, 'the admin''s seventh to twelfth codes are issued');
select is((select count(*) from waldo.invites where email in (select 'n' || n || '@test.invalid' from generate_series(6, 12) n)
  and used_at is null and revoked_at is null and expires_at = now() + interval '14 days'), 7::bigint, 'codes past five are open, stored under the lower-cased email and expire in 14 days');
select is(waldo.signin_allowed('n6@test.invalid', pg_temp.at(), pg_temp.sig('signin.n6@test.invalid.' || lpad('6', 64, '0')), lpad('6', 64, '0')), true, 'the sixth code admits its recipient');
select is(waldo.signin_allowed('n7@test.invalid', pg_temp.at(), pg_temp.sig('signin.n7@test.invalid.' || lpad('6', 64, '0')), lpad('6', 64, '0')), false, 'the sixth code admits no other email');
-- Past five, only the duplicate, active-owner and member-cap checks can refuse these.
select is(pg_temp.invite('do-admin', 'N7@test.invalid', repeat('c', 64)), false, 'an email holding a live code gets no second one, in any case');
select is(pg_temp.invite('do-admin', 'User@Test.invalid', repeat('d', 64)), false, 'an active owner is not invited');
select is(waldo.issue_member_invite('do-admin', 'm@test.invalid', repeat('e', 64), pg_temp.at(), pg_temp.sig('memberinvite.do-admin.m@test.invalid.' || repeat('e', 64))), false, 'the member path keeps its cap of five, for the admin too');
select throws_ok($$ select waldo.admin_invite('do-admin', 'f@test.invalid', pg_temp.at(), 'forged', repeat('f', 64)) $$, '42501', 'unsigned router call', 'a forged invite call is refused');
select ok((select prosecdef from pg_proc where oid = 'waldo.admin_invite(text,text,bigint,text,text)'::regprocedure), 'admin_invite still runs as security definer');
select is((select proconfig from pg_proc where oid = 'waldo.admin_invite(text,text,bigint,text,text)'::regprocedure),
  (select proconfig from pg_proc where oid = 'waldo.issue_member_invite(text,text,text,bigint,text)'::regprocedure), 'admin_invite keeps the pinned search_path of the member path');
select is(has_function_privilege('anon', 'waldo.admin_invite(text,text,bigint,text,text)', 'execute'), true, 'the signed runtime can call admin_invite');
select is(has_function_privilege('service_role', 'waldo.admin_invite(text,text,bigint,text,text)', 'execute'), false, 'service role is not granted admin_invite');
select * from finish();
rollback;
