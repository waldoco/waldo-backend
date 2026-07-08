# Next Session Plan - Harness Runtime SLICE-4 Build

Status: active entrypoint for the Waldo backend SLICE-4 Loop Governor runtime build.
Date: 2026-07-07.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at `f47127f`, and
SLICE-3c/HEY-124 merged in PR #24 at `5789b42`.

The durable delivery spine is real: journal/outbox resume is proven, the promoted `RunJournalOutbox`
interface owns the commit boundary, and the DeliveryGate runtime enforces ADR-0068 policy state.
The current session should build the ADR-0074 Loop Governor seam on top, without pulling in
scheduler, dispatcher, Scribe, real providers, or live channels.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/SLICE-3C-HANDOFF.md` (then `SLICE-3B-HANDOFF.md` for the seam invariants)
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
- The backend runtime is still mostly skeletal. The executing harness path now uses the promoted `RunJournalOutbox` seam from PR #23.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- SLICE-3b/HEY-121 is complete: `RunJournalOutbox` exposes `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`, with durable read parsing and ack-key enforcement.
- SLICE-3c/HEY-124 is complete: the DeliveryGate runtime enforces ADR-0068 caps, budgets, cooldowns, sub-kind caps, held candidates, and gate reasons atomically inside the GATED commit. Acceptance residue (property tests, timezone state, quiet hours, Pro Max, race case) is listed in `SLICE-3C-HANDOFF.md` and awaits a founder placement call.
- The current work is Loop Governor runtime promotion, not more broad contract expansion and not full product wiring.
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

Start with **SLICE-4/HEY-122: Loop Governor deterministic gate on the runtime tick path**.

Goal:

- Promote the tracer's reduced `GOVERNOR_ADMITTED` admission into the ADR-0074 Loop Governor seam:
  deterministic loop admission, budget kill, and the cross-run no-progress guard.
- Consume `packages/contracts/src/runtime/loop-policy.ts` (`LOOP_POLICIES`, `lookupLoopPolicy`,
  `admit`) as the source of truth; do not invent runtime policy constants.
- Keep Governor and DeliveryGate separate modules and separate decisions: the governor decides
  whether a loop runs, never whether a candidate sends, and never touches budget or outbox state.
- The pre-delivery Art-9 egress floor is deterministic, reuses `RAW_SENSOR_PATTERNS` from
  `packages/contracts/src/memory/sanitise.ts`, and cannot be bypassed by prompt/model output.
- Use real `@cloudflare/vitest-pool-workers` tests for any DO SQLite transaction, eviction, or
  kill-state persistence behavior.

Out of scope for SLICE-4:

- DeliveryGate policy rewrite (HEY-124 shipped; residue is a separate placement call).
- Full scheduler multiplexer (HEY-123).
- Dispatcher/tool runtime (HEY-78).
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.

First PR shape:

```text
runtime: promote loop governor gate
```

Acceptance:

- Failing test first for a governor decision driven through runtime code against the loop-policy
  contract.
- Allowed, held, and blocked loop decisions are deterministic and outside the LLM — including
  Fetch-over-Brief priority, budget kill, and stuck-loop cases.
- Kill/no-progress state survives eviction; a killed run stays killed on resume.
- No budget decrement or outbox insert occurs in the governor module.
- Existing SLICE-3a/3b/3c crash/resume, exactly-once, and gate tests still pass.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue in `SLICE-3C-HANDOFF.md` awaits a placement call. |
| Scheduler Multiplexer | Design now, runtime after governor | Codex/scheduler | Alarm pop, recurrence, retry, quarantine, liveness. Also owns held-candidate wakeup + quiet-end re-admission alarms. |
| Loop Governor Runtime | Active | Codex/policy runtime | HEY-122/SLICE-4: deterministic admission, budget kill, stuck-loop guard. |
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

1. Assign a single writer to HEY-122/SLICE-4.
2. Preserve the SLICE-3a/3b/3c proofs while promoting Loop Governor runtime state.
3. Run ADR-0066 ES256 Supabase issuer spike in parallel (HEY-125).
4. Start fake-first LLM routing/eval lane only if it avoids runtime files.
5. Start fake channel sink and Telegram ingress gate tests only against contracts/fakes.
6. Start trace/conformance artifact scaffold; do not take over runtime files from the SLICE-4 writer.
7. Founder placement call on the HEY-124 acceptance residue (property tests · timezone state · quiet hours · Pro Max · race case).

Week 2:

1. Finish Loop Governor runtime or split remaining enforcement into the next slice.
2. Begin scheduler multiplexer (HEY-123) — it also owns held-candidate wakeup and quiet-end re-admission alarms.
3. Wire dispatcher/hooks/sanitiser around the invocation skeleton.
4. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
