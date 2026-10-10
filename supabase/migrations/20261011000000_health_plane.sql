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
revoke all on waldo.health_consents, waldo.health_scopes, waldo.health_samples, waldo.health_anchors, waldo.health_requests from public, anon, authenticated, service_role;

create function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,'version',coalesce(c.version,2),
    'status',case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,'epoch',p_scope.epoch,
    'granted_at',to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at',to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state',case when c.withdrawn_at is null then 'not_required' else 'completed' end)
  from (select 1) x left join waldo.health_consents c on c.id = p_scope.consent_id $$;
revoke all on function waldo.health_consent_view(waldo.health_scopes) from public, anon, authenticated, service_role;

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
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
  if (v_body->>'expected_epoch')::integer <> v_scope.epoch then return '{"error":"epoch_conflict"}'; end if;
  -- Withdrawing either purpose withdraws both for this source and removes its data: a storage upload queued
  -- before the withdrawal cannot repopulate it, and new processing needs fresh explicit grants.
  update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and withdrawn_at is null;
  update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source;
  delete from waldo.health_samples where owner_id = v_owner and source = v_source;
  delete from waldo.health_anchors where owner_id = v_owner and source = v_source;
  delete from public.health_context_daily where user_id = v_auth;
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
    v_local_start := ((v_start at time zone 'UTC') + make_interval(mins => v_offset))::date; v_local_end := ((v_end at time zone 'UTC') + make_interval(mins => v_offset))::date;
    if v_value not between v_lo and v_hi or v_offset not between -840 and 840 or v_day is null or v_start is null or v_end is null or v_start > v_end
      or v_end > now() + interval '5 minutes' or v_revision > v_now_epoch + 300 or v_day not in (v_local_start, v_local_end)
      or (v_windowed and (v_end - v_start <> interval '1 hour' or mod((extract(epoch from v_start)::bigint + v_offset * 60), 3600) <> 0))
      or (v_signal in ('overnight_hrv','hrv_window') and coalesce(v_change->>'method','') not in ('rmssd','sdnn')) then raise exception 'invalid health sample' using errcode = '22023'; end if;
    if v_end < now() - interval '90 days' then v_ignored := v_ignored + 1; continue; end if;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.revision = v_revision then
      if v_stored.payload is not null and (v_stored.payload is distinct from v_change) then raise exception 'health sample revision conflict' using errcode = '40001'; end if;
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
    if found and v_stored.payload is null then v_ignored := v_ignored + 1; continue; end if;
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
  when invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then return '{"error":"invalid_request"}';
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
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
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
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  delete from waldo.health_samples where owner_id = v_owner
    and ((payload is not null and end_at < now() - interval '90 days') or (payload is null and deleted_at < now() - interval '90 days'));
  get diagnostics v_raw = row_count;
  delete from waldo.health_requests where owner_id = v_owner and created_at < now() - interval '90 days';
  get diagnostics v_requests = row_count;
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests);
end $$;

-- The derived read model has one writer. The backend computes the scores and writes them through this signed
-- function; the direct trusted-role write grant is revoked below.
create function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_key text; v_pillar text; v_day date; v_conf numeric;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 16384 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','form','recovery','weight','drivers','confidence','freshness','tags')) then return '{"error":"invalid_request"}'; end if;
  if not exists (select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id where s.owner_id = v_owner and s.purpose = 'storage_compute' and c.withdrawn_at is null) then return '{"error":"consent_required"}'; end if;
  if (v_body->>'day') is null or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_day := (v_body->>'day')::date;
  foreach v_pillar in array array['form','recovery','weight'] loop
    if v_body ? v_pillar and jsonb_typeof(v_body->v_pillar) = 'object' then
      if exists (select 1 from jsonb_object_keys(v_body->v_pillar) k where k not in ('score','zone','drivers','confidence'))
        or jsonb_typeof(v_body->v_pillar->'score') is distinct from 'number' or (v_body->v_pillar->>'score')::numeric not between 0 and 100
        or (v_body->v_pillar->>'zone') is null or (v_body->v_pillar->>'zone') not in ('low','moderate','good','high','unknown')
        or (v_body->v_pillar ? 'confidence' and v_body->v_pillar->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->v_pillar->'confidence') is distinct from 'number' or (v_body->v_pillar->>'confidence')::numeric not between 0 and 1))
        or (v_body->v_pillar ? 'drivers' and (jsonb_typeof(v_body->v_pillar->'drivers') is distinct from 'array' or jsonb_array_length(v_body->v_pillar->'drivers') > 8)) then return '{"error":"invalid_request"}'; end if;
    elsif v_body ? v_pillar and jsonb_typeof(v_body->v_pillar) is distinct from 'null' then return '{"error":"invalid_request"}'; end if;
  end loop;
  if (v_body ? 'drivers' and (jsonb_typeof(v_body->'drivers') is distinct from 'array' or jsonb_array_length(v_body->'drivers') > 8 or exists (select 1 from jsonb_array_elements(v_body->'drivers') d where jsonb_typeof(d) <> 'string' or char_length(d #>> '{}') > 80)))
    or (v_body ? 'tags' and (jsonb_typeof(v_body->'tags') is distinct from 'array' or jsonb_array_length(v_body->'tags') > 10 or exists (select 1 from jsonb_array_elements(v_body->'tags') t where jsonb_typeof(t) <> 'string' or char_length(t #>> '{}') > 40)))
    or (v_body ? 'confidence' and v_body->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->'confidence') is distinct from 'number' or (v_body->>'confidence')::numeric not between 0 and 1))
    or (v_body ? 'freshness' and v_body->'freshness' <> 'null'::jsonb and (v_body->>'freshness') not in ('fresh','stale','expired')) then return '{"error":"invalid_request"}'; end if;
  v_conf := case when jsonb_typeof(v_body->'confidence') = 'number' then (v_body->>'confidence')::numeric else null end;
  insert into public.health_context_daily(user_id, day, form, recovery, weight, drivers, confidence, freshness, tags)
    values (v_auth, v_day,
      case when jsonb_typeof(v_body->'form') = 'object' then v_body->'form' end, case when jsonb_typeof(v_body->'recovery') = 'object' then v_body->'recovery' end, case when jsonb_typeof(v_body->'weight') = 'object' then v_body->'weight' end,
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, case when jsonb_typeof(v_body->'freshness') = 'string' then v_body->>'freshness' end,
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]))
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags;
  return '{"written":true}'::jsonb;
exception
  when invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then return '{"error":"invalid_request"}';
end $$;

revoke all on function waldo.health_consent_list(text,text,bigint,text), waldo.health_consent_grant(text,text,bigint,text), waldo.health_consent_withdraw(text,text,bigint,text),
  waldo.health_ingest(text,text,bigint,text), waldo.health_purge(text,text,bigint,text), waldo.health_retention(text,text,bigint,text), waldo.health_context_write(text,text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.health_consent_list(text,text,bigint,text), waldo.health_consent_grant(text,text,bigint,text), waldo.health_consent_withdraw(text,text,bigint,text),
  waldo.health_ingest(text,text,bigint,text), waldo.health_purge(text,text,bigint,text), waldo.health_retention(text,text,bigint,text), waldo.health_context_write(text,text,bigint,text) to anon;

-- The backend is the only writer of the derived read model: the trusted role keeps SELECT, not INSERT or UPDATE.
revoke insert, update on table public.health_context_daily from service_role;
