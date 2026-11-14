begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.add(do_name text, payload text) returns bigint language sql as $$
  select waldo.health_log_add(do_name, 'meal', now(), 'telegram', payload, pg_temp.at(), pg_temp.sig('health.add.' || do_name || '.meal.telegram.' || md5(payload))) $$;
create function pg_temp.del(do_name text, id bigint) returns setof waldo.health_logs language sql as $$
  select * from waldo.health_log_delete(do_name, id, pg_temp.at(), pg_temp.sig('health.delete.' || do_name || '.' || id)) $$;
insert into waldo.owners (do_name, email) values ('do-delete-a', 'delete-a@test.invalid'), ('do-delete-b', 'delete-b@test.invalid');
create temp table ids as select pg_temp.add('do-delete-a', '{"description":"poha"}') as a1, pg_temp.add('do-delete-a', '{"description":"idli"}') as a2,
  pg_temp.add('do-delete-b', '{"description":"upma"}') as b1;

select is(has_function_privilege('anon', 'waldo.health_log_delete(text, bigint, bigint, text)', 'execute'), true, 'the runtime key can delete (signature still required)');
select is(has_function_privilege('service_role', 'waldo.health_log_delete(text, bigint, bigint, text)', 'execute'), false, 'service role is not granted the delete');
select is(has_function_privilege('authenticated', 'waldo.health_log_delete(text, bigint, bigint, text)', 'execute'), false, 'a signed-in user cannot call the delete directly');
select throws_ok(format($$ select * from waldo.health_log_delete('do-delete-a', %s, pg_temp.at(), 'badsig') $$, (select a1 from ids)), '42501', 'unsigned router call', 'an unsigned delete is rejected');
select throws_ok(format($$ select * from waldo.health_log_delete('do-delete-a', %s, pg_temp.at(), pg_temp.sig('health.delete.do-delete-a.%s')) $$, (select a1 from ids), (select a2 from ids)),
  '42501', 'unsigned router call', 'a signature for one id does not delete another');
select is((select count(*)::int from pg_temp.del('do-delete-a', (select b1 from ids))), 0, 'an id from another owner removes nothing');
select is((select count(*)::int from waldo.health_logs where id = (select b1 from ids)), 1, 'the other owner''s log is still there');
select is((select payload->>'description' from pg_temp.del('do-delete-a', (select a1 from ids))), 'poha', 'a signed delete returns the row it removed');
select is((select count(*)::int from waldo.health_logs where id = (select a1 from ids)), 0, 'the removed log is gone');
select is((select count(*)::int from pg_temp.del('do-delete-a', (select a1 from ids))), 0, 'deleting it again removes nothing');
select is((select count(*)::int from waldo.health_logs where id = (select a2 from ids)), 1, 'the owner''s other log is kept');
select is((select count(*)::int from pg_temp.del('do-unknown', (select a2 from ids))), 0, 'an unknown DO name removes nothing');

select * from finish();
rollback;
