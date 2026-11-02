-- Health contract revision 12 (passive load): storage, read and fence. ADR-0081 amendment of 2 Nov 2026, §5a.
-- - waldo.health_samples takes heart_rate_bins_window: one local hour's heart rate as whole seconds per 5 bpm, inside and outside
--   the platform's workouts, a raw reading in the payload under the 90-day raw retention, the withdrawal purge and account
--   deletion, which remove whole rows by owner and source. No table is added. The beat stream and sample times stay on the phone.
-- - waldo.health_bins_valid is the reading's structural check: two arrays of one length (1 to 40) starting on the 5 bpm grid at
--   30 to 225 and ending at or below the 225 bin, whole seconds of at most an hour each, adding up to value.
-- - waldo.health_ingest is re-created whole from its last definition (20261031120000) with the new signal, its unit and bounds, and
--   that check. waldo.health_series_read is re-created whole from its last definition (20261031120000): it takes the new signal and
--   returns an hour's bins under `bins`, and an hourly heart-rate window's highest under `max`, from fixed key lists; the Worker's
--   reader ignores keys it does not know, so an older Worker is unaffected. Its 31-day window, row cap and truncated flag are unchanged.
-- - The day load's fence (20261102030000) keeps its v1 check as waldo.health_day_load_v1_valid, and waldo.health_day_load_valid now
--   admits that shape, a v1 load with parts that say why the passive part is missing, or a day-load.candidate.v2 load (the
--   observed-peak method, approximate, its own band and direction) with its parts and that day's v1 load beside it. The writer
--   calls it by name, so the writer is not re-created.
-- Signatures, security definer, search_path and grants are unchanged. Rollback: supabase/rollback/20261102080000_health_passive_load.down.sql.
alter table waldo.health_samples drop constraint health_samples_signal_check;
alter table waldo.health_samples add constraint health_samples_signal_check check (signal in ('sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate',
  'daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout',
  'wrist_temperature','walking_heart_rate_average','vo2_max','heart_rate_recovery','mindful_duration',
  'body_mass','body_fat_percentage','lean_body_mass','stand_hour','heart_rate_bins_window'));

