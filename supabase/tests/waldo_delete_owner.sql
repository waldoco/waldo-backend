begin;
create extension if not exists pgtap with schema extensions;
select plan(9);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'c@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', 'do-c');

-- The owner carries one of every referencing row the delete must clear: a vault-backed
-- connection, a connect ticket, a console session and a health log (all no-cascade FKs),
-- plus the cascade-side rows (presences, owner_settings, link_codes).
select vault.create_secret('dead-token', 'conn_secret_c');
insert into waldo.connections (owner_id, provider, account, secret_id)
  select '10000000-0000-0000-0000-00000000000c', 'google', 'c@test.invalid', id from vault.secrets where name = 'conn_secret_c';
insert into waldo.connect_sessions (owner_id, provider, channel, ticket_hash, expires_at)
  values ('10000000-0000-0000-0000-00000000000c', 'google', 'console', 'ticket-c', now() + interval '30 minutes');
insert into waldo.console_sessions (owner_id, session_hash)
  values ('10000000-0000-0000-0000-00000000000c', 'sess-c');
insert into waldo.health_logs (owner_id, kind, logged_at, source, payload)
  values ('10000000-0000-0000-0000-00000000000c', 'meal', now(), 'console', '{}');
insert into waldo.presences (owner_id, provider, subject) values ('10000000-0000-0000-0000-00000000000c', 'telegram', '333');
insert into waldo.owner_settings (owner_id) values ('10000000-0000-0000-0000-00000000000c');
insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values ('h-c', '10000000-0000-0000-0000-00000000000c', 'telegram', now() + interval '10 minutes');

-- Health: derived rows are keyed on the auth user and cascade only from auth.users, so the owner delete has to clear
-- them itself. Raw readings, consent and the basis cascade from the owner. A second owner's row must survive.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d', 'd@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values ('10000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000d', 'do-d');
insert into public.health_context_daily (user_id, day, form, recovery, weight, freshness) values
  ('00000000-0000-0000-0000-00000000000c', date '2026-10-10', '{"score":70,"zone":"good"}', '{"score":72,"zone":"good"}', '{"score":30,"zone":"low"}', 'fresh'),
  ('00000000-0000-0000-0000-00000000000d', date '2026-10-10', '{"score":55,"zone":"moderate"}', '{"reason":"no_readings"}', '{"reason":"calendar_demand_unavailable"}', 'fresh');
insert into waldo.health_context_basis (owner_id, day, consent_basis, timezone) values
  ('10000000-0000-0000-0000-00000000000c', date '2026-10-10', '[{"source":"apple","consent_epoch":1}]', 'UTC'),
  ('10000000-0000-0000-0000-00000000000d', date '2026-10-10', '[{"source":"apple","consent_epoch":1}]', 'UTC');
insert into waldo.health_consents (id, owner_id, source, purpose, version, age_attested_18_plus)
  values ('20000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-00000000000c', 'apple', 'storage_compute', 2, true);
insert into waldo.health_scopes (owner_id, source, purpose, epoch, consent_id)
  values ('10000000-0000-0000-0000-00000000000c', 'apple', 'storage_compute', 1, '20000000-0000-0000-0000-00000000000c');
insert into waldo.health_samples (owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, payload)
  values ('10000000-0000-0000-0000-00000000000c', 'apple', 'resting_heart_rate', 'rhr-c', 1, 1, date '2026-10-10', timestamptz '2026-10-10 06:00+00', timestamptz '2026-10-10 06:00+00', 0, '{"value":55}');

select throws_ok(
  $$ select waldo.delete_owner('do-c', extract(epoch from now())::bigint, 'forged') $$,
  '42501', 'unsigned router call', 'a forged signature is refused');

select is(waldo.delete_owner('do-c', extract(epoch from now())::bigint, pg_temp.sig('delown.do-c', extract(epoch from now())::bigint)),
  true, 'a signed delete succeeds with every referencing table populated');

select is((select count(*) from waldo.owners where id = '10000000-0000-0000-0000-00000000000c'), 0::bigint, 'the owner row is gone');
select is((select count(*) from waldo.connect_sessions where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.console_sessions where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.health_logs where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.connections where owner_id = '10000000-0000-0000-0000-00000000000c'),
  0::bigint, 'no-cascade referencing rows are gone');
select is((select count(*) from waldo.presences where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.owner_settings where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.link_codes where owner_id = '10000000-0000-0000-0000-00000000000c'),
  0::bigint, 'cascade-side rows are gone');
select is((select count(*) from vault.secrets where name = 'conn_secret_c'), 0::bigint, 'the vault secret behind the connection is gone');

select is((select count(*) from public.health_context_daily where user_id = '00000000-0000-0000-0000-00000000000c'), 0::bigint,
  'the owner''s derived health rows are gone (they are keyed on the auth user, which the delete does not remove)');
select is((select count(*) from public.health_context_daily where user_id = '00000000-0000-0000-0000-00000000000d')
        + (select count(*) from waldo.health_context_basis where owner_id = '10000000-0000-0000-0000-00000000000d'), 2::bigint,
  'another owner''s derived health row and basis are untouched');
select is((select count(*) from waldo.health_samples where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.health_scopes where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.health_consents where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.health_context_basis where owner_id = '10000000-0000-0000-0000-00000000000c'), 0::bigint,
  'raw readings, consent, scope and the basis row are gone');

select * from finish();
rollback;
