-- HEY-9 · Supabase schema · 0001 identity & consent
-- Source of truth: WALDO_V1_MASTER_PLAN.md §5 (canonical 16-table set, HEY-119).
-- Base DDL shape: ADR-0061 (partitioning) is `proposed`, so no composite/partition PKs.
-- Access model: clients read own rows via RLS; all writes go through service-role
-- Edge Functions / the DO agent (overview §9), which bypass RLS.

-- §5 #1 — users. auth_id links app identity to Supabase Auth; auth.uid() returns auth.users.id.
create table users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid not null references auth.users(id),
  name text not null,
  email text not null,
  timezone text not null default 'UTC',
  wake_time time not null default '07:30',
  evening_time time not null default '21:00',
  day_type text,                          -- 9-5 | back-to-back | deep-work | unpredictable
  priorities text[],                      -- energy | stress | schedule | sleep
  stress_signs text[],                    -- can't-focus | snapping | heavy-body | push-crash
  autonomy_level text not null default 'suggest',  -- tell | suggest | move
  profession text,                        -- backend-inferred only, not user-editable
  wearable_type text not null default 'unknown',
  sources_active text[],
  onboarding_completed_at timestamptz,
  tos_accepted_version text,              -- 'v1.0', 'v1.1' — must match MIN_TOS_VERSION
  tos_accepted_at timestamptz,
  telegram_user_id text unique,           -- set during onboarding Telegram link step
  telegram_linked_at timestamptz,
  created_at timestamptz default now(),
  unique (auth_id)
);

alter table users enable row level security;
alter table users force row level security;
revoke all on users from anon, authenticated;
grant select on users to authenticated;
-- service_role (EFs/agent) owns all writes; grants are explicit, not inherited from Supabase
-- defaults. Append-only immutability (agent_logs, notification_log, feedback_signals) is
-- enforced application-layer by AuditedDB (HEY-11), not by grants — and patrol_entries takes
-- legitimate post-insert updates (user_thumbs, importance_score), so grant-level append-only
-- is not viable here.
grant select, insert, update, delete on users to service_role;
-- Direct auth.uid() form (NOT app_user_id(): that reads users → would recurse).
create policy users_select_own on users
  for select to authenticated
  using (auth_id = (select auth.uid()));

-- Ownership helper for every user_id-scoped table. STABLE + SECURITY INVOKER so it
-- runs under the caller's RLS (reads only the caller's own users row) and is evaluated
-- once per query as an initplan. search_path='' + fully-qualified names per ADR-0060.
create function app_user_id()
  returns uuid
  language sql
  stable
  security invoker
  set search_path = ''
as $$
  select id from public.users where auth_id = (select auth.uid())
$$;
revoke all on function app_user_id() from public;
grant execute on function app_user_id() to authenticated;

-- §5 #2 — user_consents (GDPR Art 9 health data = special category). Consent recorded
-- before first health write (enforced application-layer in ingestion EF). Append-only by
-- convention (legal record); retained for life of account.
create table user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  policy_version text not null,
  health_data_consent boolean not null,
  consented_at timestamptz default now(),
  ip_hash text,
  country_code text
);

alter table user_consents enable row level security;
alter table user_consents force row level security;
revoke all on user_consents from anon, authenticated;
grant select on user_consents to authenticated;
grant select, insert, update, delete on user_consents to service_role;
create policy user_consents_select_own on user_consents
  for select to authenticated
  using (user_id = (select app_user_id()));
