-- Health contract revision 16 (WHOOP depth): every kind WHOOP's API gives, stored, and WHOOP's consent copy 6.
-- - waldo.health_samples takes nine kinds: WHOOP's own scores provider_recovery (with calibrating), provider_day_strain (one
--   physiological cycle, with its energy, heart rate and steps, open while it runs), provider_sleep_need (with its parts),
--   provider_sleep_performance and provider_sleep_consistency, each labelled method 'whoop'; and nap, skin_temperature (absolute),
--   height and max_heart_rate (WHOOP's estimate). They are raw readings in the payload under the 90-day raw retention, the
--   withdrawal purge and account deletion, which remove whole rows by owner and source, so WHOOP data keeps the rolling retention
--   its terms require. No table is added. The signal check is the passive-load migration's (20261116110200) with these added.
-- - waldo.health_ingest is re-created whole from its last definition (20261116110200) with the nine kinds, their units and
--   bounds, and these checks: a provider score comes from the whoop source alone, says method 'whoop' and states its flag; it,
--   and a workout's provider strain, is stored only under a storage grant on copy 6 or later; a nap is asleep_duration or span;
--   skin temperature is absolute; max heart rate is the provider's estimate. Nothing else in it changes.
-- - waldo.health_series_read is re-created whole from its last definition (20261116110200). It takes the nine kinds and
--   returns, from fixed key lists: whoop_writer on a reading another app wrote that WHOOP's app wrote (bundle or package
--   com.whoop or com.whoop.*), so the Worker can prefer the WHOOP API's own record; a night's stage_totals; a provider score's
--   flag and parts under `provider`; and a workout's strain, recorded share and altitude change. The origin itself never
--   leaves. The Worker's reader ignores keys it does not know, so an older Worker is unaffected.
-- - WHOOP's consent notice moves to copy 6 (it adds that WHOOP's own scores are stored and that raw readings reach the AI
--   models). waldo.health_consent_view and waldo.health_consent_grant are re-created whole from 20261107090000: a WHOOP grant
--   may name copy 4, which an installed build still shows, or copy 6, and is stored on the copy it named; a device grant is
--   unchanged on copy 2. A grant not yet given reads as copy 6.
-- Replacing the samples check scans the populated table under a lock, as the passive-load migration did.
-- Signatures, security definer, search_path and grants are unchanged. Rollback: supabase/rollback/20261127120000_health_whoop_depth.down.sql.
alter table waldo.health_samples drop constraint health_samples_signal_check;
alter table waldo.health_samples add constraint health_samples_signal_check check (signal in ('sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate',
  'daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout',
  'wrist_temperature','walking_heart_rate_average','vo2_max','heart_rate_recovery','mindful_duration',
  'body_mass','body_fat_percentage','lean_body_mass','stand_hour','nutrition','heart_rate_bins_window',
  'provider_recovery','provider_day_strain','provider_sleep_need','provider_sleep_performance','provider_sleep_consistency','nap','skin_temperature','height','max_heart_rate'));

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
    'body_mass','body_fat_percentage','lean_body_mass','stand_hour','nutrition','heart_rate_bins_window',
    'provider_recovery','provider_day_strain','provider_sleep_need','provider_sleep_performance','provider_sleep_consistency','nap','skin_temperature','height','max_heart_rate'];
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
        ('nutrition','kilocalories',0,10000,false),
        ('heart_rate_bins_window','seconds',1,3600,true),
        ('provider_recovery','percent',0,100,false), ('provider_day_strain','strain',0,21,false), ('provider_sleep_need','minutes',0,1440,false),
        ('provider_sleep_performance','percent',0,100,false), ('provider_sleep_consistency','percent',0,100,false), ('nap','minutes',0,1440,false),
        ('skin_temperature','celsius',25,42,false), ('height','meters',0.5,2.75,false), ('max_heart_rate','beats_per_minute',100,250,false)
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
        -- A food entry's grams are each a number from 0 to 1000 and its meal one of five words; nothing else, a food's name
        -- included, is stored with it.
        or (v_signal = 'nutrition' and (
          exists (select 1 from jsonb_object_keys(v_change) k where k not in ('sample_id','revision','signal','unit','value','day','start_at','end_at','utc_offset_minutes','origin','protein_g','carbohydrate_g','fat_g','meal'))
          or exists (select 1 from unnest(array['protein_g','carbohydrate_g','fat_g']) k where v_change ? k and (jsonb_typeof(v_change->k) is distinct from 'number' or (v_change->>k)::numeric not between 0 and 1000))
          or (v_change ? 'meal' and coalesce(v_change->>'meal' not in ('breakfast','lunch','dinner','snack','unknown'), true))))
        -- An hour's heart-rate bins: whole seconds in two arrays of one length on the 5 bpm grid, adding up to the covered seconds.
        or (v_signal = 'heart_rate_bins_window' and not waldo.health_bins_valid(v_change))
        -- A provider's own score comes from that provider's source alone, says whose it is, and states its flag. It, and a
        -- workout's provider strain, is stored only under a storage grant on WHOOP's copy 6 or later, which names the scores.
        or (v_signal = any(array['provider_recovery','provider_day_strain','provider_sleep_need','provider_sleep_performance','provider_sleep_consistency'])
          and (v_source <> 'whoop' or v_change->>'method' is distinct from 'whoop' or coalesce(v_consent.version, 0) < 6))
        or (v_signal = 'provider_recovery' and jsonb_typeof(v_change->'calibrating') is distinct from 'boolean')
        or (v_signal = 'provider_day_strain' and jsonb_typeof(v_change->'open') is distinct from 'boolean')
        or (v_signal = 'workout' and v_change ? 'strain' and (v_source <> 'whoop' or coalesce(v_consent.version, 0) < 6))
        or (v_signal = 'nap' and coalesce(v_change->>'method' not in ('asleep_duration','span'), true))
        or (v_signal = 'skin_temperature' and v_change->>'method' is distinct from 'absolute')
        or (v_signal = 'max_heart_rate' and v_change->>'method' is distinct from 'provider_estimate')
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
    'body_mass','body_fat_percentage','lean_body_mass','stand_hour','nutrition','heart_rate_bins_window',
    'provider_recovery','provider_day_strain','provider_sleep_need','provider_sleep_performance','provider_sleep_consistency','nap','skin_temperature','height','max_heart_rate'];
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
              'whoop_writer', case when coalesce(p.payload #>> '{origin,source_bundle_id}', '') ~ '^com\.whoop(\.|$)' or coalesce(p.payload #>> '{origin,source_package_name}', '') ~ '^com\.whoop(\.|$)' then true end,
              'stage_totals', case when p.signal = 'sleep_duration' then p.payload->'stage_totals' end,
              'provider', case when p.signal in ('provider_recovery','provider_day_strain','provider_sleep_need') then nullif(jsonb_strip_nulls(jsonb_build_object(
                'calibrating', p.payload->'calibrating', 'open', p.payload->'open', 'energy_kcal', p.payload->'energy_kcal', 'avg_hr_bpm', p.payload->'avg_hr_bpm',
                'max_hr_bpm', p.payload->'max_hr_bpm', 'step_count', p.payload->'step_count', 'baseline_minutes', p.payload->'baseline_minutes',
                'debt_minutes', p.payload->'debt_minutes', 'strain_minutes', p.payload->'strain_minutes', 'nap_minutes', p.payload->'nap_minutes')), '{}'::jsonb) end,
              'stages', case when p.signal = 'sleep_duration' then p.payload->'stages' end,
              'max', case when p.signal = 'heart_rate_window' then p.payload->'max' end,
              'bins', case when p.signal = 'heart_rate_bins_window' then jsonb_build_object('from_bpm', p.payload->'from_bpm', 'outside_workouts', p.payload->'outside_workouts', 'in_workouts', p.payload->'in_workouts') end,
              'workout', case when p.signal = 'workout' then nullif(jsonb_strip_nulls(jsonb_build_object(
                'energy_kcal', p.payload->'energy_kcal', 'distance_m', p.payload->'distance_m', 'elevation_gain_m', p.payload->'elevation_gain_m',
                'avg_hr_bpm', p.payload->'avg_hr_bpm', 'max_hr_bpm', p.payload->'max_hr_bpm', 'hr_zones', p.payload->'hr_zones', 'effort', p.payload->'effort',
                'running', p.payload->'running', 'cycling', p.payload->'cycling', 'swimming', p.payload->'swimming',
                'strain', p.payload->'strain', 'percent_recorded', p.payload->'percent_recorded', 'elevation_change_m', p.payload->'elevation_change_m')), '{}'::jsonb) end,
              'nutrition', case when p.signal = 'nutrition' then nullif(jsonb_strip_nulls(jsonb_build_object(
                'protein_g', p.payload->'protein_g', 'carbohydrate_g', p.payload->'carbohydrate_g', 'fat_g', p.payload->'fat_g', 'meal', p.payload->'meal')), '{}'::jsonb) end)) order by p.day, p.start_at, p.signal, p.sample_id)
            from picked p where p.source = l.source and p.n <= v_cap), '[]'::jsonb)) order by l.source) from live l), '[]'::jsonb))
  );
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

