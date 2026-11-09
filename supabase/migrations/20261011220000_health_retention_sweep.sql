-- Retention ran only when something called health_retention for one owner, so an owner who stopped using the app kept
-- their expired readings and scores for as long as they stayed away. The sweep is the scheduled caller: one signed call
-- takes a bounded number of owners who hold expired rows, whatever their state, and ages each out with the same rules as
-- the per-owner call. Owners another transaction holds are skipped and found on the next run. It returns counts only.
create function waldo.health_retention_apply(p_owner uuid, p_auth uuid) returns jsonb
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
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;

create or replace function waldo.health_retention(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.retention.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o where o.do_name = p_do_name for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  return waldo.health_retention_apply(v_owner, v_auth);
end $$;

create function waldo.health_retention_sweep(p_payload text, p_at bigint, p_sig text) returns jsonb
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

revoke all on function waldo.health_retention_apply(uuid, uuid), waldo.health_retention_sweep(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.health_retention_sweep(text, bigint, text) to anon;
