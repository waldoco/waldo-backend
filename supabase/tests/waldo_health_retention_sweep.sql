begin;
create extension if not exists pgtap with schema extensions;
select plan(15);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.sweep(body text) returns jsonb language plpgsql as $$
declare a bigint := extract(epoch from now())::bigint; r jsonb;
begin
  select waldo.health_retention_sweep(body, a, pg_temp.sig('health.retention_sweep.' || md5(body), a)) into r;
  return r;
end $$;
create function pg_temp.expired_reading(owner uuid, id text) returns void language sql as $$
  insert into waldo.health_samples (owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, payload)
  values (owner, 'apple', 'steps_window', id, 1, 1, (now() - interval '100 days')::date, now() - interval '100 days' - interval '1 hour', now() - interval '100 days', 0, '{"value":1}') $$;

insert into auth.users (id, email) select ('d4000000-0000-0000-0000-00000000000' || n)::uuid, 'sw' || n || '@test.invalid' from generate_series(1, 5) n;
insert into waldo.owners (id, auth_user_id, do_name, state) select ('d5000000-0000-0000-0000-00000000000' || n)::uuid, ('d4000000-0000-0000-0000-00000000000' || n)::uuid, 'sweep-' || n, case when n = 2 then 'suspended' else 'active' end from generate_series(1, 5) n;
-- Owners are swept in id order. 1 holds an expired reading and an expired score; 2 (suspended) only an expired receipt; 3 only
-- fresh rows, so is never touched; 4 and 5 an expired reading each.
select pg_temp.expired_reading('d5000000-0000-0000-0000-000000000001', 's1');
insert into public.health_context_daily (user_id, day, form) values ('d4000000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date - 800, '{"reason":"x"}');
insert into waldo.health_requests (owner_id, request_id, operation, payload_digest, response, created_at) values ('d5000000-0000-0000-0000-000000000002', 'r-old', 'ingest', 'x', '{}', now() - interval '100 days');
insert into waldo.health_requests (owner_id, request_id, operation, payload_digest, response) values ('d5000000-0000-0000-0000-000000000003', 'r-new', 'ingest', 'x', '{}');
insert into public.health_context_daily (user_id, day, form) values ('d4000000-0000-0000-0000-000000000003', (now() at time zone 'UTC')::date, '{"reason":"x"}');
select pg_temp.expired_reading('d5000000-0000-0000-0000-000000000004', 's4');
select pg_temp.expired_reading('d5000000-0000-0000-0000-000000000005', 's5');

select throws_ok($q$select waldo.health_retention_sweep('{"limit":5}', 1, 'bad')$q$, '42501', 'unsigned router call', 'an unsigned sweep is refused');
select is(pg_temp.sweep('{"limit":0}')->>'error', 'invalid_request', 'a limit of zero is refused');
select is(pg_temp.sweep('{"limit":201}')->>'error', 'invalid_request', 'a limit past 200 is refused');
select is(pg_temp.sweep('{"limit":"5"}')->>'error', 'invalid_request', 'a limit that is not a number is refused');
select is(pg_temp.sweep('{"limit":5,"owner":"x"}')->>'error', 'invalid_request', 'an extra key is refused');
select is(pg_temp.sweep('not json')->>'error', 'invalid_request', 'a body that is not JSON is refused');

select is(pg_temp.sweep('{"limit":2}') - 'raw_deleted' - 'requests_deleted' - 'context_deleted', '{"owners":2,"more":true}', 'a sweep of limit 2 ages out two owners and says there are more');
select is(pg_temp.sweep('{"limit":10}'), '{"owners":2,"more":false,"raw_deleted":2,"requests_deleted":0,"context_deleted":0}'::jsonb, 'the next sweep reaches the other two owners with expired rows and reports what it deleted');
select is(pg_temp.sweep('{"limit":10}'), '{"owners":0,"more":false,"raw_deleted":0,"requests_deleted":0,"context_deleted":0}'::jsonb, 'with nothing expired left a sweep touches no owner');
select is((select count(*)::int from waldo.health_samples where sample_id in ('s1', 's4', 's5')), 0, 'every expired reading is gone');
select is((select count(*)::int from public.health_context_daily where user_id = 'd4000000-0000-0000-0000-000000000001'), 0, 'the expired score is gone');
select is((select count(*)::int from waldo.health_requests where owner_id = 'd5000000-0000-0000-0000-000000000002'), 0, 'the suspended owner''s expired receipt is gone, so state does not matter');
select is((select count(*)::int from waldo.health_requests where request_id = 'r-new') + (select count(*)::int from public.health_context_daily where user_id = 'd4000000-0000-0000-0000-000000000003'), 2, 'the fresh receipt and score are untouched');
select is((select array_agg(has_function_privilege('anon', 'waldo.health_retention_sweep(text,bigint,text)', 'execute')) || has_function_privilege('anon', 'waldo.health_retention_apply(uuid,uuid)', 'execute')), array[true, false], 'the signed router can run the sweep but nobody can call the per-owner worker directly');
select is((select count(*)::int from (values ('authenticated'), ('service_role'), ('public')) r(name) where has_function_privilege(r.name, 'waldo.health_retention_sweep(text,bigint,text)', 'execute') or has_function_privilege(r.name, 'waldo.health_retention_apply(uuid,uuid)', 'execute')), 0, 'no signed-in member, service role or public caller can run either');

select * from finish();
rollback;
