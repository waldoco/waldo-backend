-- ONLY for a new isolated, synthetic test database. Never run on shared/live state.
create extension if not exists pgcrypto with schema extensions;
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  created_at timestamptz default now(), updated_at timestamptz,
  not_after timestamptz, refreshed_at timestamptz
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(auth.jwt()->>'sub','')),'')::uuid
$$;
