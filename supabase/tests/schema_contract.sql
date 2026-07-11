begin;

create extension if not exists pgtap with schema extensions;

select plan(44);

select is(
  (select array_agg(table_name::text order by table_name)
   from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE'),
  array[
    'agent_logs', 'chat_messages', 'chat_threads', 'crs_scores',
    'feedback_signals', 'health_daily', 'notification_log', 'oauth_tokens',
    'one_time_tokens', 'patrol_entries', 'spots', 'subscriptions',
    'user_baselines', 'user_consents', 'user_devices', 'users'
  ]::text[],
  'public tables match the canonical 16-table contract'
);

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
  16::bigint,
  'RLS is enabled on every public table'
);

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity),
  16::bigint,
  'RLS is forced on every public table'
);

select is(
  (select array_agg(table_name::text order by table_name)
   from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'authenticated'
     and privilege_type = 'SELECT'),
  array[
    'chat_messages', 'chat_threads', 'crs_scores', 'feedback_signals',
    'health_daily', 'patrol_entries', 'spots', 'subscriptions',
    'user_baselines', 'user_consents', 'user_devices', 'users'
  ]::text[],
  'authenticated SELECT grants match client-readable tables'
);

select is(
  (select array_agg(tablename::text order by tablename)
   from pg_policies where schemaname = 'public'),
  array[
    'chat_messages', 'chat_threads', 'crs_scores', 'feedback_signals',
    'health_daily', 'patrol_entries', 'spots', 'subscriptions',
    'user_baselines', 'user_consents', 'user_devices', 'users'
  ]::text[],
  'only client-readable tables have policies'
);

select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'$$,
  'anon has no public table privileges of any kind'
);

select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and privilege_type <> 'SELECT'$$,
  'authenticated has no non-SELECT table privileges'
);

select is_empty(
  $$select table_name from (values
      ('agent_logs'), ('notification_log'), ('oauth_tokens'), ('one_time_tokens')
    ) service_only(table_name)
    where has_table_privilege('authenticated', 'public.' || table_name, 'SELECT')$$,
  'service-only tables are inaccessible to authenticated clients'
);

