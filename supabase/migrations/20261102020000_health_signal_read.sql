-- Health contract revision 9 (one reading's daily series for the app's charts): the signed read behind GET /app/v1/health/signals.
-- waldo.health_signal_read is the owner's own readings over the last 7, 30 or 90 local days for the stored signals one chart needs,
-- in the shape waldo.health_series_read answers, so the Worker reduces them with the same code the scores use. Nothing is stored, and
-- no column or table changes. It differs from the model's series read in three ways: the span is the owner's last 7, 30 or 90 days
-- ending on their own today (the zone of their newest reading, from sources that hold a live storage_compute consent), not a caller's
-- dates; a read is for at most 8 stored signals from the closed list; and a source's read holds up to 14000 readings before it is
-- marked truncated, which the Worker answers by dropping the oldest, partial day. waldo.health_series_read is not changed.
-- Same signed-call, consent and ownership rules as every health read; the grant is the one the other health reads have.
-- Rollback: supabase/rollback/20261102020000_health_signal_read.down.sql.
create or replace function waldo.health_signal_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_window integer; v_tz text; v_from date; v_to date; v_signals text[];
  v_all constant text[] := array['sleep_duration','sleep_midpoint','sleep_efficiency','overnight_hrv','resting_heart_rate','heart_rate_window','hrv_window','daylight_duration','movement_duration','active_energy_window',
    'respiratory_rate','spo2','wrist_temperature','walking_heart_rate_average'];
  v_cap constant integer := 14000;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.signal_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 512 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('days','signals'))
    or jsonb_typeof(v_body->'days') is distinct from 'number' or (v_body->>'days') not in ('7','30','90')
    or jsonb_typeof(v_body->'signals') is distinct from 'array' or jsonb_array_length(v_body->'signals') not between 1 and 8
    or exists (select 1 from jsonb_array_elements(v_body->'signals') s where jsonb_typeof(s) is distinct from 'string' or not ((s #>> '{}') = any (v_all))) then return '{"error":"invalid_request"}'; end if;
  v_window := (v_body->>'days')::integer;
  select array_agg(distinct s #>> '{}') into v_signals from jsonb_array_elements(v_body->'signals') s;
  -- The owner's own today: the zone of the newest reading a live consent covers.
  select h.timezone into v_tz
    from waldo.health_samples h
    join waldo.health_scopes s on s.owner_id = h.owner_id and s.source = h.source and s.purpose = 'storage_compute'
    join waldo.health_consents c on c.id = s.consent_id and c.withdrawn_at is null
    where h.owner_id = v_owner and h.payload is not null and h.timezone is not null
    order by h.day desc, h.start_at desc nulls last limit 1;
  if v_tz is not null and not exists (select 1 from pg_timezone_names where name = v_tz) then v_tz := 'UTC'; end if;
  v_to := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  v_from := v_to - (v_window - 1);
  -- One statement, one snapshot: the consent each source holds and the readings it returned cannot disagree.
  return (
    with live as (
      select s.source, s.epoch from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
      where s.owner_id = v_owner and s.purpose = 'storage_compute' and c.withdrawn_at is null
    ), picked as (
      select l.source, h.signal, h.sample_id, h.day, h.start_at, h.end_at, h.utc_offset_minutes, h.timezone, h.payload,
        row_number() over (partition by l.source order by h.day desc, h.start_at desc, h.signal, h.sample_id) as n
      from live l join waldo.health_samples h on h.owner_id = v_owner and h.source = l.source
      where h.payload is not null and h.day between v_from and v_to and h.signal = any (v_signals)
    )
    select jsonb_build_object(
      'access', case
        when exists (select 1 from live) then 'granted'
        when exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_withdrawn'
        else 'consent_required' end,
      'read_at', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'from', v_from, 'to', v_to,
      'sources', coalesce((select jsonb_agg(jsonb_build_object(
          'source', l.source, 'consent_epoch', l.epoch,
          'truncated', exists (select 1 from picked p where p.source = l.source and p.n > v_cap),
          'samples', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'signal', p.signal, 'day', p.day,
              'start_at', to_char(p.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'end_at', to_char(p.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'utc_offset_minutes', p.utc_offset_minutes, 'timezone', p.timezone,
              'value', p.payload->'value', 'method', p.payload->'method',
              'samsung_writer', case when (p.payload #>> '{origin,source_package_name}') = 'com.sec.android.app.shealth' then true end,
              'stages', case when p.signal = 'sleep_duration' then p.payload->'stages' end)) order by p.day, p.start_at, p.signal, p.sample_id)
            from picked p where p.source = l.source and p.n <= v_cap), '[]'::jsonb)) order by l.source) from live l), '[]'::jsonb))
  );
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
revoke all on function waldo.health_signal_read(text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_signal_read(text, text, bigint, text) to anon;
