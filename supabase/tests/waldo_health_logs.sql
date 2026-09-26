begin;
create extension if not exists pgtap with schema extensions;
select plan(10);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (do_name, email) values ('do-health', 'health@test.invalid');

select is(has_function_privilege('anon', 'waldo.health_log_add(text, text, timestamptz, text, jsonb, bigint, text)', 'execute'), true, 'the runtime key can add (signature still required)');
select is(has_function_privilege('service_role', 'waldo.health_log_add(text, text, timestamptz, text, jsonb, bigint, text)', 'execute'), false, 'service role is not granted the health RPCs');
select throws_ok($$ select waldo.health_log_add('do-health', 'meal', now(), 'telegram', '{"description":"dal, rice"}', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned add is rejected');
select isnt(waldo.health_log_add('do-health', 'meal', '2026-09-27T07:30+05:30', 'telegram', '{"description":"dal, rice, paneer"}', pg_temp.at(), pg_temp.sig('health.add.do-health.meal.telegram.' || md5('{"description":"dal, rice, paneer"}'::jsonb::text))), null, 'a signed meal log is stored');
select isnt(waldo.health_log_add('do-health', 'workout', '2026-09-27T06:00+05:30', 'console', '{"type":"run","duration_min":30}', pg_temp.at(), pg_temp.sig('health.add.do-health.workout.console.' || md5('{"type":"run","duration_min":30}'::jsonb::text))), null, 'a signed workout log is stored');
select throws_ok($$ insert into waldo.health_logs (owner_id, kind, logged_at, source, payload) select id, 'snack', now(), 'telegram', '{}' from waldo.owners where do_name = 'do-health' $$, '23514', null, 'an unknown kind is rejected');
select throws_ok($$ insert into waldo.health_logs (owner_id, kind, logged_at, source, payload) select id, 'meal', now(), 'telegram', '[]' from waldo.owners where do_name = 'do-health' $$, '23514', null, 'a non-object payload is rejected');
select is((select count(*)::int from waldo.health_log_recent('do-health', 10, pg_temp.at(), pg_temp.sig('health.recent.do-health.10'))), 2, 'a signed recent read returns both entries');
select is((select kind from waldo.health_log_recent('do-health', 1, pg_temp.at(), pg_temp.sig('health.recent.do-health.1'))), 'workout', 'recent reads newest-first with the SQL-side cap');
select throws_ok($$ select waldo.health_log_recent('do-health', 10, pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned read is rejected');

select * from finish();
rollback;