select ok(
  (select p.provolatile = 's' and not p.prosecdef
          and coalesce(p.proconfig::text, '') like '%search_path=%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'app_user_id'),
  'app_user_id is stable, security invoker, and pins search_path'
);

select ok(
  has_function_privilege('authenticated', 'public.app_user_id()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.app_user_id()', 'EXECUTE'),
  'only authenticated clients can execute app_user_id'
);

select is_empty(
  $$with expected(grantee, routine_name, privilege_type) as (
      values ('authenticated', 'app_user_id', 'EXECUTE')
    ), actual as (
      select grantee::text, routine_name::text, privilege_type::text
      from information_schema.role_routine_grants
      where routine_schema = 'public' and grantee in ('anon', 'authenticated')
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)$$,
  'app-role execution grants match the exact public-function contract'
);

select is(
  to_regprocedure('public.rls_auto_enable()')::text,
  null::text,
  'fresh canonical databases do not create the Project Woof RLS helper'
);

select is_empty(
  $$with expected(table_name, privilege_type) as (values
      ('users', 'SELECT'), ('users', 'INSERT'), ('users', 'UPDATE'), ('users', 'DELETE'),
      ('user_consents', 'SELECT'), ('user_consents', 'INSERT'),
      ('health_daily', 'SELECT'), ('health_daily', 'INSERT'), ('health_daily', 'UPDATE'), ('health_daily', 'DELETE'),
      ('crs_scores', 'SELECT'), ('crs_scores', 'INSERT'), ('crs_scores', 'UPDATE'), ('crs_scores', 'DELETE'),
      ('user_baselines', 'SELECT'), ('user_baselines', 'INSERT'), ('user_baselines', 'UPDATE'), ('user_baselines', 'DELETE'),
      ('spots', 'SELECT'), ('spots', 'INSERT'), ('spots', 'UPDATE'), ('spots', 'DELETE'),
      ('patrol_entries', 'SELECT'), ('patrol_entries', 'INSERT'), ('patrol_entries', 'UPDATE'), ('patrol_entries', 'DELETE'),
      ('feedback_signals', 'SELECT'), ('feedback_signals', 'INSERT'), ('feedback_signals', 'DELETE'),
      ('agent_logs', 'SELECT'), ('agent_logs', 'INSERT'),
      ('chat_threads', 'SELECT'), ('chat_threads', 'INSERT'), ('chat_threads', 'UPDATE'), ('chat_threads', 'DELETE'),
      ('chat_messages', 'SELECT'), ('chat_messages', 'INSERT'), ('chat_messages', 'UPDATE'), ('chat_messages', 'DELETE'),
      ('notification_log', 'SELECT'), ('notification_log', 'INSERT'), ('notification_log', 'DELETE'),
      ('user_devices', 'SELECT'), ('user_devices', 'INSERT'), ('user_devices', 'UPDATE'), ('user_devices', 'DELETE'),
      ('oauth_tokens', 'SELECT'), ('oauth_tokens', 'INSERT'), ('oauth_tokens', 'UPDATE'), ('oauth_tokens', 'DELETE'),
      ('one_time_tokens', 'SELECT'), ('one_time_tokens', 'INSERT'), ('one_time_tokens', 'UPDATE'), ('one_time_tokens', 'DELETE'),
      ('subscriptions', 'SELECT'), ('subscriptions', 'INSERT'), ('subscriptions', 'UPDATE'), ('subscriptions', 'DELETE')
    ), actual as (
      select table_name::text, privilege_type::text
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'service_role'
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)$$,
  'service-role table grants match the exact canonical matrix'
);

select ok(has_table_privilege('service_role', 'public.agent_logs', 'INSERT'),
  'agent_logs keeps service-role INSERT');
select ok(has_table_privilege('service_role', 'public.patrol_entries', 'UPDATE'),
  'patrol_entries keeps service-role UPDATE');

select ok(
  not has_table_privilege('service_role', 'public.user_consents', 'UPDATE,DELETE')
  and has_column_privilege('service_role', 'public.user_consents', 'status', 'UPDATE')
  and has_column_privilege('service_role', 'public.user_consents', 'withdrawn_at', 'UPDATE'),
  'service role can withdraw consent but cannot rewrite or directly delete audit rows'
);

select ok(
  not (select convalidated from pg_constraint
       where conname = 'user_consents_canonical_record_check'),
  'legacy consent audit rows remain readable while new rows are contract-enforced'
);

select is(
  (select array_agg(column_name::text order by column_name)
   from information_schema.columns
   where table_schema = 'public' and data_type = 'text'
     and column_name = 'trace_id'
     and table_name in ('agent_logs', 'feedback_signals', 'patrol_entries')),
  array['trace_id', 'trace_id', 'trace_id']::text[],
  'persisted trace identifiers use the opaque string contract'
);

select ok(
  exists (select 1 from pg_constraint
          where conname = 'notification_log_idempotency_key_check'),
  'notification log enforces canonical idempotency keys'
);

select is(
  (select array_agg(conname::text order by conname) from pg_constraint
   where conrelid = 'public.crs_scores'::regclass
     and conname in ('crs_scores_confidence_check', 'crs_scores_form_pillars_check',
                     'crs_scores_score_check', 'crs_scores_score_zone_check',
                     'crs_scores_zone_check')),
  array[
    'crs_scores_confidence_check', 'crs_scores_form_pillars_check',
    'crs_scores_score_check', 'crs_scores_score_zone_check', 'crs_scores_zone_check'
  ]::text[],
  'CRS persisted values carry composite, pillar, zone, and confidence constraints'
);

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000d4');

insert into public.users (id, auth_id, name, email) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'User A', 'a@example.com'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'User B', 'b@example.com'),
  ('30000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c3', 'User C', 'c@example.com');

insert into public.user_consents
  (user_id, consent_class, source, purpose, version, status, granted_at,
   age_attested_18_plus)
values
  ('10000000-0000-0000-0000-0000000000a1', 'health_processing', 'manual',
   'daily_readiness_briefing', 1, 'granted', now(), true),
  ('20000000-0000-0000-0000-0000000000b2', 'health_processing', 'manual',
   'daily_readiness_briefing', 1, 'granted', now(), true);

insert into public.health_daily (user_id, date, primary_source) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01', 'manual'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01', 'manual');
insert into public.crs_scores (user_id, date, score, zone) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01', 80, 'energized'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01', 60, 'steady');
insert into public.user_baselines (user_id, computed_at) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01');
insert into public.spots (user_id, date, category, confidence, observation) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01', 'body', 0.8, 'A spot'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01', 'body', 0.7, 'B spot');
insert into public.patrol_entries (user_id, entry_type, title, reasoning) values
  ('10000000-0000-0000-0000-0000000000a1', 'brief', 'A patrol', 'A reasoning'),
  ('20000000-0000-0000-0000-0000000000b2', 'brief', 'B patrol', 'B reasoning');
