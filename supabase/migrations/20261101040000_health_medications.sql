-- The owner's medicines (ADR-0081 amendment of 1 November 2026, accepted by the owner the same day). The owner tells Waldo what
-- they take and when; Waldo reminds them, records the doses they say they took or skipped, and counts down the supply they gave.
--
-- - waldo.health_medications: one row per medicine. The name is the owner's own label, kept word for word ("Metformin 500 mg"
--   included, by owner ruling). Daily times are HH:MM in the owner's zone. The supply is the count on hand, counted down by
--   doses taken after it was given.
-- - waldo.health_medication_doses: taken or skipped for one of a medicine's own times. Missed is what nothing said means and is
--   never stored. Kept 90 days through the retention sweep; stopping a medicine deletes its doses.
-- - Both are the owner's statement, not a source's reading: like waldo.health_logs, a source's withdrawal and the health purge
--   leave them, and account deletion removes them through the owners cascade.
-- - No table, call or payload has a dose, amount, strength or instruction field: the writes refuse any key outside their closed
--   shape. Waldo never suggests, changes or computes a dose.
-- - waldo.health_medications_read and waldo.health_medications_write are signed router calls on the health-plane pattern.

create table waldo.health_medications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  times text[] not null check (cardinality(times) between 1 and 6),
  supply integer check (supply between 0 and 2000),
  supply_set_at timestamptz,
  refill_at integer check (refill_at between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((supply is null) = (supply_set_at is null))
);
create index health_medications_owner on waldo.health_medications (owner_id, created_at);

