do $assertion$
begin
  if has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception '0006 left the legacy helper executable by an app role';
  end if;

  if not has_function_privilege('service_role', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception '0006 removed the intended service-role execution grant';
  end if;
end
$assertion$;
