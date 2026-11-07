-- Google Health (Fitbit, Pixel Watch) is a cloud source on the same health plane as WHOOP, behind the same seam: its
-- tokens sit with the oauth-proxy Edge Function, its readings go through health_ingest, and its express authorization is
-- the two grants every source has. Its consent notice is its own, copy 4, which names Google's Limited Use terms and the AI
-- model providers that process the data. A Google Health user id is case-sensitive, so it is matched and signed exactly;
-- WHOOP's numeric ids keep their lowered match.
alter table waldo.health_consents drop constraint health_consents_source_check;
alter table waldo.health_consents add constraint health_consents_source_check check (source in ('apple','samsung','health_connect','whoop','google_health'));
alter table waldo.health_scopes drop constraint health_scopes_source_check;
alter table waldo.health_scopes add constraint health_scopes_source_check check (source in ('apple','samsung','health_connect','whoop','google_health'));
alter table waldo.health_samples drop constraint health_samples_source_check;
alter table waldo.health_samples add constraint health_samples_source_check check (source in ('apple','samsung','health_connect','whoop','google_health'));

-- waldo.health_consent_view: re-created whole from 20261021170000_health_consent_copy_version.sql; only the source list and copy version change.
create or replace function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,'version',coalesce(c.version,case p_scope.source when 'whoop' then 3 when 'google_health' then 4 else 2 end),
    'status',case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,'epoch',p_scope.epoch,
    'granted_at',to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at',to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state',case when c.withdrawn_at is null then 'not_required'
      when p_scope.purpose = 'model_processing' and exists (select 1 from waldo.health_scopes s2 join waldo.health_consents c2 on c2.id = s2.consent_id
        where s2.owner_id = p_scope.owner_id and s2.source = p_scope.source and s2.purpose = 'storage_compute' and c2.withdrawn_at is null) then 'not_required'
      else 'completed' end)
  from (select 1) x left join waldo.health_consents c on c.id = p_scope.consent_id $$;

-- waldo.health_consent_grant: re-created whole from 20261021170000_health_consent_copy_version.sql; only the source list and copy version change.
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
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop','google_health')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or v_body->>'version' is distinct from (case v_source when 'whoop' then '3' when 'google_health' then '4' else '2' end) or v_body->>'age_attested_18_plus' is distinct from 'true'
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
  insert into waldo.health_consents(owner_id, source, purpose, version, age_attested_18_plus) values (v_owner, v_source, v_purpose, case v_source when 'whoop' then 3 when 'google_health' then 4 else 2 end, true) returning * into v_consent;
  insert into waldo.health_scopes(owner_id, source, purpose, epoch, consent_id) values (v_owner, v_source, v_purpose, 1, v_consent.id)
    on conflict (owner_id, source, purpose) do update set epoch = waldo.health_scopes.epoch + 1, consent_id = excluded.consent_id returning * into v_scope;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_grant', md5(p_payload), v_result);
  return v_result;
end $$;

-- waldo.health_consent_withdraw: re-created whole from 20261021150000_health_wearables_zone_change.sql; only the source list and copy version change.
create or replace function waldo.health_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_source text; v_purpose text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_result jsonb; v_live integer; v_routed boolean;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.consent_withdraw.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source'; v_purpose := v_body->>'purpose';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop','google_health')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or (v_body->>'expected_epoch') is null or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'consent_withdraw' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
  if (v_body->>'expected_epoch')::integer <> v_scope.epoch then return '{"error":"epoch_conflict"}'; end if;
  if v_purpose = 'model_processing' then
    -- Model use only: the owner stops Waldo using the data, which stays stored and keeps flowing. Nothing is deleted
    -- and ingest is not fenced. Re-granting the purpose releases what was stored before, because the data was never
    -- removed and the owner chose to grant again.
    update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and purpose = 'model_processing' and withdrawn_at is null;
    get diagnostics v_live = row_count;
    if v_live > 0 then update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source and purpose = 'model_processing'; end if;
    v_routed := false;
  else
    -- Withdrawing storage withdraws both purposes for this source and removes its data: an upload queued before the
    -- withdrawal cannot repopulate it, and new processing needs fresh explicit grants. The derived rows may mix
    -- sources, so they are removed whole and rebuilt from what remains. Upload receipts go with the data; consent
    -- receipts stay so a replayed request still gets its answer.
    update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and withdrawn_at is null;
    get diagnostics v_live = row_count;
    if v_live > 0 then update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source; end if;
    delete from waldo.health_samples where owner_id = v_owner and source = v_source;
    delete from waldo.health_anchors where owner_id = v_owner and source = v_source;
    delete from waldo.health_requests where owner_id = v_owner and operation = 'ingest' and response->>'source' = v_source;
    delete from public.health_context_daily where user_id = v_auth;
    delete from waldo.health_context_basis where owner_id = v_owner;
    v_routed := true;
  end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', v_routed);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_withdraw', md5(p_payload), v_result);
  return v_result;
