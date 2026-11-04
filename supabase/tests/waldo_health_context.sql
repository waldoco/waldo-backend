begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
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

-- Rows are read only through the consent they were computed from: both purposes live for Apple at epoch 1.
insert into waldo.health_consents (id, owner_id, source, purpose, version, age_attested_18_plus)
  select gen_random_uuid(), o.id, 'apple', p, 2, true from waldo.owners o, unnest(array['storage_compute', 'model_processing']) p where o.do_name = 'do-healthctx';
insert into waldo.health_scopes (owner_id, source, purpose, epoch, consent_id)
  select c.owner_id, c.source, c.purpose, 1, c.id from waldo.health_consents c join waldo.owners o on o.id = c.owner_id where o.do_name = 'do-healthctx';
insert into waldo.health_context_basis (owner_id, day, consent_basis, timezone)
  select o.id, v.d, '[{"source":"apple","consent_epoch":1}]'::jsonb, 'UTC' from waldo.owners o, (values ('2026-09-27'::date), ('2026-09-28'::date)) v(d) where o.do_name = 'do-healthctx';

select is(has_function_privilege('anon', 'waldo.health_context_read(text, bigint, text)', 'execute'), true, 'the runtime key can read (signature still required)');
select is(has_function_privilege('service_role', 'waldo.health_context_read(text, bigint, text)', 'execute'), false, 'service role is not granted the health RPC');
select throws_ok($$ select waldo.health_context_read('do-healthctx', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned read is rejected');
select is(waldo.health_context_read('do-unknown', pg_temp.at(), pg_temp.sig('healthctx.read.do-unknown')), null, 'an unknown DO reads null');
select is(waldo.health_context_read('do-healthctx-unlinked', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx-unlinked')), null, 'an owner without an app link reads null');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'day', '2026-09-28', 'a signed read returns the latest context day');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'previous' ->> 'form_score', '64', 'the previous day rides along for the trend');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'compiled_at', '2026-09-28T04:30:00+00:00', 'the row compilation time rides along for the narrative provenance bound');

-- A row with no basis is never read, even when it is the newest.
insert into public.health_context_daily (user_id, day, form, recovery, weight, drivers, confidence, freshness, tags, updated_at) values
  ('00000000-0000-0000-0000-0000000000d1', '2026-09-29', '{"score": 90, "zone": "high"}', '{"zone": "high"}', '{"zone": "low"}', '[]', 0.9, 'fresh', '{}', '2026-09-29T10:00:00Z');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')) -> 'context' ->> 'day', '2026-09-28', 'a newer row without a consent basis is skipped');
-- A row computed at an older storage epoch is not read.
update waldo.health_scopes set epoch = 2 where purpose = 'storage_compute' and owner_id = (select id from waldo.owners where do_name = 'do-healthctx');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')), null, 'a row from before the latest storage grant is not read');
update waldo.health_scopes set epoch = 1 where purpose = 'storage_compute' and owner_id = (select id from waldo.owners where do_name = 'do-healthctx');
-- Storage consent alone does not release a row to the prompt.
update waldo.health_consents set withdrawn_at = now() where purpose = 'model_processing' and owner_id = (select id from waldo.owners where do_name = 'do-healthctx');
select is(waldo.health_context_read('do-healthctx', pg_temp.at(), pg_temp.sig('healthctx.read.do-healthctx')), null, 'without the model purpose nothing is read');
select * from finish();
rollback;
