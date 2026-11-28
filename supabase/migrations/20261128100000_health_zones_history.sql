-- Zone history for the first build: the welcome read may ask for the owner's backfilled days too, as zone words only.
-- - waldo.health_zones_read is re-created whole from its only definition (20261106120000). Its payload gains one optional key,
--   history, a JSON boolean. Absent or false, the read is exactly as before: no backfilled day.
-- - With history true, a backfilled day is returned like a live one: its date and its Recovery zone word. A backfilled row holds
--   no Form (ADR-0081, HI-8), so its Form is null. No score, reading, driver or mark leaves the health plane.
-- - Only the runtime's first-build health stage sends history. Experiments and the body-pattern review send {from, to} and see
--   no change. A backfilled row still never raises a zone change or wakes the trigger; this read writes nothing.
-- - Every other rule stands: router-signed, a live model-use consent basis for each day, at most 57 days, a closed key list.
-- Signature, security definer, search_path and grants are unchanged. Apply before the Worker that sends history: until then
-- that Worker's first-build health read is refused as invalid_request and the stage settles unavailable, with no other effect.
create or replace function waldo.health_zones_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_from date; v_to date; v_history boolean; v_days jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.zones_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('from', 'to', 'history'))
    or jsonb_typeof(v_body->'from') is distinct from 'string' or jsonb_typeof(v_body->'to') is distinct from 'string'
    or (v_body ? 'history' and jsonb_typeof(v_body->'history') is distinct from 'boolean')
    or (v_body->>'from') !~ '^\d{4}-\d{2}-\d{2}$' or (v_body->>'to') !~ '^\d{4}-\d{2}-\d{2}$' then return '{"error":"invalid_request"}'; end if;
  v_from := (v_body->>'from')::date;
  v_to := (v_body->>'to')::date;
  v_history := coalesce((v_body->>'history')::boolean, false);
  if v_to < v_from or v_to - v_from > 56 then return '{"error":"invalid_request"}'; end if;
  select jsonb_agg(jsonb_build_object(
      'day', c.day,
      'recovery', case when c.recovery->>'zone' in ('low', 'moderate', 'good', 'high') then c.recovery->>'zone' end,
      'form', case when c.backfilled is not true and c.form->>'zone' in ('low', 'moderate', 'good', 'high') then c.form->>'zone' end) order by c.day)
    into v_days
    from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and c.day between v_from and v_to and (v_history or c.backfilled is not true)
      and waldo.health_basis_live(v_owner, b.consent_basis, true);
  return jsonb_build_object('zones', jsonb_build_object('from', v_from, 'to', v_to, 'days', coalesce(v_days, '[]'::jsonb)));
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
