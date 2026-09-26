-- A9 (BUILD_PLAN_2026-09-25): meal + workout logging. Health-adjacent custody: log and nudge,
-- never diagnose. Calorie values are model-inferred estimates, stored as estimates inside the
-- payload, never presented as measured. Writes and reads ride the signed router RPCs from the
-- owner's DO (same rail as connect sessions); the model never touches this table directly.
create table waldo.health_logs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references waldo.owners (id),
  kind text not null check (kind in ('meal', 'workout')),
  logged_at timestamptz not null,
  source text not null check (source in ('telegram', 'whatsapp', 'console')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);
create index health_logs_owner_recent on waldo.health_logs (owner_id, logged_at desc);
alter table waldo.health_logs enable row level security;
alter table waldo.health_logs force row level security;

-- Append one log entry for an owner. The payload's md5 rides the signed message so a replayed
-- signature can never attach to a different body. Returns the new id, or null for an unknown DO.
create function waldo.health_log_add(p_do_name text, p_kind text, p_logged_at timestamptz, p_source text, p_payload jsonb, p_at bigint, p_sig text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id bigint;
begin
  if not waldo.router_signed('health.add.' || p_do_name || '.' || p_kind || '.' || p_source || '.' || md5(p_payload::text), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return null; end if;
  insert into waldo.health_logs (owner_id, kind, logged_at, source, payload)
    values (v_owner, p_kind, p_logged_at, p_source, p_payload)
    returning id into v_id;
  return v_id;
end $$;

-- Recent entries for the proactive context beats (morning wag / evening close read these).
-- Bounded: the cap lives in SQL, never in the caller.
create function waldo.health_log_recent(p_do_name text, p_limit integer, p_at bigint, p_sig text) returns setof waldo.health_logs
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('health.recent.' || p_do_name || '.' || p_limit, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return; end if;
  return query select * from waldo.health_logs where owner_id = v_owner order by logged_at desc limit greatest(0, least(p_limit, 50));
end $$;

revoke all on function waldo.health_log_add(text, text, timestamptz, text, jsonb, bigint, text) from public;
revoke all on function waldo.health_log_recent(text, integer, bigint, text) from public;
grant execute on function waldo.health_log_add(text, text, timestamptz, text, jsonb, bigint, text) to anon;
grant execute on function waldo.health_log_recent(text, integer, bigint, text) to anon;
