-- Spend across every owner for the admin console: per owner per UTC day over the last 30 days, model USD, calls, input and
-- cached tokens only. Like admin_overview, only a signed router call names the asking DO, and only an active admin's DO
-- gets an answer; anyone else gets null. The ledger keeps forced RLS: this security definer function is its only reader.
-- At most 5000 rows, newest day first, with truncated saying whether more were left out.
create function waldo.admin_cost_summary(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_count bigint;
begin
  if not waldo.router_signed('admincost.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return null; end if;
  with days as (
    select l.owner_id, l.day, sum(l.usd_estimate) as usd, sum(l.calls) as calls, sum(l.input_tokens) as input_tokens, sum(l.cached_tokens) as cached_tokens
    from waldo.cost_ledger_daily l
    where l.day >= current_date - 29
    group by l.owner_id, l.day
  ), kept as (
    select d.*, count(*) over () as total from days d order by d.day desc, d.owner_id limit 5000
  )
  select coalesce(jsonb_agg(jsonb_build_object('owner_id', k.owner_id, 'day', k.day, 'usd', k.usd, 'calls', k.calls,
      'input_tokens', k.input_tokens, 'cached_tokens', k.cached_tokens) order by k.day desc, k.owner_id), '[]'::jsonb), coalesce(max(k.total), 0)
    into v_rows, v_count from kept k;
  return jsonb_build_object('rows', v_rows, 'truncated', v_count > 5000);
end $$;

revoke all on function waldo.admin_cost_summary(text, bigint, text) from public;
grant execute on function waldo.admin_cost_summary(text, bigint, text) to anon;
