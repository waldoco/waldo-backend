-- Score history for the app's chart: the owner's stored derived rows for the last 7, 30 or 90 local days, oldest first. Each
-- day is its three pillars as stored (state, zone, score, activation and the baseline label inside each), and nothing of the
-- day's drivers, windows, sleep debt, readings or freshness. A day with no row is absent, never a zero.
-- - The window ends on the owner's own today, by the zone their latest row was computed in, so an owner east or west of UTC
--   gets their own seven days and not a day of UTC's.
-- - A window holds at most 90 distinct days, so the answer is capped by construction.
-- - The read is owner-scoped through the router-signed owner lookup and returns a day only while its consent basis is live
--   for storage and compute, as waldo.health_scores_read does; the reasons for nothing to show are the same ladder.
-- - backfilled is returned for a day only when the row's own backfilled column is true. The column does not exist yet; the
--   read looks the key up by name in the row, so it picks the column up the day it is added and needs no re-creation.
-- Writes nothing and adds no table. Signature and grants follow the sibling health reads: router-signed, anon execute only.
create function waldo.health_scores_history(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_window integer; v_tz text; v_from date; v_to date; v_days jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.scores_history.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'days')
    or jsonb_typeof(v_body->'days') is distinct from 'number' or (v_body->>'days') not in ('7', '30', '90') then return '{"error":"invalid_request"}'; end if;
  v_window := (v_body->>'days')::integer;
  select b.timezone into v_tz
    from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and waldo.health_basis_live(v_owner, b.consent_basis, false)
    order by c.day desc limit 1;
  if v_tz is not null then
    if not exists (select 1 from pg_timezone_names where name = v_tz) then v_tz := 'UTC'; end if;
    v_to := (now() at time zone v_tz)::date;
    v_from := v_to - (v_window - 1);
    select jsonb_agg(jsonb_build_object('day', c.day, 'recovery', c.recovery, 'form', c.form, 'weight', c.weight)
        || case when to_jsonb(c) -> 'backfilled' = 'true'::jsonb then '{"backfilled":true}'::jsonb else '{}'::jsonb end order by c.day)
      into v_days
      from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
      where c.user_id = v_auth and c.day between v_from and v_to and waldo.health_basis_live(v_owner, b.consent_basis, false);
    if v_days is not null then return jsonb_build_object('history', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_days)); end if;
  end if;
  -- No row to show: say why, as the day read does.
  return jsonb_build_object('unavailable', case
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_required'
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute' and c.withdrawn_at is null) then 'consent_withdrawn'
    else 'no_readings' end);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

revoke all on function waldo.health_scores_history(text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_scores_history(text, text, bigint, text) to anon;
