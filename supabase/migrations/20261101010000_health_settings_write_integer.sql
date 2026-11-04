-- The sleep-need write took a whole number written with a fraction or an exponent (480.0, 4.8e2) through its whole-number
-- check and then raised casting that text to an integer. JSON has one number type, so such a figure is the whole number it
-- names: it is cast through numeric and stored. A part minute is still refused. Grants are kept by create or replace.

create or replace function waldo.health_settings_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
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
    v_minutes := (v_need #>> '{}')::numeric::integer;
  else
    return '{"error":"invalid_request"}';
  end if;
  insert into waldo.health_owner_settings (owner_id, sleep_need_minutes, updated_at) values (v_owner, v_minutes, now())
    on conflict (owner_id) do update set sleep_need_minutes = excluded.sleep_need_minutes, updated_at = excluded.updated_at
    returning * into v_row;
  return jsonb_build_object('sleep_need_minutes', v_row.sleep_need_minutes,
    'updated_at', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;
