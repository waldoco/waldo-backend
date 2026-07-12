-- HEY-125 staging prep hardening.
-- Project Woof 1 had public.rls_auto_enable() as SECURITY DEFINER and executable by
-- PUBLIC/anon/authenticated before the Waldo schema baseline was applied. Fresh databases do
-- not have this opt-in helper. Harden it where present without creating environment-specific
-- privileged code in the canonical migration chain.
do $migration$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public;
    revoke execute on function public.rls_auto_enable() from anon;
    revoke execute on function public.rls_auto_enable() from authenticated;
  end if;
end
$migration$;
