do $$
declare delta integer;
begin
  select count(*) into delta from (
    (select * from public.imessage_proof_catalog except
      select kind, identity, definition from public.imessage_proof_current)
    union all
    (select * from public.imessage_proof_current except
      select * from public.imessage_proof_catalog)
  ) differences;
  if delta <> 0 then raise exception 'catalog restoration failed: %', delta; end if;
end $$;
select 'PASS catalog restored';
