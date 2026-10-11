-- Series read for the score producer (H4a), and the one fact it needs that ingest used to discard: the zone a reading was
-- uploaded in. A day's score is computed over that day's own local hours, and a sample's offset alone does not name the
-- zone (+01:00 is Lagos all year and Paris in winter), so the batch zone is stored with each sample, never relabelled
-- later, and a day that spans two zones keeps each reading's own. Rows written before this migration have no zone
-- (none exist on any hosted database yet: no ingest route has been served); the reader returns them with a null zone.
alter table waldo.health_samples add column timezone text check (timezone is null or char_length(timezone) between 1 and 64);

-- waldo.health_ingest is re-created whole with exactly three changes against 20261011000000: the batch zone is written on
-- insert and on conflict, and a tombstone clears it. Signature and grants are unchanged.
create or replace function waldo.health_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_source text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_consent waldo.health_consents;
  v_epoch integer; v_anchor text; v_change jsonb; v_signal text; v_sample_id text; v_revision bigint; v_day date; v_start timestamptz; v_end timestamptz;
  v_offset integer; v_value numeric; v_unit text; v_lo numeric; v_hi numeric; v_windowed boolean; v_stored waldo.health_samples; v_local_start date; v_local_end date;
  v_accepted integer := 0; v_deleted integer := 0; v_ignored integer := 0; v_now_epoch bigint := extract(epoch from now())::bigint; v_result jsonb;
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
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect') then return '{"error":"invalid_request"}'; end if;
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
  for v_change in select value from jsonb_array_elements(v_body->'samples') loop
    v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
    select r.unit, r.lo, r.hi, r.windowed into v_unit, v_lo, v_hi, v_windowed from (values
      ('sleep_duration','minutes',0,1440,false), ('sleep_efficiency','ratio',0,1,false), ('sleep_midpoint','local_minute',0,1439.999,false),
      ('overnight_hrv','milliseconds',0.000001,1000,false), ('resting_heart_rate','beats_per_minute',0.000001,300,false),
      ('daylight_duration','minutes',0,60,true), ('movement_duration','minutes',0,60,true), ('heart_rate_window','beats_per_minute',0.000001,300,true),
      ('hrv_window','milliseconds',0.000001,1000,true), ('spo2','percent',50,100,false), ('respiratory_rate','breaths_per_minute',4,80,false),
      ('steps_window','count',0,300000,true), ('active_energy_window','kilocalories',0,30000,true), ('workout','minutes',0,1440,false)
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
      or (v_signal in ('overnight_hrv','hrv_window') and coalesce(v_change->>'method','') not in ('rmssd','sdnn')) then raise exception 'invalid health sample' using errcode = '22023'; end if;
    if v_end < now() - interval '90 days' then v_ignored := v_ignored + 1; continue; end if;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.revision = v_revision then
      -- Where a reading was read from may change without its value changing; only the readings themselves conflict.
      if v_stored.payload is not null and ((v_stored.payload - 'origin') is distinct from (v_change - 'origin')) then raise exception 'health sample revision conflict' using errcode = '40001'; end if;
      v_ignored := v_ignored + 1; continue;
    end if;
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, timezone, payload, deleted_at)
      values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, v_day, v_start, v_end, v_offset, v_body->>'timezone', v_change, null)
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = excluded.day, start_at = excluded.start_at,
        end_at = excluded.end_at, utc_offset_minutes = excluded.utc_offset_minutes, timezone = excluded.timezone, payload = excluded.payload, deleted_at = null;
    v_accepted := v_accepted + 1;
  end loop;
  for v_change in select value from jsonb_array_elements(v_body->'deletions') loop
    v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
    if v_signal is null or v_signal not in ('sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout')
      or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$' or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]{1,15}$'
      or (v_change->>'revision')::bigint > v_now_epoch + 300 then raise exception 'invalid health deletion' using errcode = '22023'; end if;
    v_revision := (v_change->>'revision')::bigint;
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
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'ingest', md5(p_payload), v_result);
  return v_result;
exception
  when data_exception then return '{"error":"invalid_request"}';
  when serialization_failure then return '{"error":"sample_conflict"}';
end $$;

-- The producer's read: one owner's readings for a bounded run of local days, with the consent each source holds, taken in a
-- single statement so the epochs and the readings come from one snapshot. The producer builds the basis only from sources that
-- returned readings and the write fence in health_context_write refuses a row whose epoch moved afterwards, so a withdraw and
-- regrant during a compute cannot store a row from withdrawn data. Only sources holding live storage consent are returned.
-- access says why there is nothing to compute from: consent_required (never granted) or consent_withdrawn (every grant withdrawn).
create function waldo.health_series_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_from date; v_to date; v_signals text[];
  v_all constant text[] := array['sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout'];
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
    if jsonb_typeof(v_body->'signals') is distinct from 'array' or jsonb_array_length(v_body->'signals') not between 1 and 14
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
      select l.source, h.signal, h.day, h.start_at, h.end_at, h.utc_offset_minutes, h.timezone, h.payload,
        row_number() over (partition by l.source order by h.day, h.start_at, h.signal, h.sample_id) as n
      from live l join waldo.health_samples h on h.owner_id = v_owner and h.source = l.source
      where h.payload is not null and h.day between v_from and v_to and h.signal = any (v_signals)
    )
    select jsonb_build_object(
      'access', case
        when exists (select 1 from live) then 'granted'
        when exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_withdrawn'
        else 'consent_required' end,
      'read_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sources', coalesce((select jsonb_agg(jsonb_build_object(
          'source', l.source, 'consent_epoch', l.epoch,
          'truncated', exists (select 1 from picked p where p.source = l.source and p.n > v_cap),
          'samples', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'signal', p.signal, 'day', p.day,
              'start_at', to_char(p.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'end_at', to_char(p.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'utc_offset_minutes', p.utc_offset_minutes, 'timezone', p.timezone,
              'value', p.payload->'value', 'method', p.payload->'method', 'activity', p.payload->'activity')) order by p.n)
            from picked p where p.source = l.source and p.n <= v_cap), '[]'::jsonb)) order by l.source) from live l), '[]'::jsonb))
  );
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
revoke all on function waldo.health_series_read(text,text,bigint,text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_series_read(text,text,bigint,text) to anon;
