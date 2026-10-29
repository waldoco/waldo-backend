# Observability

Two tiers.

## 1. Dev loop logs (built)

Every owner turn writes one JSON line per hop, all with the same trace id (`tg-<update_id>`), a duration in ms, `ok`, and the error message when a hop fails. Hops: `pickup`, `receipt`, `typing`, `choose_reaction`, `joined_path`, `respond`, `send`, `resolved` or `failed`, `turn`, then `memory` when the background memory update finishes. Source: `packages/runtime/src/channels/telegram-listener.ts`.

Where to read them:

- Local runner: stdout of `scripts/telegram-listener-run.ts`, which also logs each update's field names and every poll error.
- Staging Worker: `npx wrangler tail waldo-runtime-staging --format json` from `packages/runtime`.

Secrets never appear in these logs. Bot tokens are redacted in error text.

## 2. Observability service (built, off until keys are set)

[Langfuse](https://langfuse.com/) for traces, model calls, costs and evaluations across turns. The owner chose Langfuse Cloud over [self-hosting](https://langfuse.com/self-hosting). It needs its own project keys, stored as Worker secrets and in the local env file, never in the repo. The per-hop trace ids above map onto Langfuse traces and spans.

Instrumentation follows [OpenTelemetry](https://opentelemetry.io/) for traces and metrics, so the pipeline stays vendor-neutral. Langfuse Cloud is the LLM-facing backend and accepts OTLP traces on its [`/api/public/otel` endpoint](https://langfuse.com/integrations/native/opentelemetry). Other OTel backends can be added without touching the runtime.

`packages/runtime/src/observability/otlp-turns.ts` exports each owner turn as one OTLP trace, following Langfuse's [attribute mapping](https://langfuse.com/integrations/native/opentelemetry#property-mapping). It turns on when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` are Worker secrets. A failed export logs an `otlp_export` hop and never affects the reply. Message text is off by default and exported only when `LANGFUSE_CAPTURE_TEXT=true` (see Text capture below). Worker logs never carry text.

### Trace schema (version 1)

Dashboards and evals depend on these names. Change them only by bumping `TRACE_SCHEMA_VERSION` and noting it here.

Trace level, set on the root span:

| Field | Value | Source |
| --- | --- | --- |
| name | `<channel>.turn`, e.g. `telegram.turn` | `langfuse.trace.name` |
| userId | `telegram:<owner telegram id>` | `langfuse.user.id` |
| sessionId | `telegram-dm:<owner telegram id>` | `langfuse.session.id` |
| environment | `WALDO_ENVIRONMENT` var (`staging`, `production`; `development` if unset) | `langfuse.environment` on every span |
| release, version | `WALDO_RELEASE` var, the deployed commit SHA | `langfuse.release`, `langfuse.version` |
| tags | `channel:<channel>` plus `feature:<area>` for every area with a hop in the turn | `langfuse.trace.tags` |
| metadata.schema_version | `TURN_EVENT_SCHEMA_VERSION` (currently `14`) | filterable |
| metadata.channel | `telegram` | filterable |
| metadata.trace_key | runtime trace id (`tg-<update id>`), joins Langfuse to Worker logs | filterable |
| metadata.outcome | `answered` or `failed` | filterable |
| metadata.model_calls, tokens_input, tokens_output, cost_usd | totals for model calls finished before the reply | filterable |

Late hops (the background `memory` edit) join the same trace and add their own `feature:` tag.

Observation level, on every child span: name is the hop, `metadata.hop`, `metadata.feature`, `metadata.trace_key`, optional `metadata.detail` (for `memory`, the files changed), and status (error message on failure, level ERROR).

Feature areas and observation types live in `HOPS`. The root span is type `agent`. Current map:

| Feature | Hop (type) |
| --- | --- |
| channel | `pickup` (span), `typing`, `progress`, `send` (tool) |
| reactions | `receipt`, `resolved` (tool), `choose_reaction` (chain), `llm_reaction` (generation) |
| reply | `respond`, `joined_path` (chain), `llm_reply` (generation) |
| memory | `memory` (chain), `llm_memory` (generation) |
| other | any hop not yet mapped (span) |

### Text capture

`LANGFUSE_CAPTURE_TEXT=true` (a Worker var) exports text for the owner's own project:
- the root span: input is the user message, output is the reply;
- each `llm_*` generation: input is the system prompt and user content as a message array, output is the model text, or `{ reasoning, text }` when the model returned a reasoning summary (OpenAI `reasoning.summary: auto`).

The owner turned this on for staging on 2026-09-23 to read model inputs, thinking and outputs. Unset or any other value exports no text, which is the default for every other environment and user. Flip it off with `--var LANGFUSE_CAPTURE_TEXT:false` on deploy.

Adding a feature: name its hops `snake_case`, add them to `HOPS` with the most specific type, add a row here. Model calls are hops named `llm_<purpose>`.

### Retention (built, off)

The privacy notice promises that traces are deleted after 30 days, and the Langfuse Hobby plan has no retention setting. `packages/runtime/src/observability/langfuse-retention.ts` enforces it from the daily cron (`17 3 * * *`, staging only; production has no cron trigger until the owner turns this on).

- **Selection.**
  - A trace is aged by its root observation's start: `GET /api/public/v2/observations` with `isRootObservation=true` and `toStartTime` set to now minus 29 days.
  - Before deleting, one guard read per batch (`filter`: `traceId` any of the batch, `startTime >= cutoff`) keeps any trace with activity after the cutoff.
  - Only traces in the project the keys belong to (`GET /api/public/projects`) are touched.
  - Langfuse retired the trace list: `GET /api/public/traces` is served only until 16 Nov 2026 ([migration](https://langfuse.com/faq/all/deprecated-api-migration)). That is why the sweep uses the observation list.
- **Rating scores.** `reply_rating` scores older than the cutoff are deleted on their own (`GET /api/public/v3/scores`, then `DELETE /api/public/scores/{id}`), because a score can outlive a trace that never reached Langfuse.
- **Deletion.** `DELETE /api/public/traces` with 40 ids at a time. Langfuse deletes the observations and scores too, usually within 15 minutes ([Data Deletion](https://langfuse.com/docs/administration/data-deletion)).
- **Limits** ([API limits](https://langfuse.com/faq/all/api-limits), Hobby plan):
  - The general bucket allows 30 requests a minute. Every request is paced 2.1 s apart.
  - Deletion allows 50 requests a day per organization, and the same bucket covers trace and score deletes. A run's trace and score deletes together use at most 40, about 1,600 traces, which leaves 10 a day for people and for rating changes (each change of a Like or Dislike deletes the score it replaces). Scores take at most 5, and only what the traces left.
  - Metrics API v2 allows 100 requests a day. A run makes three.
  - A 429 waits for its `Retry-After` and is retried three times. If it still holds, the run ends `incomplete` and the next day resumes.
- **Modes.** `LANGFUSE_RETENTION_SWEEP` is absent by default.
  - `dry` makes every read and deletes nothing.
  - `1` deletes.
  - Any other value is off.
- **Backlog.** Before deleting, the sweep counts root traces through `GET /api/public/v2/metrics`:
  - `backlog`: older than the cutoff;
  - `overdue`: already past the 30 days promised;
  - `daily_new`: arrived in the last day.

  From those it works out `days_to_clear`. The value is `never` when one day's arrivals alone fill a run's 1,600-trace budget. A run with `overdue` above zero logs at error level, because the promise is already broken. The repo has no alerting (see the production runbook, S10), so the Worker log is where this shows.
- **Log.** One line with counts and status codes only, never a trace id:

  `langfuse retention sweep <mode> <state> backlog= overdue= daily_new= days_to_clear= candidates= deleted= would_delete= skipped_recent= skipped_project= scores_deleted= would_delete_scores= requests= last_status=`

  States are `complete`, `incomplete` (budget or rate limit; resumes next run), `partial` (a failure after some deletes) and `failed`.

### Context size per model call

Each `llm_*` generation carries numeric metadata (bytes, UTF-8) describing what filled that call, never text: `context_system_bytes`, `context_request_bytes`, `context_tools_count`, `context_tools_bytes` (the tool definitions sent), `context_tool_turns_bytes`, `context_history_messages`, `context_history_bytes`, `context_current_bytes`, `context_attachments`, and on the owner reply one `context_system_<section>_bytes` per system-prompt section (`reasons`, `behavior`, `health`, `clock`, `memory`, `orders`, `loops`, `skill_catalog`, `task_context`, `skill_procedures`). The sections plus their joins equal `context_system_bytes`. What rides the owner's message as the turn context is sized per section as `context_turn_<section>_bytes`. Calls whose system prompt carries the voice block (`llm_reply`, `llm_background_decision`) also carry `voice_version`. Trace schema version 6.

### Model calls, tokens and cost

Each model call is a Langfuse generation with `model.name`, `usage_details` (`input` uncached, `input_cached_tokens`, `output`) and `cost_details` (`input`, `output`, `total` in USD). Cost is computed in the Worker from `packages/runtime/src/llm/pricing.ts`, the one place prices live, so it does not depend on Langfuse's model price table. A model missing from that table still reports tokens, and Langfuse can price it from its own table. Langfuse sums generation costs into the trace and session totals, which include late memory calls.

Deploy with both vars so traces carry them:
`npx wrangler deploy --name waldo-runtime-staging --var WALDO_OWNER_TELEGRAM_ID:<id> --var WALDO_ENVIRONMENT:staging --var WALDO_RELEASE:$(git rev-parse --short HEAD) --var LANGFUSE_CAPTURE_TEXT:true`

### Durable cost ledger

`waldo.cost_ledger_daily` (Supabase, migration `20261020120000_waldo_cost_ledger.sql`) holds one row per owner, UTC day, cost kind (`turn`, `background`, `worker`, `heartbeat`, `eval`) and model: calls, input, output and cached tokens, hosted web searches, `sandbox_ms`, `usd_estimate`, and the reserved `browser_ms` and `broker_calls` (no producer yet). Rows that are not a model call file under model `''`. The USD figure comes from `llm/pricing.ts`; an unpriced model counts tokens at `0` USD.

The owner's Durable Object is the only writer. `packages/runtime/src/observability/cost-rollup.ts` folds each turn-log hop with usage into per-day deltas held in the DO's KV, and after the hop sends them over the signed router rail (`waldo.cost_ledger_add`). It is write-behind: the turn never waits on Supabase, a failed send keeps the deltas and retries the same batch id on the next hop (the database ignores a batch id it has already applied), and a batch refused 20 times is dropped with a `cost_ledger` hop (`code: sync_failed`). Deleting the owner deletes their ledger rows.

It is off unless the Worker var `WALDO_COST_LEDGER_SYNC=on`. Staging sets it `on` (the migration is applied there); production sets it `off`. Rollback is the var back to `off`.

The same KV keeps the owner's spend for the current UTC month (`cost_month_usd`), counted from every delta recorded while the ledger is on, whether or not it has reached Supabase yet. A turn that starts at or past `MONTHLY_SPEND_CEILING_USD` (USD 25 per owner per month in every environment, staging included, a code value in `packages/runtime/src/llm/cost-ledger.ts`) degrades rather than stops. The provider clamps each of its calls to the auxiliary route (Luna, then Haiku), which is where Briefs, check-ins, closes and other machine turns already run, so they keep going. `browse_page`, `browse_act` and `execute_code` are refused by the dispatcher before anything runs, with the tool refusal `spend_ceiling_reached`. Its fix tells the model what still works (the read tools, on the cheaper model) and the UTC day the ceiling resets, so it degrades the task rather than stopping. Each hold logs a `spend_hold` hop (`code: spend_ceiling_reached:<tool>`), and the ledger stores it as one call on model `held:<tool>` with `usd_estimate` 0. To count holds per owner per month, sum `calls` where `model like 'held:%'`; the month's spend is the sum of `usd_estimate` over the other rows. With the ledger off there is no month total and so no ceiling. The total counts model USD only (browser and sandbox time are priced at 0), and it starts at 0 in each DO storage, so the first month undercounts.

Known gap: the ledger undercounts billed tokens, so treat the baseline as a floor. It misses:

- an OpenAI call that ends `oversize` (incomplete output) returns no `spent`, so tokens the provider billed for are not logged;
- failed routes and the template floor log no usage;
- `failFromHook` in `llm/provider.ts` drops a call that was already billed;
- `llm/pricing.ts` does not model cache writes, which bill above the uncached input rate.

No test yet pins that a failed attempt's `spent` is added exactly once. Follow-up: make every billed attempt reach the turn log and add that test.

An active admin sees the same window per owner, with a deployment total, under "Spend (last 30 days)" on the console admin page. It is read through `waldo.admin_cost_summary` (migration `20261024010000`), a signed call that answers only an admin's DO and returns owner, day, USD, calls, input and cached tokens. On a deployment with the ledger off the table says nothing was recorded.

Spend per owner per day for the last 30 days (service role):

```sql
select o.do_name, l.day, sum(l.usd_estimate) as usd, sum(l.input_tokens) as input, sum(l.cached_tokens) as cached
from waldo.cost_ledger_daily l join waldo.owners o on o.id = l.owner_id
where l.day >= current_date - 30 group by 1, 2 order by 2 desc, 3 desc;
```

`scripts/cost-report.mjs` turns the ledger (exported with the query in its header) and Langfuse's model calls into a per-owner, per-day table of calls, traces, input, cached tokens, cache share, output and USD, with a `--baseline` window for before and after. It is the baseline every cost change is judged against.
