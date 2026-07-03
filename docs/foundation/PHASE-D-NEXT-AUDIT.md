# Phase D Runtime Contract Audit

Date: 2026-07-03
Branch: `codex/runtime-run-session-working-memory`
Baseline: PR #7, PR #8, and PR #9 merged into `main`

## Verdict

This branch is a contract-only runtime seam. It adds the full run/session/working-memory
contracts needed before scheduler, goal, full delivery, telemetry, or public DTO expansion.
It does not claim the full harness loop, scheduler multiplexer, or delivery flusher exists.

## Source Set Checked

- ADR-0054: run journal and transactional outbox.
- ADR-0033: session trust reset on every DO wake and every resumed run.
- ADR-0057: working-memory carryover buckets and caps.
- ADR-0065: scheduled-trigger occurrence identity and per-logical-wake session reset.
- ADR-0068: DeliveryGate at the `GATED` run step.
- ADR-0074: Loop Governor composes with the run journal; it does not replace it.
- ADR-0029: backend-owned workspace contracts are the source of truth.
- DeepWiki pages: `runtime-model.html`, `runtime-loop.html`, `memory-scribe.html`,
  `scheduler.html`, `delivery-governor.html`, `store-ownership.html`,
  `conformance-build.html`.
- Current branch code under `packages/contracts/src/runtime`.

## What This Branch Adds

- `runtime/run`: full ADR-0054 state enum, transition table, terminal-state guard, strict run
  record schema, and stable idempotency input serialization for message-nonce and scheduled
  occurrence identities.
- `runtime/session`: fresh ADR-0033 trust envelope rebuilt from `TOOL_PERMISSIONS[trigger]`,
  reset-only context/iteration/cost/approval/sandbox fields, canary validation, rate-limit
  window, and deny-first tool check helper.
- `runtime/working-memory`: ADR-0057 carryover buckets with caps 10/10/6/8, strict entries,
  duplicate rejection, LRU append helper, and `CompactAttachment` wrapper.
- `packages/contracts/src/index.ts`: exports the three runtime contract modules.

## Not Claimed

- no Durable Object run journal implementation beyond the Phase C tracer
- no scheduler multiplexer or fleet liveness runtime
- no full outbox flusher, APNs/Telegram send path, or public feed delivery
- no Supabase RLS/JWKS/mint runtime execution
- no public OpenAPI/generated client freshness yet
- no live provider, production data, or dogfood lane

## Adversarial Review

Attack questions checked:

- Can replay double-deliver by crossing a 15-minute bucket? The run idempotency input is now
  nonce/occurrence based, not time-bucket based. The actual SHA-256 hash and per-kind outbox
  flusher remain runtime work.
- Can a resumed run reuse stale auth? The session contract has no durable approval, context,
  sandbox, cost, or iteration carryover, and the permission slate must exactly match
  `TOOL_PERMISSIONS[trigger]`.
- Can a trigger smuggle `execute_code` into a brief session? No. `sessionStateSchema` rejects
  a permission slate that differs from the trigger ACL.
- Can working memory become raw-health storage? The entry and snapshot schemas are strict and
  reject drift fields; default fixtures remain synthetic. Free-text health leakage is still
  owned by sanitiser/runtime egress checks, not this structural schema.
- Can thread continuity become authorization? No session id, thread id, prior approval token,
  or replay auth field is accepted by `sessionStateSchema`.
- Can reduced tracer states be mistaken for full run states? No. `runtimeRunStateSchema`
  rejects `RUN_OPENED` and `GOVERNOR_ADMITTED`; the reduced tracer remains isolated in
  `runtime/journal`.

Residual risk:

- Runtime Workers tests are still needed when `startRun`/`tickRun`/`resumeRun` write real DO
  state.
- The outbox flusher must prove exactly-once delivery under crash/resume, committed `GATED`
  skips, and idempotent retry.
- Scheduler/goal contracts are the next dependency seam; do not start full delivery before
  they exist.

## Next Step

After this branch lands:

1. Implement scheduler and runtime goal contracts.
2. Add Workers runtime tests only when those contracts touch Durable Object state.
3. Then expand full delivery, telemetry, public DTO/OpenAPI, generated-client freshness,
   scenario/property/mutation lanes, and live/dogfood evidence.
