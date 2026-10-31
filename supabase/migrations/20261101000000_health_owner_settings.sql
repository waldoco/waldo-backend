-- The owner's health settings: the sleep need they stated (ADR-0081 §1, the 27 Oct amendment: "Need is the owner-confirmed figure if
-- there is one"). The figure lives here, in the health plane, and nowhere else: memory keeps no copy, and the score engine reads it
-- through the producer only while the coaching switch is on.
--
-- - waldo.health_owner_settings holds one row per owner. It is the owner's statement, not a reading: no source holds it, so one
--   source's withdrawal leaves it (as with waldo.health_logs), and account deletion removes it through the owners cascade.
-- - waldo.health_settings_read and waldo.health_settings_write are signed router calls on the health-plane pattern
--   (waldo.health_scores_read). The write replaces the need whole; null clears it. Both answer the stored need and when it last
--   changed, which the producer uses so a new need is never told to the health trigger as a change in the body.
-- - The bounds are the score engine's: six to ten hours, in whole minutes.

create table waldo.health_owner_settings (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  sleep_need_minutes integer check (sleep_need_minutes between 360 and 600),
  updated_at timestamptz not null default now()
);
alter table waldo.health_owner_settings enable row level security;
alter table waldo.health_owner_settings force row level security;
revoke all on waldo.health_owner_settings from public, anon, authenticated, service_role;

create function waldo.health_settings_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.health_owner_settings;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.settings_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if p_payload <> '{}' then return '{"error":"invalid_request"}'; end if;
  select * into v_row from waldo.health_owner_settings where owner_id = v_owner;
  return jsonb_build_object('sleep_need_minutes', v_row.sleep_need_minutes,
    'updated_at', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

create function waldo.health_settings_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_body jsonb; v_need jsonb; v_minutes integer; v_row waldo.health_owner_settings;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.settings_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 1024 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or not (v_body ? 'sleep_need_minutes')
    or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'sleep_need_minutes') then
    return '{"error":"invalid_request"}';
  end if;
  v_need := v_body -> 'sleep_need_minutes';
  if jsonb_typeof(v_need) = 'null' then
    v_minutes := null;
  elsif jsonb_typeof(v_need) = 'number' and (v_need #>> '{}')::numeric = trunc((v_need #>> '{}')::numeric)
    and (v_need #>> '{}')::numeric between 360 and 600 then
    v_minutes := (v_need #>> '{}')::integer;
  else
    return '{"error":"invalid_request"}';
  end if;
  insert into waldo.health_owner_settings (owner_id, sleep_need_minutes, updated_at) values (v_owner, v_minutes, now())
    on conflict (owner_id) do update set sleep_need_minutes = excluded.sleep_need_minutes, updated_at = excluded.updated_at
    returning * into v_row;
  return jsonb_build_object('sleep_need_minutes', v_row.sleep_need_minutes,
    'updated_at', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

revoke all on function waldo.health_settings_read(text,text,bigint,text), waldo.health_settings_write(text,text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function waldo.health_settings_read(text,text,bigint,text), waldo.health_settings_write(text,text,bigint,text) to anon;
