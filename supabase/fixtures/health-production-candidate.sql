-- Candidate only. Apply to an isolated synthetic database for review; live migration
-- promotion/application requires the exact reviewed design and migration receipt.
-- Raw readings remain in owner-RLS Supabase; this function never logs payloads.
create table if not exists waldo.health_scopes (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  source text not null check(source in ('apple','oura','whoop','samsung','garmin','manual')),
  purpose text not null check(purpose in ('storage_compute','model_processing')),
  epoch integer not null default 0 check(epoch >= 0),
  consent_id uuid references public.user_consents(id),
  primary key(owner_id, source, purpose)
);
-- A value-free data revision makes paged raw export restart after any late
-- ingest, deletion or retention mutation rather than silently skipping a change.
alter table waldo.health_scopes add column if not exists data_revision bigint not null default 0;
create table if not exists waldo.health_samples (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null,
  metric text not null check(metric in ('sleep_duration','sleep_efficiency','overnight_hrv','resting_heart_rate','sleep_midpoint','daylight_duration','movement_duration','perceived_stress','physical_load')),
  sample_id text not null check(char_length(sample_id) between 1 and 128),
  revision bigint not null check(revision >= 0),
  epoch integer not null check(epoch > 0),
  timezone text,
  day date,
  start_at timestamptz,
  end_at timestamptz,
  payload jsonb,
  deleted_at timestamptz,
  primary key(owner_id,source,metric,sample_id),
  check((payload is null) = (deleted_at is not null)),
  check(payload is null or (day is not null and start_at is not null and end_at >= start_at))
);
alter table waldo.health_samples drop constraint if exists health_samples_metric_check;
alter table waldo.health_samples add constraint health_samples_metric_check check(metric in ('sleep_duration','sleep_efficiency','overnight_hrv','resting_heart_rate','sleep_midpoint','daylight_duration','movement_duration','perceived_stress','physical_load'));
create index if not exists health_samples_day on waldo.health_samples(owner_id,source,day);
create or replace function waldo.health_sample_revision_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update waldo.health_scopes set data_revision=data_revision+1
    where owner_id=coalesce(new.owner_id,old.owner_id) and source=coalesce(new.source,old.source) and purpose='storage_compute';
  return null;
end $$;
revoke all on function waldo.health_sample_revision_change() from public,anon,authenticated,service_role;
drop trigger if exists health_sample_revision_change on waldo.health_samples;
create trigger health_sample_revision_change after insert or update or delete on waldo.health_samples for each row execute function waldo.health_sample_revision_change();

create table if not exists waldo.health_daily_aggregates (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null,
  day date not null,
  epoch integer not null,
  timezone text not null,
  metrics jsonb not null,
  compiled_at timestamptz not null,
  primary key(owner_id,source,day)
);
create table if not exists waldo.health_anchors (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null,
  epoch integer not null,
  anchor text not null,
  primary key(owner_id,source)
);
create table if not exists waldo.health_requests (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  request_id text not null,
  operation text not null,
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id,request_id)
);
alter table waldo.health_scopes enable row level security;
alter table waldo.health_scopes force row level security;
alter table waldo.health_samples enable row level security;
alter table waldo.health_samples force row level security;
alter table waldo.health_daily_aggregates enable row level security;
alter table waldo.health_daily_aggregates force row level security;
alter table waldo.health_anchors enable row level security;
alter table waldo.health_anchors force row level security;
alter table waldo.health_requests enable row level security;
alter table waldo.health_requests force row level security;
revoke all on waldo.health_scopes, waldo.health_samples, waldo.health_daily_aggregates, waldo.health_anchors, waldo.health_requests from public, anon, authenticated, service_role;
-- All health reads go through the current-consent check below. No direct JWT table
-- read can race withdrawal or ignore version/purpose/epoch.

create or replace function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,
    'version',1,'status',coalesce(c.status,'not_granted'),'epoch',p_scope.epoch,
    'granted_at',case when c.granted_at is null then null else to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'withdrawn_at',case when c.withdrawn_at is null then null else to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'deletion_state',case when c.status = 'withdrawn' then 'completed' else 'not_required' end
  ) from (select 1) x left join public.user_consents c on c.id = p_scope.consent_id
$$;
revoke all on function waldo.health_consent_view(waldo.health_scopes) from public, anon, authenticated, service_role;

