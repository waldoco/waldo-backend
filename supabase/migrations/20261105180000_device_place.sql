-- Device context on the health plane, first signal place: the latest coarse place per owner and device, sent by the owner's
-- phone and read by the owner through the app (and, in a later slice, by the owner's agent). The contract is
-- packages/contracts/src/app/device-context.ts; the design is docs/proposals/ADR_DRAFT_DEVICE_CONTEXT_2026-11-05.md.
--
-- - Consent is per signal, apart from health and screen time: purposes storage_compute, model_processing and provider_lookup,
--   each with an epoch, on the screen-time pattern. The last two sit on top of storage. Withdrawing storage withdraws all three
--   and deletes the signal's stored rows and upload receipts; withdrawing either other purpose only stops that use.
-- - waldo.device_place_latest holds one row per owner and device, overwritten: a 5-character geohash cell, the OS place names,
--   the time zone and the platform. No coordinate, no history. An older observation never overwrites a newer one.
-- - Retention: a place not refreshed in 30 days, and receipts older than 90 days, go with the health retention sweep
--   (re-created below with lines added). Account deletion removes everything through the owners cascade.
-- - Every call is a signed router call that resolves the owner from the private locator; no role touches the tables.

create table waldo.device_context_consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  signal text not null check (signal in ('place')),
  purpose text not null check (purpose in ('storage_compute', 'model_processing', 'provider_lookup')),
  version integer not null check (version > 0),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz check (withdrawn_at is null or withdrawn_at >= granted_at)
);
create unique index device_context_consents_one_active on waldo.device_context_consents (owner_id, signal, purpose) where withdrawn_at is null;

create table waldo.device_context_scopes (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  signal text not null check (signal in ('place')),
  purpose text not null check (purpose in ('storage_compute', 'model_processing', 'provider_lookup')),
  epoch integer not null default 0 check (epoch >= 0),
  consent_id uuid references waldo.device_context_consents (id),
  primary key (owner_id, signal, purpose)
);

