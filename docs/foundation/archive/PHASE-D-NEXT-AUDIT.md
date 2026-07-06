# Phase D Scheduler/Goal Contract Audit

Date: 2026-07-03
Branch: `codex/scheduler-goal-contracts`
Baseline: PR #7, PR #8, PR #9, and PR #10 merged into `main`

## Verdict

This branch is a scheduler/goal contract seam with one tracer compatibility patch. It adds
the seven schedule kinds, pre-brief sweep trigger/ACL/routing coverage, and persistent goal
record contract needed before full governor, delivery, telemetry, or public DTO expansion.
It does not claim the full harness loop, Durable Object scheduler runtime, or delivery
flusher exists.

## Source Set Checked

- ADR-0065: DO alarm multiplexer, seven schedule kinds, priority order, recurrence, retry,
  quarantine, and `pre_brief_sweep` trigger taxonomy.
- ADR-0064: persistent goals as per-user DO SQLite records, with onboarding/user-message write
  authority and no Curator/GEPA mutation in V1.
- ADR-0017: patrol amendment making pre-brief sweep its own LLM-bearing trigger, not a patrol
  sub-step.
- ADR-0054: scheduled occurrence identity and resumed-run trigger custody.
- ADR-0033: per-logical-wake session reset through trigger ACLs.
- ADR-0069: routing table coverage for the newly canonical `pre_brief_sweep` trigger.
- ADR-0029: backend-owned workspace contracts are the source of truth.
- DeepWiki pages: `scheduler.html`, `runtime-model.html`, `runtime-loop.html`,
  `store-ownership.html`, and `conformance-build.html`.
- Current branch code under `packages/contracts/src/runtime`.

## What This Branch Adds

- `runtime/schedule`: ADR-0065 seven-kind `ScheduleKind`, priority map, kind-to-trigger map,
  recurrence shape, strict schedule rows, reference-only payloads, quarantine eligibility, and
  `nextWakeBound` helper.
- `runtime/goal`: ADR-0064 `GoalRecord` with bounded text, ISO timestamps, default active
  state, strict raw-health rejection, and user-message-only trigger write authority.
- `core/trigger`, `tools/permissions`, and `runtime/routing`: canonical `pre_brief_sweep`
  trigger coverage, read/precompute-only ACL, and explicit primary/template routing row.
- Phase C tracer compatibility: the existing alarm tracer persists a canonical one-shot
  `handoff` schedule row and has a Workers test validating that row against `scheduleEntrySchema`.
- `packages/contracts/src/index.ts`: exports the goal contract module; schedule was already
  exported and now carries the full contract instead of the tracer placeholder.

## Not Claimed

- no Durable Object run journal implementation beyond the Phase C tracer
- no Durable Object scheduler multiplexer, alarm pop loop, recurrence advancement, fleet liveness,
  or watchdog runtime
- no full outbox flusher, APNs/Telegram send path, or public feed delivery
- no onboarding/user-message tool implementation that mutates goal records
- no Supabase RLS/JWKS/mint runtime execution
- no public OpenAPI/generated client freshness yet
- no live provider, production data, or dogfood lane

## Adversarial Review

Attack questions checked:

- Can scheduler payloads smuggle raw health or prompt content? `payload_refs` accepts only
  id/cursor-shaped string references and rejects content keys, raw health keys, and non-string
  values.
- Can scheduler invent a trigger for durability resumes? No. `journal` and `handoff` map to
  `null`; they must resume under the stored run trigger from ADR-0054.
- Can pre-brief sweep send user-visible messages or execute actions? No. Its ACL is
  read/precompute-only and excludes `send_message`, `execute_action`, and `execute_code`.
- Can a goal record become measured-health storage? No. The schema is strict, text fields are
  bounded, and raw measured fields such as `hrv_ms` are rejected.
- Can non-chat triggers mutate goals? No. Trigger-origin goal writes are allowed only from
  `user_message`; onboarding is named as a separate non-trigger write source.
- Can stale tracer schedule rows still parse? No. `kind: "tracer"` is rejected by
  `scheduleEntrySchema`.

Residual risk:

- Runtime Workers tests are still needed when the real scheduler `alarm()` loop writes DO state,
  advances recurrence, retries/quarantines rows, and re-arms the alarm slot.
- The outbox flusher must prove exactly-once delivery under crash/resume, committed `GATED`
  skips, and idempotent retry.
- Goal write tools must prove authenticated onboarding/user-message authority before they touch
  per-user DO goal state.

## Next Step

After this branch lands:

1. Expand full governor plus delivery/outbox contracts beyond the tracer.
2. Add Workers runtime tests when those contracts touch Durable Object state.
3. Then expand telemetry, public DTO/OpenAPI, generated-client freshness,
   scenario/property/mutation lanes, and live/dogfood evidence.