create or replace function waldo.health_plane(p_do_name text,p_operation text,p_payload text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_user uuid; v_auth uuid; v_payload jsonb; v_source text; v_purpose text;
  v_scope waldo.health_scopes; v_consent public.user_consents; v_previous waldo.health_requests;
  v_id text; v_result jsonb; v_epoch integer; v_anchor text; v_change jsonb;
  v_sample waldo.health_samples; v_metric text; v_sample_id text; v_revision bigint;
  v_day date; v_days date[] := '{}'; v_start timestamptz; v_end timestamptz;
  v_accepted integer := 0; v_deleted integer := 0; v_ignored integer := 0;
  v_raw_deleted integer := 0; v_aggregate_deleted integer := 0; v_from date; v_to date;
  v_scopes_revoked integer := 0; v_compat_deleted integer := 0; v_count integer := 0;
  v_sleep jsonb; v_interval jsonb; v_sleep_end timestamptz; v_asleep_minutes numeric; v_bed_minutes numeric; v_origin jsonb; v_origin_key text; v_cursor jsonb; v_after_day date; v_after_metric text; v_after_id text; v_data_revision bigint;
begin
  if not waldo.router_signed('healthplane.' || p_do_name || '.' || p_operation || '.' || md5(p_payload),p_at,p_sig) then
    raise exception 'unsigned router call' using errcode='42501';
  end if;
  -- Serialize this owner's health plane, including reads and withdrawal. No external
  -- I/O occurs under this lock; late results must pass the epoch check again.
  select id,auth_user_id into v_owner,v_auth from waldo.owners where do_name=p_do_name and state='active' for update;
  if v_owner is null or v_auth is null then return '{"error":"not_linked"}'; end if;
  select id into v_user from public.users where auth_id=v_auth;
  if v_user is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload)>98304 then return '{"error":"invalid_request"}'; end if;
  begin v_payload := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_payload)<>'object' then return '{"error":"invalid_request"}'; end if;
  if p_operation='consents' then
    return jsonb_build_object('consents',coalesce((select jsonb_agg(waldo.health_consent_view(s) order by source,purpose) from waldo.health_scopes s where owner_id=v_owner),'[]'::jsonb));
  end if;
  if p_operation='purge' then
    update public.user_consents c set status='withdrawn',withdrawn_at=now()
      where c.user_id=v_user and c.consent_class='health_processing' and c.status='granted';
    get diagnostics v_scopes_revoked = row_count;
    update waldo.health_scopes set epoch=epoch+1 where owner_id=v_owner;
    delete from waldo.health_samples where owner_id=v_owner;
    get diagnostics v_raw_deleted = row_count;
    delete from waldo.health_daily_aggregates where owner_id=v_owner;
    get diagnostics v_aggregate_deleted = row_count;
    delete from waldo.health_anchors where owner_id=v_owner;
    delete from waldo.health_requests where owner_id=v_owner;
    delete from public.health_daily where user_id=v_user;
    get diagnostics v_count = row_count; v_compat_deleted:=v_compat_deleted+v_count;
    delete from public.crs_scores where user_id=v_user;
    get diagnostics v_count = row_count; v_compat_deleted:=v_compat_deleted+v_count;
    delete from public.user_baselines where user_id=v_user;
    get diagnostics v_count = row_count; v_compat_deleted:=v_compat_deleted+v_count;
    delete from public.health_context_daily where user_id=v_auth;
    get diagnostics v_count = row_count; v_compat_deleted:=v_compat_deleted+v_count;
    return jsonb_build_object('state','completed','scopes_revoked',v_scopes_revoked,'raw_deleted',v_raw_deleted,'aggregates_deleted',v_aggregate_deleted,'compatibility_rows_deleted',v_compat_deleted,'retained','consent_audit_only');
  end if;
  if p_operation='retention' then
    delete from waldo.health_samples where owner_id=v_owner and
      ((payload is not null and end_at < now()-interval '90 days') or (payload is null and deleted_at < now()-interval '90 days'));
    get diagnostics v_raw_deleted = row_count;
    delete from waldo.health_daily_aggregates where owner_id=v_owner and day < (now()-interval '24 months')::date;
    get diagnostics v_aggregate_deleted = row_count;
    -- Count-only receipts are recovery metadata, not retained raw health.
    delete from waldo.health_requests where owner_id=v_owner and created_at < now()-interval '90 days';
    return jsonb_build_object('raw_deleted',v_raw_deleted,'aggregates_deleted',v_aggregate_deleted);
  end if;
  v_source:=v_payload->>'source';
  if v_source is null or v_source not in ('apple','oura','whoop','samsung','garmin','manual') then return '{"error":"invalid_request"}'; end if;
  v_purpose := case when p_operation in ('grant','withdraw') then v_payload->>'purpose' else 'storage_compute' end;
  if v_purpose is null or v_purpose not in ('storage_compute','model_processing') then return '{"error":"invalid_request"}'; end if;
  insert into waldo.health_scopes(owner_id,user_id,source,purpose) values(v_owner,v_user,v_source,v_purpose) on conflict do nothing;
  select * into v_scope from waldo.health_scopes where owner_id=v_owner and source=v_source and purpose=v_purpose for update;
  select * into v_consent from public.user_consents where id=v_scope.consent_id;

  if p_operation in ('grant','withdraw','ingest') then
    v_id:=v_payload->>'request_id';
    if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' then return '{"error":"invalid_request"}'; end if;
    select * into v_previous from waldo.health_requests where owner_id=v_owner and request_id=v_id;
    if found and (v_previous.operation<>p_operation or v_previous.payload_digest<>md5(p_payload)) then return '{"error":"idempotency_conflict"}'; end if;
    -- Replays of old grants/ingests cannot bypass current withdrawal/epoch. A
    -- withdrawal replay is safe and retains its original audit receipt.
    if v_previous.request_id is not null then
      if p_operation<>'withdraw' and v_consent.status is distinct from 'granted' then return '{"error":"consent_withdrawn"}'; end if;
      if p_operation<>'withdraw' and v_scope.epoch is distinct from
          (case when p_operation='ingest' then v_previous.response->>'consent_epoch' else v_previous.response->'consent'->>'epoch' end)::integer then return '{"error":"epoch_conflict"}'; end if;
      return jsonb_set(v_previous.response,'{replayed}','true');
    end if;
  end if;
  if p_operation in ('grant','withdraw') then
    if (v_payload->>'expected_epoch') is null or (v_payload->>'expected_epoch') !~ '^[0-9]+$' then return '{"error":"invalid_request"}'; end if;
    if (v_payload->>'expected_epoch')::integer<>v_scope.epoch then return '{"error":"epoch_conflict"}'; end if;
    if p_operation='grant' then
      if v_payload->>'version' is distinct from '1' or v_payload->>'age_attested_18_plus' is distinct from 'true' then return '{"error":"invalid_request"}'; end if;
      if v_consent.status='granted' then return '{"error":"epoch_conflict"}'; end if;
      insert into public.user_consents(user_id,consent_class,source,purpose,version,status,granted_at,withdrawn_at,age_attested_18_plus)
        values(v_user,'health_processing',v_source,v_purpose,1,'granted',now(),null,true) returning * into v_consent;
    else
      if v_consent.status='granted' then
        update public.user_consents set status='withdrawn',withdrawn_at=now() where id=v_scope.consent_id returning * into v_consent;
      end if;
      -- Withdrawing either health purpose removes this source and withdraws both
      -- grants. A storage upload already queued before model withdrawal must not
      -- repopulate purged data; new processing needs fresh explicit grants.
      delete from waldo.health_samples where owner_id=v_owner and source=v_source;
      delete from waldo.health_daily_aggregates where owner_id=v_owner and source=v_source;
      delete from waldo.health_anchors where owner_id=v_owner and source=v_source;
      update public.user_consents c set status='withdrawn',withdrawn_at=now()
        from waldo.health_scopes s where s.owner_id=v_owner and s.source=v_source and s.purpose<>v_purpose and c.id=s.consent_id and c.status='granted';
      update public.user_consents set status='withdrawn',withdrawn_at=now()
        where user_id=v_user and consent_class='health_processing' and source=v_source and status='granted';
      update waldo.health_scopes set epoch=epoch+1 where owner_id=v_owner and source=v_source and purpose<>v_purpose;
      -- Compatibility stores belong to this owner too; remove their health values.
      delete from public.health_daily where user_id=v_user and primary_source=v_source;
      delete from public.crs_scores where user_id=v_user;
      delete from public.user_baselines where user_id=v_user;
      delete from public.health_context_daily where user_id=v_auth;
    end if;
    update waldo.health_scopes set epoch=epoch+1,consent_id=v_consent.id where owner_id=v_owner and source=v_source and purpose=v_purpose returning * into v_scope;
    v_result:=jsonb_build_object('consent',waldo.health_consent_view(v_scope),'replayed',false,'deletion_routed',p_operation='withdraw');
  else
    if v_consent.status is distinct from 'granted' or v_consent.version is distinct from 1 or v_consent.age_attested_18_plus is distinct from true then
      return jsonb_build_object('error',case when v_consent.status='withdrawn' then 'consent_withdrawn' else 'consent_required' end);
    end if;
    v_epoch:=v_scope.epoch;
    if p_operation<>'today' and ((v_payload->>'consent_epoch') is null or (v_payload->>'consent_epoch') !~ '^[0-9]+$') then return '{"error":"invalid_request"}'; end if;
    if p_operation<>'today' and (v_payload->>'consent_epoch')::integer<>v_epoch then return '{"error":"epoch_conflict"}'; end if;
    if p_operation='ingest' then
      if jsonb_typeof(v_payload->'samples') is distinct from 'array' or jsonb_typeof(v_payload->'deletions') is distinct from 'array'
        or jsonb_array_length(v_payload->'samples')+jsonb_array_length(v_payload->'deletions') not between 0 and 128
        or char_length(v_payload->>'anchor_after') not between 1 and 2048
        or not exists(select 1 from pg_timezone_names where name=v_payload->>'timezone') then return '{"error":"invalid_request"}'; end if;
      select anchor into v_anchor from waldo.health_anchors where owner_id=v_owner and source=v_source and epoch=v_epoch;
      if v_anchor is distinct from (v_payload->>'anchor_before') then return '{"error":"anchor_conflict"}'; end if;
      for v_change in select value from jsonb_array_elements(v_payload->'samples') loop
        v_metric:=v_change->>'metric'; v_sample_id:=v_change->>'sample_id';
        if v_metric is null or v_metric not in ('sleep_duration','sleep_efficiency','overnight_hrv','resting_heart_rate','sleep_midpoint','daylight_duration','movement_duration','perceived_stress','physical_load') or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$'
          or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]+$' or jsonb_typeof(v_change->'value') is distinct from 'number' then raise exception 'invalid health sample' using errcode='22023'; end if;
        v_revision:=(v_change->>'revision')::bigint; v_day:=(v_change->>'day')::date; v_start:=(v_change->>'start_at')::timestamptz; v_end:=(v_change->>'end_at')::timestamptz;
        if v_day is null or v_start is null or v_end is null or v_start>v_end or v_end>now()+interval '5 minutes' or (case when v_change ? 'sleep_context' then v_change->'sleep_context'->>'waking_day' is distinct from v_day::text else (v_end at time zone (v_payload->>'timezone'))::date<>v_day end) then raise exception 'invalid health sample' using errcode='22023'; end if;
        if (v_metric='sleep_duration' and (v_change->>'unit' is distinct from 'minutes' or (v_change->>'value')::numeric not between 0 and 1440))
          or (v_metric='sleep_efficiency' and (v_change->>'unit' is distinct from 'ratio' or (v_change->>'value')::numeric not between 0 and 1))
          or (v_metric='overnight_hrv' and (v_change->>'unit' is distinct from 'milliseconds' or v_change->>'method' is null or v_change->>'method' not in ('rmssd','sdnn') or (v_change->>'value')::numeric not between 0.000001 and 1000))
          or (v_metric='resting_heart_rate' and (v_change->>'unit' is distinct from 'beats_per_minute' or (v_change->>'value')::numeric not between 0.000001 and 300))
          or (v_metric='sleep_midpoint' and (v_change->>'unit' is distinct from 'local_minute' or v_change->>'method' is distinct from 'sleep_midpoint' or (v_change->>'value')::numeric not between 0 and 1439.999))
          or (v_metric in ('daylight_duration','movement_duration') and (v_change->>'unit' is distinct from 'minutes' or v_change->>'method' is distinct from case when v_metric='daylight_duration' then 'daylight_duration' else 'active_minutes' end or (v_change->>'value')::numeric not between 0 and 1440))
          or (v_metric='perceived_stress' and (v_change->>'unit' is distinct from 'rating_0_10' or v_change->>'method' is distinct from 'self_report_0_10' or (v_change->>'value')::numeric not between 0 and 10))
          or (v_metric='physical_load' and (v_change->>'unit' is distinct from 'source_units' or v_change->>'method' is null or v_change->>'method' not in ('provider_load','trimp') or (v_change->>'value')::numeric not between 0 and 1000000))
          or (v_metric in ('daylight_duration','movement_duration','perceived_stress','physical_load') and (v_change->>'context_ref' is null or v_change->>'context_ref' !~ '^[A-Za-z0-9._:-]{1,128}$')) then raise exception 'invalid health sample' using errcode='22023'; end if;
        if v_change ? 'origin' then
          v_origin:=v_change->'origin';
          if jsonb_typeof(v_origin) is distinct from 'object' or not(v_origin ?& array['read_api','source_bundle_id','source_package_name','source_version','source_revision','device_ref','recording_method'])
            or exists(select 1 from jsonb_object_keys(v_origin) k where k not in ('read_api','source_bundle_id','source_package_name','source_version','source_revision','device_ref','recording_method','manufacturer','product_type','client_record_version','sync_version'))
            or v_origin->>'read_api' is null or v_origin->>'read_api' not in ('healthkit','health_connect','samsung_health','provider_api','manual')
            or v_origin->>'recording_method' is null or not((jsonb_typeof(v_origin->'recording_method')='string' and v_origin->>'recording_method' in ('automatic','active','manual','unknown')) or (jsonb_typeof(v_origin->'recording_method')='number' and v_origin->>'recording_method' in ('0','1','2','3')) or jsonb_typeof(v_origin->'recording_method')='boolean') then raise exception 'invalid health origin' using errcode='22023'; end if;
          if (v_origin->>'read_api'='healthkit' and v_origin->>'source_bundle_id' is null) or (v_origin->>'read_api'='health_connect' and v_origin->>'source_package_name' is null)
            or (v_origin->>'device_ref' is not null and v_origin->>'device_ref'!~'^(sha256:|hmac-sha256:)?[0-9a-f]{64}$') then raise exception 'invalid native origin' using errcode='22023'; end if;
          foreach v_origin_key in array array['manufacturer','product_type'] loop
            if v_origin ? v_origin_key and (jsonb_typeof(v_origin->v_origin_key) not in ('string','null') or (jsonb_typeof(v_origin->v_origin_key)='string' and char_length(v_origin->>v_origin_key) not between 1 and 128)) then raise exception 'invalid native descriptor' using errcode='22023'; end if;
          end loop;
          foreach v_origin_key in array array['client_record_version','sync_version'] loop
            if v_origin ? v_origin_key and v_origin->v_origin_key<>'null'::jsonb and (jsonb_typeof(v_origin->v_origin_key) is distinct from 'number' or v_origin->>v_origin_key!~'^[0-9]+$') then raise exception 'invalid native revision' using errcode='22023'; end if;
          end loop;
          foreach v_origin_key in array array['source_bundle_id','source_package_name','source_version','source_revision','device_ref'] loop
            if jsonb_typeof(v_origin->v_origin_key) not in ('string','null') or (jsonb_typeof(v_origin->v_origin_key)='string' and char_length(v_origin->>v_origin_key) not between 1 and case when v_origin_key in ('source_bundle_id','source_package_name') then 200 else 128 end) then raise exception 'invalid health origin' using errcode='22023'; end if;
          end loop;
        end if;
        if (v_metric='sleep_duration' and v_change ? 'method' and v_change->>'method' not in ('asleep_duration','time_in_bed','unknown'))
          or (v_metric='resting_heart_rate' and v_change ? 'method' and v_change->>'method' not in ('overnight_resting','provider_resting_daily','resting_measurement','unknown')) then raise exception 'invalid health method' using errcode='22023'; end if;
        if v_change ? 'sleep_context' then
          v_sleep:=v_change->'sleep_context';
          if not(v_change ? 'origin') or jsonb_typeof(v_sleep) is distinct from 'object' or not(v_sleep ?& array['source_ref','session_ref','waking_day','reducer_version','contributor_ids','intervals'])
            or exists(select 1 from jsonb_object_keys(v_sleep) k where k not in ('source_ref','session_ref','waking_day','reducer_version','contributor_ids','intervals'))
            or v_sleep->>'reducer_version' is distinct from 'asleep-interval-union.v1' or v_sleep->>'waking_day' is distinct from v_day::text
            or v_sleep->>'source_ref' is null or char_length(v_sleep->>'source_ref') not between 1 and 200
            or v_sleep->>'session_ref' is null or v_sleep->>'session_ref'!~'^[A-Za-z0-9._:-]{1,128}$'
            or jsonb_typeof(v_sleep->'intervals') is distinct from 'array' or jsonb_array_length(v_sleep->'intervals')>128
            or jsonb_typeof(v_sleep->'contributor_ids') is distinct from 'array' or jsonb_array_length(v_sleep->'contributor_ids')>128
            or (v_change->'origin'->>'read_api'='healthkit' and v_sleep->>'source_ref' is distinct from v_change->'origin'->>'source_bundle_id')
            or (v_change->'origin'->>'read_api'='health_connect' and v_sleep->>'source_ref' is distinct from v_change->'origin'->>'source_package_name')
            or (select count(*)<>count(distinct x) from jsonb_array_elements_text(v_sleep->'contributor_ids') x)
            or exists(select 1 from jsonb_array_elements_text(v_sleep->'contributor_ids') x where x!~'^[A-Za-z0-9._:-]{1,128}$') then raise exception 'invalid sleep attribution' using errcode='22023'; end if;
          for v_interval in select value from jsonb_array_elements(v_sleep->'intervals') loop
            if jsonb_typeof(v_interval) is distinct from 'object' or not(v_interval ?& array['contributor_id','start_at','end_at','kind'])
              or exists(select 1 from jsonb_object_keys(v_interval) k where k not in ('contributor_id','start_at','end_at','kind'))
              or v_interval->>'kind' is null or v_interval->>'kind' not in ('asleep','in_bed') or v_interval->>'contributor_id' is null
              or not(v_sleep->'contributor_ids' @> jsonb_build_array(v_interval->>'contributor_id'))
              or (v_interval->>'start_at')::timestamptz is null or (v_interval->>'end_at')::timestamptz is null
              or (v_interval->>'start_at')::timestamptz>=(v_interval->>'end_at')::timestamptz or (v_interval->>'end_at')::timestamptz>now()+interval '5 minutes'
              or (v_interval->>'end_at')::timestamptz-(v_interval->>'start_at')::timestamptz>interval '36 hours' then raise exception 'invalid sleep interval' using errcode='22023'; end if;
          end loop;
          select max((x->>'end_at')::timestamptz) into v_sleep_end from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='asleep';
          if v_sleep_end is not null and (v_sleep_end at time zone (v_payload->>'timezone'))::date<>v_day then raise exception 'invalid waking day' using errcode='22023'; end if;
          select coalesce(sum(extract(epoch from upper(x)-lower(x)))/60,0) into v_asleep_minutes from unnest((select range_agg(tstzrange((x->>'start_at')::timestamptz,(x->>'end_at')::timestamptz,'[)')) from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='asleep')) x;
          select coalesce(sum(extract(epoch from upper(x)-lower(x)))/60,0) into v_bed_minutes from unnest((select range_agg(tstzrange((x->>'start_at')::timestamptz,(x->>'end_at')::timestamptz,'[)')) from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='in_bed')) x;
          if v_metric='sleep_duration' and v_change->>'method'='asleep_duration' and abs((v_change->>'value')::numeric-v_asleep_minutes)>.001 then raise exception 'invalid sleep reduction' using errcode='22023'; end if;
          if v_metric='sleep_efficiency' and (v_bed_minutes<=0 or abs((v_change->>'value')::numeric-v_asleep_minutes/v_bed_minutes)>.000001
            or not((select range_agg(tstzrange((x->>'start_at')::timestamptz,(x->>'end_at')::timestamptz,'[)')) from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='in_bed') @> (select range_agg(tstzrange((x->>'start_at')::timestamptz,(x->>'end_at')::timestamptz,'[)')) from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='asleep'))) then raise exception 'invalid sleep denominator' using errcode='22023'; end if;
          if (v_metric='overnight_hrv' or (v_metric='resting_heart_rate' and v_change->>'method'='overnight_resting')) and coalesce((select range_agg(tstzrange((x->>'start_at')::timestamptz,(x->>'end_at')::timestamptz,'[]')) from jsonb_array_elements(v_sleep->'intervals') x where x->>'kind'='asleep') @> tstzrange(v_start,v_end,'[]'),false) is distinct from true then raise exception 'not observed during sleep' using errcode='22023'; end if;
        elsif v_change ? 'origin' and (v_metric in ('overnight_hrv','sleep_efficiency') or (v_metric='sleep_duration' and v_change->>'method'='asleep_duration') or (v_metric='resting_heart_rate' and v_change->>'method'='overnight_resting')) then raise exception 'missing sleep attribution' using errcode='22023'; end if;
        if v_end<now()-interval '90 days' then v_ignored:=v_ignored+1; continue; end if;
        select * into v_sample from waldo.health_samples where owner_id=v_owner and source=v_source and metric=v_metric and sample_id=v_sample_id;
        if found and v_sample.revision>v_revision then v_ignored:=v_ignored+1; continue; end if;
        if found and v_sample.revision=v_revision then
          if v_sample.payload is distinct from v_change or v_sample.timezone is distinct from v_payload->>'timezone' then raise exception 'health sample revision conflict' using errcode='40001'; end if;
          v_ignored:=v_ignored+1; continue;
        end if;
        if v_sample.day is not null then v_days:=array_append(v_days,v_sample.day); end if;
        if exists(select 1 from waldo.health_samples where owner_id=v_owner and source=v_source and day=v_day and payload is not null and not (metric=v_metric and sample_id=v_sample_id) and timezone is distinct from v_payload->>'timezone') then raise exception 'health day timezone conflict' using errcode='40001'; end if;
        insert into waldo.health_samples(owner_id,source,metric,sample_id,revision,epoch,timezone,day,start_at,end_at,payload,deleted_at)
          values(v_owner,v_source,v_metric,v_sample_id,v_revision,v_epoch,v_payload->>'timezone',v_day,v_start,v_end,v_change,null)
          on conflict(owner_id,source,metric,sample_id) do update set revision=excluded.revision,epoch=excluded.epoch,timezone=excluded.timezone,day=excluded.day,start_at=excluded.start_at,end_at=excluded.end_at,payload=excluded.payload,deleted_at=null;
        v_days:=array_append(v_days,v_day); v_accepted:=v_accepted+1;
      end loop;
      for v_change in select value from jsonb_array_elements(v_payload->'deletions') loop
        v_metric:=v_change->>'metric'; v_sample_id:=v_change->>'sample_id';
        if v_metric is null or v_metric not in ('sleep_duration','sleep_efficiency','overnight_hrv','resting_heart_rate','sleep_midpoint','daylight_duration','movement_duration','perceived_stress','physical_load') or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$' or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]+$' then raise exception 'invalid health deletion' using errcode='22023'; end if;
        v_revision:=(v_change->>'revision')::bigint;
        select * into v_sample from waldo.health_samples where owner_id=v_owner and source=v_source and metric=v_metric and sample_id=v_sample_id;
        if found and v_sample.revision>=v_revision then
          if v_sample.revision=v_revision and v_sample.payload is not null then raise exception 'health sample revision conflict' using errcode='40001'; end if;
          v_ignored:=v_ignored+1; continue;
        end if;
        if v_sample.day is not null then v_days:=array_append(v_days,v_sample.day); end if;
        insert into waldo.health_samples(owner_id,source,metric,sample_id,revision,epoch,payload,deleted_at)
          values(v_owner,v_source,v_metric,v_sample_id,v_revision,v_epoch,null,now())
          on conflict(owner_id,source,metric,sample_id) do update set revision=excluded.revision,epoch=excluded.epoch,payload=null,deleted_at=now();
        v_deleted:=v_deleted+1;
      end loop;
      for v_day in select distinct unnest(v_days) loop
        delete from waldo.health_daily_aggregates where owner_id=v_owner and source=v_source and day=v_day;
        insert into waldo.health_daily_aggregates(owner_id,source,day,epoch,timezone,metrics,compiled_at)
          select v_owner,v_source,v_day,v_epoch,max(sample_timezone),jsonb_object_agg(metric,aggregate),max(observed_at)
          from (select metric,jsonb_build_object('mean',avg((payload->>'value')::numeric),'count',count(*),'distinct_values',count(distinct payload->>'value'),'methods',jsonb_agg(distinct coalesce(payload->>'method',case metric when 'sleep_efficiency' then 'ratio' else 'unknown' end)),
            'contexts',jsonb_agg(distinct coalesce(payload->>'context_ref','overnight_daily')),'origins',jsonb_agg(distinct payload->'origin'),
            'eligibility',case when metric in ('sleep_duration','overnight_hrv','resting_heart_rate') and bool_and(payload ? 'origin' and payload ? 'sleep_context') then 'admitted_sleep_context' when metric='resting_heart_rate' and bool_and(payload ? 'origin' and payload->>'method' in ('provider_resting_daily','resting_measurement')) then 'admitted_resting_method' else 'unknown' end,
            'sleep_ended_at',to_char(max((select max((x->>'end_at')::timestamptz) from jsonb_array_elements(coalesce(payload->'sleep_context'->'intervals','[]'::jsonb)) x where x->>'kind'='asleep')) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'observed_at',to_char(max(end_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',max(revision)) aggregate,max(end_at) observed_at,max(timezone) sample_timezone
            from waldo.health_samples where owner_id=v_owner and source=v_source and day=v_day and payload is not null and epoch=v_epoch group by metric) x having count(*)>0;
      end loop;
      insert into waldo.health_anchors(owner_id,source,epoch,anchor) values(v_owner,v_source,v_epoch,v_payload->>'anchor_after')
        on conflict(owner_id,source) do update set epoch=excluded.epoch,anchor=excluded.anchor;
      v_result:=jsonb_build_object('request_id',v_id,'source',v_source,'consent_epoch',v_epoch,'accepted',v_accepted,'deleted',v_deleted,'ignored',v_ignored,'anchor_after',v_payload->>'anchor_after','replayed',false);
    elsif p_operation in ('history','today','readings') then
      if p_operation='today' then
        select max(day) into v_to from waldo.health_daily_aggregates where owner_id=v_owner and source=v_source and epoch=v_epoch;
        if v_to is null then return 'null'::jsonb; end if;
        v_from:=v_to;
      else
        v_from:=(v_payload->>'from')::date; v_to:=(v_payload->>'to')::date;
        if v_from is null or v_to is null or v_from>v_to or v_to-v_from>89 then return '{"error":"invalid_request"}'; end if;
      end if;
      if p_operation='readings' then
        if v_payload->>'audience' not in ('owner','model') or v_payload->>'audience' is null then return '{"error":"invalid_request"}'; end if;
        if v_payload->>'audience'='model' and not exists(select 1 from waldo.health_scopes s join public.user_consents c on c.id=s.consent_id where s.owner_id=v_owner and s.source=v_source and s.purpose='model_processing' and c.status='granted' and c.version=1 and c.age_attested_18_plus) then return '{"error":"consent_required"}'; end if;
        v_data_revision:=v_scope.data_revision;
        if v_payload ? 'cursor' then
          if jsonb_typeof(v_payload->'cursor') is distinct from 'string' or char_length(v_payload->>'cursor') not between 1 and 2048 or v_payload->>'cursor'!~'^[A-Za-z0-9_-]+$' then return '{"error":"invalid_request"}'; end if;
          begin
            v_cursor:=convert_from(decode(translate(v_payload->>'cursor','-_','+/')||repeat('=',(4-length(v_payload->>'cursor')%4)%4),'base64'),'UTF8')::jsonb;
          exception when others then return '{"error":"invalid_request"}'; end;
          if jsonb_typeof(v_cursor) is distinct from 'object' or not(v_cursor ?& array['v','owner','source','epoch','from','to','revision','day','metric','id'])
            or exists(select 1 from jsonb_object_keys(v_cursor) k where k not in ('v','owner','source','epoch','from','to','revision','day','metric','id'))
            or v_cursor->>'v' is distinct from '1' or v_cursor->>'owner' is distinct from v_owner::text or v_cursor->>'source' is distinct from v_source
            or v_cursor->>'epoch' is distinct from v_epoch::text or v_cursor->>'from' is distinct from v_from::text or v_cursor->>'to' is distinct from v_to::text
            or v_cursor->>'revision' is null or v_cursor->>'revision'!~'^[0-9]+$'
            or v_cursor->>'metric' is null or v_cursor->>'metric' not in ('sleep_duration','sleep_efficiency','overnight_hrv','resting_heart_rate','sleep_midpoint','daylight_duration','movement_duration','perceived_stress','physical_load')
            or v_cursor->>'id' is null or v_cursor->>'id'!~'^[A-Za-z0-9._:-]{1,128}$' then return '{"error":"invalid_request"}'; end if;
          if (v_cursor->>'revision')::bigint<>v_data_revision then return '{"error":"anchor_conflict"}'; end if;
          v_after_day:=(v_cursor->>'day')::date; v_after_metric:=v_cursor->>'metric'; v_after_id:=v_cursor->>'id';
          if v_after_day is null or v_after_day<v_from or v_after_day>v_to then return '{"error":"invalid_request"}'; end if;
        end if;
        with selected as (
          select payload,day,metric,sample_id from waldo.health_samples
          where owner_id=v_owner and source=v_source and epoch=v_epoch and payload is not null and day between v_from and v_to and end_at>=now()-interval '90 days'
            and (v_after_day is null or (day,metric collate "C",sample_id collate "C")>(v_after_day,v_after_metric collate "C",v_after_id collate "C"))
          order by day,metric collate "C",sample_id collate "C" limit 4097
        ), page as (
          select *,row_number() over(order by day,metric collate "C",sample_id collate "C") as position from selected
        )
        select jsonb_build_object('source',v_source,'consent_epoch',v_epoch,
          'samples',coalesce(jsonb_agg(payload order by position) filter(where position<=4096),'[]'::jsonb),
          'count',least(count(*),4096),'has_more',count(*)>4096,
          'next_cursor',case when count(*)>4096 then (
            select rtrim(translate(replace(encode(convert_to(jsonb_build_object('v',1,'owner',v_owner::text,'source',v_source,'epoch',v_epoch,'from',v_from::text,'to',v_to::text,
              'revision',v_data_revision,'day',day::text,'metric',metric,'id',sample_id)::text,'UTF8'),'base64'),E'\n',''),'+/','-_'),'=') from page where position=4096
          ) else null end) into v_result from page;
      else
        select coalesce(jsonb_agg(jsonb_build_object('source',v_source,'consent_epoch',v_epoch,'day',a.day,'timezone',a.timezone,
          'compiled_at',to_char(a.compiled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          -- Daily producers consume the complete bounded aggregate plane. Raw
          -- source pages have their separate purpose-bound readings operation.
          'samples','[]'::jsonb,
          'aggregates',coalesce((select jsonb_agg(jsonb_build_object('day',b.day,
            'timezone',b.timezone,'observed_at',to_char(b.compiled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'values',coalesce((select jsonb_object_agg(k,v->'mean') from jsonb_each(b.metrics) e(k,v)),'{}'::jsonb),
            'observations',coalesce((select jsonb_object_agg(k,(jsonb_build_object('method',coalesce(v->'methods'->>0,'unknown'),'context_ref',v->'contexts'->>0,'observed_at',v->>'observed_at','revision',v->'revision','eligibility',coalesce(v->>'eligibility','unknown'))||case when v->>'sleep_ended_at' is not null then jsonb_build_object('sleep_ended_at',v->>'sleep_ended_at') else '{}'::jsonb end||case when v->'origins'->0 is not null and v->'origins'->0<>'null'::jsonb then jsonb_build_object('origin',v->'origins'->0) else '{}'::jsonb end)) from jsonb_each(b.metrics) e(k,v) where jsonb_array_length(v->'methods')=1 and jsonb_array_length(v->'contexts')=1),'{}'::jsonb),
            'metrics',coalesce((select jsonb_agg(k) from jsonb_object_keys(b.metrics) k),'[]'::jsonb),
            'methods',coalesce((select jsonb_agg(m) from jsonb_array_elements(b.metrics->'overnight_hrv'->'methods') m where m<>'null'::jsonb),'[]'::jsonb),
            'conflicting_metrics',coalesce((select jsonb_agg(k) from jsonb_each(b.metrics) e(k,v) where (v->>'distinct_values')::integer>1 or jsonb_array_length(v->'methods')>1 or jsonb_array_length(v->'contexts')>1 or jsonb_array_length(v->'origins')>1),'[]'::jsonb)) order by b.day)
            from waldo.health_daily_aggregates b where b.owner_id=v_owner and b.source=v_source and b.epoch=v_epoch and b.day between a.day-43 and a.day),'[]'::jsonb)) order by a.day desc),'[]'::jsonb) into v_result
          from waldo.health_daily_aggregates a where a.owner_id=v_owner and a.source=v_source and a.epoch=v_epoch and a.day between v_from and v_to and a.day>=(now()-interval '24 months')::date;
        if p_operation='today' then return v_result->0; end if;
        return jsonb_build_object('days',v_result);
      end if;
    else return '{"error":"invalid_request"}'; end if;
  end if;
  if v_id is not null then insert into waldo.health_requests(owner_id,request_id,operation,payload_digest,response) values(v_owner,v_id,p_operation,md5(p_payload),v_result); end if;
  return v_result;
exception
  when invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then return '{"error":"invalid_request"}';
  when serialization_failure then return '{"error":"sample_conflict"}';
end $$;
revoke all on function waldo.health_plane(text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.health_plane(text,text,text,bigint,text) to anon,authenticated;
grant usage on schema waldo to anon;
