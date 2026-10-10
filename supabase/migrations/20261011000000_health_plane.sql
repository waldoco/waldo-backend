-- Health plane (owner-keyed). Raw readings and consent live only here, in forced-RLS tables with no client
-- privileges; every read and write is a signed router call that resolves the owner from the private locator.
-- The Worker validates request shape against the app contract before it signs a call. The database owns what
-- it must: ownership, consent and epoch, idempotency, revision order, signal bounds, retention and purge.

create table waldo.health_consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null check (source in ('apple','samsung','health_connect')),
  purpose text not null check (purpose in ('storage_compute','model_processing')),
  version integer not null check (version > 0),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz check (withdrawn_at is null or withdrawn_at >= granted_at),
  age_attested_18_plus boolean not null check (age_attested_18_plus is true)
);
create unique index health_consents_one_active on waldo.health_consents(owner_id, source, purpose) where withdrawn_at is null;

-- Consent is audit evidence: the only in-place change is a withdrawal.
create function waldo.health_consent_history() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.withdrawn_at is not null or new.withdrawn_at is null
    or old.id is distinct from new.id or old.owner_id is distinct from new.owner_id or old.source is distinct from new.source
    or old.purpose is distinct from new.purpose or old.version is distinct from new.version
    or old.granted_at is distinct from new.granted_at or old.age_attested_18_plus is distinct from new.age_attested_18_plus then
    raise exception 'health consent records are immutable except for withdrawal' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function waldo.health_consent_history() from public, anon, authenticated, service_role;
create trigger health_consent_history before update on waldo.health_consents for each row execute function waldo.health_consent_history();

create table waldo.health_scopes (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null check (source in ('apple','samsung','health_connect')),
  purpose text not null check (purpose in ('storage_compute','model_processing')),
  epoch integer not null default 0 check (epoch >= 0),
  consent_id uuid references waldo.health_consents(id),
  primary key (owner_id, source, purpose)
);

create table waldo.health_samples (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null check (source in ('apple','samsung','health_connect')),
  signal text not null check (signal in ('sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout')),
  sample_id text not null check (char_length(sample_id) between 1 and 128),
  revision bigint not null check (revision >= 0),
  epoch integer not null check (epoch > 0),
  day date,
  start_at timestamptz,
  end_at timestamptz,
  utc_offset_minutes smallint,
  payload jsonb,
  deleted_at timestamptz,
  primary key (owner_id, source, signal, sample_id),
  check ((payload is null) = (deleted_at is not null)),
  check (payload is null or (day is not null and start_at is not null and end_at >= start_at and utc_offset_minutes is not null))
);
create index health_samples_day on waldo.health_samples(owner_id, source, day);

create table waldo.health_anchors (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null,
  epoch integer not null,
  anchor text not null,
  primary key (owner_id, source)
);

-- Receipts keep only a digest and the count-only response, never the request body.
create table waldo.health_requests (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  request_id text not null,
  operation text not null,
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

-- The consent each derived row was computed from. The public read model is shared with the app repo, so the basis
-- lives beside it here: a row with no basis here is never read, and withdrawal removes both.
create table waldo.health_context_basis (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  day date not null,
  consent_basis jsonb not null check (jsonb_typeof(consent_basis) = 'array' and jsonb_array_length(consent_basis) between 1 and 3),
  timezone text not null,
  primary key (owner_id, day)
);

alter table waldo.health_consents enable row level security;
alter table waldo.health_consents force row level security;
alter table waldo.health_scopes enable row level security;
alter table waldo.health_scopes force row level security;
alter table waldo.health_samples enable row level security;
alter table waldo.health_samples force row level security;
alter table waldo.health_anchors enable row level security;
alter table waldo.health_anchors force row level security;
alter table waldo.health_requests enable row level security;
alter table waldo.health_requests force row level security;
alter table waldo.health_context_basis enable row level security;
alter table waldo.health_context_basis force row level security;
revoke all on waldo.health_consents, waldo.health_scopes, waldo.health_samples, waldo.health_anchors, waldo.health_requests, waldo.health_context_basis from public, anon, authenticated, service_role;

create function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,'version',coalesce(c.version,2),
    'status',case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,'epoch',p_scope.epoch,
    'granted_at',to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at',to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state',case when c.withdrawn_at is null then 'not_required' else 'completed' end)
  from (select 1) x left join waldo.health_consents c on c.id = p_scope.consent_id $$;