create or replace function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,'version',coalesce(c.version,case when p_scope.source = 'whoop' then 6 else 2 end),
    'status',case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,'epoch',p_scope.epoch,
    'granted_at',to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at',to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state',case when c.withdrawn_at is null then 'not_required'
      when p_scope.purpose = 'model_processing' and exists (select 1 from waldo.health_scopes s2 join waldo.health_consents c2 on c2.id = s2.consent_id
        where s2.owner_id = p_scope.owner_id and s2.source = p_scope.source and s2.purpose = 'storage_compute' and c2.withdrawn_at is null) then 'not_required'
      else 'completed' end)
  from (select 1) x left join waldo.health_consents c on c.id = p_scope.consent_id $$;

create or replace function waldo.health_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_source text; v_purpose text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes;
  v_epoch integer; v_consent waldo.health_consents; v_result jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.consent_grant.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source'; v_purpose := v_body->>'purpose';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or (v_source = 'whoop' and coalesce(v_body->>'version' not in ('4','6'), true)) or (v_source <> 'whoop' and v_body->>'version' is distinct from '2') or v_body->>'age_attested_18_plus' is distinct from 'true'
    or (v_body->>'expected_epoch') is null or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  v_epoch := coalesce(v_scope.epoch, 0);
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'consent_grant' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    if not exists (select 1 from waldo.health_consents c where c.id = v_scope.consent_id and c.withdrawn_at is null) then return '{"error":"consent_withdrawn"}'; end if;
    if v_epoch is distinct from (v_prior.response->'consent'->>'epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  -- Model use sits on top of storage: it can be granted only while the same source holds live storage consent.
  if v_purpose = 'model_processing' and not exists (select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
    where s.owner_id = v_owner and s.source = v_source and s.purpose = 'storage_compute' and c.withdrawn_at is null) then return '{"error":"consent_required"}'; end if;
  if (v_body->>'expected_epoch')::integer <> v_epoch
    or exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.source = v_source and c.purpose = v_purpose and c.withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
  insert into waldo.health_consents(owner_id, source, purpose, version, age_attested_18_plus) values (v_owner, v_source, v_purpose, (v_body->>'version')::integer, true) returning * into v_consent;
  insert into waldo.health_scopes(owner_id, source, purpose, epoch, consent_id) values (v_owner, v_source, v_purpose, 1, v_consent.id)
    on conflict (owner_id, source, purpose) do update set epoch = waldo.health_scopes.epoch + 1, consent_id = excluded.consent_id returning * into v_scope;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_grant', md5(p_payload), v_result);
  return v_result;
end $$;
