-- Score history for the app's detail chart: the derived rows waldo.health_scores_read returns one day at a time, for a
-- window of 1 to 31 local days. The days are read in one statement, so every day in the answer comes from the same
-- consent snapshot. Same owner, signature and basis rule as the day read; nothing is written and no new table is made.
create function waldo.health_scores_history(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_from date; v_to date; v_days jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.scores_history.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 1024 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('from','to'))
    or jsonb_typeof(v_body->'from') is distinct from 'string' or (v_body->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(v_body->'to') is distinct from 'string' or (v_body->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_from := (v_body->>'from')::date; v_to := (v_body->>'to')::date;
  if v_to < v_from or v_to - v_from > 30 then return '{"error":"invalid_request"}'; end if;
  select jsonb_agg(jsonb_build_object('day', c.day, 'timezone', b.timezone,
      'compiled_at', to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'freshness', c.freshness, 'form', c.form, 'recovery', c.recovery, 'weight', c.weight) order by c.day)
    into v_days
    from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and c.day between v_from and v_to and waldo.health_basis_live(v_owner, b.consent_basis, false);
  if v_days is not null then return jsonb_build_object('history', v_days); end if;
  -- No row in the window: say why, as the day read does.
  return jsonb_build_object('unavailable', case
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_required'
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute' and c.withdrawn_at is null) then 'consent_withdrawn'
    else 'no_readings' end);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

revoke all on function waldo.health_scores_history(text,text,bigint,text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_scores_history(text,text,bigint,text) to anon;
