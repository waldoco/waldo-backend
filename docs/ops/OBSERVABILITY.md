# Observability

Two tiers.

## 1. Dev loop logs (built)

Every owner turn writes one JSON line per hop, all with the same trace id (`tg-<update_id>`), a duration in ms, `ok`, and the error message when a hop fails. Hops: `pickup`, `receipt`, `typing`, `choose_reaction`, `joined_path`, `respond`, `send`, `resolved` or `failed`, `turn`. Source: `packages/runtime/src/channels/telegram-listener.ts`.

Where to read them:

- Local runner: stdout of `scripts/telegram-listener-run.ts`, which also logs each update's field names and every poll error.
- Staging Worker: `npx wrangler tail waldo-runtime-staging --format json` from `packages/runtime`.

Secrets never appear in these logs. Bot tokens are redacted in error text.

## 2. Observability service (planned)

[Langfuse](https://langfuse.com/) for traces, model calls, costs and evaluations across turns. The owner chose Langfuse Cloud over [self-hosting](https://langfuse.com/self-hosting). It needs its own project keys, stored as Worker secrets and in the local env file, never in the repo. The per-hop trace ids above map onto Langfuse traces and spans.

Instrumentation follows [OpenTelemetry](https://opentelemetry.io/) for traces and metrics, so the pipeline stays vendor-neutral. Langfuse Cloud is the LLM-facing backend and accepts OTLP traces on its [`/api/public/otel` endpoint](https://langfuse.com/integrations/native/opentelemetry). Other OTel backends can be added without touching the runtime.