create table waldo.health_medication_doses (
  medication_id uuid not null references waldo.health_medications (id) on delete cascade,
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  due_at timestamptz not null,
  slot text not null check (slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status text not null check (status in ('taken', 'skipped')),
  logged_at timestamptz not null default now(),
  primary key (medication_id, due_at)
);
create index health_medication_doses_owner_due on waldo.health_medication_doses (owner_id, due_at);

alter table waldo.health_medications enable row level security;
alter table waldo.health_medications force row level security;
alter table waldo.health_medication_doses enable row level security;
alter table waldo.health_medication_doses force row level security;
revoke all on waldo.health_medications, waldo.health_medication_doses from public, anon, authenticated, service_role;

-- One medicine as the calls answer it, with the doses said in the last eight days, oldest first.
create function waldo.health_medication_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'times', to_jsonb(m.times), 'supply', m.supply,
    'supply_set_at', to_char(m.supply_set_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'refill_at', m.refill_at,
    'created_at', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'doses', coalesce((select jsonb_agg(jsonb_build_object('due_at', to_char(d.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'slot', d.slot, 'status', d.status) order by d.due_at) from waldo.health_medication_doses d
      where d.medication_id = m.id and d.due_at >= now() - interval '8 days'), '[]'::jsonb))
  from waldo.health_medications m where m.id = p_id
$$;

create function waldo.health_medications_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.medications_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  return jsonb_build_object('medications', coalesce((select jsonb_agg(waldo.health_medication_json(m.id) order by m.created_at, m.id)
    from waldo.health_medications m where m.owner_id = v_owner), '[]'::jsonb));
end $$;

-- One write, by op:
--   track {medication_id?, name, times, supply?, refill_at?}: start tracking, or replace one's name and times by id. A count
--         given sets the supply as of now; a count or reorder point not given keeps the one stored.
--   dose  {medication_id, slot, due_at, status}: taken or skipped for one of its own times, at most eight days back or twelve
--         hours ahead. A dose due after the count was given moves it: taken counts it down, a change away from taken gives it back.
--   stop  {medication_id}: delete it and its doses.
create function waldo.health_medications_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_body jsonb; v_op text; v_id uuid; v_row waldo.health_medications; v_times text[]; v_name text;
  v_due timestamptz; v_old text; v_new text; v_n integer;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.medications_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or jsonb_typeof(v_body->'op') is distinct from 'string' then return '{"error":"invalid_request"}'; end if;
  v_op := v_body->>'op';
  if v_body ? 'medication_id' then
    if jsonb_typeof(v_body->'medication_id') is distinct from 'string'
      or (v_body->>'medication_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return '{"error":"invalid_request"}'; end if;
    v_id := (v_body->>'medication_id')::uuid;
    select * into v_row from waldo.health_medications where id = v_id and owner_id = v_owner for update;
  end if;

  if v_op = 'track' then
    if exists (select 1 from jsonb_object_keys(v_body) k where k not in ('op', 'medication_id', 'name', 'times', 'supply', 'refill_at'))
      or jsonb_typeof(v_body->'name') is distinct from 'string' or jsonb_typeof(v_body->'times') is distinct from 'array'
      or jsonb_array_length(v_body->'times') not between 1 and 6
      or exists (select 1 from jsonb_array_elements(v_body->'times') t
        where jsonb_typeof(t) <> 'string' or (t #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      or (v_body ? 'supply' and (jsonb_typeof(v_body->'supply') is distinct from 'number' or (v_body->>'supply') !~ '^[0-9]{1,4}$'
        or (v_body->>'supply')::integer > 2000))
      or (v_body ? 'refill_at' and (jsonb_typeof(v_body->'refill_at') is distinct from 'number' or (v_body->>'refill_at') !~ '^[0-9]{1,3}$'
        or (v_body->>'refill_at')::integer not between 1 and 500)) then
      return '{"error":"invalid_request"}';
    end if;
    v_name := v_body->>'name';
    if char_length(v_name) not between 1 and 80 or btrim(v_name) = '' or v_name ~ '[[:cntrl:]]' then return '{"error":"invalid_request"}'; end if;
    select array_agg(distinct t order by t) into v_times from jsonb_array_elements_text(v_body->'times') t;
    if cardinality(v_times) <> jsonb_array_length(v_body->'times') then return '{"error":"invalid_request"}'; end if;
    if v_body ? 'medication_id' then
      if v_row.id is null then return '{"error":"not_found"}'; end if;
      update waldo.health_medications set name = v_name, times = v_times,
        supply = case when v_body ? 'supply' then (v_body->>'supply')::integer else supply end,
        supply_set_at = case when v_body ? 'supply' then now() else supply_set_at end,
        refill_at = case when v_body ? 'refill_at' then (v_body->>'refill_at')::integer else refill_at end,
        updated_at = now()
      where id = v_row.id;
      return waldo.health_medication_json(v_row.id);
    end if;
    perform 1 from waldo.owners where id = v_owner for update;
    if (select count(*) from waldo.health_medications where owner_id = v_owner) >= 20 then return '{"error":"limit_reached"}'; end if;
    insert into waldo.health_medications (owner_id, name, times, supply, supply_set_at, refill_at)
      values (v_owner, v_name, v_times, (v_body->>'supply')::integer, case when v_body ? 'supply' then now() end, (v_body->>'refill_at')::integer)
      returning id into v_id;
    return waldo.health_medication_json(v_id);

  elsif v_op = 'dose' then
    if exists (select 1 from jsonb_object_keys(v_body) k where k not in ('op', 'medication_id', 'slot', 'due_at', 'status'))
      or not (v_body ? 'medication_id') or jsonb_typeof(v_body->'slot') is distinct from 'string'
      or jsonb_typeof(v_body->'due_at') is distinct from 'string' or (v_body->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$'
      or (v_body->>'status') is null or (v_body->>'status') not in ('taken', 'skipped') then
      return '{"error":"invalid_request"}';
    end if;
    if v_row.id is null then return '{"error":"not_found"}'; end if;
    begin v_due := (v_body->>'due_at')::timestamptz; exception when others then return '{"error":"invalid_request"}'; end;
    if not ((v_body->>'slot') = any (v_row.times)) or v_due < now() - interval '8 days' or v_due > now() + interval '12 hours' then
      return '{"error":"invalid_request"}';
    end if;
    v_new := v_body->>'status';
    select status into v_old from waldo.health_medication_doses where medication_id = v_row.id and due_at = v_due;
    insert into waldo.health_medication_doses (medication_id, owner_id, due_at, slot, status) values (v_row.id, v_owner, v_due, v_body->>'slot', v_new)
      on conflict (medication_id, due_at) do update set status = excluded.status, slot = excluded.slot, logged_at = now();
    if v_row.supply is not null and v_due >= v_row.supply_set_at and v_old is distinct from v_new then
      if v_new = 'taken' then
        update waldo.health_medications set supply = greatest(supply - 1, 0) where id = v_row.id;
      elsif v_old = 'taken' then
        update waldo.health_medications set supply = least(supply + 1, 2000) where id = v_row.id;
      end if;
    end if;
    return waldo.health_medication_json(v_row.id);

  elsif v_op = 'stop' then
    if exists (select 1 from jsonb_object_keys(v_body) k where k not in ('op', 'medication_id')) or not (v_body ? 'medication_id') then
      return '{"error":"invalid_request"}';
    end if;
    delete from waldo.health_medications where id = v_id and owner_id = v_owner;
    get diagnostics v_n = row_count;
    return jsonb_build_object('stopped', v_n > 0);
  end if;
  return '{"error":"invalid_request"}';
end $$;

revoke all on function waldo.health_medication_json(uuid) from public, anon, authenticated, service_role;
revoke all on function waldo.health_medications_read(text,text,bigint,text), waldo.health_medications_write(text,text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.health_medications_read(text,text,bigint,text), waldo.health_medications_write(text,text,bigint,text) to anon;

-- Retention (20261023120000): the per-owner call and the sweep also age out doses older than 90 days, and the sweep finds an
-- owner whose only expired rows are doses. The result keeps its keys.
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