create function waldo.health_bins_valid(p_change jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_n integer; v_from integer;
begin
  if jsonb_typeof(p_change->'outside_workouts') is distinct from 'array' or jsonb_typeof(p_change->'in_workouts') is distinct from 'array'
    or p_change->'bin_bpm' is distinct from '5'::jsonb or (p_change->>'from_bpm') !~ '^[0-9]{2,3}$' or (p_change->>'value') !~ '^[0-9]{1,4}$' then return false; end if;
  v_n := jsonb_array_length(p_change->'outside_workouts'); v_from := (p_change->>'from_bpm')::integer;
  if v_n not between 1 and 40 or jsonb_array_length(p_change->'in_workouts') <> v_n or v_from not between 30 and 225 or mod(v_from, 5) <> 0 or v_from + 5 * (v_n - 1) > 225 then return false; end if;
  return coalesce((
    select bool_and(jsonb_typeof(e.s) = 'number' and (e.s #>> '{}') ~ '^[0-9]{1,4}$' and (e.s #>> '{}')::integer <= 3600)
      and sum(case when (e.s #>> '{}') ~ '^[0-9]{1,4}$' then (e.s #>> '{}')::integer end) = (p_change->>'value')::integer
    from (select value as s from jsonb_array_elements(p_change->'outside_workouts') union all select value from jsonb_array_elements(p_change->'in_workouts')) e), false);
end $$;
revoke all on function waldo.health_bins_valid(jsonb) from public, anon, authenticated, service_role;

create or replace function waldo.health_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_source text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_consent waldo.health_consents;
  v_epoch integer; v_anchor text; v_change jsonb; v_signal text; v_sample_id text; v_revision bigint; v_day date; v_start timestamptz; v_end timestamptz;
  v_offset integer; v_value numeric; v_unit text; v_lo numeric; v_hi numeric; v_windowed boolean; v_stored waldo.health_samples; v_local_start date; v_local_end date;
  v_accepted integer := 0; v_deleted integer := 0; v_ignored integer := 0; v_now_epoch bigint := extract(epoch from now())::bigint; v_result jsonb;
  v_per_sample boolean; v_index integer; v_rejected jsonb := '[]';
  v_signals constant text[] := array['sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout',
    'wrist_temperature','walking_heart_rate_average','vo2_max','heart_rate_recovery','mindful_duration',
    'body_mass','body_fat_percentage','lean_body_mass','stand_hour','heart_rate_bins_window'];
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.ingest.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop') then return '{"error":"invalid_request"}'; end if;
  if v_body ? 'rejection' and v_body->'rejection' is distinct from '"per_sample"'::jsonb then return '{"error":"invalid_request"}'; end if;
  v_per_sample := v_body ? 'rejection';
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found and (v_prior.operation <> 'ingest' or v_prior.payload_digest <> md5(p_payload)) then return '{"error":"idempotency_conflict"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = 'storage_compute' for update;
  select * into v_consent from waldo.health_consents where id = v_scope.consent_id;
  if v_consent.id is null then return '{"error":"consent_required"}'; end if;
  if v_consent.withdrawn_at is not null then return '{"error":"consent_withdrawn"}'; end if;
  v_epoch := v_scope.epoch;
  -- A replay cannot bypass a later withdrawal or epoch change.
  if v_prior.request_id is not null then
    if v_epoch is distinct from (v_prior.response->>'consent_epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  if (v_body->>'consent_epoch') is null or (v_body->>'consent_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  if (v_body->>'consent_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;
  if jsonb_typeof(v_body->'samples') is distinct from 'array' or jsonb_typeof(v_body->'deletions') is distinct from 'array'
    or jsonb_array_length(v_body->'samples') + jsonb_array_length(v_body->'deletions') > 128
    or jsonb_typeof(v_body->'anchor_after') is distinct from 'string' or char_length(v_body->>'anchor_after') not between 1 and 2048
    or jsonb_typeof(v_body->'anchor_before') not in ('string','null')
    or not exists (select 1 from pg_timezone_names where name = v_body->>'timezone') then return '{"error":"invalid_request"}'; end if;
  -- The anchor is an opaque compare-and-set cursor. A null anchor is always a resync; samples are idempotent.
  if jsonb_typeof(v_body->'anchor_before') = 'string' then
    select anchor into v_anchor from waldo.health_anchors where owner_id = v_owner and source = v_source;
    if v_anchor is distinct from (v_body->>'anchor_before') then return '{"error":"anchor_conflict"}'; end if;
  end if;
  for v_change, v_index in select value, ordinality - 1 from jsonb_array_elements(v_body->'samples') with ordinality loop
    v_unit := null; v_signal := null;
    if v_per_sample and jsonb_typeof(v_change) = 'object' and v_change ? 'rejected' then
      -- The Worker's own rejection. Anything but its exact shape is a fault on our side, so the whole batch is refused.
      if coalesce(v_change->>'rejected' in ('invalid_sample','unsupported_signal'), false) is false or (v_change - 'rejected' - 'signal') <> '{}'::jsonb
        or coalesce(v_change->'signal' = 'null'::jsonb or v_change->>'signal' = any(v_signals), false) is false then raise exception 'invalid worker rejection' using errcode = '22023'; end if;
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('change','sample','index',v_index,'signal',v_change->'signal','reason',v_change->>'rejected'));
      continue;
    end if;
    begin
      v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
      select r.unit, r.lo, r.hi, r.windowed into v_unit, v_lo, v_hi, v_windowed from (values
        ('sleep_duration','minutes',0,1440,false), ('sleep_efficiency','ratio',0,1,false), ('sleep_midpoint','local_minute',0,1439.999,false),
        ('overnight_hrv','milliseconds',0.000001,1000,false), ('resting_heart_rate','beats_per_minute',0.000001,300,false),
        ('daylight_duration','minutes',0,60,true), ('movement_duration','minutes',0,60,true), ('heart_rate_window','beats_per_minute',0.000001,300,true),
        ('hrv_window','milliseconds',0.000001,1000,true), ('spo2','percent',50,100,false), ('respiratory_rate','breaths_per_minute',4,80,false),
        ('steps_window','count',0,300000,true), ('active_energy_window','kilocalories',0,30000,true), ('workout','minutes',0,1440,false),
        ('wrist_temperature','celsius',-5,42,false), ('walking_heart_rate_average','beats_per_minute',0.000001,300,false), ('vo2_max','ml_per_kg_min',10,90,false),
        ('heart_rate_recovery','beats_per_minute',0,120,false), ('mindful_duration','minutes',0,1440,false),
        ('body_mass','kilograms',20,400,false), ('body_fat_percentage','percent',2,75,false), ('lean_body_mass','kilograms',10,250,false), ('stand_hour','count',0,1,true),
        ('heart_rate_bins_window','seconds',1,3600,true)
      ) r(signal, unit, lo, hi, windowed) where r.signal = v_signal;
      if v_unit is null or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$'
        or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]{1,15}$'
        or jsonb_typeof(v_change->'value') is distinct from 'number' or v_change->>'unit' is distinct from v_unit
        or (v_change->>'utc_offset_minutes') is null or (v_change->>'utc_offset_minutes') !~ '^-?[0-9]{1,3}$' then raise exception 'invalid health sample' using errcode = '22023'; end if;
      v_revision := (v_change->>'revision')::bigint; v_value := (v_change->>'value')::numeric; v_offset := (v_change->>'utc_offset_minutes')::integer;
      v_day := (v_change->>'day')::date; v_start := (v_change->>'start_at')::timestamptz; v_end := (v_change->>'end_at')::timestamptz;
      if v_day is null or v_start is null or v_end is null or not isfinite(v_day) or not isfinite(v_start) or not isfinite(v_end) then raise exception 'invalid health sample' using errcode = '22023'; end if;
      v_local_start := ((v_start at time zone 'UTC') + make_interval(mins => v_offset))::date; v_local_end := ((v_end at time zone 'UTC') + make_interval(mins => v_offset))::date;
      -- A window is one local hour dated by its start and may still be running; a point record or a sleep session is over.
      if v_value not between v_lo and v_hi or v_offset not between -840 and 840 or v_start > v_end or v_revision > v_now_epoch + 300
        or (v_windowed and v_start > now() + interval '5 minutes') or (not v_windowed and v_end > now() + interval '5 minutes')
        or (v_windowed and v_day <> v_local_start) or (not v_windowed and v_day not in (v_local_start, v_local_end))
        or (v_windowed and (v_end - v_start <> interval '1 hour' or mod((extract(epoch from v_start)::bigint + v_offset * 60), 3600) <> 0))
        or (v_signal in ('overnight_hrv','hrv_window') and coalesce(v_change->>'method','') not in ('rmssd','sdnn'))
        -- A temperature's scale is its method's: an absolute night is 25 to 42 degrees, a delta against the platform's own
        -- baseline is -5 to 5, so a Fahrenheit value or a delta labelled absolute is caught.
        or (v_signal = 'wrist_temperature' and not coalesce((v_change->>'method' = 'absolute' and v_value between 25 and 42) or (v_change->>'method' = 'baseline_delta' and v_value between -5 and 5), false))
        -- An hour stood or did not: 0 or 1, never a fraction.
        or (v_signal = 'stand_hour' and v_value not in (0, 1))
        -- An hour's heart-rate bins: whole seconds in two arrays of one length on the 5 bpm grid, adding up to the covered seconds.
        or (v_signal = 'heart_rate_bins_window' and not waldo.health_bins_valid(v_change))
      then raise exception 'invalid health sample' using errcode = '22023'; end if;
    exception when data_exception then
      if not v_per_sample then raise; end if;
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('change','sample','index',v_index,'signal',case when v_unit is null then null else v_signal end,'reason','invalid_sample'));
      continue;
    end;
    if v_end < now() - interval '90 days' then v_ignored := v_ignored + 1; continue; end if;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.revision = v_revision then
      -- Where a reading was read from may change without its value changing; only the readings themselves conflict.
      if v_stored.payload is not null and ((v_stored.payload - 'origin') is distinct from (v_change - 'origin')) then
        if not v_per_sample then raise exception 'health sample revision conflict' using errcode = '40001'; end if;
        v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('change','sample','index',v_index,'signal',v_signal,'reason','revision_conflict'));
        continue;
      end if;
      v_ignored := v_ignored + 1; continue;
    end if;
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, timezone, payload, deleted_at)
      values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, v_day, v_start, v_end, v_offset, v_body->>'timezone', v_change, null)
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = excluded.day, start_at = excluded.start_at,
        end_at = excluded.end_at, utc_offset_minutes = excluded.utc_offset_minutes, timezone = excluded.timezone, payload = excluded.payload, deleted_at = null;
    v_accepted := v_accepted + 1;
  end loop;
  for v_change, v_index in select value, ordinality - 1 from jsonb_array_elements(v_body->'deletions') with ordinality loop
    v_signal := null;
    if v_per_sample and jsonb_typeof(v_change) = 'object' and v_change ? 'rejected' then
      if coalesce(v_change->>'rejected' in ('invalid_sample','unsupported_signal'), false) is false or (v_change - 'rejected' - 'signal') <> '{}'::jsonb
        or coalesce(v_change->'signal' = 'null'::jsonb or v_change->>'signal' = any(v_signals), false) is false then raise exception 'invalid worker rejection' using errcode = '22023'; end if;
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('change','deletion','index',v_index,'signal',v_change->'signal','reason',v_change->>'rejected'));
      continue;
    end if;
    begin
      v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
      if v_signal is null or v_signal <> all(v_signals)
        or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$' or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]{1,15}$'
        or (v_change->>'revision')::bigint > v_now_epoch + 300 then raise exception 'invalid health deletion' using errcode = '22023'; end if;
      v_revision := (v_change->>'revision')::bigint;
    exception when data_exception then
      if not v_per_sample then raise; end if;
      v_rejected := v_rejected || jsonb_build_array(jsonb_build_object('change','deletion','index',v_index,'signal',case when v_signal = any(v_signals) then v_signal end,'reason','invalid_sample'));
      continue;
    end;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.payload is null then
      -- A newer deletion of a deleted reading raises the tombstone, so an older late reading cannot come back.
      if v_stored.revision < v_revision then
        update waldo.health_samples set revision = v_revision, epoch = v_epoch where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
      end if;
      v_ignored := v_ignored + 1; continue;
    end if;
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, payload, deleted_at) values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, null, now())
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = null, start_at = null, end_at = null, utc_offset_minutes = null, timezone = null, payload = null, deleted_at = now();
    v_deleted := v_deleted + 1;
  end loop;
  insert into waldo.health_anchors(owner_id, source, epoch, anchor) values (v_owner, v_source, v_epoch, v_body->>'anchor_after')
    on conflict (owner_id, source) do update set epoch = excluded.epoch, anchor = excluded.anchor;
  v_result := jsonb_build_object('request_id', v_id, 'source', v_source, 'consent_epoch', v_epoch, 'accepted', v_accepted, 'deleted', v_deleted, 'ignored', v_ignored, 'anchor_after', v_body->>'anchor_after', 'replayed', false);
  if v_per_sample then v_result := v_result || jsonb_build_object('rejected', v_rejected); end if;
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'ingest', md5(p_payload), v_result);
  return v_result;
