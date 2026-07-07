# Next Session Plan - Harness Runtime SLICE-3b Build

Status: active entrypoint for the next Waldo backend grilling/planning session.
Date: 2026-07-07.
Baseline: current `main` after PR #21 (`dadc50d`) merged SLICE-3a/HEY-120.

This replaces the old SLICE-3a planning entrypoint. The contract spine is ready enough for runtime work and SLICE-3a proved durable outbox delivery; the next session should grill the runtime interface seam, assign safe parallel lanes, and then start SLICE-3b.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/FOUNDATION-HANDOVER.md`
6. `docs/foundation/BUILD-PLAN.md`
7. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
8. The Waldo Brain source files listed in the runtime build plan for the seam being grilled.

Then run the baseline gate before planning claims or edits:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Current Truth

- The Waldo Brain architecture is no longer an open research problem for V1. It calls for a per-user Cloudflare Durable Object running a resumable, journaled, deterministically governed agent loop.
- The backend contract spine is broad and real: contracts exist for runtime run/session/schedule/goal/outbox/policy, tools, memory, prompt, model routing, adapters, public DTO/OpenAPI, telemetry, and evidence lanes.
- The backend runtime is still mostly skeletal. The only executing harness path is the scheduled `fetch_alert` tracer, now with a durable exactly-once outbox proof.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- The next work is runtime interface promotion, not more contract expansion and not full product wiring.
- Split work by runtime seam, not by product pillar. Brief, Fetch, Spots, and Chat all converge on the same DO loop, journal, scheduler, dispatcher, memory, and delivery files.

## Grilling Questions

Use `/grill-with-docs`, `/waldo-isa-run-contract`, and `/codebase-design` against these questions before implementation:

1. What exact invariant must the next runtime PR prove?
2. Which files are single-writer for that PR?
3. Which accepted ADR owns the behavior?
4. What must be tested in `@cloudflare/vitest-pool-workers`, not only in Node?
5. What must stay out of scope so the first PR stays reviewable?
6. Which parallel lanes are safe because they do not write the same runtime files?
7. What would make the plan unsafe for Art-9 health data, auth, memory, or delivery?

## Exact Next Slice

Start with **SLICE-3b/HEY-121: promote tracer run journal/outbox into the runtime interface**.

Goal:

- Promote the tracer-proven journal/outbox behavior behind a narrow runtime-facing interface: `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`.
- Preserve the SLICE-3a invariant: external side effects leave only through idempotent outbox rows and resume converges from committed DO SQLite state.
- Parse/enforce contract DTOs at the durable read and delivery seams: outbox rows on read, sink requests before send, sink acks before commit, and ack key must match the row key.
- Keep trace/crash controls as test scaffolding unless a piece is explicitly promoted into a production runtime interface.
- Use real `@cloudflare/vitest-pool-workers` tests for eviction, duplicate alarm, corrupt journal/outbox read, and post-send/pre-ack resume behavior.

Out of scope for SLICE-3b:

- Full scheduler multiplexer.
- Full Loop Governor enforcement.
- Dispatcher/tool runtime.
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.
- DeliveryGate budgets/cooldowns/held-candidate runtime beyond what the existing tracer proof needs.

First PR shape:

```text
runtime: promote journal/outbox interface
```

Acceptance:

- Failing Workers/DO test first for a runtime-interface resume path that currently only the tracer owns.
- One committed state transition per DO SQLite transaction.
- Existing SLICE-3a crash/resume and exactly-once delivery tests still pass.
- Malformed durable rows fail closed at the read seam; a mismatched ack key is rejected before state mutation.
- Runtime interface does not import scheduler, dispatcher, Scribe, real LLM, live channel credentials, or app feed code.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Now | Codex/runtime | Current slice: HEY-121/SLICE-3b. Single-writer. |
| DeliveryGate Runtime | After SLICE-3b interface shape | Codex/runtime | HEY-124/SLICE-3c: budget, cooldown, held candidates, GATED step. |
| Scheduler Multiplexer | Design now, runtime after outbox | Codex/scheduler | Alarm pop, recurrence, retry, quarantine, liveness. |
| Loop Governor Runtime | Comparator tests now | Codex/policy runtime | Integration waits on run loop and loop-progress rows. |
| Dispatcher + Hooks + ACL + Sanitiser | Isolated tests now | Codex/security runtime | Integration waits on invocation/run skeleton. |
| Context + Memory + Prompt Hydration | Fake-backed design now | Claude memory/context + Codex integration | Keep raw health out of DO/R2/prompts/logs. |
| LLMProvider + Routing + Eval | Now | Codex/eval | Fake-first provider and route tests are low collision. |
| Channels + App Surfaces | Fake sinks now | Codex/channel + app team | Production delivery waits on outbox. Live chat/feed need decision. |
| Auth/Data Plane/Adapters | Now | Claude/Supabase + Codex adapters | ADR-0066 ES256 Supabase issuer spike is a parallel blocker. |
| Observability/Conformance | Now | Codex/infra | Trace event shape, scenario artifacts, replay/eval scaffolding. |

## Coordination Rules

Every lane must declare this before work starts:

```text
Owner:
Pillar:
Source ADR/docs:
Files owned:
Files explicitly out of scope:
Invariant:
Tests:
Merge dependency:
```

Single-writer surfaces:

- `packages/runtime/src/*`
- `packages/contracts/src/runtime/*`
- `packages/contracts/src/tools/*`
- `packages/contracts/src/memory/sanitise.ts`
- `packages/contracts/src/core/trigger.ts`
- `packages/contracts/src/model/roster.ts`
- `packages/contracts/src/index.ts`
- Foundation truth docs when updating status.

Safe parallel lanes:

- Read-only source rechecks.
- Adversarial review.
- Fixture/eval/scenario scaffolding.
- Fake LLM routing tests.
- Fake channel sink tests.
- Supabase ES256 staging spike.
- Live-chat/feed spike notes, without production implementation.

## Week Plan

Week 1:

1. Assign a single writer to HEY-121/SLICE-3b.
2. Preserve the SLICE-3a proof while extracting the journal/outbox runtime interface.
3. Run ADR-0066 ES256 Supabase issuer spike in parallel.
4. Start fake-first LLM routing/eval lane only if it avoids runtime files.
5. Start fake channel sink and Telegram ingress gate tests only against contracts/fakes.
6. Start trace/conformance artifact scaffold; do not take over runtime trace files from the SLICE-3b writer.
7. Start pure Loop Governor comparator tests only if they avoid shared runtime writes.

Week 2:

1. Integrate DeliveryGate runtime onto the promoted durable journal/outbox seam.
2. Wire Loop Governor runtime enforcement.
3. Wire dispatcher/hooks/sanitiser around the invocation skeleton.
4. Begin scheduler multiplexer once run identity and retry semantics are stable.
5. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
