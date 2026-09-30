begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'healthctx@test.invalid');
insert into waldo.owners (do_name, email) values ('do-healthctx-unlinked', 'healthctx-unlinked@test.invalid');
insert into waldo.owners (do_name, email, auth_user_id) values ('do-healthctx', 'healthctx-owner@test.invalid', '00000000-0000-0000-0000-0000000000d1');

insert into public.health_context_daily (user_id, day, form, recovery, weight, drivers, confidence, freshness, tags, updated_at) values
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-27', '{"score": 64, "zone": "moderate", "drivers": [], "confidence": 0.7}', '{"zone": "moderate"}', '{"zone": "low"}', '[]', 0.7, 'fresh', '{}', '2026-09-27T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-28', '{"score": 72, "zone": "good", "drivers": ["sleep below baseline"], "confidence": 0.8}', '{"zone": "good"}', '{"zone": "moderate"}', '["sleep below baseline"]', 0.8, 'fresh', '{travel}', '2026-09-28T04:30:00Z');

select is(has_function_privilege('anon', 'waldo.health_context_read(text, bigint, text)', 'execute'), true, 'the runtime key can read (signature still required)');
select is(has_function_privilege('service_role', 'waldo.health_context_read(text, bigint, text)', 'execute'), false, 'service role is not granted the health RPC');
select throws_ok($$ select waldo.health_context_read('do-healthctx', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned read is rejected');
select is(waldo.health_context_read('do-unknown', pg_temp.at(), pg_temp.sig('healthctx.read.do-unknown')), null, 'an unknown DO reads null');
select is(waldo.health_context_read('do-healthctx-unlinked', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx-unlinked')), null, 'an owner without an app link reads null');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'day', '2026-09-28', 'a signed read returns the latest context day');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'previous' ->> 'form_score', '64', 'the previous day rides along for the trend');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'compiled_at', '2026-09-28T04:30:00+00:00', 'the row compilation time rides along for the narrative provenance bound');

select * from finish();
rollback;