exception
  when data_exception then return '{"error":"invalid_request"}';
  when serialization_failure then return '{"error":"sample_conflict"}';
end $$;

create or replace function waldo.health_series_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_from date; v_to date; v_signals text[];
  v_all constant text[] := array['sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout',
    'wrist_temperature','walking_heart_rate_average','vo2_max','heart_rate_recovery','mindful_duration',
    'body_mass','body_fat_percentage','lean_body_mass','stand_hour','heart_rate_bins_window'];
  v_cap constant integer := 8000;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.series_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 1024 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('from','to','signals')) then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'from') is distinct from 'string' or (v_body->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(v_body->'to') is distinct from 'string' or (v_body->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_from := (v_body->>'from')::date; v_to := (v_body->>'to')::date;
  if v_to < v_from or v_to - v_from > 30 then return '{"error":"invalid_request"}'; end if;
  if v_body ? 'signals' then
    if jsonb_typeof(v_body->'signals') is distinct from 'array' or jsonb_array_length(v_body->'signals') not between 1 and cardinality(v_all)
      or exists (select 1 from jsonb_array_elements(v_body->'signals') s where jsonb_typeof(s) is distinct from 'string' or not ((s #>> '{}') = any (v_all))) then return '{"error":"invalid_request"}'; end if;
    select array_agg(distinct s #>> '{}') into v_signals from jsonb_array_elements(v_body->'signals') s;
  else
    v_signals := v_all;
  end if;
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
      'sources', coalesce((select jsonb_agg(jsonb_build_object(
          'source', l.source, 'consent_epoch', l.epoch,
          'truncated', exists (select 1 from picked p where p.source = l.source and p.n > v_cap),
          'samples', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'signal', p.signal, 'day', p.day,
              'start_at', to_char(p.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'end_at', to_char(p.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'utc_offset_minutes', p.utc_offset_minutes, 'timezone', p.timezone,
              'value', p.payload->'value', 'method', p.payload->'method', 'activity', p.payload->'activity',
              'samsung_writer', case when (p.payload #>> '{origin,source_package_name}') = 'com.sec.android.app.shealth' then true end,
              'stages', case when p.signal = 'sleep_duration' then p.payload->'stages' end,
              'max', case when p.signal = 'heart_rate_window' then p.payload->'max' end,
              'bins', case when p.signal = 'heart_rate_bins_window' then jsonb_build_object('from_bpm', p.payload->'from_bpm', 'outside_workouts', p.payload->'outside_workouts', 'in_workouts', p.payload->'in_workouts') end,
              'workout', case when p.signal = 'workout' then nullif(jsonb_strip_nulls(jsonb_build_object(
                'energy_kcal', p.payload->'energy_kcal', 'distance_m', p.payload->'distance_m', 'elevation_gain_m', p.payload->'elevation_gain_m',
                'avg_hr_bpm', p.payload->'avg_hr_bpm', 'max_hr_bpm', p.payload->'max_hr_bpm', 'hr_zones', p.payload->'hr_zones', 'effort', p.payload->'effort',
                'running', p.payload->'running', 'cycling', p.payload->'cycling', 'swimming', p.payload->'swimming')), '{}'::jsonb) end)) order by p.day, p.start_at, p.signal, p.sample_id)
            from picked p where p.source = l.source and p.n <= v_cap), '[]'::jsonb)) order by l.source) from live l), '[]'::jsonb))
  );
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

alter function waldo.health_day_load_valid(jsonb) rename to health_day_load_v1_valid;

-- A load's parts: shares of the day's load, unit-free. A v2 load's passive part is read, with its observed hours, and the two
-- shares add up (or are both 0 on a day with no load). A v1 load's passive part is missing with its reason, and the workouts are
-- all of the load or there is none.
create function waldo.health_day_load_parts_valid(p_parts jsonb, p_v2 boolean) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_w jsonb := p_parts->'workouts'; v_p jsonb := p_parts->'passive'; v_ws numeric; v_ps numeric;
begin
  if jsonb_typeof(p_parts) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(p_parts) k) is distinct from array['passive','workouts']
    or jsonb_typeof(v_w) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(v_w) k) is distinct from array['share']
    or jsonb_typeof(v_w->'share') is distinct from 'number' or jsonb_typeof(v_p) is distinct from 'object' then return false; end if;
  v_ws := (v_w->>'share')::numeric;
  if v_ws not between 0 and 1 then return false; end if;
  if not p_v2 then
    return (select array_agg(k order by k) from jsonb_object_keys(v_p) k) = array['reason','state'] and v_p->'state' = '"unavailable"'::jsonb
      and v_p->>'reason' in ('no_bins','sparse','no_zone_basis','zone_basis_low') and v_ws in (0, 1);
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v_p) k) is distinct from array['observed_hours','share','state'] or v_p->'state' is distinct from '"available"'::jsonb
    or jsonb_typeof(v_p->'share') is distinct from 'number' or (v_p->>'observed_hours') !~ '^[0-9]{1,2}$' or (v_p->>'observed_hours')::integer not between 12 and 25 then return false; end if;
  v_ps := (v_p->>'share')::numeric;
  return v_ps between 0 and 1 and ((v_ws = 0 and v_ps = 0) or abs(v_ws + v_ps - 1) <= 0.001);
