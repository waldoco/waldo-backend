-- Prompt-cache writes in the cost ledger. cached_tokens holds reads and input_tokens the whole prompt, so writes had no
-- column of their own and only showed up inside usd_estimate. cache_write_tokens is the part of input_tokens the provider
-- billed at its write rate. The default keeps every existing row valid, and a batch from a DO that does not send the field
-- adds 0. The function keeps its signature, so its grants stand.
alter table waldo.cost_ledger_daily
  add column cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0);

create or replace function waldo.cost_ledger_add(p_do_name text, p_batch text, p_rows text, p_at bigint, p_sig text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_rows jsonb; v_count integer;
begin
  if not waldo.router_signed('cost.add.' || p_do_name || '.' || p_batch || '.' || md5(p_rows), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return null; end if;
  v_rows := p_rows::jsonb;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) > 500 then
    raise exception 'cost ledger batch must be an array of at most 500 rows' using errcode = '22023';
  end if;
  insert into waldo.cost_ledger_batches (owner_id, batch_id) values (v_owner, p_batch) on conflict do nothing;
  if not found then return 0; end if;
  delete from waldo.cost_ledger_batches where owner_id = v_owner and applied_at < now() - interval '30 days';
  insert into waldo.cost_ledger_daily as ledger (owner_id, day, kind, model, calls, input_tokens, output_tokens, cached_tokens,
      cache_write_tokens, web_searches, browser_ms, sandbox_ms, broker_calls, usd_estimate)
    select v_owner, r.day, r.kind, coalesce(r.model, ''), sum(coalesce(r.calls, 0)), sum(coalesce(r.input, 0)),
      sum(coalesce(r.output, 0)), sum(coalesce(r.cached, 0)), sum(coalesce(r.cache_write, 0)), sum(coalesce(r.web_searches, 0)),
      sum(coalesce(r.browser_ms, 0)), sum(coalesce(r.sandbox_ms, 0)), sum(coalesce(r.broker_calls, 0)), sum(coalesce(r.usd, 0))
    from jsonb_to_recordset(v_rows) as r(day date, kind text, model text, calls bigint, input bigint, output bigint, cached bigint,
      cache_write bigint, web_searches bigint, browser_ms bigint, sandbox_ms bigint, broker_calls bigint, usd numeric)
    where r.day between current_date - 400 and current_date + 1
    group by r.day, r.kind, coalesce(r.model, '')
  on conflict (owner_id, day, kind, model) do update set
    calls = ledger.calls + excluded.calls,
    input_tokens = ledger.input_tokens + excluded.input_tokens,
    output_tokens = ledger.output_tokens + excluded.output_tokens,
    cached_tokens = ledger.cached_tokens + excluded.cached_tokens,
    cache_write_tokens = ledger.cache_write_tokens + excluded.cache_write_tokens,
    web_searches = ledger.web_searches + excluded.web_searches,
    browser_ms = ledger.browser_ms + excluded.browser_ms,
    sandbox_ms = ledger.sandbox_ms + excluded.sandbox_ms,
    broker_calls = ledger.broker_calls + excluded.broker_calls,
    usd_estimate = ledger.usd_estimate + excluded.usd_estimate,
    updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;
