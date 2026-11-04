-- Menstrual cycle context on the health plane, under proposed ADR-0085: the owner's period dates, sent by their phone from Apple
-- Health or Health Connect after the owner turned the Cycle row on. The contract is packages/contracts/src/app/cycle.ts.
--
-- - Consent is its own class, reproductive_health, with one purpose, cycle_context, and its own epoch. A grant needs a live health
--   storage_compute grant for apple or health_connect. Withdrawing cycle_context, or either of those storage grants (the trigger
--   on waldo.health_consents below), withdraws it, deletes every stored period and its upload receipts, and moves the epoch, so a
--   queued upload cannot repopulate anything.
-- - waldo.cycle_periods holds one interval per period: local start and end dates, the reading's provenance and the recording
--   app's name. Nothing else; flow level is never sent.
-- - Retention: periods and receipts 90 days, through the health retention sweep (re-created below with two lines added).
--   Account deletion removes everything through the owners cascade.
-- - Every call is a signed router call that resolves the owner from the private locator; no role touches the tables.

create table waldo.cycle_consents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  version integer not null check (version > 0),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz check (withdrawn_at is null or withdrawn_at >= granted_at),
  age_attested_18_plus boolean not null check (age_attested_18_plus is true)
);
create unique index cycle_consents_one_active on waldo.cycle_consents (owner_id) where withdrawn_at is null;

-- Consent is audit evidence: the only in-place change is a withdrawal.
create function waldo.cycle_consent_history() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.withdrawn_at is not null or new.withdrawn_at is null or old.id is distinct from new.id or old.owner_id is distinct from new.owner_id
    or old.version is distinct from new.version or old.granted_at is distinct from new.granted_at or old.age_attested_18_plus is distinct from new.age_attested_18_plus then
    raise exception 'cycle consent records are immutable except for withdrawal' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function waldo.cycle_consent_history() from public, anon, authenticated, service_role;
create trigger cycle_consent_history before update on waldo.cycle_consents for each row execute function waldo.cycle_consent_history();

create table waldo.cycle_scopes (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  epoch integer not null default 0 check (epoch >= 0),
  consent_id uuid references waldo.cycle_consents (id)
);

create table waldo.cycle_periods (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  source text not null check (source in ('apple', 'health_connect')),
  start_date date not null,
  end_date date check (end_date is null or end_date between start_date and start_date + 14),
  epoch integer not null check (epoch > 0),
  origin jsonb not null check (jsonb_typeof(origin) = 'object'),
  source_name text check (source_name is null or length(source_name) between 1 and 100),
  received_at timestamptz not null default now(),
  primary key (owner_id, source, start_date)
);

