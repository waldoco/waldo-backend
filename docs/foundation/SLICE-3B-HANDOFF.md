# SLICE-3b -> SLICE-3c Handoff

Date: 2026-07-07.
Branch: `codex/hey-121-runtime-journal-outbox-interface`.
Linear: [HEY-121](https://linear.app/heywaldo/issue/HEY-121/harness-slice-3b-promote-tracer-run-journaloutbox-into-runtime).
Status: merged in PR #23 at `f47127f`; use as the SLICE-3c source handoff.

## What PR #23 Built

- Promoted the tracer journal/outbox proof into `RunJournalOutbox`, a narrow runtime module with
  `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`.
- Refactored `TracerDO` to delegate journal/outbox work to the promoted runtime interface while
  preserving the existing alarm-driven tracer behavior.
- Made `enqueueOutbox` own the reduced DeliveryGate commit boundary: verdict stamp, class-state
  update, outbox insert, and `GATED` advance commit in one DO SQLite transaction.
- Enforced contract parsing at durable read and delivery seams: full journal/outbox row parse on
  read, sink request parse before send, sink ack parse before mutation, and ack key equality before
  the keyed ack update.
- Hardened the payload and error boundary: outbox payloads are generated allowlisted opaque tokens,
  free-text payloads are rejected by contract, and persisted send failures store `send_failed`.

## What The PR Branch Proves

- `packages/runtime/test/run-journal-interface.test.ts` proves the promoted interface resumes across
  eviction after post-send/pre-ack failure without duplicate physical delivery.
- The first slice test is named exactly:
  `resumes the promoted journal/outbox interface across eviction without re-sending`.
- Malformed committed journal/outbox rows fail closed at the read seam.
- Invalid sink acks and mismatched ack keys fail before ack mutation.
- Duplicate ticks after terminal `DONE` do not re-send.
- Full verification passed:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

Result: contracts 47 files / 1157 tests passed, runtime 4 files / 31 tests passed, all guards passed,
and whitespace check passed.

## What Does Not Work Yet

- No full ADR-0054 run FSM runtime; the promoted module still drives the reduced tracer FSM.
- No multi-kind outbox flusher, retry exhaustion policy, poison-row policy, or Supabase
  `notification_log` UNIQUE mirror.
- No SLICE-3c DeliveryGate runtime for budgets, cooldowns, held candidates, or real policy state.
- No scheduler multiplexer, full Loop Governor runtime, dispatcher, Scribe runtime, real LLM, live
  APNs/Telegram sink, live chat transport, or app feed integration.

## Architecture Decisions Made

- `enqueueOutbox` is not a free-standing row insert. In the promoted interface it is the gate-owned
  commit that keeps verdict, class-state accounting, outbox intent, and `GATED` state atomic.
- `flushOutbox` may reach the sink only after a parsed journal row is `GATED` or `SINK_SENT` with a
  `send` verdict, and after the outbox row parses under the shared contract.
- A sink ack can mutate only the row with the same idempotency key; the SQL update includes the key
  predicate after the runtime compares the parsed ack to the parsed row.
- Crash hooks remain test scaffolding through constructor-injected fault hooks; they are not a
  product runtime surface.

## Hard-Won Lessons

- Promoting a tracer helper into a runtime interface can accidentally promote a partial mutation.
  The invariant must travel with the method: if a method enqueues a side effect, it must also own or
  prove the journal state transition that makes the side effect legal.
- Durable read seams need full-row contract parsing, not only enum parsing. Otherwise corrupt
  columns can survive long enough to drive a side effect.
- Provider errors are not safe audit text by default. Persist a bounded category until a real
  redaction and provider-error taxonomy exists.

## Compound Learning Capture

Lesson: Runtime side-effect helpers must carry their commit boundary when promoted from a tracer.
Mode: Lightweight.
Track: Knowledge/practice.
Overlap check: ADR-0054, `HARNESS-RUNTIME-BUILD-PLAN.md`, and `SLICE-3A-HANDOFF.md` already own the
run-journal/outbox principle; this handoff captures the slice-specific interface lesson.
Destination: `docs/foundation/SLICE-3B-HANDOFF.md`.
Source/provenance: HEY-121 implementation and review pass in this branch.
Applicability limit: Applies to DO SQLite journal/outbox promotion and future DeliveryGate flusher
methods; do not generalize to pure read adapters.
Eval/pressure scenario: Workers/DO eviction or duplicate alarm after an outbox row exists but before
ack mutation.
Refresh outcome: Update.
Evidence Trail: focused runtime tests, full `verify`, and `git diff --check` listed above.
Impact surface: `packages/runtime/src/run-journal/*`, `packages/runtime/src/tracer/*`,
`packages/contracts/src/runtime/*`.

## Prerequisites For SLICE-3c

- Read this handoff, ADR-0054, ADR-0068, ADR-0074, and the DeepWiki conformance/delivery pages.
- Start with DeliveryGate runtime policy state, not scheduler, dispatcher, Scribe, real LLMs, or live
  channels.
- Preserve the promoted interface invariant: no sink reach without parsed journal/outbox rows and no
  ack mutation without the same idempotency key.
- Add real `@cloudflare/vitest-pool-workers` tests for any DO SQLite, alarm, eviction, or retry
  behavior.

## Files Changed In SLICE-3b

- `docs/foundation/SLICE-3B-HANDOFF.md`
- `packages/contracts/src/runtime/journal.ts`
- `packages/contracts/src/runtime/journal.test.ts`
- `packages/contracts/src/runtime/outbox.ts`
- `packages/contracts/src/runtime/outbox.test.ts`
- `packages/contracts/src/runtime/sink.test.ts`
- `packages/runtime/src/run-journal/outbox-runtime.ts`
- `packages/runtime/src/tracer/journal.ts`
- `packages/runtime/src/tracer/outbox.ts`
- `packages/runtime/src/tracer/sink.ts`
- `packages/runtime/src/tracer/tracer-do.ts`
- `packages/runtime/test/outbox-delivery.test.ts`
- `packages/runtime/test/run-journal-interface.test.ts`

## Verification For Next Slice

```bash
pnpm --filter @waldo/runtime test -- run-journal-interface
pnpm --filter @waldo/runtime test -- outbox
pnpm --filter @waldo/contracts test
pnpm -r typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```
