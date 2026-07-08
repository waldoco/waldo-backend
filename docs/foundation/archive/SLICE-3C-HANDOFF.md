# SLICE-3c -> Next Slice Handoff

Date: 2026-07-07.
Branch: `codex/hey-124-deliverygate-runtime`.
Linear: HEY-124.
Status: local implementation complete; PR not opened in this session.

## What This Slice Built

- Promoted ADR-0068 DeliveryGate policy state on top of the SLICE-3b journal/outbox seam.
- Added a contract-owned `pushClassSchema` module and widened runtime journal/outbox contracts from
  `fetch_alert`-literal to all ADR-0068 push classes.
- Added a closed gate-reason vocabulary. Non-send admissions and journal verdicts now carry a
  durable `gate_reason`; `send` verdicts must not.
- Persisted gate candidates in DO SQLite, then made the gate read parsed committed candidate,
  journal, and outbox state before side effects.
- Implemented class caps, APNs counted-budget accounting, exempt telemetry, event-scoped cooldowns,
  adjustment sub-kind caps, held-candidate freeze, and `releaseHeld`.
- Added `candidate_expired` as a contract-owned drop reason so stale standalone candidates fail
  closed before counters, held rows, or outbox intents mutate.
- Kept the GATED commit atomic for send/degrade: verdict + reason, policy-state mutation, outbox
  intent, transaction-local admission recalculation, and `GATED` advance commit in one transaction.
- Preserved the SLICE-3b sink invariant: no sink reach without parsed committed journal/outbox state
  and no ack mutation without the same idempotency key.
- Added DO-local schema migration coverage for legacy `class_state`, `subkind_state`, and
  `daily_push_budget` shapes using Cloudflare storage transactions, not raw SQLite `BEGIN`.
- Corrected stale foundation docs that still described PR #23 / SLICE-3b as pending or draft.

## What The Branch Proves

- `packages/runtime/test/delivery-gate.test.ts` proves a fetch-alert gate commits class state,
  exempt telemetry, and outbox intent atomically, then resumes after eviction without re-stamping or
  double-counting.
- The same test suite proves expired candidates drop with `candidate_expired` before durable policy
  state or the sink can move.
- Held candidates freeze without outbox insertion or counter mutation, and `releaseHeld` opens a
  fresh run that re-enters the GATED path.
- Expired held candidates are deleted by `releaseHeld` without opening a new run or touching the
  sink.
- Held rows now store the actual cooldown release time or next UTC day boundary, not a placeholder
  fallback duration.
- Counted APNs sends charge the daily budget; non-APNs `brief` sends do not.
- Exempt sends increment both class-specific telemetry and the daily `exempt_sends` budget column,
  making exempt accounting observable for future notification-log reconciliation.
- Event-scoped cooldowns allow separate events while class counts still accumulate.
- `intervention_knock` remains exempt and capped; exhausted candidates are held and frozen.
- `constellation_first` sends once and later drops with `once_ever_already_sent`, not `hold`.
- Proposed adjustments obey their sub-cap/cooldown while executed adjustments remain uncapped.
- Counted budget and class daily caps are keyed by the UTC local-date fallback.
- Legacy schema migrations preserve counters while adding `local_date`/`exempt_sends`.
- Contract tests reject stale `defer_next_day`, arbitrary journal triggers, missing non-send
  reasons, and invalid adjustment `sub_kind` envelopes.

## What Does Not Work Yet

- No scheduler/alarm multiplexer or real held-candidate wakeup policy; `releaseHeld` is the callable
  release path only.
- No user timezone state. Daily budget and class caps use the explicit UTC fallback.
- No quiet-hours runtime because user quiet-window state is not present in this slice.
- No `sync_error` `exempt_after_h` escalation runtime; the policy row remains contract-owned for a
  later scheduler/error-age slice.
- No full Loop Governor runtime, dispatcher/tool runtime, Scribe runtime, real LLM, live APNs or
  Telegram provider, live app feed, or Supabase `notification_log` mirror.
