-- D5 health context read (Art-9 read-only slice): the owner's derived daily health context
-- rides the signed router RPC from the owner's DO into the composer's health material slot.
-- Read-only: returns derived pillar scores/zones, never raw metric streams. The
-- redact-to-zone transform (ADR-0024) happens runtime-side before any of this reaches a
-- prompt; the model never touches these tables. The app-owned public.health_context_daily
-- table is applied by the companion app repo's migrations; plpgsql bodies bind late, so this
-- function deploys cleanly ahead of it and errors (caught, logged, degraded to absence)
-- until it exists. It deliberately does not touch public.health_daily: that name is owned by
-- this repo's older HEY-9 columnar schema (a cross-repo collision with the app repo's
-- same-named jsonb table), so pillar coverage derives from which context pillars are present
-- instead.
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
    )
    from public.health_context_daily c
    where c.user_id = v_auth
    order by c.day desc
    limit 1
  );
end $$;

revoke all on function waldo.health_context_read(text, bigint, text) from public;
grant execute on function waldo.health_context_read(text, bigint, text) to anon;
