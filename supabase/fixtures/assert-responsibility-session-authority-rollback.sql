do $assertion$
declare
  rollback_message text;
begin
  begin
    drop function public.waldo_responsibility_session_active();

    if to_regprocedure('public.waldo_responsibility_session_active()') is not null then
      raise exception 'responsibility session authority rollback did not remove the function';
    end if;

    raise exception 'expected responsibility session authority rollback';
  exception when raise_exception then
    get stacked diagnostics rollback_message = message_text;

    if rollback_message <> 'expected responsibility session authority rollback' then
      raise;
    end if;

    if to_regprocedure('public.waldo_responsibility_session_active()') is null then
      raise exception 'responsibility session authority rollback was not transactional';
    end if;
  end;
end
$assertion$;
