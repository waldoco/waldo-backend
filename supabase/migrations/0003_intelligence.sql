-- HEY-9 · Supabase schema · 0003 intelligence & audit
-- Source: WALDO_V1_MASTER_PLAN.md §5 #6,7,12,16.
-- Written by service-role Edge Functions (e.g. build-intelligence); clients read own rows.
-- The DO/agent loop never holds the service-role key (ADR-0052) — it reads via RLS JWT.
-- patrol_entries, feedback_signals, agent_logs are append-only (ADR-0037), enforced at the
-- application layer via AuditedDB (HEY-11, out of scope). Client grants are read-only; the
-- service_role grants below additionally drop UPDATE on the write-once logs.

-- §5 #6 — spots (individual observations, 90d display expiry). patrol_entry_id /
-- constellation_id are soft references (no FK in §5) to avoid coupling retention lifecycles.
create table spots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  generated_at timestamptz default now(),
  category text not null,                 -- body | schedule | comms | tasks | mood | pattern
  confidence real not null,               -- ordering only, never displayed
  observation text not null,
  reasoning text,
  tier3_data jsonb,                       -- internal signals only
  expires_at date,                        -- 90d for display
  dismissed_at timestamptz,
  patrol_entry_id uuid,
  constellation_id uuid,
  linked_categories text[]
);

alter table spots enable row level security;
alter table spots force row level security;
revoke all on spots from anon, authenticated;
grant select on spots to authenticated;
grant select, insert, update, delete on spots to service_role;
create policy spots_select_own on spots
  for select to authenticated
  using (user_id = (select app_user_id()));

create index idx_spots_user_date_confidence on spots (user_id, date desc, confidence desc);

-- §5 #7 — patrol_entries (immutable audit trail, retain all time). data_reference holds NO
-- raw health values (overview logging redline).
create table patrol_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  occurred_at timestamptz default now(),
  entry_type text not null,               -- brief | fetch | adjustment | spot | window | handoff | close | intervention
  title text not null,
  reasoning text not null,
  data_reference jsonb,                   -- NO raw health values
  outcome text,
  triggered_by_metric text,               -- 'form' | 'recovery' | 'weight' | null
  importance_score real default 0.5,      -- 0-1, Overview top-5 ranking
  is_reversible boolean default false,
  reversed_at timestamptz,
  causal_chain_id uuid,
  chain_position integer,
  user_thumbs text,                       -- up | down | null → feeds CARA
  trace_id uuid
);

alter table patrol_entries enable row level security;
alter table patrol_entries force row level security;
revoke all on patrol_entries from anon, authenticated;
grant select on patrol_entries to authenticated;
-- UPDATE retained: user_thumbs / importance_score / reversed_at / outcome are set post-insert.
grant select, insert, update, delete on patrol_entries to service_role;
create policy patrol_entries_select_own on patrol_entries
  for select to authenticated
  using (user_id = (select app_user_id()));

create index idx_patrol_entries_user_time on patrol_entries (user_id, occurred_at desc);
create index idx_patrol_entries_chain on patrol_entries (causal_chain_id) where causal_chain_id is not null;

-- §5 #16 — feedback_signals (unified WIS / CARA / GEPA signal stream). Written by
-- track-feedback EF; read server-side. Client SELECT-own kept for data-export parity.
create table feedback_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  trace_id uuid,                          -- links to agent_logs for context
  signal_type text not null,              -- thumbs_up | thumbs_down | dismissed | opened_within_2h | replied | corrected | proposal_accepted | proposal_declined
  target_type text not null,              -- brief | fetch | adjustment | spot | proposal | window | handoff | close | intervention | patrol_entry | chat_message
  target_id uuid,
  occurred_at timestamptz default now()
);

alter table feedback_signals enable row level security;
alter table feedback_signals force row level security;
revoke all on feedback_signals from anon, authenticated;
grant select on feedback_signals to authenticated;
-- write-once event stream → no UPDATE (DELETE kept for R2 archival/retention, ADR-0061).
revoke all on feedback_signals from service_role;
grant select, insert, delete on feedback_signals to service_role;
create policy feedback_signals_select_own on feedback_signals
  for select to authenticated
  using (user_id = (select app_user_id()));

create index idx_feedback_user_time on feedback_signals (user_id, occurred_at desc);
create index idx_feedback_trace on feedback_signals (trace_id) where trace_id is not null;

-- §5 #12 — agent_logs (append-only; 90d in Supabase → R2 aggregate). §5 principle 6:
-- service role only, NO client access. Never stores raw health values or message content.
-- RLS enabled with no policy → only service_role (BYPASSRLS) can read/write.
create table agent_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  trace_id uuid not null,
  trigger_type text not null,
  tools_called text[],
  iterations integer,
  total_tokens integer,
  cache_hit_rate real,
  latency_ms integer,
  llm_model text,
  llm_fallback_level integer,
  estimated_cost_usd real,
  delivery_status text,
  error_class text,
  wis_engagement real,
  wis_action_acceptance real,
  contributing_sources text[],
  created_at timestamptz default now()
);

alter table agent_logs enable row level security;
alter table agent_logs force row level security;
revoke all on agent_logs from anon, authenticated;
-- strict append-only audit trail (ADR-0037): write new events, do not mutate rows.
revoke all on agent_logs from service_role;
grant select, insert on agent_logs to service_role;

create index idx_agent_logs_user_date on agent_logs (user_id, created_at desc);