- The reduced tracer FSM still represents held/drop outcomes as terminal `FAILED` rows with durable
  DeliveryGate verdict/reason; a fuller runtime FSM can split those terminal states later.

## Architecture Decisions Made

- Candidate state is durable input, not a caller-owned enqueue parameter. `startRun` persists the
  parsed `DeliveryCandidate`; every later gate/outbox step reloads it from DO SQLite.
- `enqueueOutbox` recomputes the admission from committed candidate, journal, class, sub-kind, and
  budget rows inside the same transaction that stamps the verdict, mutates policy state, inserts
  outbox, and advances to `GATED`.
- The journal row is the durable explanation seam. `verdict` says what happened; `gate_reason`
  explains every non-send verdict using a closed vocabulary.
- Daily caps and cooldowns are distinct clocks: class/sub-kind counts reset by derived local date,
  while cooldown checks use the latest send timestamp across dates.
- `enqueueOutbox` now rejects non-`GOVERNOR_ADMITTED` runs before recomputing admission. State-gate
  errors must win over later policy recalculation.
- The old tracer `gate.ts`/`store.ts` helpers were removed after the promoted DeliveryGate runtime
  became the single writer for class state, budgets, held rows, and outbox intent.

## Hard-Won Lessons

- Runtime promotion needs both a policy decision and a durable explanation. A verdict without a
  reason is not enough once resumes, holds, and drops become first-class.
- "Daily cap" and "cooldown" look like one counter until midnight. They need separate storage
  semantics: date-scoped counts plus cross-date last-send timestamps.
- Test helpers can hide missing guarantees. The intervention test originally counted the wrong held
  candidate; counting by class made the freeze assertion load-bearing.
- Budget helper reads must use the run's local date. A cross-day sum can make a rollover test pass
  while proving the wrong budget invariant.
- Cloudflare DO storage migrations should use `storage.transactionSync`; raw `BEGIN`/`COMMIT`
  is not a safe abstraction inside the Workers storage API.

## Compound Learning Capture

Lesson: DeliveryGate policy state needs separate storage identities for durable candidate input,
date-scoped caps, cross-date cooldowns, and non-send explanations.
Mode: Lightweight.
Track: Knowledge/practice.
Overlap check: ADR-0068 owns the policy vocabulary; this handoff captures the runtime-storage
lesson from implementing it over DO SQLite.
Destination: `docs/foundation/SLICE-3C-HANDOFF.md`.
Source/provenance: HEY-124 implementation and manual break/review pass.
Applicability limit: Applies to DeliveryGate-style policy runtimes; do not generalize to stateless
contract validators.
Eval/pressure scenario: Workers/DO eviction after GATED, held-candidate release, expired held-row
cleanup, expired candidate drop, schema migration, budget day rollover, and duplicate admission
attempts.
Refresh outcome: Add.
Evidence Trail: focused contract/runtime tests, full `verify`, `git diff --check`.
Impact surface: `packages/contracts/src/runtime/*`, `packages/runtime/src/delivery-gate/*`,
`packages/runtime/src/run-journal/*`, `packages/runtime/src/tracer/*`.

## Files Changed In SLICE-3c

- `docs/foundation/SLICE-3C-HANDOFF.md`
- `docs/foundation/{BUILD-PLAN,FOUNDATION-HANDOVER,HARNESS-RUNTIME-BUILD-PLAN,NEXT-SESSION-PLAN,SLICE-3B-HANDOFF}.md`
- `packages/contracts/src/runtime/{class-state,delivery-policy,journal,outbox,push-class}.ts`
- `packages/contracts/src/runtime/{delivery-policy,journal,outbox}.test.ts`
- `packages/runtime/src/delivery-gate/{gate,store}.ts`
- `packages/runtime/src/run-journal/outbox-runtime.ts`
- `packages/runtime/src/tracer/{journal,outbox,schema,tracer-do}.ts`
- `packages/runtime/test/{delivery-gate,run-journal-interface,schema-migration,tracer}.test.ts`
- Removed obsolete `packages/runtime/src/tracer/{gate,store}.ts`

## Verification For Next Slice

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 -r typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```
