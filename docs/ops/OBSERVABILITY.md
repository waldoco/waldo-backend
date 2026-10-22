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
| metadata.schema_version | `TURN_EVENT_SCHEMA_VERSION` (currently `10`) | filterable |
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

### Context size per model call

Each `llm_*` generation carries numeric metadata (bytes, UTF-8) describing what filled that call, never text: `context_system_bytes`, `context_request_bytes`, `context_tools_count`, `context_tools_bytes` (the tool definitions sent), `context_tool_turns_bytes`, `context_history_messages`, `context_history_bytes`, `context_current_bytes`, `context_attachments`, and on the owner reply one `context_system_<section>_bytes` per system-prompt section (`reasons`, `behavior`, `health`, `clock`, `memory`, `orders`, `loops`, `skill_catalog`, `task_context`, `skill_procedures`). The sections plus their joins equal `context_system_bytes`. Trace schema version 6.

### Model calls, tokens and cost

Each model call is a Langfuse generation with `model.name`, `usage_details` (`input` uncached, `input_cached_tokens`, `output`) and `cost_details` (`input`, `output`, `total` in USD). Cost is computed in the Worker from `packages/runtime/src/llm/pricing.ts`, the one place prices live, so it does not depend on Langfuse's model price table. A model missing from that table still reports tokens, and Langfuse can price it from its own table. Langfuse sums generation costs into the trace and session totals, which include late memory calls.

Deploy with both vars so traces carry them:
`npx wrangler deploy --name waldo-runtime-staging --var WALDO_OWNER_TELEGRAM_ID:<id> --var WALDO_ENVIRONMENT:staging --var WALDO_RELEASE:$(git rev-parse --short HEAD) --var LANGFUSE_CAPTURE_TEXT:true`

### Durable cost ledger

`waldo.cost_ledger_daily` (Supabase, migration `20261020120000_waldo_cost_ledger.sql`) holds one row per owner, UTC day, cost kind (`turn`, `background`, `worker`, `heartbeat`, `eval`) and model: calls, input, output and cached tokens, hosted web searches, `sandbox_ms`, `usd_estimate`, and the reserved `browser_ms` and `broker_calls` (no producer yet). Rows that are not a model call file under model `''`. The USD figure comes from `llm/pricing.ts`; an unpriced model counts tokens at `0` USD.

The owner's Durable Object is the only writer. `packages/runtime/src/observability/cost-rollup.ts` folds each turn-log hop with usage into per-day deltas held in the DO's KV, and after the hop sends them over the signed router rail (`waldo.cost_ledger_add`). It is write-behind: the turn never waits on Supabase, a failed send keeps the deltas and retries the same batch id on the next hop (the database ignores a batch id it has already applied), and a batch refused 20 times is dropped with a `cost_ledger` hop (`code: sync_failed`). Deleting the owner deletes their ledger rows.

It is off unless the Worker var `WALDO_COST_LEDGER_SYNC=on`. No hosted config sets it; turn it on per environment once the migration has been applied there.

The same KV keeps the owner's spend for the current UTC month (`cost_month_usd`), counted from every delta recorded while the ledger is on, whether or not it has reached Supabase yet. A turn that starts at or past `MONTHLY_SPEND_CEILING_USD` (USD 25 per owner per month, a code value in `packages/runtime/src/llm/cost-ledger.ts`) degrades rather than stops. The provider clamps each of its calls to the auxiliary route (Luna, then Haiku), which is where Briefs, check-ins, closes and other machine turns already run, so they keep going. `browse_page`, `browse_act` and `execute_code` are refused by the dispatcher before anything runs, with the tool refusal `spend_ceiling_reached`. Its fix tells the model what still works (the read tools, on the cheaper model) and the UTC day the ceiling resets, so it degrades the task rather than stopping. Each hold logs a `spend_hold` hop (`code: spend_ceiling_reached:<tool>`), and the ledger stores it as one call on model `held:<tool>` with `usd_estimate` 0. To count holds per owner per month, sum `calls` where `model like 'held:%'`; the month's spend is the sum of `usd_estimate` over the other rows. With the ledger off there is no month total and so no ceiling. The total counts model USD only (browser and sandbox time are priced at 0), and it starts at 0 in each DO storage, so the first month undercounts.

Spend per owner per day for the last 30 days (service role):

```sql
select o.do_name, l.day, sum(l.usd_estimate) as usd, sum(l.input_tokens) as input, sum(l.cached_tokens) as cached
from waldo.cost_ledger_daily l join waldo.owners o on o.id = l.owner_id
where l.day >= current_date - 30 group by 1, 2 order by 2 desc, 3 desc;
```
