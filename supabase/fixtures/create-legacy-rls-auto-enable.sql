do $fixture$
begin
  -- CI-only Project Woof drift fixture. This function is never part of the canonical schema.
  -- Keep this as one top-level statement: `supabase db query --file` uses prepared execution.
  execute $create$
    create or replace function public.rls_auto_enable()
      returns event_trigger
      language plpgsql
      security definer
      set search_path = pg_catalog
    as $body$
    begin
      null;
    end;
    $body$;
  $create$;

  execute 'grant execute on function public.rls_auto_enable() to public, anon, authenticated, service_role';
end
$fixture$;