insert into public.feedback_signals (user_id, signal_type, target_type) values
  ('10000000-0000-0000-0000-0000000000a1', 'thumbs_up', 'brief'),
  ('20000000-0000-0000-0000-0000000000b2', 'thumbs_down', 'brief');
insert into public.chat_threads (id, user_id, title) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'A thread'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b2', 'B thread');
insert into public.chat_messages (id, thread_id, user_id, role, content) values
  ('11111111-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'user', 'A message'),
  ('22222222-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b2', 'user', 'B message');
insert into public.user_devices (user_id, platform, push_token) values
  ('10000000-0000-0000-0000-0000000000a1', 'ios', 'token-a'),
  ('20000000-0000-0000-0000-0000000000b2', 'ios', 'token-b');
insert into public.subscriptions (user_id) values
  ('10000000-0000-0000-0000-0000000000a1'),
  ('20000000-0000-0000-0000-0000000000b2');
insert into public.agent_logs (user_id, trace_id, trigger_type) values
  ('10000000-0000-0000-0000-0000000000a1', 'run-evidence-01', 'brief');
insert into public.notification_log
  (user_id, notification_type, channel, idempotency_key) values
  ('10000000-0000-0000-0000-0000000000a1', 'brief', 'push', repeat('a', 64));
insert into public.oauth_tokens (user_id, provider) values
  ('10000000-0000-0000-0000-0000000000a1', 'google');
insert into public.one_time_tokens (token, user_id, kind, expires_at) values
  ('token-a', '10000000-0000-0000-0000-0000000000a1', 'telegram_link', now() + interval '10 minutes');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

select is_empty(
  $$select table_name from (values
      ('users', (select count(*) from public.users)),
      ('user_consents', (select count(*) from public.user_consents)),
      ('health_daily', (select count(*) from public.health_daily)),
      ('crs_scores', (select count(*) from public.crs_scores)),
      ('user_baselines', (select count(*) from public.user_baselines)),
      ('spots', (select count(*) from public.spots)),
      ('patrol_entries', (select count(*) from public.patrol_entries)),
      ('feedback_signals', (select count(*) from public.feedback_signals)),
      ('chat_threads', (select count(*) from public.chat_threads)),
      ('chat_messages', (select count(*) from public.chat_messages)),
      ('user_devices', (select count(*) from public.user_devices)),
      ('subscriptions', (select count(*) from public.subscriptions))
    ) visible(table_name, row_count) where row_count <> 1$$,
  'authenticated user sees exactly one own row per client-readable table'
);

select throws_ok(
  $$insert into public.user_devices (user_id, platform) values
    ('10000000-0000-0000-0000-0000000000a1', 'ios')$$,
  '42501'::char(5), null,
  'authenticated own-row inserts are denied by the read-only contract'
);

select throws_ok(
  $$select count(*) from public.agent_logs$$,
  '42501'::char(5), null,
  'authenticated reads of service-only tables are denied'
);

select throws_ok(
  $$update public.users set timezone = 'UTC'
    where auth_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501'::char(5), null,
  'authenticated own-row updates are denied by the read-only contract'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
select is((select count(*) from public.users), 0::bigint,
  'an authenticated subject without an app user mapping sees no users');
select set_config('request.jwt.claim.sub', '', true);
select is((select count(*) from public.users), 0::bigint,
  'a missing subject sees no users');

reset role;

select is_empty(
  $$select policyname from pg_policies where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%user_metadata%'$$,
  'no policy authorizes from user metadata'
);

select throws_ok(
  $$insert into public.chat_messages (thread_id, user_id, role, content)
    values ('bbbbbbbb-0000-0000-0000-0000000000b2',
            '10000000-0000-0000-0000-0000000000a1', 'user', 'cross tenant')$$,
  '23503'::char(5), null,
  'chat messages reject cross-tenant thread links'
);

select throws_ok(
  $$insert into public.chat_messages
      (thread_id, user_id, role, content, parent_message_id)
    values ('bbbbbbbb-0000-0000-0000-0000000000b2',
            '20000000-0000-0000-0000-0000000000b2', 'user', 'cross thread',
            '11111111-0000-0000-0000-0000000000a1')$$,
  '23503'::char(5), null,
  'chat messages reject cross-thread parents'
);

delete from public.users where id = '10000000-0000-0000-0000-0000000000a1';
select is(
  (select sum(row_count)::bigint from (
    select count(*) row_count from public.user_consents where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.health_daily where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.crs_scores where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.user_baselines where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.spots where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.patrol_entries where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.feedback_signals where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.chat_threads where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.chat_messages where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.user_devices where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.oauth_tokens where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.agent_logs where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.notification_log where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.one_time_tokens where user_id = '10000000-0000-0000-0000-0000000000a1'
    union all select count(*) from public.subscriptions where user_id = '10000000-0000-0000-0000-0000000000a1'
  ) counts),
  0::bigint,
  'deleting users cascades to all public child tables'
);

select throws_ok(
  $$insert into public.health_daily (user_id, date, primary_source)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-01', 'whoop')$$,
  '23514'::char(5), null,
  'health writes fail without active consent'
);

select throws_ok(
  $$insert into public.user_consents
      (user_id, consent_class, source, purpose, version, status, granted_at,
       age_attested_18_plus)
    values ('30000000-0000-0000-0000-0000000000c3', 'health_processing',
            'whoop', 'daily_readiness_briefing', 1, 'granted', now(), false)$$,
  '23514'::char(5), null,
  'under-18 consent records are unrepresentable'
);

insert into public.user_consents
  (user_id, consent_class, source, purpose, version, status, granted_at,
   age_attested_18_plus)
values
  ('30000000-0000-0000-0000-0000000000c3', 'health_processing', 'whoop',
   'daily_readiness_briefing', 1, 'granted', now(), true);

select throws_ok(
  $$insert into public.health_daily (user_id, date, primary_source)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-01', 'manual')$$,
  '23514'::char(5), null,
  'consent for another source cannot authorize a health write'
);

select lives_ok(
  $$insert into public.health_daily (user_id, date, primary_source)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-02', 'whoop')$$,
  'matching active consent authorizes a health write'
);

select throws_ok(
  $$insert into public.user_consents
      (user_id, consent_class, source, purpose, version, status, granted_at,
       age_attested_18_plus)
    values ('30000000-0000-0000-0000-0000000000c3', 'health_processing',
            'whoop', 'daily_readiness_briefing', 2, 'granted', now(), true)$$,
  '23505'::char(5), null,
  'only one active grant exists per class, source, and purpose'
);

update public.user_consents
set status = 'withdrawn', withdrawn_at = now()
where user_id = '30000000-0000-0000-0000-0000000000c3';
select throws_ok(
  $$update public.health_daily set synced_at = now()
    where user_id = '30000000-0000-0000-0000-0000000000c3'$$,
  '23514'::char(5), null,
  'withdrawal blocks later health updates'
);

select throws_ok(
  $$update public.user_consents set status = 'granted', withdrawn_at = null
    where user_id = '30000000-0000-0000-0000-0000000000c3'$$,
  '23514'::char(5), null,
  'withdrawn consent cannot be reactivated in place'
);

select throws_ok(
  $$update public.user_consents set version = 2
    where user_id = '30000000-0000-0000-0000-0000000000c3'$$,
  '23514'::char(5), null,
  'consent scope and grant evidence are immutable'
);

select lives_ok(
  $$insert into public.user_consents
      (user_id, consent_class, source, purpose, version, status, granted_at,
       age_attested_18_plus)
    values ('30000000-0000-0000-0000-0000000000c3', 'health_processing',
            'whoop', 'daily_readiness_briefing', 2, 'granted', now(), true)$$,
  're-grant after withdrawal creates a new versioned record'
);

select throws_ok(
  $$insert into public.notification_log
      (user_id, notification_type, channel, idempotency_key)
    values ('20000000-0000-0000-0000-0000000000b2', 'brief', 'push', 'retry-1')$$,
  '23514'::char(5), null,
  'non-canonical notification idempotency keys are rejected'
);
select lives_ok(
  $$insert into public.notification_log
      (user_id, notification_type, channel, idempotency_key)
    values ('20000000-0000-0000-0000-0000000000b2', 'brief', 'push', repeat('b', 64))$$,
  'canonical notification idempotency keys are accepted'
);

select throws_ok(
  $$insert into public.crs_scores (user_id, date, score, zone)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-03', 80, 'steady')$$,
  '23514'::char(5), null,
  'CRS score and zone drift is rejected'
);
select throws_ok(
  $$insert into public.crs_scores
      (user_id, date, score, zone, sleep_score, hrv_score, circadian_score, motion_score)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-04', 80,
            'energized', 101, 80, 80, 80)$$,
  '23514'::char(5), null,
  'CRS pillar scores outside the shared contract scale are rejected'
);
select lives_ok(
  $$insert into public.crs_scores (user_id, date, score, zone, confidence)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-03', 80,
            'energized', 0.8)$$,
  'matching CRS score, zone, and confidence are accepted'
);

select * from finish();

rollback;