end $$;

-- waldo.health_freshness: re-created whole from 20261023120000_health_console_freshness.sql; only the source list and copy version change.
create or replace function waldo.health_freshness(p_owner uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sources', coalesce((select jsonb_agg(jsonb_build_object(
        'source', u.source,
        'newest_upload_at', to_char(u.newest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'uploads_7d', u.uploads_7d,
        'rejected_readings_7d', coalesce((select jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n) order by r.reason)
          from (select x->>'reason' as reason, count(*)::int as n from waldo.health_requests q cross join lateral jsonb_array_elements(coalesce(q.response->'rejected', '[]')) x
                where q.owner_id = p_owner and q.operation = 'ingest' and q.response->>'source' = u.source and q.created_at > now() - interval '7 days'
                  and x->>'reason' in ('invalid_sample','unsupported_signal','revision_conflict')
                group by 1) r), '[]'::jsonb)) order by u.source)
      from (select q.response->>'source' as source, max(q.created_at) as newest, (count(*) filter (where q.created_at > now() - interval '7 days'))::int as uploads_7d
            from waldo.health_requests q where q.owner_id = p_owner and q.operation = 'ingest' and q.response->>'source' in ('apple','samsung','health_connect','whoop','google_health')
            group by 1) u), '[]'::jsonb),
    'refusals_7d', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'status', f.status, 'count', f.n,
        'newest_at', to_char(f.newest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by f.code, f.status)
      from (select code, status, sum(refusals)::int as n, max(newest_at) as newest from waldo.health_ingest_refusals
            where owner_id = p_owner and day > (now() at time zone 'UTC')::date - 7 group by 1, 2) f), '[]'::jsonb),
    'newest_derived', (select jsonb_build_object('day', c.day, 'compiled_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      from public.health_context_daily c join waldo.owners o on o.auth_user_id = c.user_id join waldo.health_context_basis b on b.owner_id = o.id and b.day = c.day
      where o.id = p_owner order by c.day desc limit 1)) $$;

-- waldo.health_ingest: re-created whole from 20261031120000_health_coach_signals.sql; only the source list and copy version change.
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
    'body_mass','body_fat_percentage','lean_body_mass','stand_hour'];
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
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop','google_health') then return '{"error":"invalid_request"}'; end if;
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
        ('body_mass','kilograms',20,400,false), ('body_fat_percentage','percent',2,75,false), ('lean_body_mass','kilograms',10,250,false), ('stand_hour','count',0,1,true)
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

