-- Retention aged out raw readings, tombstones and request receipts after 90 days but never expired the derived rows,
-- so an owner's daily scores and zones stayed stored for as long as the owner existed. Derived rows live for the same
-- 24 months health_context_write accepts a day for. The cut is taken from the UTC date with a day of slack, because the
-- write bound is taken from the owner's own clock and that can be a day behind UTC: a day the write would still accept
-- is never expired. The function is replaced with the same signature, so its grants carry over.
create or replace function waldo.health_retention(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_raw integer; v_requests integer; v_context integer; v_cut date;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.retention.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o where o.do_name = p_do_name for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  delete from waldo.health_samples where owner_id = v_owner
    and ((payload is not null and end_at < now() - interval '90 days') or (payload is null and deleted_at < now() - interval '90 days'));
  get diagnostics v_raw = row_count;
  delete from waldo.health_requests where owner_id = v_owner and created_at < now() - interval '90 days';
  get diagnostics v_requests = row_count;
  v_cut := (now() at time zone 'UTC')::date - 733;
  delete from public.health_context_daily where user_id = v_auth and day < v_cut;
  get diagnostics v_context = row_count;
  delete from waldo.health_context_basis where owner_id = v_owner and day < v_cut;
  return jsonb_build_object('raw_deleted', v_raw, 'requests_deleted', v_requests, 'context_deleted', v_context);
end $$;