create table waldo.device_place_latest (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  device_id uuid not null,
  epoch integer not null check (epoch > 0),
  place jsonb not null check (jsonb_typeof(place) = 'object' and place->>'cell' ~ '^[0-9b-hjkmnp-z]{5}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  primary key (owner_id, device_id)
);

-- Receipts keep only a digest and the answer, never the request body.
create table waldo.device_context_requests (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  request_id text not null,
  operation text not null check (operation in ('consent_grant', 'consent_withdraw', 'place_ingest')),
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

alter table waldo.device_context_consents enable row level security;
alter table waldo.device_context_consents force row level security;
alter table waldo.device_context_scopes enable row level security;
alter table waldo.device_context_scopes force row level security;
alter table waldo.device_place_latest enable row level security;
alter table waldo.device_place_latest force row level security;
alter table waldo.device_context_requests enable row level security;
alter table waldo.device_context_requests force row level security;
revoke all on waldo.device_context_consents, waldo.device_context_scopes, waldo.device_place_latest, waldo.device_context_requests
  from public, anon, authenticated, service_role;

create function waldo.device_context_consent_view(p_owner uuid, p_signal text, p_purpose text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('signal', p_signal, 'purpose', p_purpose, 'version', coalesce(c.version, 1),
    'status', case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,
    'epoch', coalesce(s.epoch, 0),
    'granted_at', to_char(c.granted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at', to_char(c.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  from (select 1) x
  left join waldo.device_context_scopes s on s.owner_id = p_owner and s.signal = p_signal and s.purpose = p_purpose
  left join waldo.device_context_consents c on c.id = s.consent_id $$;

-- Null while every named purpose of the signal is live; otherwise the refusal the owner would recognise: a withdrawal beats
-- "not asked yet".
create function waldo.device_context_refusal(p_owner uuid, p_signal text, p_purposes text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when not exists (select 1 from unnest(p_purposes) p where not exists (select 1 from waldo.device_context_scopes s
      join waldo.device_context_consents c on c.id = s.consent_id
      where s.owner_id = p_owner and s.signal = p_signal and s.purpose = p and c.withdrawn_at is null)) then null
    when exists (select 1 from waldo.device_context_scopes s join waldo.device_context_consents c on c.id = s.consent_id
      where s.owner_id = p_owner and s.signal = p_signal and s.purpose = any (p_purposes) and c.withdrawn_at is not null) then '{"error":"consent_withdrawn"}'::jsonb
    else '{"error":"consent_required"}'::jsonb end $$;

create function waldo.device_context_owner(p_op text, p_do_name text, p_payload text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('device_context.' || p_op || '.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  return v_owner;
end $$;

create function waldo.device_context_consent_list(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.device_context_owner('consent_list', p_do_name, p_payload, p_at, p_sig);
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  return jsonb_build_object('consents', jsonb_build_array(waldo.device_context_consent_view(v_owner, 'place', 'storage_compute'),
    waldo.device_context_consent_view(v_owner, 'place', 'model_processing'), waldo.device_context_consent_view(v_owner, 'place', 'provider_lookup')));
end $$;

-- The two consent changes share their checks: a closed body, a replayed request answered from its receipt, and the epoch the
-- app last read. p_grant picks the change.
create function waldo.device_context_consent_change(p_grant boolean, p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_op text := case when p_grant then 'consent_grant' else 'consent_withdraw' end;
  v_owner uuid := waldo.device_context_owner(v_op, p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_id text; v_signal text; v_purpose text; v_prior waldo.device_context_requests; v_scope waldo.device_context_scopes;
  v_consent uuid; v_routed boolean := false; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'signal', 'purpose', 'expected_epoch', 'version'))
    or (p_grant and v_body->'version' is distinct from '1'::jsonb) or (not p_grant and v_body ? 'version') then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_signal := v_body->>'signal'; v_purpose := v_body->>'purpose';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or v_signal is null or v_signal not in ('place')
    or v_purpose is null or v_purpose not in ('storage_compute', 'model_processing', 'provider_lookup')
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.device_context_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> v_op or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  select * into v_scope from waldo.device_context_scopes where owner_id = v_owner and signal = v_signal and purpose = v_purpose for update;
  if (v_body->>'expected_epoch')::integer <> coalesce(v_scope.epoch, 0) then return '{"error":"epoch_conflict"}'; end if;

  if p_grant then
    -- Model use and provider lookup sit on top of storage.
    if v_purpose <> 'storage_compute' and waldo.device_context_refusal(v_owner, v_signal, array['storage_compute']) is not null then return '{"error":"consent_required"}'; end if;
    if exists (select 1 from waldo.device_context_consents where owner_id = v_owner and signal = v_signal and purpose = v_purpose and withdrawn_at is null) then
      return '{"error":"epoch_conflict"}';
    end if;
    insert into waldo.device_context_consents (owner_id, signal, purpose, version) values (v_owner, v_signal, v_purpose, 1) returning id into v_consent;
    insert into waldo.device_context_scopes (owner_id, signal, purpose, epoch, consent_id) values (v_owner, v_signal, v_purpose, 1, v_consent)
      on conflict (owner_id, signal, purpose) do update set epoch = waldo.device_context_scopes.epoch + 1, consent_id = excluded.consent_id;
  else
    if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
    -- Withdrawing storage withdraws the other purposes too and deletes what was kept; an upload queued before it carries the old
    -- epoch and is refused. Consent receipts stay so a replayed request still gets its answer.
    update waldo.device_context_scopes s set epoch = s.epoch + 1 from waldo.device_context_consents c
      where c.id = s.consent_id and c.withdrawn_at is null and s.owner_id = v_owner and s.signal = v_signal
        and (v_purpose = 'storage_compute' or s.purpose = v_purpose);
    update waldo.device_context_consents set withdrawn_at = now()
      where owner_id = v_owner and signal = v_signal and withdrawn_at is null and (v_purpose = 'storage_compute' or purpose = v_purpose);
    if v_purpose = 'storage_compute' then
      delete from waldo.device_place_latest where owner_id = v_owner;
      delete from waldo.device_context_requests where owner_id = v_owner and operation = 'place_ingest';
      v_routed := true;
    end if;
  end if;
  v_result := jsonb_build_object('consent', waldo.device_context_consent_view(v_owner, v_signal, v_purpose), 'replayed', false, 'deletion_routed', v_routed);
  insert into waldo.device_context_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, v_op, md5(p_payload), v_result);
  return v_result;
end $$;

create function waldo.device_context_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.device_context_consent_change(true, p_do_name, p_payload, p_at, p_sig) $$;
create function waldo.device_context_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.device_context_consent_change(false, p_do_name, p_payload, p_at, p_sig) $$;

-- One place from one device. The place's own shape is the contract's, checked by the Worker; here its keys are closed, the cell is
-- coarse and the time zone and time are real. An observation more than 10 minutes in the future is refused; one older than the
-- stored observation for the same device is answered superseded and changes nothing.
create function waldo.device_context_place_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := waldo.device_context_owner('place_ingest', p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_place jsonb; v_id text; v_prior waldo.device_context_requests; v_epoch integer; v_device uuid; v_observed timestamptz;
  v_refusal jsonb; v_status text := 'accepted'; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'expected_epoch', 'device_id', 'place')) then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_place := v_body->'place';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$'
    or jsonb_typeof(v_body->'device_id') is distinct from 'string' or (v_body->>'device_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(v_place) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_place) k where k not in ('cell', 'locality', 'region', 'country', 'timezone', 'platform', 'observed_at'))
    or jsonb_typeof(v_place->'cell') is distinct from 'string' or (v_place->>'cell') !~ '^[0-9b-hjkmnp-z]{5}$'
    or jsonb_typeof(v_place->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = v_place->>'timezone')
    or v_place->>'platform' is null or v_place->>'platform' not in ('ios', 'android')
    or jsonb_typeof(v_place->'observed_at') is distinct from 'string' then return '{"error":"invalid_request"}'; end if;
  begin v_observed := (v_place->>'observed_at')::timestamptz; exception when others then return '{"error":"invalid_request"}'; end;
  if v_observed > now() + interval '10 minutes' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.device_context_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'place_ingest' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  v_refusal := waldo.device_context_refusal(v_owner, 'place', array['storage_compute']);
  if v_refusal is not null then return v_refusal; end if;
  select epoch into v_epoch from waldo.device_context_scopes where owner_id = v_owner and signal = 'place' and purpose = 'storage_compute';
  if (v_body->>'expected_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;
  v_device := (v_body->>'device_id')::uuid;
  if not exists (select 1 from waldo.device_place_latest where owner_id = v_owner and device_id = v_device)
    and (select count(*) from waldo.device_place_latest where owner_id = v_owner) >= 8 then return '{"error":"invalid_request"}'; end if;
  insert into waldo.device_place_latest (owner_id, device_id, epoch, place, observed_at) values (v_owner, v_device, v_epoch, v_place, v_observed)
    on conflict (owner_id, device_id) do update set place = excluded.place, epoch = excluded.epoch, observed_at = excluded.observed_at, received_at = now()
      where waldo.device_place_latest.observed_at <= excluded.observed_at;
  if not found then v_status := 'superseded'; end if;
  v_result := jsonb_build_object('request_id', v_id, 'replayed', false, 'status', v_status);
  insert into waldo.device_context_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'place_ingest', md5(p_payload), v_result);
  return v_result;
end $$;

-- The latest place per device, newest first. purpose owner is the owner's own view and needs storage consent; purpose model is the
-- agent's read and needs storage and model use.
create function waldo.device_context_place_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.device_context_owner('place_read', p_do_name, p_payload, p_at, p_sig); v_body jsonb; v_refusal jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'purpose')
    or v_body->>'purpose' is null or v_body->>'purpose' not in ('owner', 'model') then return '{"error":"invalid_request"}'; end if;
  v_refusal := waldo.device_context_refusal(v_owner, 'place', case when v_body->>'purpose' = 'model' then array['storage_compute', 'model_processing'] else array['storage_compute'] end);
  if v_refusal is not null then return v_refusal; end if;
  return jsonb_build_object('places', coalesce((select jsonb_agg(jsonb_build_object('device_id', p.device_id,
      'received_at', to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'place', p.place) order by p.observed_at desc, p.device_id)
    from waldo.device_place_latest p where p.owner_id = v_owner), '[]'::jsonb));
end $$;

revoke all on function waldo.device_context_consent_view(uuid, text, text), waldo.device_context_refusal(uuid, text, text[]),
  waldo.device_context_owner(text, text, text, bigint, text), waldo.device_context_consent_change(boolean, text, text, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function waldo.device_context_consent_list(text, text, bigint, text), waldo.device_context_consent_grant(text, text, bigint, text),
  waldo.device_context_consent_withdraw(text, text, bigint, text), waldo.device_context_place_ingest(text, text, bigint, text),
  waldo.device_context_place_read(text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.device_context_consent_list(text, text, bigint, text), waldo.device_context_consent_grant(text, text, bigint, text),
  waldo.device_context_consent_withdraw(text, text, bigint, text), waldo.device_context_place_ingest(text, text, bigint, text),
  waldo.device_context_place_read(text, text, bigint, text) to anon;

-- Retention (20261103120000): the per-owner call and the sweep also age out places not refreshed in 30 days and device-context
-- receipts older than 90 days, and the sweep finds an owner whose only expired rows are those. The result keeps its keys.
create or replace function waldo.health_retention_apply(p_owner uuid, p_auth uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_raw integer; v_requests integer; v_context integer; v_cut date := (now() at time zone 'UTC')::date - 733;
begin
  delete from waldo.health_samples where owner_id = p_owner
    and ((payload is not null and end_at < now() - interval '90 days') or (payload is null and deleted_at < now() - interval '90 days'));
  get diagnostics v_raw = row_count;
  delete from waldo.health_requests where owner_id = p_owner and created_at < now() - interval '90 days';
  get diagnostics v_requests = row_count;
  delete from public.health_context_daily where user_id = p_auth and day < v_cut;
  get diagnostics v_context = row_count;
  delete from waldo.health_context_basis where owner_id = p_owner and day < v_cut;
  delete from waldo.health_ingest_refusals where owner_id = p_owner and day < (now() at time zone 'UTC')::date - 30;
  delete from waldo.health_medication_doses where owner_id = p_owner and due_at < now() - interval '90 days';
  delete from waldo.screen_time_days where owner_id = p_owner and day < (now() at time zone 'UTC')::date - 90;
  delete from waldo.screen_time_requests where owner_id = p_owner and created_at < now() - interval '90 days';
  delete from waldo.device_place_latest where owner_id = p_owner and received_at < now() - interval '30 days';
  delete from waldo.device_context_requests where owner_id = p_owner and created_at < now() - interval '90 days';
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;

create or replace function waldo.health_retention_sweep(p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_body jsonb; v_limit integer; v_owner record; v_n integer := 0; v_more boolean := false; v_one jsonb;
  v_raw integer := 0; v_requests integer := 0; v_context integer := 0;
begin
  if p_payload is null or waldo.router_signed('health.retention_sweep.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'limit')
    or jsonb_typeof(v_body->'limit') is distinct from 'number' or (v_body->>'limit') !~ '^[0-9]{1,3}$'
    or (v_body->>'limit')::integer not between 1 and 200 then return '{"error":"invalid_request"}'; end if;
  v_limit := (v_body->>'limit')::integer;
  for v_owner in
    select o.id, o.auth_user_id from waldo.owners o
    where exists (select 1 from waldo.health_samples s where s.owner_id = o.id
        and ((s.payload is not null and s.end_at < now() - interval '90 days') or (s.payload is null and s.deleted_at < now() - interval '90 days')))
      or exists (select 1 from waldo.health_requests r where r.owner_id = o.id and r.created_at < now() - interval '90 days')
      or exists (select 1 from public.health_context_daily d where d.user_id = o.auth_user_id and d.day < (now() at time zone 'UTC')::date - 733)
      or exists (select 1 from waldo.health_context_basis b where b.owner_id = o.id and b.day < (now() at time zone 'UTC')::date - 733)
      or exists (select 1 from waldo.health_ingest_refusals f where f.owner_id = o.id and f.day < (now() at time zone 'UTC')::date - 30)
      or exists (select 1 from waldo.health_medication_doses m where m.owner_id = o.id and m.due_at < now() - interval '90 days')
      or exists (select 1 from waldo.screen_time_days t where t.owner_id = o.id and t.day < (now() at time zone 'UTC')::date - 90)
      or exists (select 1 from waldo.screen_time_requests q where q.owner_id = o.id and q.created_at < now() - interval '90 days')
      or exists (select 1 from waldo.device_place_latest p where p.owner_id = o.id and p.received_at < now() - interval '30 days')
      or exists (select 1 from waldo.device_context_requests c where c.owner_id = o.id and c.created_at < now() - interval '90 days')
    order by o.id limit v_limit + 1 for update of o skip locked
  loop
    if v_n = v_limit then v_more := true; exit; end if;
    v_one := waldo.health_retention_apply(v_owner.id, v_owner.auth_user_id);
    v_n := v_n + 1;
    v_raw := v_raw + (v_one->>'raw_deleted')::integer;
    v_requests := v_requests + (v_one->>'requests_deleted')::integer;
    v_context := v_context + (v_one->>'context_deleted')::integer;
  end loop;
  return jsonb_build_object('owners', v_n, 'more', v_more, 'raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;
