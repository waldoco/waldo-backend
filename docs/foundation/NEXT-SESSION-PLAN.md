# Next Session Plan - Harness Runtime Grilling And Build Planning

Status: active entrypoint for the next Waldo backend grilling/planning session.
Date: 2026-07-06.
Baseline: current `main` after Phase D contract-spine completion and the agent operating workflow docs.

This replaces the old Phase D contract-spine runbook. The contract spine is ready enough for runtime work; the next session should grill the runtime plan, assign async pillars, and then start with the first durable runtime slice.

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
- The backend runtime is still mostly skeletal. The only executing harness path is the scheduled `fetch_alert` tracer.
- The next work is runtime proof, not more contract expansion.
- Split work by runtime seam, not by product pillar. Brief, Fetch, Spots, and Chat all converge on the same DO loop, journal, scheduler, dispatcher, memory, and delivery files.

## Grilling Questions

Use `/grill-with-docs`, `/waldo-isa-run-contract`, and `/codebase-design` against these questions before implementation:

1. What exact invariant must the first runtime PR prove?
2. Which files are single-writer for that PR?
3. Which accepted ADR owns the behavior?
4. What must be tested in `@cloudflare/vitest-pool-workers`, not only in Node?
5. What must stay out of scope so the first PR stays reviewable?
6. Which parallel lanes are safe because they do not write the same runtime files?
7. What would make the plan unsafe for Art-9 health data, auth, memory, or delivery?

## Exact Next Slice

Start with **SLICE-3a: durable DeliveryGate/outbox proof**.

Goal:

- Build the production run-journal/outbox seam far enough to prove side-effect idempotency.
- Add the DO SQLite state needed for outbox status, attempts, next retry, ack, held candidates, daily push budget, and the notification-log mirror seam where applicable.
- Prove crash after sink send but before ack does not double-deliver.
- Use real `@cloudflare/vitest-pool-workers` eviction/resume tests.

Out of scope for SLICE-3a:

- Full scheduler multiplexer.
- Full Loop Governor enforcement.
- Dispatcher/tool runtime.
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.

First PR shape:

```text
runtime: prove durable outbox exactly-once delivery
```

Acceptance:

- Failing test first for post-send/pre-ack crash.
- Durable ack/idempotency state prevents duplicate side effects.
- Fake sink does not hide the proof; the runtime interface itself names the idempotency contract.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Now | Codex/runtime | Critical path. Single-writer. |
| DeliveryGate Runtime | After outbox transaction shape | Codex/runtime | Budget, cooldown, held candidates, GATED step. |
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

1. Assign a single writer to SLICE-3a.
2. Run ADR-0066 ES256 Supabase issuer spike in parallel.
3. Start fake-first LLM routing/eval lane.
4. Start fake channel sink and Telegram ingress gate tests.
5. Start trace/conformance artifact scaffold.
6. Start pure Loop Governor comparator tests only if they avoid shared runtime writes.

Week 2:

1. Integrate DeliveryGate runtime onto the durable journal/outbox seam.
2. Wire Loop Governor runtime enforcement.
3. Wire dispatcher/hooks/sanitiser around the invocation skeleton.
4. Begin scheduler multiplexer once run identity and retry semantics are stable.
5. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
