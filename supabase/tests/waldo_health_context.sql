begin;
create extension if not exists pgtap with schema extensions;
select plan(9);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

-- The app-owned tables live in the companion app repo's migrations; the CI database only runs
-- this repo's set. These fixtures mirror exactly the app-contract columns the RPC reads, and
-- roll back with the test.
create table public.health_context_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  day date not null,
  form jsonb,
  recovery jsonb,
  weight jsonb,
  drivers jsonb not null default '[]'::jsonb,
  confidence numeric,
  freshness text,
  tags text[] not null default '{}'
);
create table public.health_daily (
  user_id uuid not null,
  day date not null,
  source text not null,
  inputs jsonb not null default '{}'::jsonb
);
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'healthctx@test.invalid');
insert into waldo.owners (do_name, email) values ('do-healthctx-unlinked', 'healthctx-unlinked@test.invalid');
insert into waldo.owners (do_name, email, auth_user_id) values ('do-healthctx', 'healthctx-owner@test.invalid', '00000000-0000-0000-0000-0000000000d1');

insert into public.health_context_daily (user_id, day, form, recovery, weight, drivers, confidence, freshness, tags) values
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-27', '{"score": 64, "zone": "moderate", "drivers": [], "confidence": 0.7}', '{"zone": "moderate"}', '{"zone": "low"}', '[]', 0.7, 'fresh', '{}'),
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-28', '{"score": 72, "zone": "good", "drivers": ["sleep below baseline"], "confidence": 0.8}', '{"zone": "good"}', '{"zone": "moderate"}', '["sleep below baseline"]', 0.8, 'fresh', '{travel}');
insert into public.health_daily (user_id, day, source, inputs) values
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-28', 'apple_healthkit', '{"sleep_duration_min": 380, "hrv_overnight_ms": null, "steps": 5000}');

select is(has_function_privilege('anon', 'waldo.health_context_read(text, bigint, text)', 'execute'), true, 'the runtime key can read (signature still required)');
select is(has_function_privilege('service_role', 'waldo.health_context_read(text, bigint, text)', 'execute'), false, 'service role is not granted the health RPC');
select throws_ok($$ select waldo.health_context_read('do-healthctx', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned read is rejected');
select is(waldo.health_context_read('do-unknown', pg_temp.at(), pg_temp.sig('healthctx.read.do-unknown')), null, 'an unknown DO reads null');
select is(waldo.health_context_read('do-healthctx-unlinked', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx-unlinked')), null, 'an owner without an app link reads null');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'day', '2026-09-28', 'a signed read returns the latest context day');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'previous' ->> 'form_score', '64', 'the previous day rides along for the trend');
select is((select jsonb_agg(k order by k) from (select jsonb_array_elements_text(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'input_keys') k) s), '["sleep_duration_min", "steps"]'::jsonb, 'input keys cover present values only (jsonb nulls excluded)');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'sources', '["apple_healthkit"]'::jsonb, 'the day''s sources ride along');

select * from finish();
rollback;