revoke all on function waldo.health_consent_view(waldo.health_scopes) from public, anon, authenticated, service_role;

-- True while every source a derived row was computed from still holds storage consent at the epoch the row recorded
-- and, when the row is going to a model, a live model_processing grant as well.
create function waldo.health_basis_live(p_owner uuid, p_basis jsonb, p_model boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select jsonb_typeof(p_basis) = 'array' and jsonb_array_length(p_basis) > 0 and not exists (
    select 1 from jsonb_array_elements(p_basis) b
    where not exists (
        select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
        where s.owner_id = p_owner and s.source = b->>'source' and s.purpose = 'storage_compute'
          and s.epoch = (b->>'consent_epoch')::integer and c.withdrawn_at is null)
      or (p_model and not exists (
        select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
        where s.owner_id = p_owner and s.source = b->>'source' and s.purpose = 'model_processing' and c.withdrawn_at is null))) $$;
revoke all on function waldo.health_basis_live(uuid, jsonb, boolean) from public, anon, authenticated, service_role;

create function waldo.health_consent_list(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.consent_list.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  return jsonb_build_object('consents', coalesce((select jsonb_agg(waldo.health_consent_view(s) order by s.source, s.purpose) from waldo.health_scopes s where s.owner_id = v_owner), '[]'::jsonb));
end $$;

create function waldo.health_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
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
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or v_body->>'version' is distinct from '2' or v_body->>'age_attested_18_plus' is distinct from 'true'
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
  if (v_body->>'expected_epoch')::integer <> v_epoch
    or exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.source = v_source and c.purpose = v_purpose and c.withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
  insert into waldo.health_consents(owner_id, source, purpose, version, age_attested_18_plus) values (v_owner, v_source, v_purpose, 2, true) returning * into v_consent;
  insert into waldo.health_scopes(owner_id, source, purpose, epoch, consent_id) values (v_owner, v_source, v_purpose, 1, v_consent.id)
    on conflict (owner_id, source, purpose) do update set epoch = waldo.health_scopes.epoch + 1, consent_id = excluded.consent_id returning * into v_scope;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_grant', md5(p_payload), v_result);
  return v_result;
end $$;

create function waldo.health_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_source text; v_purpose text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_result jsonb;
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
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or (v_body->>'expected_epoch') is null or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'consent_withdraw' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  if not exists (select 1 from waldo.health_scopes where owner_id = v_owner and source = v_source) then return '{"error":"consent_required"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  if (v_body->>'expected_epoch')::integer <> coalesce(v_scope.epoch, 0) then return '{"error":"epoch_conflict"}'; end if;
  -- Withdrawing either purpose withdraws both for this source and removes its data: a storage upload queued
  -- before the withdrawal cannot repopulate it, and new processing needs fresh explicit grants. The derived rows
  -- may mix sources, so they are removed whole and rebuilt from what remains. Upload receipts go with the data;
  -- consent receipts stay so a replayed request still gets its answer.
  update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and withdrawn_at is null;
  insert into waldo.health_scopes(owner_id, source, purpose) select v_owner, v_source, p from unnest(array['storage_compute','model_processing']) p on conflict do nothing;
  update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source;
  delete from waldo.health_samples where owner_id = v_owner and source = v_source;
  delete from waldo.health_anchors where owner_id = v_owner and source = v_source;
  delete from waldo.health_requests where owner_id = v_owner and operation = 'ingest' and response->>'source' = v_source;
  delete from public.health_context_daily where user_id = v_auth;
  delete from waldo.health_context_basis where owner_id = v_owner;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', true);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_withdraw', md5(p_payload), v_result);
  return v_result;
end $$;

create function waldo.health_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
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
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, payload, deleted_at)
      values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, v_day, v_start, v_end, v_offset, v_change, null)
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = excluded.day, start_at = excluded.start_at,
        end_at = excluded.end_at, utc_offset_minutes = excluded.utc_offset_minutes, payload = excluded.payload, deleted_at = null;
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
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = null, start_at = null, end_at = null, utc_offset_minutes = null, payload = null, deleted_at = now();
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

