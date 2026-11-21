-- The model's body read: today's readings against the owner's usual, the parts of each score, the day's load and the hours of
-- strain at rest, from the derived row the model's health block already stands on. The Worker turns them into closed words (which
-- way, whether far, tenths of the sleep need, clock ranges) and never passes a figure to the prompt.
-- - waldo.health_body_read(do_name, payload, at, sig) is new. Payload {}. It answers {"body": ...} for the same row
--   waldo.health_context_read gives the model: the owner's newest row that is not backfilled and whose basis has live storage and
--   model-use grants. It returns the row's day, its parts (components) and usual bands, and, only while the row is the owner's own
--   today by its zone, the day's load, today's stress curve and what changed today. No row is null. Router-signed like the other
--   health reads; granted to anon as they are.
-- Basis: docs/app/HEALTH_PLANE_AMENDMENT.md ruling 2, the owner's derived health context may reach model context, here only under
-- live storage and model-use grants for the row's basis, as waldo.health_context_read is. The values reach the owner's Worker for
-- that turn's prompt alone, which is given words and clock times; nothing of them is stored, logged or traced by this read.
-- No table, column or existing function changes. Rollback: supabase/rollback/20261121130000_health_body_read.down.sql.
create function waldo.health_body_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.body_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 64 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if v_body is distinct from '{}'::jsonb then return '{"error":"invalid_request"}'; end if;
  return (
    select jsonb_build_object('body', jsonb_build_object('day', c.day)
      || case when c.components is null then '{}'::jsonb else jsonb_build_object('components', c.components) end
      || case when c.usual is null then '{}'::jsonb else jsonb_build_object('usual', c.usual) end
      || case when c.day <> (now() at time zone b.timezone)::date then '{}'::jsonb else
           case when c.day_load is null then '{}'::jsonb else jsonb_build_object('day_load', c.day_load) end
           || case when c.stress_curve is null then '{}'::jsonb else jsonb_build_object('stress_curve', c.stress_curve) end
           || case when c.changes is null then '{}'::jsonb else jsonb_build_object('changes', c.changes) end
         end)
    from public.health_context_daily c
    join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and c.backfilled is not true and waldo.health_basis_live(v_owner, b.consent_basis, true)
    order by c.day desc
    limit 1
  );
end $$;
revoke all on function waldo.health_body_read(text,text,bigint,text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_body_read(text,text,bigint,text) to anon;
