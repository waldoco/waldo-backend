-- HEY-9 · Supabase schema · 0004 comms
-- Source: WALDO_V1_MASTER_PLAN.md §5 #10,11,13.
-- Chat is created server-side (messages route through the DO agent, overview); clients read
-- own threads/messages via RLS. notification_log is service-role only (§5 principle 6).

-- §5 #10 — chat_threads (persistent by topic, cross-surface)
create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text,
  topic_tags text[],                      -- for DO thread_topic_index sync
  last_message_at timestamptz,
  telegram_thread_id text,
  whatsapp_thread_id text,
  archived_at timestamptz,
  created_at timestamptz default now(),
  unique (id, user_id)                    -- composite-FK target for chat_messages tenant integrity (#5)
);

alter table chat_threads enable row level security;
alter table chat_threads force row level security;
revoke all on chat_threads from anon, authenticated;
grant select on chat_threads to authenticated;
grant select, insert, update, delete on chat_threads to service_role;
create policy chat_threads_select_own on chat_threads
  for select to authenticated
  using (user_id = (select app_user_id()));

-- §5 #11 — chat_messages (persistent, cross-surface, soft-delete). deleted_at = recoverable.
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  role text not null,                     -- user | waldo | system
  content text not null,
  parent_message_id uuid,                 -- branch structure (same-thread, enforced below)
  branch_depth integer default 0,
  context_card_type text,
  context_card_data jsonb,
  channel text default 'in_app',          -- in_app | telegram | whatsapp
  delivered_at timestamptz default now(),
  read_at timestamptz,
  deleted_at timestamptz,                 -- soft delete, recoverable
  is_proactive boolean default false,
  injection_topic text,
  unique (id, thread_id),                 -- target for the parent self-FK below
  -- Tenant integrity: the message's thread must belong to the same user — blocks a
  -- service-role bug from linking a message into another tenant's thread (#5).
  foreign key (thread_id, user_id) references chat_threads (id, user_id) on delete cascade,
  -- A reply must live in its parent's thread (nullable parent → unenforced via MATCH SIMPLE).
  foreign key (parent_message_id, thread_id) references chat_messages (id, thread_id)
);

alter table chat_messages enable row level security;
alter table chat_messages force row level security;
revoke all on chat_messages from anon, authenticated;
grant select on chat_messages to authenticated;
grant select, insert, update, delete on chat_messages to service_role;
create policy chat_messages_select_own on chat_messages
  for select to authenticated
  using (user_id = (select app_user_id()));

create index idx_chat_messages_thread on chat_messages (thread_id, delivered_at desc);
create index idx_chat_messages_parent on chat_messages (parent_message_id) where parent_message_id is not null;

-- §5 #13 — notification_log (push-budget enforcement). §5 principle 6: service role only.
-- idempotency_key unique = dedupe guard for the delivery outbox.
create table notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  sent_at timestamptz default now(),
  notification_type text not null,
  channel text not null,
  is_standalone boolean default false,
  apns_collapse_id text,
  idempotency_key text not null,          -- every send carries a dedupe key — outbox guarantee (#4)
  unique (idempotency_key)
);

alter table notification_log enable row level security;
alter table notification_log force row level security;
revoke all on notification_log from anon, authenticated;
grant select, insert, update, delete on notification_log to service_role;