-- Receipts keep only a digest and the count-only answer, never the request body.
create table waldo.cycle_requests (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  request_id text not null,
  operation text not null check (operation in ('consent_grant', 'consent_withdraw', 'ingest')),
  payload_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

alter table waldo.cycle_consents enable row level security;
alter table waldo.cycle_consents force row level security;
alter table waldo.cycle_scopes enable row level security;
alter table waldo.cycle_scopes force row level security;
alter table waldo.cycle_periods enable row level security;
alter table waldo.cycle_periods force row level security;
alter table waldo.cycle_requests enable row level security;
alter table waldo.cycle_requests force row level security;
revoke all on waldo.cycle_consents, waldo.cycle_scopes, waldo.cycle_periods, waldo.cycle_requests from public, anon, authenticated, service_role;

-- A withdrawal always deletes, so a withdrawn record's deletion is completed.
create function waldo.cycle_consent_view(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class', 'reproductive_health', 'purpose', 'cycle_context', 'version', coalesce(c.version, 1),
    'status', case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,
    'epoch', coalesce(s.epoch, 0),
    'granted_at', to_char(c.granted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at', to_char(c.withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state', case when c.withdrawn_at is null then 'not_required' else 'completed' end)
  from (select 1) x
  left join waldo.cycle_scopes s on s.owner_id = p_owner
  left join waldo.cycle_consents c on c.id = s.consent_id $$;

-- Null while cycle_context is live; otherwise the refusal the owner would recognise: a withdrawal beats "not asked yet".
create function waldo.cycle_refusal(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from waldo.cycle_scopes s join waldo.cycle_consents c on c.id = s.consent_id where s.owner_id = p_owner and c.withdrawn_at is null) then null
    when exists (select 1 from waldo.cycle_scopes s join waldo.cycle_consents c on c.id = s.consent_id where s.owner_id = p_owner) then '{"error":"consent_withdrawn"}'::jsonb
    else '{"error":"consent_required"}'::jsonb end $$;

create function waldo.cycle_storage_live(p_owner uuid, p_sources text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from waldo.health_consents where owner_id = p_owner and purpose = 'storage_compute' and source = any (p_sources) and withdrawn_at is null) $$;

-- Withdraws a live cycle_context and deletes everything it kept. True when there was one to withdraw.
create function waldo.cycle_withdraw_all(p_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  -- The owner lock orders a withdrawal after any upload in flight, whichever path withdrew.
  perform 1 from waldo.owners where id = p_owner for update;
  update waldo.cycle_scopes s set epoch = s.epoch + 1 from waldo.cycle_consents c
    where c.id = s.consent_id and c.withdrawn_at is null and s.owner_id = p_owner;
  if not found then return false; end if;
  update waldo.cycle_consents set withdrawn_at = now() where owner_id = p_owner and withdrawn_at is null;
  delete from waldo.cycle_periods where owner_id = p_owner;
  delete from waldo.cycle_requests where owner_id = p_owner and operation = 'ingest';
  return true;
end $$;

create function waldo.cycle_owner(p_op text, p_do_name text, p_payload text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('cycle.' || p_op || '.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  return v_owner;
end $$;

create function waldo.cycle_consent_list(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.cycle_owner('consent_list', p_do_name, p_payload, p_at, p_sig);
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  return jsonb_build_object('consents', jsonb_build_array(waldo.cycle_consent_view(v_owner)));
end $$;

-- The two consent changes share their checks: a closed body, a replayed request answered from its receipt, and the epoch the
-- app last read. p_grant picks the change.
create function waldo.cycle_consent_change(p_grant boolean, p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_op text := case when p_grant then 'consent_grant' else 'consent_withdraw' end;
  v_owner uuid := waldo.cycle_owner(v_op, p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_id text; v_prior waldo.cycle_requests; v_scope waldo.cycle_scopes; v_consent uuid; v_routed boolean := false; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'purpose', 'expected_epoch', 'version', 'age_attested_18_plus'))
    or (p_grant and (v_body->'version' is distinct from '1'::jsonb or v_body->'age_attested_18_plus' is distinct from 'true'::jsonb))
    or (not p_grant and (v_body ? 'version' or v_body ? 'age_attested_18_plus')) then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or v_body->>'purpose' is distinct from 'cycle_context'
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.cycle_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> v_op or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  select * into v_scope from waldo.cycle_scopes where owner_id = v_owner for update;
  if (v_body->>'expected_epoch')::integer <> coalesce(v_scope.epoch, 0) then return '{"error":"epoch_conflict"}'; end if;

  if p_grant then
    -- Cycle context sits on top of health storage from a source it can come from.
    if not waldo.cycle_storage_live(v_owner, array['apple', 'health_connect']) then return '{"error":"consent_required"}'; end if;
    if exists (select 1 from waldo.cycle_consents where owner_id = v_owner and withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
    insert into waldo.cycle_consents (owner_id, version, age_attested_18_plus) values (v_owner, 1, true) returning id into v_consent;
    insert into waldo.cycle_scopes (owner_id, epoch, consent_id) values (v_owner, 1, v_consent)
      on conflict (owner_id) do update set epoch = waldo.cycle_scopes.epoch + 1, consent_id = excluded.consent_id;
  else
    if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
    v_routed := waldo.cycle_withdraw_all(v_owner);
  end if;
  v_result := jsonb_build_object('consent', waldo.cycle_consent_view(v_owner), 'replayed', false, 'deletion_routed', v_routed);
  insert into waldo.cycle_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, v_op, md5(p_payload), v_result);
  return v_result;
end $$;

create function waldo.cycle_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.cycle_consent_change(true, p_do_name, p_payload, p_at, p_sig) $$;
create function waldo.cycle_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language sql security definer set search_path = '' as $$ select waldo.cycle_consent_change(false, p_do_name, p_payload, p_at, p_sig) $$;

-- The periods from one source that start on or after window_start replace what was stored for that source from window_start
-- on. A period that ended more than 90 days ago, or starts after tomorrow, is counted as ignored and not stored.
create function waldo.cycle_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := waldo.cycle_owner('ingest', p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_id text; v_prior waldo.cycle_requests; v_epoch integer; v_source text; v_window date; v_period jsonb; v_start date; v_end date;
  v_today date := (now() at time zone 'UTC')::date; v_refusal jsonb; v_accepted integer := 0; v_ignored integer := 0; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 32768 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'expected_epoch', 'source', 'window_start', 'periods')) then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$'
    or v_source is null or v_source not in ('apple', 'health_connect')
    or jsonb_typeof(v_body->'window_start') is distinct from 'string' or (v_body->>'window_start') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(v_body->'periods') is distinct from 'array' or jsonb_array_length(v_body->'periods') > 12 then return '{"error":"invalid_request"}'; end if;
  -- The period's own shape is the contract's, checked by the Worker; here its keys are closed and its dates are checked.
  if exists (select 1 from jsonb_array_elements(v_body->'periods') p where jsonb_typeof(p) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(p) k where k not in ('signal', 'start_date', 'end_date', 'origin', 'source_name'))
      or p->>'signal' is distinct from 'menstrual_period'
      or jsonb_typeof(p->'start_date') is distinct from 'string' or (p->>'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (jsonb_typeof(p->'end_date') is distinct from 'null' and (jsonb_typeof(p->'end_date') is distinct from 'string' or (p->>'end_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
      or jsonb_typeof(p->'origin') is distinct from 'object'
      or (jsonb_typeof(p->'source_name') is distinct from 'null' and (jsonb_typeof(p->'source_name') is distinct from 'string' or length(p->>'source_name') not between 1 and 100)))
    or (select count(distinct p->>'start_date') from jsonb_array_elements(v_body->'periods') p) <> jsonb_array_length(v_body->'periods') then return '{"error":"invalid_request"}'; end if;
  begin v_window := (v_body->>'window_start')::date; exception when others then return '{"error":"invalid_request"}'; end;
  select * into v_prior from waldo.cycle_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'ingest' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  v_refusal := waldo.cycle_refusal(v_owner);
  if v_refusal is not null then return v_refusal; end if;
  if not waldo.cycle_storage_live(v_owner, array[v_source]) then return '{"error":"consent_required"}'; end if;
  select epoch into v_epoch from waldo.cycle_scopes where owner_id = v_owner;
  if (v_body->>'expected_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;

  -- Every period is checked before anything is replaced, so a refused upload changes nothing.
  for v_period in select p from jsonb_array_elements(v_body->'periods') p loop
    begin
      v_start := (v_period->>'start_date')::date;
      v_end := (v_period->>'end_date')::date;
    exception when others then return '{"error":"invalid_request"}'; end;
    if v_start < v_window or (v_end is not null and v_end not between v_start and v_start + 14) then return '{"error":"invalid_request"}'; end if;
  end loop;
  delete from waldo.cycle_periods where owner_id = v_owner and source = v_source and start_date >= v_window;
  for v_period in select p from jsonb_array_elements(v_body->'periods') p loop
    v_start := (v_period->>'start_date')::date;
    v_end := (v_period->>'end_date')::date;
    if coalesce(v_end, v_start) < v_today - 90 or v_start > v_today + 1 then v_ignored := v_ignored + 1; continue; end if;
    insert into waldo.cycle_periods (owner_id, source, start_date, end_date, epoch, origin, source_name)
      values (v_owner, v_source, v_start, v_end, v_epoch, v_period->'origin', v_period->>'source_name');
    v_accepted := v_accepted + 1;
  end loop;
  v_result := jsonb_build_object('request_id', v_id, 'replayed', false, 'accepted', v_accepted, 'ignored', v_ignored);
  insert into waldo.cycle_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'ingest', md5(p_payload), v_result);
  return v_result;
end $$;

-- The Cycle row: off unless cycle_context is live, then whether any period is stored and the latest one's start and app.
create function waldo.cycle_status_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.cycle_owner('status_read', p_do_name, p_payload, p_at, p_sig); v_latest waldo.cycle_periods;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  if waldo.cycle_refusal(v_owner) is not null then return '{"state":"off"}'; end if;
  select * into v_latest from waldo.cycle_periods where owner_id = v_owner order by start_date desc, source limit 1;
  if not found then return '{"state":"waiting_for_data"}'; end if;
  return jsonb_strip_nulls(jsonb_build_object('state', 'active', 'last_period_start', to_char(v_latest.start_date, 'YYYY-MM-DD'), 'last_source_name', v_latest.source_name));
end $$;

-- Withdrawing health storage for a source cycle data comes from withdraws cycle_context too, whichever path withdrew it.
create function waldo.cycle_follow_health_storage() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.purpose = 'storage_compute' and new.source in ('apple', 'health_connect') and old.withdrawn_at is null and new.withdrawn_at is not null then
    perform waldo.cycle_withdraw_all(new.owner_id);
  end if;
  return null;
end $$;
create trigger cycle_follow_health_storage after update on waldo.health_consents for each row execute function waldo.cycle_follow_health_storage();

revoke all on function waldo.cycle_consent_view(uuid), waldo.cycle_refusal(uuid), waldo.cycle_storage_live(uuid, text[]), waldo.cycle_withdraw_all(uuid),
  waldo.cycle_owner(text, text, text, bigint, text), waldo.cycle_consent_change(boolean, text, text, bigint, text), waldo.cycle_follow_health_storage()
  from public, anon, authenticated, service_role;
revoke all on function waldo.cycle_consent_list(text, text, bigint, text), waldo.cycle_consent_grant(text, text, bigint, text),
  waldo.cycle_consent_withdraw(text, text, bigint, text), waldo.cycle_ingest(text, text, bigint, text), waldo.cycle_status_read(text, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.cycle_consent_list(text, text, bigint, text), waldo.cycle_consent_grant(text, text, bigint, text),
  waldo.cycle_consent_withdraw(text, text, bigint, text), waldo.cycle_ingest(text, text, bigint, text), waldo.cycle_status_read(text, text, bigint, text)
  to anon;

-- Retention (20261103120000): the per-owner call and the sweep also age out periods that ended more than 90 days ago and receipts
-- older than 90 days, and the sweep finds an owner whose only expired rows are those. The result keeps its keys.
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
  delete from waldo.cycle_periods where owner_id = p_owner and coalesce(end_date, start_date) < (now() at time zone 'UTC')::date - 90;
  delete from waldo.cycle_requests where owner_id = p_owner and created_at < now() - interval '90 days';
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
      or exists (select 1 from waldo.cycle_periods c where c.owner_id = o.id and coalesce(c.end_date, c.start_date) < (now() at time zone 'UTC')::date - 90)
      or exists (select 1 from waldo.cycle_requests y where y.owner_id = o.id and y.created_at < now() - interval '90 days')
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
