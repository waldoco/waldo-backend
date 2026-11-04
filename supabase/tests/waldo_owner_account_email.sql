begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('account-email-fixture-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'account-email-fixture-router', 'sha256'), 'hex')
$$;
insert into auth.users(id, email, email_confirmed_at) values
  ('72000000-0000-0000-0000-000000000001', 'Account-A@test.invalid', now()),
  ('72000000-0000-0000-0000-000000000002', 'account-b@test.invalid', now());
insert into waldo.owners(id, auth_user_id, do_name, email) values
  ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'account-owner-a', 'account-a@test.invalid'),
  ('73000000-0000-0000-0000-000000000002', '72000000-0000-0000-0000-000000000002', 'account-owner-b', 'account-b@test.invalid');
create function pg_temp.email(which text) returns text language sql as $$
  select waldo.owner_account_email(which, pg_temp.at(), pg_temp.sig('accountemail.' || which))
$$;
select is(pg_temp.email('account-owner-a'), 'account-a@test.invalid', 'the confirmed Auth email, lower-cased');
select is(pg_temp.email('account-owner-b'), 'account-b@test.invalid', 'another owner reads only their own address');
select is(pg_temp.email('unknown-owner'), null::text, 'an unknown owner has no address');
update auth.users set email = 'account-new@test.invalid' where id = '72000000-0000-0000-0000-000000000001';
select is(pg_temp.email('account-owner-a'), null::text, 'an Auth address that no longer matches the owner row is not served');
update waldo.owners set email = 'account-new@test.invalid' where do_name = 'account-owner-a';
select is(pg_temp.email('account-owner-a'), 'account-new@test.invalid', 'a changed address that matches again is served');
update auth.users set email_confirmed_at = null where id = '72000000-0000-0000-0000-000000000001';
select is(pg_temp.email('account-owner-a'), null::text, 'an unconfirmed address is not served');
select throws_ok($$select waldo.owner_account_email('account-owner-b', extract(epoch from now())::bigint, 'forged')$$,
  '42501', 'unsigned router call', 'a forged signature is refused');
select throws_ok(format($$select waldo.owner_account_email('account-owner-b', %s, %L)$$, pg_temp.at(), pg_temp.sig('accountemail.account-owner-a')),
  '42501', 'unsigned router call', 'a signature for another owner does not read this one');
select ok(has_function_privilege('anon', 'waldo.owner_account_email(text,bigint,text)', 'execute'), 'the signed entry is callable');
select ok(not has_function_privilege('authenticated', 'waldo.owner_account_email(text,bigint,text)', 'execute'), 'a signed-in end user cannot call it');
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
  where p.oid = 'waldo.owner_account_email(text,bigint,text)'::regprocedure and a.grantee = 0), 'no PUBLIC execution privilege');
select * from finish();
rollback;
