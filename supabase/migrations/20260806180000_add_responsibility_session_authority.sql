-- Trusted session authority for the public responsibility adapter.
-- The caller supplies no identifiers: both user and session come from verified JWT claims.
create function public.waldo_responsibility_session_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from auth.sessions as active_session
    where active_session.user_id = auth.uid()
      and active_session.id = case
        when coalesce(auth.jwt() ->> 'session_id', '') ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          then (auth.jwt() ->> 'session_id')::uuid
        else null
      end
      and (
        active_session.not_after is null
        or active_session.not_after > now()
      )
  );
$function$;

revoke all on function public.waldo_responsibility_session_active() from public;
revoke all on function public.waldo_responsibility_session_active() from anon;
revoke all on function public.waldo_responsibility_session_active() from authenticated;
revoke all on function public.waldo_responsibility_session_active() from service_role;
grant execute on function public.waldo_responsibility_session_active() to authenticated;

comment on function public.waldo_responsibility_session_active() is
  'Returns whether the authenticated JWT user/session pair still has a live auth.sessions row.';
