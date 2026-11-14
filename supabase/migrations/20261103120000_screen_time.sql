-- Screen time on the health plane: one summary per owner, device and local day, sent by the owner's phone (Android Usage access)
-- and read by the owner's agent through get_screen_time and by the owner through the app. The contract is
-- packages/contracts/src/app/screen-time.ts.
--
-- - Consent is its own, apart from health: purposes storage_compute and model_processing, each with an epoch, on the
--   health-consent pattern. Model use needs both. Withdrawing storage withdraws both and deletes every stored day and upload
--   receipt; withdrawing model use only stops the agent's reads.
-- - waldo.screen_time_days holds the summary the Worker validated against the contract, and nothing else: no raw event, app
--   or package name. A day re-sent replaces the earlier copy for the same device.
-- - Retention: days and receipts 90 days, through the health retention sweep (re-created below with two lines added).
--   Account deletion removes everything through the owners cascade.
-- - Every call is a signed router call that resolves the owner from the private locator; no role touches the tables.

create table waldo.screen_time_consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  purpose text not null check (purpose in ('storage_compute', 'model_processing')),
  version integer not null check (version > 0),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz check (withdrawn_at is null or withdrawn_at >= granted_at)
);
create unique index screen_time_consents_one_active on waldo.screen_time_consents (owner_id, purpose) where withdrawn_at is null;

create table waldo.screen_time_scopes (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  purpose text not null check (purpose in ('storage_compute', 'model_processing')),
  epoch integer not null default 0 check (epoch >= 0),
  consent_id uuid references waldo.screen_time_consents (id),
  primary key (owner_id, purpose)
);

create table waldo.screen_time_days (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  device_id uuid not null,
  day date not null,
  epoch integer not null check (epoch > 0),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  primary key (owner_id, device_id, day)
);
create index screen_time_days_owner_day on waldo.screen_time_days (owner_id, day);

