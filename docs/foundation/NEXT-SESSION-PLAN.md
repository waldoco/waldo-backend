# Next Session Plan - Harness Runtime SLICE-3c Build

Status: draft entrypoint for the next Waldo backend grilling/planning session after SLICE-3b merges.
Date: 2026-07-07.
Baseline: SLICE-3a/HEY-120 merged in PR #21, and SLICE-3b/HEY-121 is pending in PR #23 on branch
`codex/hey-121-runtime-journal-outbox-interface`.

After PR #23 merges, this replaces the SLICE-3b planning entrypoint. The contract spine is ready
enough for runtime work, SLICE-3a proved durable outbox delivery, and PR #23 proposes to promote
that proof into a narrow runtime interface. The next session should grill DeliveryGate runtime state,
assign safe parallel lanes, and then start SLICE-3c.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/SLICE-3B-HANDOFF.md`
6. `docs/foundation/FOUNDATION-HANDOVER.md`
7. `docs/foundation/BUILD-PLAN.md`
8. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
9. The Waldo Brain source files listed in the runtime build plan for the seam being grilled.

Then run the baseline gate before planning claims or edits:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Current Truth

- The Waldo Brain architecture is no longer an open research problem for V1. It calls for a per-user Cloudflare Durable Object running a resumable, journaled, deterministically governed agent loop.
- The backend contract spine is broad and real: contracts exist for runtime run/session/schedule/goal/outbox/policy, tools, memory, prompt, model routing, adapters, public DTO/OpenAPI, telemetry, and evidence lanes.
- The backend runtime is still mostly skeletal. The only executing harness path is the scheduled `fetch_alert` tracer; PR #23 proposes to back it with a promoted run-journal/outbox interface.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- SLICE-3b/HEY-121 is pending in PR #23: `RunJournalOutbox` exposes `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`, with durable read parsing and ack-key enforcement.
- After PR #23 merges, the next work is DeliveryGate runtime promotion, not more contract expansion and not full product wiring.
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

Start with **SLICE-3c/HEY-124: DeliveryGate runtime on the promoted journal/outbox seam**.

Goal:

- Move from the tracer's proof-shaped gate into a runtime DeliveryGate seam for budgets, cooldowns,
  held candidates, and class policy state.
- Preserve the SLICE-3b invariant: the gate may commit an outbox intent only through the promoted
  journal/outbox interface, and flush may reach a sink only from parsed committed DO SQLite state.
- Use ADR-0068 contracts as the source of truth; do not invent new delivery verdict enums.
- Keep scheduler, dispatcher, Scribe, real LLMs, live channels, and app feed code out of SLICE-3c.
- Use real `@cloudflare/vitest-pool-workers` tests for any DO SQLite transaction, eviction, retry,
  or alarm behavior.

Out of scope for SLICE-3c:

- Full scheduler multiplexer.
- Full Loop Governor enforcement.
- Dispatcher/tool runtime.
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.
- Live provider credentials and cross-store `notification_log` mirroring unless the slice explicitly
  narrows to that seam.

First PR shape:

```text
runtime: promote delivery gate runtime
```

Acceptance:

- Failing test first for a DeliveryGate runtime path that consumes the promoted journal/outbox seam.
- Gate verdict, class-state accounting, held/drop/degrade behavior, and outbox intent commit match
  ADR-0068 contracts.
- Existing SLICE-3a and SLICE-3b crash/resume and exactly-once delivery tests still pass.
- Runtime gate code does not import scheduler, dispatcher, Scribe, real LLM, live channel
  credentials, or app feed code.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Pending PR #23 | Codex/runtime | Preserve; expand only if SLICE-3c exposes a real gap after merge. |
| DeliveryGate Runtime | After PR #23 merges | Codex/runtime | HEY-124/SLICE-3c: budget, cooldown, held candidates, GATED step. |
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

1. Assign a single writer to HEY-124/SLICE-3c.
2. After PR #23 merges, preserve the SLICE-3a/3b proof while extracting DeliveryGate runtime state.
3. Run ADR-0066 ES256 Supabase issuer spike in parallel.
4. Start fake-first LLM routing/eval lane only if it avoids runtime files.
5. Start fake channel sink and Telegram ingress gate tests only against contracts/fakes.
6. Start trace/conformance artifact scaffold; do not take over DeliveryGate runtime files from the SLICE-3c writer.
7. Start pure Loop Governor comparator tests only if they avoid shared runtime writes.

Week 2:

1. Finish DeliveryGate runtime or split the remaining policy state into the next slice.
2. Wire Loop Governor runtime enforcement.
3. Wire dispatcher/hooks/sanitiser around the invocation skeleton.
4. Begin scheduler multiplexer once run identity and retry semantics are stable.
5. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
