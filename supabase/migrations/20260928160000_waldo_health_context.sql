-- D5 health context read (Art-9 read-only slice): the owner's derived daily health context
-- rides the signed router RPC from the owner's DO into the composer's health material slot.
-- Read-only: returns derived pillar scores/zones and the day's input-key coverage, never raw
-- metric streams. The redact-to-zone transform (ADR-0024) happens runtime-side before any of
-- this reaches a prompt; the model never touches these tables. The app-owned public tables
-- (health_context_daily, health_daily) are applied by the companion app repo's migrations;
-- plpgsql bodies bind late, so this function deploys cleanly ahead of them and errors
-- (caught, logged, degraded to absence) until they exist.
create function waldo.health_context_read(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_auth uuid;
begin
  if not waldo.router_signed('healthctx.read.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select auth_user_id into v_auth from waldo.owners where do_name = p_do_name and state = 'active';
  if v_auth is null then return null; end if;
  return (
    select jsonb_build_object(
      'context', jsonb_build_object(
        'id', c.id,
        'day', c.day,
        'form', c.form,
        'recovery', c.recovery,
        'weight', c.weight,
        'drivers', c.drivers,
        'confidence', c.confidence,
        'freshness', c.freshness,
        'tags', c.tags
      ),
      'previous', (
        select jsonb_build_object('day', p2.day, 'form_score', (p2.form ->> 'score')::numeric)
        from public.health_context_daily p2
        where p2.user_id = v_auth and p2.day < c.day
        order by p2.day desc
        limit 1
      ),
      'sources', coalesce((
        select jsonb_agg(d.source order by d.source)
        from public.health_daily d
        where d.user_id = v_auth and d.day = c.day
      ), '[]'::jsonb),
      'input_keys', coalesce((
        select jsonb_agg(k.key order by k.key)
        from (
          select distinct k2.key
          from public.health_daily d2, lateral jsonb_each(d2.inputs) k2
          where d2.user_id = v_auth and d2.day = c.day and k2.value is not null and k2.value <> 'null'::jsonb
        ) k
      ), '[]'::jsonb)
    )
    from public.health_context_daily c
    where c.user_id = v_auth
    order by c.day desc
    limit 1
  );
end $$;

revoke all on function waldo.health_context_read(text, bigint, text) from public;
grant execute on function waldo.health_context_read(text, bigint, text) to anon;
