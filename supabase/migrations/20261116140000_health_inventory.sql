-- The health inventory: which kinds of body data exist for the owner, how fresh and on how many days, with no value. It lets the
-- model's standing health block say what the owner's phone and wearables have sent, even on a day no score could be computed,
-- and lets the model choose what to read with get_health.
-- - waldo.health_inventory_read(do_name, payload, at, sig) is new. Payload {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, at most 31
--   days, as waldo.health_series_read. It answers, per source whose storage and model-use grants are both live (the inventory
--   goes to the model), each stored kind with readings in the window: the end of its newest reading and the number of days
--   holding one. Never a value, a method, a payload key or a sample id. Router-signed like the other health reads; granted to
--   anon as they are.
-- No table, column or existing function changes. Rollback: supabase/rollback/20261116140000_health_inventory.down.sql.
create function waldo.health_inventory_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_body jsonb; v_from date; v_to date;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.inventory_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('from','to'))
    or jsonb_typeof(v_body->'from') is distinct from 'string' or (v_body->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(v_body->'to') is distinct from 'string' or (v_body->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_from := (v_body->>'from')::date; v_to := (v_body->>'to')::date;
  if v_to < v_from or v_to - v_from > 30 then return '{"error":"invalid_request"}'; end if;
  return (
    with live as (
      select s.source from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
      where s.owner_id = v_owner and s.purpose = 'storage_compute' and c.withdrawn_at is null
        and exists (select 1 from waldo.health_scopes m join waldo.health_consents mc on mc.id = m.consent_id
          where m.owner_id = v_owner and m.source = s.source and m.purpose = 'model_processing' and mc.withdrawn_at is null)
    ), kinds as (
      select l.source, h.signal, max(h.end_at) as newest_at, count(distinct h.day) as days
      from live l join waldo.health_samples h on h.owner_id = v_owner and h.source = l.source
      where h.payload is not null and h.day between v_from and v_to
      group by l.source, h.signal
    )
    select jsonb_build_object('sources', coalesce((select jsonb_agg(jsonb_build_object('source', l.source,
        'kinds', coalesce((select jsonb_agg(jsonb_build_object('signal', k.signal,
            'newest_at', to_char(k.newest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'days', k.days) order by k.signal)
          from kinds k where k.source = l.source), '[]'::jsonb)) order by l.source) from live l), '[]'::jsonb))
  );
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
revoke all on function waldo.health_inventory_read(text,text,bigint,text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_inventory_read(text,text,bigint,text) to anon;
