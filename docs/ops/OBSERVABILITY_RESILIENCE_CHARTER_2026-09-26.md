# Observability + resilience charter - 2026-09-26

Owner mandate (WhatsApp, 2026-09-26 18:54 IST): not just the 429 incident - comprehensive logging,
observability, tracing and resilience for EVERY failure class in agent applications, so anything
that breaks is debuggable from traces without guessing. Code-only lane; the owner's sequencing
call gates each build.

Labels: [observed-waldo] = verified in code at fc1c7098 or live traces on 2026-09-26;
[competitor] = mature-platform practice with primary source; [recommendation] = proposed fix.

## Hard constraints (owner rules, apply to every slice)

1. **User-facing error copy never names the model or provider** (owner, 18:59 IST). Users see
   generic copy ("facing some issues, retrying shortly"). Provider/model/status detail is
   developer-only telemetry (Langfuse, worker logs). This applies to every current and future
   error surface.
2. **The privacy gate is never weakened.** `LANGFUSE_CAPTURE_TEXT=true` is scoped to staging
   during this debugging phase only (owner's own data, single owner); default off everywhere
   else; revisit before any beta user. Gated sinks and the canary test stay exercised.
3. Observability failures must never affect the reply path (already true for OTLP export:
   a failed export logs an `otlp_export` hop and the reply proceeds).

## Failure-class coverage matrix

### 1. LLM provider failures (429 / 5xx / auth / network / timeout / oversize)
- Today [observed-waldo]: user_message route is OpenAI primary, `fallback: []`, template floor
  disabled (telegram-turn.ts:64). Attempt plan tries the same provider twice (full, then reduced
  context), each exactly once, back-to-back, no wait (provider.ts attemptPlan). No Retry-After
  parsing, no backoff, no same-step retry anywhere in `llm/`. 429 maps to per-attempt code
  `rate_limited` (gateway.ts:223, openai.ts:158) but nothing acts on it. Per-attempt telemetry
  (status, code, latency) is dropped before every sink; the turn collapses to `transient`
  regardless of cause. Live incident 2026-09-26: both model calls failed in ~1.1s; the bot
  walled at ~90% failure; the failure class was unconfirmable from traces.
- Mature practice [competitor]: LangGraph declarative RetryPolicy with initial interval,
  backoff factor, max attempts, jitter and an exception filter
  (docs.langchain.com/oss/python/langgraph/fault-tolerance,
  reference.langchain.com/python/langgraph/types/RetryPolicy). OpenHands retries with tenacity
  exponential backoff and retries ONLY transient exception classes
  (github.com/OpenHands/OpenHands llm/retry_mixin.py; PR #6557 stopped retrying unrecoverable
  errors). Hermes honors Retry-After / X-RateLimit-Reset headers and uses bounded backoff loops
  (local clone d0288be5). OpenClaw pairs circuit breaking with loop detection
  (docs.openclaw.ai/tools/loop-detection).
- Fixes [recommendation]:
  R1. Export per-attempt telemetry (provider, model, HTTP status/code, latency_ms) as span
      metadata and a worker log line. Top priority: unblocks all future RCA.
  R2. Retry-after-aware bounded retry: parse Retry-After on 429 in both adapters; exponential
      backoff with jitter (1s/2s/4s, cap ~8s); max 2-3 same-step retries; transient classes
      only (429/5xx/network) - never auth/invalid/oversize (OpenHands lesson).
  R3. At least one cross-provider fallback step in the user_message route so a single-provider
      rate limit cannot wall the bot.
  R4. Degraded floor on rate-limit exhaustion: generic user copy per constraint 1, plus an
      optional DO-alarm queued retry so the turn survives the rate-limit window.

### 2. Tool execution failures
- Today [observed-waldo]: tool hops log ok:false with a closed typed-code union; tool_* spans
  export as observation type `tool`; external-origin results carry source_taint on every arm
  including refusals. Error text survives to sinks only under capture-on; the typed code always
  survives. Per-tool failure classification is a queued MED. A tool missing from the central
  registry map dies with "tool args schema unavailable".
- Mature practice [competitor]: Langfuse trace-shape guidance - a tool call nests under the
  orchestrating span as a sibling of the generation that requested it; names stay
  low-cardinality, model never in names (langfuse.com/docs/observability/best-practices).
- Fixes [recommendation]:
  R8. Bounded `error_class` on every failed tool span (class + first 120 chars through the
      egress-guard redactor) so tool failures are classifiable with capture off (S7a).
  R9. Per-tool failure classification + tool-failure budget in the loop (queued MED lands here).
  R10. Registry-miss guard: a tool absent from the schema map fails the deploy-time check, not
       the runtime call.

### 3. Channel ingress failures (webhook, spool, dedupe)
- Today [observed-waldo]: durable spool ingress exists (#168 lane); SPOOL_MAX_ATTEMPTS=5 then the
  body is silently DELETED (verified #168 hold) - no DLQ, no owner notice. Stale 'processing'
  claim suppresses redelivery forever after a crash (verified #167 hold); received_at is already
  stored, no sweep exists. Ingress dedupe and idempotency ship on #218 (merged).
- Mature practice [competitor]: Temporal-style durable execution - every ingress item is
  retried with backoff and lands in a dead-letter sink, never silently dropped
  (temporal.io/blog/idempotency-and-durable-execution).
- Fixes [recommendation]:
  R11. Stale-claim sweep: reclaim spool rows whose received_at is older than a bound (small,
       received_at already stored).
  R12. Dead-letter instead of delete after max attempts: metadata-only DLQ + owner notice.
  R13. Ingress alarm: consecutive webhook 5xx to Telegram surfaces as an owner-visible alert.

### 4. Channel egress failures (sends, reactions, typing)
- Today [observed-waldo]: send failures carry typed codes (`send_failed`); reaction/typing
  failures are swallowed with `.catch(() => undefined)` and a gated hop. Egress guard scrubs
  model-adjacent sends; receipt-truth work (#182) verified real, one more readback pass queued.
- Fixes [recommendation]:
  R14. Send retry with backoff on Telegram 429/5xx honoring retry_after (Telegram returns it),
       then typed failure + owner notice on final failure.
  R15. Reaction/typing failures stay silent by design; count them in a per-turn egress_failures
       metadata counter so silent-degradation is visible in aggregate.

### 5. Agent loop / control-plane failures
- Today [observed-waldo]: loop warn-no-progress (#221) and mutation-reset (#222) merged-pending;
  loop close requires tool_calls undefined (test-stub lesson recorded); loop-detection benchmark
  exists vs OpenClaw. Steering and stop classification fixed on #224.
- Fixes [recommendation]:
  R16. Every loop termination exports a reason enum (answered/max_rounds/no_progress/guard_halt/
       provider_exhausted) as root-span metadata - "why did the loop end" should never need a
       guess.

### 6. DO / alarm / scheduling failures
- Today [observed-waldo]: heartbeat starvation fixed on #223 (cooldown filter before LIMIT);
  unattended-cron hard-stop is a queued MED; DO trace book exists (trace_log); alarm retries are
  platform-owned. No surface shows "an alarm fired and failed" today beyond hop rows.
- Fixes [recommendation]:
  R17. Alarm/cron failure hops export with the schedule id and typed code; a failing cron emits
       an owner-visible notice after N consecutive failures (unattended-cron hard-stop pairs).

### 7. Memory / brain failures
- Today [observed-waldo]: memory admission gate slice queued (owner yes 16:33 IST); nightly
  memory hops exist; #196 weak-hash receipt defect verified (FNV-1a 32-bit unsalted; fix = keyed
  64-bit + legacy backfill decision).
- Fixes [recommendation]:
  R18. Memory write/read failures export typed codes and degrade to no-memory turns, never to
       dead turns. Brain tool failures land in the tool-class budget (R9).

### 8. Deploy / config failures
- Today [observed-waldo]: some deploys ship environment=development/release=unknown (10 events
  tagged development on 2026-09-26); WALDO_ENVIRONMENT/WALDO_RELEASE unset at deploy (S7b, still
  unfixed). Migrations are CI-gated (pgTAP green on #219@296feb9). No boot-time secret/config
  validation - a missing secret surfaces as a runtime failure class instead of a deploy failure.
- Mature practice [competitor]: Langfuse guidance - set the environment attribute so test
  traffic never pollutes production dashboards (langfuse.com/docs/observability/best-practices).
- Fixes [recommendation]:
  R19. Deploy step always passes WALDO_ENVIRONMENT + WALDO_RELEASE=<sha>; CI fails the deploy
       job without them.
  R20. Boot-time config validation: required secrets/vars checked at worker init, missing ones
       produce one loud typed log line + a fail-closed health signal, not scattered runtime
       errors.

### 9. Auth / integration failures (Google connect, token expiry)
- Today [observed-waldo]: connect-offer / oauth_exchange / google_token_migrated hops are on the
  content-free whitelist (they export fixed enums/counts by design); token-expiry refresh paths
  exist. Typed codes cover auth_failed (401/403) per provider call.
- Fixes [recommendation]:
  R21. Auth-failure turns tell the user to reconnect with generic copy and log the typed code;
       recurring auth failures across turns emit one owner notice per day, not per turn.

### 10. Observability-pipeline failures
- Today [observed-waldo]: failed OTLP export logs an `otlp_export` hop and never affects the
  reply (good). Turns crashing before the 'turn' hop never export (pending buffer, cap 50).
- Fixes [recommendation]:
  R6. Flush pending spans with a terminal 'crashed' root when a turn dies before hop 'turn'
      (waitUntil-bounded best effort).
  R22. Langfuse outage detector: N consecutive otlp_export failures emit one owner notice, then
       back off - observability about observability, rate-limited.

## Build order proposal (owner's sequencing call decides)
1. R1 + R8 + R19/R20 (see everything, pin every trace to a commit) - smallest, highest RCA value.
2. R2 + R3 + R4 (the rate-limit wall itself; R4 copy per constraint 1).
3. R11 + R12 (ingress durability, closes verified #167/#168 holds).
4. R6 + R16 + R17 + R22 (control-plane and pipeline self-coverage).
5. R9/R10 + R14/R15 + R18 + R21 (class-by-class hardening).

## Sources
- LangGraph fault tolerance + RetryPolicy: https://docs.langchain.com/oss/python/langgraph/fault-tolerance , https://reference.langchain.com/python/langgraph/types/RetryPolicy
- OpenHands retry mixin: https://github.com/OpenHands/OpenHands/blob/26fa1185/openhands/llm/retry_mixin.py and PR https://github.com/All-Hands-AI/OpenHands/pull/6557
- Langfuse trace best practices: https://langfuse.com/docs/observability/best-practices
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Temporal idempotency/durable execution: https://temporal.io/blog/idempotency-and-durable-execution
- OpenClaw loop detection: https://docs.openclaw.ai/tools/loop-detection
- Hermes (local clone d0288be5): Retry-After honoring and bounded backoff loops.
