# HEY-114 Step 3: Flaky Test Fix Report

## Issue

`pnpm verify` step 3 failed due to a flaky test in `tracer.test.ts` within the `@waldo/runtime` package. The test suite showed intermittent failures where a Durable Object alarm-driven exactly-once delivery test would pass when run in isolation but fail when run as part of the full suite.

### Symptom

```
FAIL test/tracer.test.ts > TracerDO edge lanes > hostile: a duplicate alarm delivery after DONE is a no-op
expected 2 to be 1  (sink.observedDeliveries() was 2 instead of 1)
```

After applying the first fix, the failure shifted to:

```
test #6 crash after ack recorded before handler returns: resume enters at ACK_RECORDED, skips the sink
expected 2 to be 1  (sink.observedDeliveries() was 2 instead of 1)
```

Both failures showed the same pattern: the `FakeSink` delivery counter exceeded the expected exactly-once invariant.

## Root Cause

`FakeSink` used module-level mutable state (either bare module variables or a `static get shared()` singleton) shared across **all** `TracerDO` instances within the same vitest-pool-workers process. When multiple tests create, evict, and resume Durable Objects, the following race conditions occur:

1. A test evicts a DO and creates a new instance; both instances reference the same `FakeSink.shared` singleton
2. The `beforeEach` reset runs in the test's JavaScript context, but the DO's alarm handler may have pending microtasks in the workerd runtime that complete *after* the reset, incrementing the counter for the next test's assertions

The core tension: `FakeSink` must preserve its counters across DO eviction (so a resumed DO sees the previous delivery count) while also being isolated per-test (so one test cannot contaminate another).

## Fix: Per-DO-Instance Sinks via `FakeSink.forDO()`

### Design

Replace the global singleton with a `Map<string, FakeSink>` registry keyed by the DO's durable name (`ctx.id.toString()`). This gives every DO its own private `FakeSink` instance that:

- Survives eviction+resume (same key → same sink on re-creation)
- Is naturally isolated from other DO instances (different key → different sink)
- Is cleaned up between tests via `afterEach(() => FakeSink.resetAll())`

### Files Changed

| File | Change |
|---|---|
| `packages/runtime/src/tracer/sink.ts` | Added `Map<string, FakeSink>` registry with `forDO(doName)` and `resetAll()`; preserved `.shared` singleton for backward compatibility |
| `packages/runtime/src/tracer/tracer-do.ts` | Constructor uses `FakeSink.forDO(ctx.id.toString())` instead of `FakeSink.shared`; added `DeliverySink` type import |
| `packages/runtime/test/tracer.test.ts` | Replaced `beforeEach` shared-reset with `afterEach` map-clear; all tests use `FakeSink.forDO(stub.id.toString())` |
| `packages/runtime/test/delivery-gate.test.ts` | Same pattern as tracer.test.ts |
| `packages/runtime/test/outbox-delivery.test.ts` | Same pattern, plus `FakeSink.shared.failNextSend` → `sink.failNextSend` |
| `packages/runtime/test/run-journal-interface.test.ts` | Same pattern, plus `FakeSink.shared.returnInvalidAckOnce` → `FakeSink.forDO(...)` |
| `packages/runtime/test/scheduler-alarm.test.ts` | Same pattern as tracer.test.ts |

### Key Principle

Each `TracerDO` instance creates or retrieves its `FakeSink` by calling `FakeSink.forDO(ctx.id.toString())` in its constructor. The test helper creates the stub first, then obtains the matching sink with `FakeSink.forDO(stub.id.toString())`. Because `stub.id.toString()` and `ctx.id.toString()` produce the same string (both derived from `DurableObjectId.idFromName()`), the test and the DO always share the same `FakeSink` instance — even across eviction and resume.

### Verification

- All 560 runtime tests pass (22 test files, 0 failures)
- All 1190 contract tests pass
- Typecheck passes across all packages
- `pnpm verify` completes end-to-end (typecheck → contracts → runtime → supabase → guards)
- No change in production behavior (FakeSink is test-only; the `DeliverySink` interface is unchanged)
