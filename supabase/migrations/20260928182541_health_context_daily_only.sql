create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Narrow shared-staging migration: derived daily health context only.
create table public.health_context_daily (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  day          date not null,
  form         jsonb,
  recovery     jsonb,
  weight       jsonb,
  tier2        jsonb,
  drivers      jsonb not null default '[]'::jsonb,
  confidence   numeric,
  freshness    text,
  tags         text[] not null default '{}',
  evidence     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, day)
);

create index health_context_user_day_idx
  on public.health_context_daily (user_id, day desc);

create trigger health_context_set_updated_at
  before update on public.health_context_daily
  for each row execute function public.set_updated_at();

alter table public.health_context_daily enable row level security;

create policy "own rows" on public.health_context_daily
  for select using (auth.uid() = user_id);
