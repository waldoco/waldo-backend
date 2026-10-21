begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (do_name, email) values ('do-a', 'a@test.invalid'), ('do-b', 'b@test.invalid'), ('do-c', 'c@test.invalid');
create temp table c as select waldo.proxy_store('do-a', 'google', 'Shared@X.test', 'gmail.readonly', 'rt-a') as a, waldo.proxy_store('do-b', 'google', 'shared@x.test', 'gmail.readonly', 'rt-b') as b,
  waldo.proxy_store('do-c', 'google', 'shared@x.test', 'gmail.readonly', 'rt-c') as cc;
select waldo.connection_revoke('do-c', (select cc from c), pg_temp.at(), pg_temp.sig('connrevoke.do-c.' || (select cc from c)));

select is(has_function_privilege('anon', 'waldo.gmail_push_route(text, bigint, text)', 'execute'), true, 'the runtime key can look up (signature still required)');
select throws_ok($$ select * from waldo.gmail_push_route('shared@x.test', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'an unsigned lookup is refused');
select throws_ok($$ select * from waldo.gmail_push_route('other@x.test', pg_temp.at(), pg_temp.sig('gmailroute.shared@x.test')) $$, '42501', 'unsigned router call', 'a signature for one address does not look up another');
select set_eq($$ select do_name from waldo.gmail_push_route('SHARED@x.test', pg_temp.at(), pg_temp.sig('gmailroute.shared@x.test')) $$, array['do-a', 'do-b'], 'every live owner of the mailbox is found, whatever the case, and a revoked connection is not');
select is((select connection from waldo.gmail_push_route('shared@x.test', pg_temp.at(), pg_temp.sig('gmailroute.shared@x.test')) where do_name = 'do-a'), (select a from c), 'each row names that owner''s own connection');
update waldo.owners set state = 'suspended' where do_name = 'do-b';
select set_eq($$ select do_name from waldo.gmail_push_route('shared@x.test', pg_temp.at(), pg_temp.sig('gmailroute.shared@x.test')) $$, array['do-a'], 'a suspended owner is not woken');
select is((select count(*)::int from waldo.gmail_push_route('nobody@x.test', pg_temp.at(), pg_temp.sig('gmailroute.nobody@x.test'))), 0, 'an unknown mailbox wakes no one');
select * from finish();
rollback;
