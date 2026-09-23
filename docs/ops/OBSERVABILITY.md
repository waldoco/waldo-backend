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

`packages/runtime/src/observability/otlp-turns.ts` exports each owner turn as one OTLP trace, following Langfuse's [attribute mapping](https://langfuse.com/integrations/native/opentelemetry#property-mapping). It turns on when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` are Worker secrets. A failed export logs an `otlp_export` hop and never affects the reply. Message text never leaves the Worker: no span carries input or output.

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
| metadata.schema_version | `1` | filterable |
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

Trace input and output are left empty on purpose: the no-message-text rule wins over Langfuse's default of showing the user message. Evals that need text must run on our side or use an opt-in, masked export decided later.

Adding a feature: name its hops `snake_case`, add them to `HOPS` with the most specific type, add a row here. Model calls are hops named `llm_<purpose>`.

### Model calls, tokens and cost

Each model call is a Langfuse generation with `model.name`, `usage_details` (`input` uncached, `input_cached_tokens`, `output`) and `cost_details` (`input`, `output`, `total` in USD). Cost is computed in the Worker from `packages/runtime/src/llm/pricing.ts`, the one place prices live, so it does not depend on Langfuse's model price table. A model missing from that table still reports tokens, and Langfuse can price it from its own table. Langfuse sums generation costs into the trace and session totals, which include late memory calls.

Deploy with both vars so traces carry them:
`npx wrangler deploy --name waldo-runtime-staging --var WALDO_OWNER_TELEGRAM_ID:<id> --var WALDO_ENVIRONMENT:staging --var WALDO_RELEASE:$(git rev-parse --short HEAD)`