create function waldo.health_purge(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_revoked integer; v_raw integer; v_context integer;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.purge.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  -- Erasure and retention do not depend on the owner being active: a suspended owner's data must still age out.
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and withdrawn_at is null;
  get diagnostics v_revoked = row_count;
  update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner;
  delete from waldo.health_samples where owner_id = v_owner;
  get diagnostics v_raw = row_count;
  delete from waldo.health_anchors where owner_id = v_owner;
  delete from waldo.health_requests where owner_id = v_owner;
  delete from public.health_context_daily where user_id = v_auth;
  get diagnostics v_context = row_count;
  delete from waldo.health_context_basis where owner_id = v_owner;
  return jsonb_build_object('state', 'completed', 'scopes_revoked', v_revoked, 'raw_deleted', v_raw, 'context_deleted', v_context, 'retained', 'consent_audit_only');
end $$;

create function waldo.health_retention(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_raw integer; v_requests integer;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.retention.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  delete from waldo.health_samples where owner_id = v_owner
    and ((payload is not null and end_at < now() - interval '90 days') or (payload is null and deleted_at < now() - interval '90 days'));
  get diagnostics v_raw = row_count;
  delete from waldo.health_requests where owner_id = v_owner and created_at < now() - interval '90 days';
  get diagnostics v_requests = row_count;
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests);
end $$;

-- The derived read model has one writer. The backend computes the scores and writes them through this signed
-- function; the direct trusted-role write grant is revoked below. A row names the consent it was computed from, and
-- the write is fenced on it: a producer that read data later withdrawn cannot store a row from it.
create function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_pillar text; v_p jsonb; v_day date; v_conf numeric; v_tz text; v_entry jsonb;
  v_scope waldo.health_scopes; v_consent waldo.health_consents;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 16384 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','timezone','basis','form','recovery','weight','drivers','confidence','freshness','tags')) then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = v_body->>'timezone') then return '{"error":"invalid_request"}'; end if;
  v_tz := v_body->>'timezone';
  if jsonb_typeof(v_body->'day') is distinct from 'string' or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_day := (v_body->>'day')::date;
  -- A row is for a day the owner can be in: at most tomorrow by their own clock, within the aggregate retention.
  if v_day > (now() at time zone v_tz)::date + 1 or v_day < (now() at time zone v_tz)::date - 731 then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'basis') is distinct from 'array' or jsonb_array_length(v_body->'basis') not between 1 and 3
    or exists (select 1 from jsonb_array_elements(v_body->'basis') b where jsonb_typeof(b) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(b) k where k not in ('source','consent_epoch'))
      or b->>'source' is null or b->>'source' not in ('apple','samsung','health_connect')
      or jsonb_typeof(b->'consent_epoch') is distinct from 'number' or b->>'consent_epoch' !~ '^[0-9]{1,9}$')
    or (select count(distinct b->>'source') from jsonb_array_elements(v_body->'basis') b) <> jsonb_array_length(v_body->'basis') then return '{"error":"invalid_request"}'; end if;
  foreach v_pillar in array array['form','recovery','weight'] loop
    v_p := v_body->v_pillar;
    if v_p is null or jsonb_typeof(v_p) = 'null' then continue; end if;
    if jsonb_typeof(v_p) <> 'object' then return '{"error":"invalid_request"}'; end if;
    if v_p ? 'reason' then
      -- An unavailable pillar says why and carries nothing else.
      if (select count(*) from jsonb_object_keys(v_p)) <> 1 or v_p->>'reason' not in ('not_linked','consent_required','consent_withdrawn','no_readings','baseline_immature','missing_sleep',
        'missing_resting_signal','stale_inputs','conflicting_inputs','intraday_inputs_unavailable','calendar_demand_unavailable') then return '{"error":"invalid_request"}'; end if;
    elsif exists (select 1 from jsonb_object_keys(v_p) k where k not in ('score','zone','drivers','confidence','algorithm_version','activation','hrv_method'))
      or jsonb_typeof(v_p->'score') is distinct from 'number' or (v_p->>'score')::numeric not between 0 and 100
      or jsonb_typeof(v_p->'zone') is distinct from 'string' or (v_p->>'zone') not in ('low','moderate','good','high','unknown')
      or jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
      or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')
      or (v_p ? 'hrv_method' and jsonb_typeof(v_p->'hrv_method') <> 'null' and (jsonb_typeof(v_p->'hrv_method') is distinct from 'string' or (v_p->>'hrv_method') not in ('rmssd','sdnn')))
      or (v_p ? 'confidence' and jsonb_typeof(v_p->'confidence') <> 'null' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p ? 'drivers' and (jsonb_typeof(v_p->'drivers') is distinct from 'array' or jsonb_array_length(v_p->'drivers') > 8)) then return '{"error":"invalid_request"}'; end if;
  end loop;
  if (v_body ? 'drivers' and (jsonb_typeof(v_body->'drivers') is distinct from 'array' or jsonb_array_length(v_body->'drivers') > 8 or exists (select 1 from jsonb_array_elements(v_body->'drivers') d where jsonb_typeof(d) <> 'string' or char_length(d #>> '{}') > 80)))
    or (v_body ? 'tags' and (jsonb_typeof(v_body->'tags') is distinct from 'array' or jsonb_array_length(v_body->'tags') > 10 or exists (select 1 from jsonb_array_elements(v_body->'tags') t where jsonb_typeof(t) <> 'string' or char_length(t #>> '{}') > 40)))
    or (v_body ? 'confidence' and v_body->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->'confidence') is distinct from 'number' or (v_body->>'confidence')::numeric not between 0 and 1))
    or (v_body ? 'freshness' and v_body->'freshness' <> 'null'::jsonb and (v_body->>'freshness') not in ('fresh','stale','expired')) then return '{"error":"invalid_request"}'; end if;
  for v_entry in select value from jsonb_array_elements(v_body->'basis') loop
    select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_entry->>'source' and purpose = 'storage_compute';
    select * into v_consent from waldo.health_consents where id = v_scope.consent_id;
    if v_consent.id is null or v_consent.withdrawn_at is not null then return '{"error":"consent_required"}'; end if;
    if v_scope.epoch <> (v_entry->>'consent_epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
  end loop;
  v_conf := case when jsonb_typeof(v_body->'confidence') = 'number' then (v_body->>'confidence')::numeric else null end;
  insert into public.health_context_daily(user_id, day, form, recovery, weight, drivers, confidence, freshness, tags)
    values (v_auth, v_day,
      case when jsonb_typeof(v_body->'form') = 'object' then v_body->'form' end, case when jsonb_typeof(v_body->'recovery') = 'object' then v_body->'recovery' end, case when jsonb_typeof(v_body->'weight') = 'object' then v_body->'weight' end,
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, case when jsonb_typeof(v_body->'freshness') = 'string' then v_body->>'freshness' end,
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]))
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags;
  insert into waldo.health_context_basis(owner_id, day, consent_basis, timezone) values (v_owner, v_day, v_body->'basis', v_tz)
    on conflict (owner_id, day) do update set consent_basis = excluded.consent_basis, timezone = excluded.timezone;
  return '{"written":true}'::jsonb;
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

-- The owner's own scores, for the app. This is not a model read: it needs live storage consent at the recorded epoch and
-- nothing else, so an owner who shares storage only still sees their scores in the app. The prompt path stays
-- waldo.health_context_read, which also needs the model purpose.
create function waldo.health_scores_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_day date; v_row record;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.scores_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 1024 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'day') then return '{"error":"invalid_request"}'; end if;
  if v_body ? 'day' then
    if jsonb_typeof(v_body->'day') is distinct from 'string' or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
    v_day := (v_body->>'day')::date;
  end if;
  select c.day, b.timezone, c.updated_at, c.freshness, c.form, c.recovery, c.weight into v_row
    from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and (v_day is null or c.day = v_day) and waldo.health_basis_live(v_owner, b.consent_basis, false)
    order by c.day desc limit 1;
  if v_row.day is not null then
    return jsonb_build_object('scores', jsonb_build_object('day', v_row.day, 'timezone', v_row.timezone,
      'compiled_at', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'freshness', v_row.freshness, 'form', v_row.form, 'recovery', v_row.recovery, 'weight', v_row.weight));
  end if;
  -- No row to show: say why, so the app can tell a missing grant from missing readings.
  return jsonb_build_object('unavailable', case
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_required'
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute' and c.withdrawn_at is null) then 'consent_withdrawn'
    else 'no_readings' end);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

revoke all on function waldo.health_consent_list(text,text,bigint,text), waldo.health_consent_grant(text,text,bigint,text), waldo.health_consent_withdraw(text,text,bigint,text),
  waldo.health_ingest(text,text,bigint,text), waldo.health_purge(text,text,bigint,text), waldo.health_retention(text,text,bigint,text), waldo.health_context_write(text,text,bigint,text), waldo.health_scores_read(text,text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.health_consent_list(text,text,bigint,text), waldo.health_consent_grant(text,text,bigint,text), waldo.health_consent_withdraw(text,text,bigint,text),
  waldo.health_ingest(text,text,bigint,text), waldo.health_purge(text,text,bigint,text), waldo.health_retention(text,text,bigint,text), waldo.health_context_write(text,text,bigint,text), waldo.health_scores_read(text,text,bigint,text) to anon;

-- The backend is the only writer of the derived read model: the trusted role keeps SELECT, not INSERT or UPDATE.
revoke insert, update on table public.health_context_daily from service_role;

-- The prompt read: the latest row, and the one before it for the trend, are returned only while every source they
-- were computed from still holds storage consent at the recorded epoch and a live model_processing grant. A row with
-- no basis is never read. Same signature and signed-call rule as before; only the rows it may return change.
create or replace function waldo.health_context_read(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid;
begin
  if not waldo.router_signed('healthctx.read.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id, auth_user_id into v_owner, v_auth from waldo.owners where do_name = p_do_name and state = 'active';
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
        'tags', c.tags,
        'compiled_at', c.updated_at
      ),
      'previous', (
        select jsonb_build_object('day', p2.day, 'form_score', (p2.form ->> 'score')::numeric)
        from public.health_context_daily p2
        join waldo.health_context_basis pb on pb.owner_id = v_owner and pb.day = p2.day
        where p2.user_id = v_auth and p2.day < c.day and waldo.health_basis_live(v_owner, pb.consent_basis, true)
        order by p2.day desc
        limit 1
      )
    )
    from public.health_context_daily c
    join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and waldo.health_basis_live(v_owner, b.consent_basis, true)
    order by c.day desc
    limit 1
  );
end $$;
revoke all on function waldo.health_context_read(text, bigint, text) from public;
grant execute on function waldo.health_context_read(text, bigint, text) to anon;
