do $assertion$
declare
  actual text[];
  expected constant text[] := array[
    '20260709171312',
    '20260709171336',
    '20260709171359',
    '20260709171417',
    '20260709171953',
    '20260709172043',
    '20260710182949',
    '20260806180000',
    '20260924120000',
    '20260924130000',
    '20260924140000',
    '20260924150000',
    '20260924160000',
    '20260924170000',
    '20260924180000',
    '20260924190000',
    '20260925000000',
    '20260925010000',
    '20260925102000',
    '20260925110000',
    '20260925120000',
    '20260925130000',
    '20260925170000',
    '20260926100000',
    '20260926110000'
  ];
begin
  select array_agg(version::text order by version::text)
  into actual
  from supabase_migrations.schema_migrations;

  if actual is distinct from expected then
    raise exception 'migration history drifted: expected %, actual %', expected, actual;
  end if;
end
$assertion$;