-- waldo.health_context_write: re-created whole from 20261101020000_health_zone_observed_peak.sql; only the source list and copy version change.
create or replace function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_pillar text; v_p jsonb; v_day date; v_conf numeric; v_tz text; v_entry jsonb;
  v_scope waldo.health_scopes; v_consent waldo.health_consents; v_read_at timestamptz; v_held timestamptz;
  v_old public.health_context_daily; v_old_basis jsonb; v_changed jsonb := '[]'::jsonb;
  -- The closed driver vocabulary: a signal's plain-word subject, an optional 'far', a direction, 'usual'. Nothing else, so no
  -- value, abbreviation or judgment can ride a driver into the prompt or the app.
  v_driver constant text := '^(breathing rate|wrist temperature|blood oxygen|awake time in the night|walking heart rate)( far)? (above|below) usual$';
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 16384 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','timezone','basis','form','recovery','weight','drivers','confidence','freshness','tags','read_at','sleep_debt','windows','windows_version','backfilled','training_load')) then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = v_body->>'timezone') then return '{"error":"invalid_request"}'; end if;
  v_tz := v_body->>'timezone';
  if v_body ? 'read_at' then
    if jsonb_typeof(v_body->'read_at') is distinct from 'string' or (v_body->>'read_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return '{"error":"invalid_request"}'; end if;
    v_read_at := (v_body->>'read_at')::timestamptz;
  end if;
  if jsonb_typeof(v_body->'day') is distinct from 'string' or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_day := (v_body->>'day')::date;
  -- A row is for a day the owner can be in: at most tomorrow by their own clock, within the aggregate retention.
  if v_day > (now() at time zone v_tz)::date + 1 or v_day < (now() at time zone v_tz)::date - 731 then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'basis') is distinct from 'array' or jsonb_array_length(v_body->'basis') not between 1 and 3
    or exists (select 1 from jsonb_array_elements(v_body->'basis') b where jsonb_typeof(b) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(b) k where k not in ('source','consent_epoch'))
      or b->>'source' is null or b->>'source' not in ('apple','samsung','health_connect','whoop','google_health')
      or jsonb_typeof(b->'consent_epoch') is distinct from 'number' or b->>'consent_epoch' !~ '^[0-9]{1,9}$')
    or (select count(distinct b->>'source') from jsonb_array_elements(v_body->'basis') b) <> jsonb_array_length(v_body->'basis') then return '{"error":"invalid_request"}'; end if;
  foreach v_pillar in array array['form','recovery','weight'] loop
    -- Every pillar is present, either available or unavailable with its reason, so the app never has to guess one.
    v_p := v_body->v_pillar;
    if jsonb_typeof(v_p) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
    if v_p ? 'reason' then
      -- An unavailable pillar says why and carries nothing else.
      if (select count(*) from jsonb_object_keys(v_p)) <> 1 or v_p->>'reason' not in ('not_linked','consent_required','consent_withdrawn','no_readings','baseline_immature','missing_sleep',
        'missing_resting_signal','stale_inputs','conflicting_inputs','intraday_inputs_unavailable','calendar_demand_unavailable') then return '{"error":"invalid_request"}'; end if;
    elsif exists (select 1 from jsonb_object_keys(v_p) k where k not in ('score','zone','drivers','confidence','algorithm_version','activation','hrv_method','baseline','used'))
      or jsonb_typeof(v_p->'score') is distinct from 'number' or (v_p->>'score')::numeric not between 0 and 100
      or jsonb_typeof(v_p->'zone') is distinct from 'string' or (v_p->>'zone') not in ('low','moderate','good','high','unknown')
      or jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
      or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')
      or (v_p ? 'hrv_method' and jsonb_typeof(v_p->'hrv_method') <> 'null' and (jsonb_typeof(v_p->'hrv_method') is distinct from 'string' or (v_p->>'hrv_method') not in ('rmssd','sdnn')))
      or (v_p ? 'confidence' and jsonb_typeof(v_p->'confidence') <> 'null' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p ? 'drivers' and (jsonb_typeof(v_p->'drivers') is distinct from 'array' or jsonb_array_length(v_p->'drivers') > 8
        or exists (select 1 from jsonb_array_elements(v_p->'drivers') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ v_driver)))
      -- The label and the provenance travel together. The label has exactly its four fields: a state that follows the count of
      -- the owner's own days against the fourteen needed, and a prior named only from the closed set. The provenance names the
      -- signals the pillar used from the closed list and the days they came from, as day strings only, so no reading rides it.
      or (v_p ? 'baseline') <> (v_p ? 'used')
      or (v_p ? 'baseline' and jsonb_typeof(v_p->'confidence') is distinct from 'number')
      or (v_p ? 'baseline' and (
        jsonb_typeof(v_p->'baseline') is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(v_p->'baseline') k) is distinct from array['needed','personal_days','prior','state']
        or jsonb_typeof(v_p #> '{baseline,state}') is distinct from 'string' or (v_p #>> '{baseline,state}') not in ('provisional','personal')
        or jsonb_typeof(v_p #> '{baseline,personal_days}') is distinct from 'number' or (v_p #>> '{baseline,personal_days}') !~ '^[0-9]{1,2}$'
        or jsonb_typeof(v_p #> '{baseline,needed}') is distinct from 'number' or (v_p #>> '{baseline,needed}') <> '14'
        or jsonb_typeof(v_p #> '{baseline,prior}') is distinct from 'string' or (v_p #>> '{baseline,prior}') not in ('adults','none')
        or (v_p #>> '{baseline,personal_days}')::int > 30
        or ((v_p #>> '{baseline,state}') = 'personal') <> ((v_p #>> '{baseline,personal_days}')::int >= 14)))
      or (v_p ? 'used' and (
        jsonb_typeof(v_p->'used') is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(v_p->'used') k) is distinct from array['days','signals']
        or jsonb_typeof(v_p #> '{used,signals}') is distinct from 'array' or jsonb_array_length(v_p #> '{used,signals}') not between 1 and 12
        or exists (select 1 from jsonb_array_elements(v_p #> '{used,signals}') s where jsonb_typeof(s) <> 'string'
          or (s #>> '{}') not in ('sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress','calendar','tasks','messages','physical_load'))
        or (select count(distinct s) from jsonb_array_elements(v_p #> '{used,signals}') s) <> jsonb_array_length(v_p #> '{used,signals}')
        or jsonb_typeof(v_p #> '{used,days}') is distinct from 'array' or jsonb_array_length(v_p #> '{used,days}') not between 1 and 31
        or exists (select 1 from jsonb_array_elements(v_p #> '{used,days}') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or (d #>> '{}')::date not between v_day - 31 and v_day)
        or (select count(distinct d) from jsonb_array_elements(v_p #> '{used,days}') d) <> jsonb_array_length(v_p #> '{used,days}')))
      then return '{"error":"invalid_request"}'; end if;
  end loop;
  if (v_body ? 'drivers' and (jsonb_typeof(v_body->'drivers') is distinct from 'array' or jsonb_array_length(v_body->'drivers') > 8 or exists (select 1 from jsonb_array_elements(v_body->'drivers') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ v_driver)))
    or (v_body ? 'tags' and (jsonb_typeof(v_body->'tags') is distinct from 'array' or jsonb_array_length(v_body->'tags') > 10 or exists (select 1 from jsonb_array_elements(v_body->'tags') t where jsonb_typeof(t) <> 'string' or char_length(t #>> '{}') > 40)))
    or (v_body ? 'confidence' and v_body->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->'confidence') is distinct from 'number' or (v_body->>'confidence')::numeric not between 0 and 1))
    or jsonb_typeof(v_body->'freshness') is distinct from 'string' or (v_body->>'freshness') not in ('fresh','stale','expired') then return '{"error":"invalid_request"}'; end if;
  -- Sleep debt, when sent, has exactly the shape the app reads: unavailable with its reason, partial with the recorded
  -- share of the window and no figure, or available with its weighted minutes and the basis of the need. The key-set CASE
  -- is parenthesised: PL/pgSQL ends an IF condition at the first THEN outside parentheses.
  if v_body ? 'sleep_debt' then
    v_p := v_body->'sleep_debt';
    if jsonb_typeof(v_p) is distinct from 'object' or jsonb_typeof(v_p->'state') is distinct from 'string'
      or (select array_agg(k order by k) from jsonb_object_keys(v_p) k where k <> 'trend') is distinct from (case v_p->>'state'
        when 'unavailable' then array['reason','state']
        when 'partial' then array['activation','algorithm_version','confidence','state']
        when 'available' then array['activation','algorithm_version','debt_minutes','need_basis','state'] end)
      or (v_p->>'state' = 'unavailable' and (jsonb_typeof(v_p->'reason') is distinct from 'string' or v_p->>'reason' not in ('not_linked','consent_required','consent_withdrawn','no_readings','baseline_immature','missing_sleep',
        'missing_resting_signal','stale_inputs','conflicting_inputs','intraday_inputs_unavailable','calendar_demand_unavailable')))
      or (v_p->>'state' <> 'unavailable' and (
        jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
        or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')))
      or (v_p ? 'trend' and (v_p->>'state' = 'unavailable' or jsonb_typeof(v_p->'trend') is distinct from 'string' or (v_p->>'trend') not in ('building','easing','steady')))
      or (v_p->>'state' = 'partial' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p->>'state' = 'available' and (jsonb_typeof(v_p->'debt_minutes') is distinct from 'number' or (v_p->>'debt_minutes')::numeric not between 0 and 20160
        or jsonb_typeof(v_p->'need_basis') is distinct from 'string' or (v_p->>'need_basis') not in ('owner_confirmed','own_average','blended_average'))) then return '{"error":"invalid_request"}'; end if;
  end if;
  -- Today's energy windows, when sent: one to four stretches of the day as 24-hour clock times in the row's zone, each ending
  -- after it starts, a kind of peak or dip and nothing else, with the version that computed them, together or not at all.
  if v_body ? 'windows' or v_body ? 'windows_version' then
    if not (v_body ? 'windows' and v_body ? 'windows_version')
      or jsonb_typeof(v_body->'windows') is distinct from 'array' or jsonb_array_length(v_body->'windows') not between 1 and 4
      or jsonb_typeof(v_body->'windows_version') is distinct from 'string' or (v_body->>'windows_version') !~ '^energy-windows\.v[0-9]+$'
      or exists (select 1 from jsonb_array_elements(v_body->'windows') win where jsonb_typeof(win) is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(win) k) is distinct from array['end','kind','start']
        or jsonb_typeof(win->'start') is distinct from 'string' or jsonb_typeof(win->'end') is distinct from 'string' or jsonb_typeof(win->'kind') is distinct from 'string'
        or (win->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (win->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'kind') not in ('peak','dip') or (win->>'start') collate "C" >= (win->>'end') collate "C") then return '{"error":"invalid_request"}'; end if;
  end if;
  -- The candidate training load, when sent: a closed phrase, its method, version and the candidate activation, or a closed
  -- reason. Exactly those keys, so no figure can ride it to the model.
  if v_body ? 'training_load' then
    v_p := v_body->'training_load';
    if jsonb_typeof(v_p) is distinct from 'object' or jsonb_typeof(v_p->'state') is distinct from 'string'
      or (v_p->>'state' = 'unavailable' and ((select array_agg(k order by k) from jsonb_object_keys(v_p) k) is distinct from array['reason','state']
        or jsonb_typeof(v_p->'reason') is distinct from 'string' or v_p->>'reason' not in ('no_readings','baseline_immature')))
      or (v_p->>'state' = 'available' and ((select array_agg(k order by k) from jsonb_object_keys(v_p) k) is distinct from array['activation','algorithm_version','method','phrase','state']
        or jsonb_typeof(v_p->'phrase') is distinct from 'string' or v_p->>'phrase' not in ('much lighter than usual','lighter than usual','about usual','heavier than usual','much heavier than usual')
        or jsonb_typeof(v_p->'method') is distinct from 'string' or v_p->>'method' not in ('hr_zones','hr_zones_observed_peak','effort','minutes')
        or v_p->'algorithm_version' is distinct from '"training-load.candidate.v1"'::jsonb or v_p->'activation' is distinct from '"candidate_unaccepted"'::jsonb))
      or v_p->>'state' not in ('available','unavailable') or v_body ? 'backfilled' then return '{"error":"invalid_request"}'; end if;
  end if;
  -- A backfilled row is a day recomputed from history that arrived late: true or absent (never false), for a day older than
  -- yesterday and within the ninety-day raw window, with Form and Weight unavailable and no windows.
  if v_body ? 'backfilled' then
    if v_body->'backfilled' is distinct from 'true'::jsonb
      or v_day > (now() at time zone v_tz)::date - 2 or v_day < (now() at time zone v_tz)::date - 90
      or not (v_body->'form' ? 'reason') or not (v_body->'weight' ? 'reason') or v_body ? 'windows' then return '{"error":"invalid_request"}'; end if;
  end if;
  -- Accepted is for the sources the amendment names. Which writer inside Health Connect may be accepted is decided by the
  -- computation authority, the producer, not here.
  if exists (select 1 from (select v_body->'recovery' as p union all select v_body->'form' union all select v_body->'weight' union all select v_body->'sleep_debt') x where x.p->>'activation' = 'accepted')
    and exists (select 1 from jsonb_array_elements(v_body->'basis') b where b->>'source' not in ('apple','oura','whoop','samsung','health_connect','google_health')) then return '{"error":"invalid_request"}'; end if;
  for v_entry in select value from jsonb_array_elements(v_body->'basis') loop
    select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_entry->>'source' and purpose = 'storage_compute';
    select * into v_consent from waldo.health_consents where id = v_scope.consent_id;
    if v_consent.id is null or v_consent.withdrawn_at is not null then return '{"error":"consent_required"}'; end if;
    if v_scope.epoch <> (v_entry->>'consent_epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
  end loop;
  -- Writes for one owner are serialised by the owner row lock above, so this check cannot race. The instant is the one the
  -- series read reported, so a producer that read before a newer ingest committed cannot replace a score computed after it.
  if v_read_at is not null then
    select b.read_at into v_held from waldo.health_context_basis b where b.owner_id = v_owner and b.day = v_day;
    if v_held is not null and v_held > v_read_at then return '{"written":false,"stale":true}'; end if;
  end if;
  -- A backfilled row never replaces a live one: the live row stands, and the answer is the stale one a late writer already gets.
  if v_body ? 'backfilled' and exists (select 1 from public.health_context_daily c where c.user_id = v_auth and c.day = v_day and c.backfilled is not true) then
    return '{"written":false,"stale":true}';
  end if;
  -- Which pillars moved to another zone word: against the row this write replaces or, for a day's first row, the newest
  -- earlier day. Only a row computed from the same sources is compared, so a switch of wearable is never a change. The
  -- answer names pillars only, never a zone or a score. The owner row lock above serialises this with every other write.
  select c.* into v_old from public.health_context_daily c where c.user_id = v_auth and c.day = v_day and c.backfilled is not true;
  if v_old.id is null then
    select c.* into v_old from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
      where c.user_id = v_auth and c.day < v_day and c.backfilled is not true order by c.day desc limit 1;
  end if;
  if v_old.id is not null then select b.consent_basis into v_old_basis from waldo.health_context_basis b where b.owner_id = v_owner and b.day = v_old.day; end if;
  if not (v_body ? 'backfilled') and v_old.id is not null and waldo.health_basis_sources(v_old_basis) = waldo.health_basis_sources(v_body->'basis') then
    foreach v_pillar in array array['recovery','form','weight'] loop
      if (to_jsonb(v_old)->v_pillar->>'zone') in ('low','moderate','good','high') and (v_body->v_pillar->>'zone') in ('low','moderate','good','high')
        and (to_jsonb(v_old)->v_pillar->>'zone') <> (v_body->v_pillar->>'zone') then v_changed := v_changed || to_jsonb(v_pillar); end if;
    end loop;
  end if;
  v_conf := case when jsonb_typeof(v_body->'confidence') = 'number' then (v_body->>'confidence')::numeric else null end;
  insert into public.health_context_daily(user_id, day, form, recovery, weight, sleep_debt, drivers, confidence, freshness, tags, windows, windows_version, backfilled, training_load)
    values (v_auth, v_day,
      v_body->'form', v_body->'recovery', v_body->'weight', v_body->'sleep_debt',
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, v_body->>'freshness',
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]),
      v_body->'windows', v_body->>'windows_version', (v_body->>'backfilled')::boolean, v_body->'training_load')
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, sleep_debt = excluded.sleep_debt, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags,
      windows = excluded.windows, windows_version = excluded.windows_version, backfilled = excluded.backfilled, training_load = excluded.training_load;
  insert into waldo.health_context_basis(owner_id, day, consent_basis, timezone, read_at) values (v_owner, v_day, v_body->'basis', v_tz, v_read_at)
    on conflict (owner_id, day) do update set consent_basis = excluded.consent_basis, timezone = excluded.timezone, read_at = excluded.read_at;
  return jsonb_build_object('written', true, 'changed', v_changed);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

insert into waldo.connection_custody (provider, custodian) values ('google_health', 'oauth-proxy');

-- A Google Health user id is case-sensitive, so the edge's store keeps it as Google gave it; every other account is
-- stored lowered as before. The answer names the account as stored, so the edge hands the owner object the same id.
create or replace function waldo.oauth_store(p_do_name text, p_provider text, p_account text, p_scopes text, p_pins jsonb, p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.connections;
  v_account text := case when p_provider = 'google_health' then p_account else lower(p_account) end;
begin
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_secret is null or p_secret = '' or p_account is null or p_account = '' or p_pins is null or jsonb_typeof(p_pins) <> 'object' then return '{"error":"invalid"}'; end if;
  if not exists (select 1 from waldo.connection_custody where provider = p_provider and custodian = 'oauth-proxy') then return '{"error":"invalid"}'; end if;
  select * into v_row from waldo.connections where owner_id = v_owner and provider = p_provider and account = v_account and status <> 'revoked' for update;
  if found then
    perform vault.update_secret(v_row.secret_id, p_secret);
    update waldo.connections set scopes = string_to_array(p_scopes, ' '), pins = p_pins, status = 'active', last_error = null, last_refresh_at = now() where id = v_row.id;
    return jsonb_build_object('id', v_row.id, 'account', v_account);
  end if;
  insert into waldo.connections (owner_id, provider, account, scopes, secret_id, pins, last_refresh_at)
    values (v_owner, p_provider, v_account, string_to_array(p_scopes, ' '), vault.create_secret(p_secret), p_pins, now())
    returning id into v_row.id;
  return jsonb_build_object('id', v_row.id, 'account', v_account);
exception when unique_violation then
  return '{"error":"account_linked"}';
end $$;
drop index waldo.connections_live_provider_account;
create unique index connections_live_provider_account on waldo.connections (provider, account) where provider in ('whoop', 'google_health') and status <> 'revoked';

create or replace function waldo.health_provider_route(p_provider text, p_account text, p_at bigint, p_sig text) returns table(do_name text, connection uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_account text := case when p_provider = 'whoop' then lower(p_account) else p_account end;
begin
  if not waldo.router_signed('provroute.' || p_provider || '.' || v_account, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return query select o.do_name, c.id from waldo.connections c join waldo.owners o on o.id = c.owner_id
    where c.provider = p_provider and p_provider in ('whoop', 'google_health') and c.account = v_account and c.status <> 'revoked' and o.state = 'active';
end $$;

alter table waldo.connect_sessions drop constraint connect_sessions_provider_check;
alter table waldo.connect_sessions add constraint connect_sessions_provider_check
  check (provider in ('google', 'whoop', 'granola', 'google_health') or provider ~ '^mcp:[a-z][a-z0-9-]{1,31}$');
