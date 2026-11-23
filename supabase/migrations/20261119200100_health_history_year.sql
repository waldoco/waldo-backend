-- The Body screen's six months and year (HEY-483): the score history read takes 180 and 365 days beside 7, 30 and 90, ending on the
-- owner's own today as before. A day is the same row the shorter windows return, and a day with no row is left out, never a zero.
-- A day's parts are asked for only with 90 days or fewer, so a year's answer carries its scores alone. Derived rows are kept 733
-- days (waldo.health_retention_apply), so a year is held.
-- - waldo.health_scores_history is re-created whole from its last definition (20261116100000) with only those two changes.
-- Signature, security definer, search_path and grants are unchanged. Rollback: supabase/rollback/20261119200100_health_history_year.down.sql.
create or replace function waldo.health_scores_history(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_window integer; v_tz text; v_from date; v_to date; v_days jsonb; v_parts boolean;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.scores_history.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('days', 'parts'))
    or jsonb_typeof(v_body->'days') is distinct from 'number' or (v_body->>'days') not in ('7', '30', '90', '180', '365')
    or (v_body ? 'parts' and (v_body->'parts' is distinct from 'true'::jsonb or (v_body->>'days')::integer > 90)) then return '{"error":"invalid_request"}'; end if;
  v_parts := coalesce(v_body->'parts' = 'true'::jsonb, false);
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
        || case when to_jsonb(c) -> 'backfilled' = 'true'::jsonb then '{"backfilled":true}'::jsonb else '{}'::jsonb end
        || case when not v_parts or c.components is null then '{}'::jsonb else jsonb_build_object('components', c.components) end order by c.day)
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
