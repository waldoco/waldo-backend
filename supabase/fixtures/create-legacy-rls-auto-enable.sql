-- CI-only Project Woof drift fixture. This function is never part of the canonical schema.
create function public.rls_auto_enable()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $$
begin
  null;
end;
$$;

grant execute on function public.rls_auto_enable() to public, anon, authenticated, service_role;
