# SLICE-3a -> SLICE-3b Handoff

Date: 2026-07-07.
Merged PR: [#21](https://github.com/Pin4sf/waldo-backend/pull/21), commit `dadc50d`.
Linear: [HEY-120](https://linear.app/heywaldo/issue/HEY-120/harness-slice-3a-deliverygateoutbox-exactly-once-proof) done; [HEY-121](https://linear.app/heywaldo/issue/HEY-121/harness-slice-3b-promote-tracer-run-journaloutbox-into-runtime) is the next slice.

## What Was Built

- Durable outbox send-attempt state in the tracer path: `sent_unacked`, `attempts`,
  `next_retry_at`, `acked_at`, `sink_ack`, and `last_error`.
- Explicit `DeliverySink` idempotency-by-key contract and a wiring-time guard for undeclared sinks.
- Workerd crash/resume proof for post-send/pre-ack failure across Durable Object eviction.
- Contract coverage for outbox row and sink request/ack shapes.
- Foundation handover update marking exactly-once delivery as resolved for the proof slice.

## What Works

- `packages/runtime/test/outbox-delivery.test.ts`: proves the fake sink sees one physical delivery
  while runtime attempt counts and idempotency-key identity remain visible.
- Existing tracer tests still prove the scheduled `fetch_alert` path reaches `DONE`.
- Contract tests cover the new outbox and sink contract surface.
- Full merge gate passed before merge: `npx -y pnpm@10.34.4 verify` and `git diff --check`.

## What Does Not Work Yet

- No promoted runtime journal/outbox module exists yet; the behavior still lives in tracer-shaped code.
- No full run FSM runtime, scheduler multiplexer, Loop Governor runtime enforcement, dispatcher,
  Scribe runtime, real LLM provider, live channels, or app feed exists.
- No multi-kind outbox retry exhaustion policy or Supabase `notification_log` mirror exists.
- Provider error persistence is proof-shaped; before real sinks, normalize/sanitize `last_error`.

## Decisions Made

- Exactly-once delivery is split into two obligations: runtime commits attempts/acks durably, and
  the sink must declare idempotency by key.
- External sink calls stay outside the DO SQLite transaction; send-attempt state commits before the
  call and ack state commits after the call.
- An in-doubt `sent_unacked` row may retry only with the same idempotency key.
- Tracer crash hooks are test scaffolding unless SLICE-3b deliberately promotes a production seam.

## Hard-Won Lessons

- A process-local fake sink can hide duplicate sends unless tests also assert runtime attempt counts
  and idempotency-key stability.
- The durable read seam must parse stored rows before the runtime trusts them; writes alone are not
  enough for crash/resume code.
- Sink acks need their own contract check, including key equality with the row being acknowledged.

## Prerequisites For SLICE-3b

- Read `NEXT-SESSION-PLAN.md`, `HARNESS-RUNTIME-BUILD-PLAN.md`, this handoff, ADR-0054, and the
  DeepWiki conformance/delivery pages.
- Start with a failing `@cloudflare/vitest-pool-workers` test that drives the promoted interface,
  not tracer internals.
- Single-writer owned files: `packages/runtime/src/*`, `packages/runtime/test/*` for the touched
  runtime proof, and `packages/contracts/src/runtime/*` if the interface DTOs change.
- Out of scope: scheduler, governor runtime, dispatcher, Scribe, real LLMs, live credentials,
  DeliveryGate budgets/cooldowns/held candidates, and app feed.

## Files Changed In SLICE-3a

- `docs/foundation/FOUNDATION-HANDOVER.md`
- `packages/contracts/src/runtime/journal.ts`
- `packages/contracts/src/runtime/outbox.ts`
- `packages/contracts/src/runtime/outbox.test.ts`
- `packages/contracts/src/runtime/sink.ts`
- `packages/contracts/src/runtime/sink.test.ts`
- `packages/runtime/src/tracer/outbox.ts`
- `packages/runtime/src/tracer/schema.ts`
- `packages/runtime/src/tracer/sink.ts`
- `packages/runtime/src/tracer/tracer-do.ts`
- `packages/runtime/test/outbox-delivery.test.ts`
- `packages/runtime/test/tracer.test.ts`

## Verification For Next Slice

```bash
pnpm --filter @waldo/runtime test -- run-journal
pnpm --filter @waldo/runtime test -- outbox
pnpm --filter @waldo/contracts test
pnpm -r typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```