-- Receipts keep only a digest and the count-only answer, never the request body.
create table waldo.screen_time_requests (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  request_id text not null,
  operation text not null check (operation in ('consent_grant', 'consent_withdraw', 'ingest')),
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

alter table waldo.screen_time_consents enable row level security;
alter table waldo.screen_time_consents force row level security;
alter table waldo.screen_time_scopes enable row level security;
alter table waldo.screen_time_scopes force row level security;
alter table waldo.screen_time_days enable row level security;
alter table waldo.screen_time_days force row level security;
alter table waldo.screen_time_requests enable row level security;
alter table waldo.screen_time_requests force row level security;
revoke all on waldo.screen_time_consents, waldo.screen_time_scopes, waldo.screen_time_days, waldo.screen_time_requests
  from public, anon, authenticated, service_role;

create function waldo.screen_time_consent_view(p_owner uuid, p_purpose text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('purpose', p_purpose, 'version', coalesce(c.version, 1),
    'status', case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,
    'epoch', coalesce(s.epoch, 0),
    'granted_at', to_char(c.granted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at', to_char(c.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  from (select 1) x
  left join waldo.screen_time_scopes s on s.owner_id = p_owner and s.purpose = p_purpose
  left join waldo.screen_time_consents c on c.id = s.consent_id $$;

-- Null while every named purpose is live; otherwise the refusal the owner would recognise: a withdrawal beats "not asked yet".
create function waldo.screen_time_refusal(p_owner uuid, p_purposes text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when not exists (select 1 from unnest(p_purposes) p where not exists (select 1 from waldo.screen_time_scopes s
      join waldo.screen_time_consents c on c.id = s.consent_id where s.owner_id = p_owner and s.purpose = p and c.withdrawn_at is null)) then null
    when exists (select 1 from waldo.screen_time_scopes s join waldo.screen_time_consents c on c.id = s.consent_id
      where s.owner_id = p_owner and s.purpose = any (p_purposes) and c.withdrawn_at is not null) then '{"error":"consent_withdrawn"}'::jsonb
    else '{"error":"consent_required"}'::jsonb end $$;

create function waldo.screen_time_owner(p_op text, p_do_name text, p_payload text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('screen_time.' || p_op || '.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  return v_owner;
end $$;

create function waldo.screen_time_consent_list(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.screen_time_owner('consent_list', p_do_name, p_payload, p_at, p_sig);
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  return jsonb_build_object('consents', jsonb_build_array(waldo.screen_time_consent_view(v_owner, 'storage_compute'), waldo.screen_time_consent_view(v_owner, 'model_processing')));
end $$;

-- The two consent changes share their checks: a closed body, a replayed request answered from its receipt, and the epoch the
-- app last read. p_grant picks the change.
create function waldo.screen_time_consent_change(p_grant boolean, p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_op text := case when p_grant then 'consent_grant' else 'consent_withdraw' end;
  v_owner uuid := waldo.screen_time_owner(v_op, p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_id text; v_purpose text; v_prior waldo.screen_time_requests; v_scope waldo.screen_time_scopes; v_consent uuid; v_routed boolean := false; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'purpose', 'expected_epoch', 'version'))
    or (p_grant and v_body->'version' is distinct from '1'::jsonb) or (not p_grant and v_body ? 'version') then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_purpose := v_body->>'purpose';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or v_purpose is null or v_purpose not in ('storage_compute', 'model_processing')
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.screen_time_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> v_op or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  select * into v_scope from waldo.screen_time_scopes where owner_id = v_owner and purpose = v_purpose for update;
  if (v_body->>'expected_epoch')::integer <> coalesce(v_scope.epoch, 0) then return '{"error":"epoch_conflict"}'; end if;

  if p_grant then
    -- Model use sits on top of storage.
    if v_purpose = 'model_processing' and waldo.screen_time_refusal(v_owner, array['storage_compute']) is not null then return '{"error":"consent_required"}'; end if;
    if exists (select 1 from waldo.screen_time_consents where owner_id = v_owner and purpose = v_purpose and withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
    insert into waldo.screen_time_consents (owner_id, purpose, version) values (v_owner, v_purpose, 1) returning id into v_consent;
    insert into waldo.screen_time_scopes (owner_id, purpose, epoch, consent_id) values (v_owner, v_purpose, 1, v_consent)
      on conflict (owner_id, purpose) do update set epoch = waldo.screen_time_scopes.epoch + 1, consent_id = excluded.consent_id;
  else
    if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
    -- Withdrawing storage withdraws model use too and deletes what was kept; an upload queued before it carries the old epoch
    -- and is refused. Consent receipts stay so a replayed request still gets its answer.
    update waldo.screen_time_scopes s set epoch = s.epoch + 1 from waldo.screen_time_consents c
      where c.id = s.consent_id and c.withdrawn_at is null and s.owner_id = v_owner and (v_purpose = 'storage_compute' or s.purpose = v_purpose);
    update waldo.screen_time_consents set withdrawn_at = now()
      where owner_id = v_owner and withdrawn_at is null and (v_purpose = 'storage_compute' or purpose = v_purpose);
    if v_purpose = 'storage_compute' then
      delete from waldo.screen_time_days where owner_id = v_owner;
      delete from waldo.screen_time_requests where owner_id = v_owner and operation = 'ingest';
      v_routed := true;
    end if;
  end if;
  v_result := jsonb_build_object('consent', waldo.screen_time_consent_view(v_owner, v_purpose), 'replayed', false, 'deletion_routed', v_routed);
  insert into waldo.screen_time_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, v_op, md5(p_payload), v_result);
  return v_result;
end $$;

create function waldo.screen_time_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.screen_time_consent_change(true, p_do_name, p_payload, p_at, p_sig) $$;
create function waldo.screen_time_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.screen_time_consent_change(false, p_do_name, p_payload, p_at, p_sig) $$;

-- Up to 14 days from one device, each accepted or rejected on its own. A day later than tomorrow or more than 14 days before
-- today, in its own zone, is rejected: Android keeps only a few days of events, so an older day is not a fresh read.
create function waldo.screen_time_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := waldo.screen_time_owner('ingest', p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_id text; v_prior waldo.screen_time_requests; v_epoch integer; v_device uuid; v_day jsonb; v_date date; v_today date;
  v_refusal jsonb; v_results jsonb := '[]'::jsonb; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 65536 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'expected_epoch', 'device_id', 'days')) then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$'
    or jsonb_typeof(v_body->'device_id') is distinct from 'string' or (v_body->>'device_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(v_body->'days') is distinct from 'array' or jsonb_array_length(v_body->'days') not between 1 and 14 then return '{"error":"invalid_request"}'; end if;
  -- The summary's own shape is the contract's, checked by the Worker; here its keys are closed and its identity is checked.
  if exists (select 1 from jsonb_array_elements(v_body->'days') d where jsonb_typeof(d) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(d) k where k not in ('day', 'timezone', 'platform', 'coverage', 'screen_on_minutes', 'pickups', 'unlocks',
        'late_night_minutes', 'late_night_window', 'first_use_at', 'last_use_at', 'categories'))
      or jsonb_typeof(d->'day') is distinct from 'string' or (d->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(d->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = d->>'timezone')
      or d->>'platform' is distinct from 'android' or d->>'coverage' is null or d->>'coverage' not in ('complete', 'partial', 'none'))
    or (select count(distinct d->>'day') from jsonb_array_elements(v_body->'days') d) <> jsonb_array_length(v_body->'days') then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.screen_time_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'ingest' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  v_refusal := waldo.screen_time_refusal(v_owner, array['storage_compute']);
  if v_refusal is not null then return v_refusal; end if;
  select epoch into v_epoch from waldo.screen_time_scopes where owner_id = v_owner and purpose = 'storage_compute';
  if (v_body->>'expected_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;
  v_device := (v_body->>'device_id')::uuid;
  -- Eight devices at most, so the agent's device numbers stay small; a reinstall is a new installation id.
  if not exists (select 1 from waldo.screen_time_days where owner_id = v_owner and device_id = v_device)
    and (select count(distinct device_id) from waldo.screen_time_days where owner_id = v_owner) >= 8 then return '{"error":"invalid_request"}'; end if;
  for v_day in select d from jsonb_array_elements(v_body->'days') d order by d->>'day' loop
    begin v_date := (v_day->>'day')::date; exception when others then return '{"error":"invalid_request"}'; end;
    v_today := (now() at time zone (v_day->>'timezone'))::date;
    if v_date > v_today + 1 or v_date < v_today - 14 then
      v_results := v_results || jsonb_build_array(jsonb_build_object('day', v_day->>'day', 'status', 'rejected', 'reason', 'out_of_window'));
      continue;
    end if;
    insert into waldo.screen_time_days (owner_id, device_id, day, epoch, summary) values (v_owner, v_device, v_date, v_epoch, v_day)
      on conflict (owner_id, device_id, day) do update set summary = excluded.summary, epoch = excluded.epoch, received_at = now();
    v_results := v_results || jsonb_build_array(jsonb_build_object('day', v_day->>'day', 'status', 'accepted'));
  end loop;
  v_result := jsonb_build_object('request_id', v_id, 'replayed', false, 'results', v_results);
  insert into waldo.screen_time_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'ingest', md5(p_payload), v_result);
  return v_result;
end $$;

-- Stored days from from to to, oldest first. purpose owner is the owner's own view and needs storage consent; purpose model is
-- the agent's read and needs both. device numbers the owner's devices 1, 2, ... in the order they first sent.
create function waldo.screen_time_days_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.screen_time_owner('days_read', p_do_name, p_payload, p_at, p_sig); v_body jsonb; v_from date; v_to date; v_refusal jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('from', 'to', 'purpose'))
    or v_body->>'purpose' is null or v_body->>'purpose' not in ('owner', 'model')
    or jsonb_typeof(v_body->'from') is distinct from 'string' or (v_body->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(v_body->'to') is distinct from 'string' or (v_body->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  begin v_from := (v_body->>'from')::date; v_to := (v_body->>'to')::date; exception when others then return '{"error":"invalid_request"}'; end;
  if v_to < v_from or v_to - v_from >= 31 then return '{"error":"invalid_request"}'; end if;
  v_refusal := waldo.screen_time_refusal(v_owner, case when v_body->>'purpose' = 'model' then array['storage_compute', 'model_processing'] else array['storage_compute'] end);
  if v_refusal is not null then return v_refusal; end if;
  return jsonb_build_object('days', coalesce((
    with devices as (select device_id, row_number() over (order by min(created_at), device_id) as n
      from waldo.screen_time_days where owner_id = v_owner group by device_id)
    select jsonb_agg(jsonb_build_object('device_id', d.device_id, 'device', v.n,
      'received_at', to_char(d.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'summary', d.summary) order by d.day, v.n)
    from waldo.screen_time_days d join devices v on v.device_id = d.device_id
    where d.owner_id = v_owner and d.day between v_from and v_to), '[]'::jsonb));
end $$;

revoke all on function waldo.screen_time_consent_view(uuid, text), waldo.screen_time_refusal(uuid, text[]), waldo.screen_time_owner(text, text, text, bigint, text),
  waldo.screen_time_consent_change(boolean, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.screen_time_consent_list(text, text, bigint, text), waldo.screen_time_consent_grant(text, text, bigint, text),
  waldo.screen_time_consent_withdraw(text, text, bigint, text), waldo.screen_time_ingest(text, text, bigint, text), waldo.screen_time_days_read(text, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.screen_time_consent_list(text, text, bigint, text), waldo.screen_time_consent_grant(text, text, bigint, text),
  waldo.screen_time_consent_withdraw(text, text, bigint, text), waldo.screen_time_ingest(text, text, bigint, text), waldo.screen_time_days_read(text, text, bigint, text)
  to anon;

-- Retention (20261101040000): the per-owner call and the sweep also age out screen-time days and receipts older than 90 days, and
-- the sweep finds an owner whose only expired rows are those. The result keeps its keys.
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
