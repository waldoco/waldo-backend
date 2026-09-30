-- Derived health context: owner JWT reads; trusted ingestion owns writes.
-- Keep the already-applied table/rows/helper intact and normalize default ACLs.
revoke all on table public.health_context_daily from public, anon, authenticated, service_role;
grant select on table public.health_context_daily to authenticated;
grant select, insert, update on table public.health_context_daily to service_role;

-- Owner RLS also applies to non-bypass table owners; the trusted Supabase writer
-- uses BYPASSRLS. This does not grant authenticated clients a write policy.
alter table public.health_context_daily force row level security;

-- Trigger invocation does not require direct caller EXECUTE after creation.
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