end $$;
revoke all on function waldo.health_day_load_parts_valid(jsonb, boolean) from public, anon, authenticated, service_role;

create function waldo.health_day_load_valid(p_load jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_load) is distinct from 'object' then return false; end if;
  if p_load->'version' = '"day-load.candidate.v2"'::jsonb then
    -- The core of a v2 load is checked as a v1 load would be (score, band, direction), with its own method and label, and the day's
    -- v1 load beside it is a whole v1 load.
    return p_load ? 'parts' and p_load ? 'v1' and p_load->'method' = '"hr_zones_observed_peak"'::jsonb
      and waldo.health_day_load_v1_valid(jsonb_set(p_load - 'parts' - 'v1', '{version}', '"day-load.candidate.v1"'))
      and waldo.health_day_load_parts_valid(p_load->'parts', true) and waldo.health_day_load_v1_valid(p_load->'v1');
  end if;
  if p_load ? 'parts' then
    return p_load->'state' = '"available"'::jsonb and waldo.health_day_load_v1_valid(p_load - 'parts') and waldo.health_day_load_parts_valid(p_load->'parts', false);
  end if;
  return waldo.health_day_load_v1_valid(p_load);
end $$;
revoke all on function waldo.health_day_load_valid(jsonb) from public, anon, authenticated, service_role;
