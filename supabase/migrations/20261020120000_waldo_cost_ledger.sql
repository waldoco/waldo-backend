-- Durable cost ledger: one row per owner, UTC day, cost kind and model, so spend per owner per day can be read
-- back for as long as the rows are kept (the DO's own trace table rolls over after 500 hops). The owner's DO is the
-- only writer: it rolls its turn-log hops up and sends the deltas over the signed router rail, behind its own flag,
-- after the turn (write-behind; a turn never waits on this). model = '' holds spend that is not a model call.
-- broker_calls and browser_ms are reserved: no producer sets them yet.
create table waldo.cost_ledger_daily (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('turn', 'background', 'worker', 'heartbeat', 'eval')),
  model text not null check (char_length(model) <= 128),
  calls bigint not null default 0 check (calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_tokens bigint not null default 0 check (cached_tokens >= 0),
  web_searches bigint not null default 0 check (web_searches >= 0),
  browser_ms bigint not null default 0 check (browser_ms >= 0),
  sandbox_ms bigint not null default 0 check (sandbox_ms >= 0),
  broker_calls bigint not null default 0 check (broker_calls >= 0),
  usd_estimate numeric(16, 8) not null default 0 check (usd_estimate >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, day, kind, model)
);
create index cost_ledger_daily_day on waldo.cost_ledger_daily (day);
alter table waldo.cost_ledger_daily enable row level security;
alter table waldo.cost_ledger_daily force row level security;

-- Batches already applied, so a batch the DO resends after a lost reply is not counted twice.
create table waldo.cost_ledger_batches (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  batch_id text not null check (batch_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  applied_at timestamptz not null default now(),
  primary key (owner_id, batch_id)
);
alter table waldo.cost_ledger_batches enable row level security;
alter table waldo.cost_ledger_batches force row level security;

-- Add one batch of per-day deltas. p_rows is text, not jsonb, for the same reason as health_log_add: its md5 rides
-- the signed message, and only the exact bytes the DO sent reproduce it. Returns the number of buckets touched,
-- 0 for a batch already applied, or null for an unknown DO.
create function waldo.cost_ledger_add(p_do_name text, p_batch text, p_rows text, p_at bigint, p_sig text) returns integer
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
      web_searches, browser_ms, sandbox_ms, broker_calls, usd_estimate)
    select v_owner, r.day, r.kind, coalesce(r.model, ''), sum(coalesce(r.calls, 0)), sum(coalesce(r.input, 0)),
      sum(coalesce(r.output, 0)), sum(coalesce(r.cached, 0)), sum(coalesce(r.web_searches, 0)), sum(coalesce(r.browser_ms, 0)),
      sum(coalesce(r.sandbox_ms, 0)), sum(coalesce(r.broker_calls, 0)), sum(coalesce(r.usd, 0))
    from jsonb_to_recordset(v_rows) as r(day date, kind text, model text, calls bigint, input bigint, output bigint, cached bigint,
      web_searches bigint, browser_ms bigint, sandbox_ms bigint, broker_calls bigint, usd numeric)
    where r.day between current_date - 400 and current_date + 1
    group by r.day, r.kind, coalesce(r.model, '')
  on conflict (owner_id, day, kind, model) do update set
    calls = ledger.calls + excluded.calls,
    input_tokens = ledger.input_tokens + excluded.input_tokens,
    output_tokens = ledger.output_tokens + excluded.output_tokens,
    cached_tokens = ledger.cached_tokens + excluded.cached_tokens,
    web_searches = ledger.web_searches + excluded.web_searches,
    browser_ms = ledger.browser_ms + excluded.browser_ms,
    sandbox_ms = ledger.sandbox_ms + excluded.sandbox_ms,
    broker_calls = ledger.broker_calls + excluded.broker_calls,
    usd_estimate = ledger.usd_estimate + excluded.usd_estimate,
    updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function waldo.cost_ledger_add(text, text, text, bigint, text) from public;
grant execute on function waldo.cost_ledger_add(text, text, text, bigint, text) to anon;
