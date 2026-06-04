-- HEY-9 · Supabase schema · 0005 devices, integrations, billing
-- Source: WALDO_V1_MASTER_PLAN.md §5 #8,9,14,15.
-- oauth_tokens and one_time_tokens hold credentials / bearer secrets → service-role only
-- (health-data-security: secrets are never client-readable; connected-account display is
-- projected by an EF, not by reading these rows). user_devices/subscriptions are client-read.

-- §5 #8 — user_devices (push tokens, one row per device)
create table user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  platform text not null,                 -- ios | android
  push_token text,
  token_type text,                        -- apns | fcm | apns-sandbox
  is_active boolean default true,
  last_seen timestamptz default now(),
  unique (user_id, push_token)
);

alter table user_devices enable row level security;
alter table user_devices force row level security;
revoke all on user_devices from anon, authenticated;
grant select on user_devices to authenticated;
grant select, insert, update, delete on user_devices to service_role;
create policy user_devices_select_own on user_devices
  for select to authenticated
  using (user_id = (select app_user_id()));

-- §5 #9 — oauth_tokens (encrypted credentials via Supabase Vault). Service-role only.
create table oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,                 -- google | whoop | oura | garmin
  account_label text,                     -- work | personal
  account_email text,
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  scopes text[],
  last_sync_at timestamptz,
  sync_error text,
  sync_error_since timestamptz,
  is_active boolean default true,
  -- NULLS NOT DISTINCT (PG15+) so a null account_email can't create duplicate (user,provider)
  -- connections — a null is treated as equal, capping it at one row per provider (#4).
  unique nulls not distinct (user_id, provider, account_email)
);

alter table oauth_tokens enable row level security;
alter table oauth_tokens force row level security;
revoke all on oauth_tokens from anon, authenticated;
grant select, insert, update, delete on oauth_tokens to service_role;

-- §5 #14 — one_time_tokens (Telegram link + OAuth PKCE state + password reset). Bearer
-- secrets, created/consumed by EFs → service-role only. used_at set on consume (single-use).
create table one_time_tokens (
  token text primary key,                 -- cryptographically random, 32 bytes hex
  user_id uuid references users(id) on delete cascade,
  kind text not null,                     -- telegram_link | oauth_state | password_reset
  metadata jsonb,                         -- oauth: { provider, code_verifier, redirect_uri }
  expires_at timestamptz not null,        -- telegram_link: 10min · oauth_state: 5min
  used_at timestamptz
);

alter table one_time_tokens enable row level security;
alter table one_time_tokens force row level security;
revoke all on one_time_tokens from anon, authenticated;
grant select, insert, update, delete on one_time_tokens to service_role;

create index idx_one_time_tokens_expires on one_time_tokens (expires_at);

-- §5 #15 — subscriptions (RevenueCat state, source of truth for tier gating). Written by the
-- RevenueCat webhook (service role); client reads own tier.
create table subscriptions (
  user_id uuid primary key references users(id) on delete cascade,
  tier text not null default 'free',      -- free | pro
  status text not null default 'active',  -- active | trial | expired | cancelled | grace_period
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  revenuecat_user_id text unique,
  store text,                             -- app_store | play_store
  updated_at timestamptz default now()
);

alter table subscriptions enable row level security;
alter table subscriptions force row level security;
revoke all on subscriptions from anon, authenticated;
grant select on subscriptions to authenticated;
grant select, insert, update, delete on subscriptions to service_role;
create policy subscriptions_select_own on subscriptions
  for select to authenticated
  using (user_id = (select app_user_id()));
