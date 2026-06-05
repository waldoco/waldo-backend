begin;

create extension if not exists pgtap;

select plan(14);

select is(
  (select array_agg(table_name::text order by table_name)
   from information_schema.tables
   where table_schema = 'public'
     and table_type = 'BASE TABLE'),
  array[
    'agent_logs',
    'chat_messages',
    'chat_threads',
    'crs_scores',
    'feedback_signals',
    'health_daily',
    'notification_log',
    'oauth_tokens',
    'one_time_tokens',
    'patrol_entries',
    'spots',
    'subscriptions',
    'user_baselines',
    'user_consents',
    'user_devices',
    'users'
  ]::text[],
  'public tables match the 16 canonical HEY-9 tables'
);

select is(
  (select count(*)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relrowsecurity),
  16::bigint,
  'RLS is enabled on every public table'
);

select is(
  (select count(*)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relforcerowsecurity),
  16::bigint,
  'RLS is forced on every public table'
);

select is(
  (select array_agg(table_name::text order by table_name)
   from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'authenticated'
     and privilege_type = 'SELECT'
     and table_name = any (array[
       'agent_logs',
       'chat_messages',
       'chat_threads',
       'crs_scores',
       'feedback_signals',
       'health_daily',
       'notification_log',
       'oauth_tokens',
       'one_time_tokens',
       'patrol_entries',
       'spots',
       'subscriptions',
       'user_baselines',
       'user_consents',
       'user_devices',
       'users'
     ])),
  array[
    'chat_messages',
    'chat_threads',
    'crs_scores',
    'feedback_signals',
    'health_daily',
    'patrol_entries',
    'spots',
    'subscriptions',
    'user_baselines',
    'user_consents',
    'user_devices',
    'users'
  ]::text[],
  'authenticated SELECT grants match client-readable tables'
);

select is((select count(*) from pg_policies where schemaname = 'public'), 12::bigint, 'client-readable tables have RLS policies');

select is_empty(
  $$select table_name, privilege_type
    from (values
      ('agent_logs', 'DELETE'),
      ('agent_logs', 'UPDATE'),
      ('notification_log', 'UPDATE'),
      ('feedback_signals', 'UPDATE')
    ) v(table_name, privilege_type)
    where has_table_privilege('service_role', 'public.' || table_name, privilege_type)$$,
  'append-only/write-once service-role grants do not allow forbidden mutations'
);

select ok(has_table_privilege('service_role', 'public.agent_logs', 'INSERT'), 'agent_logs keeps service_role INSERT for append-only writes');
select ok(has_table_privilege('service_role', 'public.patrol_entries', 'UPDATE'), 'patrol_entries keeps service_role UPDATE for post-insert fields');

insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c3');

insert into public.users (id, auth_id, name, email) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'User A', 'a@example.com'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'User B', 'b@example.com'),
  ('30000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c3', 'User C', 'c@example.com');

insert into public.user_consents (user_id, policy_version, health_data_consent) values
  ('10000000-0000-0000-0000-0000000000a1', 'v1', true),
  ('20000000-0000-0000-0000-0000000000b2', 'v1', true);

insert into public.health_daily (user_id, date, primary_source) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01', 'manual'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01', 'manual');

insert into public.crs_scores (user_id, date, score, zone) values
  ('10000000-0000-0000-0000-0000000000a1', date '2026-06-01', 80, 'steady'),
  ('20000000-0000-0000-0000-0000000000b2', date '2026-06-01', 60, 'flagging');

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
  ('10000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-1111-1111-1111-111111111111', 'brief');

insert into public.notification_log (user_id, notification_type, channel, idempotency_key) values
  ('10000000-0000-0000-0000-0000000000a1', 'brief', 'push', 'notify-a');

insert into public.oauth_tokens (user_id, provider) values
  ('10000000-0000-0000-0000-0000000000a1', 'google');

insert into public.one_time_tokens (token, user_id, kind, expires_at) values
  ('token-a', '10000000-0000-0000-0000-0000000000a1', 'telegram_link', now() + interval '10 minutes');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

select is_empty(
  $$select table_name
    from (
      values
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
    ) visible(table_name, row_count)
    where row_count <> 1$$,
  'authenticated user sees exactly one own row per client-readable table'
);

reset role;

select throws_ok(
  $$insert into public.chat_messages (thread_id, user_id, role, content)
    values ('bbbbbbbb-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-0000000000a1', 'user', 'cross tenant')$$,
  '23503'::char(5),
  null,
  'chat_messages rejects cross-tenant thread links'
);

select throws_ok(
  $$insert into public.chat_messages (thread_id, user_id, role, content, parent_message_id)
    values ('bbbbbbbb-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b2', 'user', 'cross thread', '11111111-0000-0000-0000-0000000000a1')$$,
  '23503'::char(5),
  null,
  'chat_messages rejects cross-thread parents'
);

delete from public.users where id = '10000000-0000-0000-0000-0000000000a1';

select is(
  (select sum(row_count)::bigint
   from (
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
  'deleting users cascades to public child tables'
);

select throws_ok(
  $$insert into public.health_daily (user_id, date, primary_source)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-01', 'manual')$$
);

insert into public.user_consents (user_id, policy_version, health_data_consent)
values ('30000000-0000-0000-0000-0000000000c3', 'v1', true);

select lives_ok(
  $$insert into public.health_daily (user_id, date, primary_source)
    values ('30000000-0000-0000-0000-0000000000c3', date '2026-06-02', 'manual')$$,
  'health_daily accepts service-role write after consent'
);

select * from finish();

rollback;
