# Next Session Plan - Harness Runtime HEY-77 Build

Status: active entrypoint for the Waldo backend HEY-77 triage dispatcher single-entry PR.
Date: 2026-07-08.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at `f47127f`, and
SLICE-3c/HEY-124 merged in PR #24 at `5789b42`. HEY-122/SLICE-4 Loop Governor merged via PR #27;
HEY-123/SLICE-5 scheduler/alarm multiplexer merged via PR #28 at `061e72c`; `origin/main` is at or
after `061e72c`.

The durable delivery spine is real: journal/outbox resume is proven, the promoted `RunJournalOutbox`
interface owns the commit boundary, the DeliveryGate runtime enforces ADR-0068 policy state, and
the Loop Governor runtime seam is merged. The scheduler/alarm multiplexer is merged; the current
runtime-lane unit is HEY-77 on `codex/hey-77-triage-dispatcher-single-entry`. Keep HEY-12, HEY-78,
HEY-17, HEY-136, and later runtime-lane work out of this PR.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. The Waldo Brain source files listed in the runtime build plan for the seam being grilled.

Then run the baseline gate before planning claims or edits:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Current Truth

- The Waldo Brain architecture is no longer an open research problem for V1. It calls for a per-user Cloudflare Durable Object running a resumable, journaled, deterministically governed agent loop.
- The backend contract spine is broad and real: contracts exist for runtime run/session/schedule/goal/outbox/policy, tools, memory, prompt, model routing, adapters, public DTO/OpenAPI, telemetry, and evidence lanes.
- The backend runtime is still incomplete, but the runtime spine now includes journal/outbox,
  DeliveryGate, Loop Governor, and the HEY-123 scheduler/alarm multiplexer merged in PR #28.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- SLICE-3b/HEY-121 is complete: `RunJournalOutbox` exposes `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`, with durable read parsing and ack-key enforcement.
- SLICE-3c/HEY-124 is complete: the DeliveryGate runtime enforces ADR-0068 caps, budgets, cooldowns, sub-kind caps, held candidates, and gate reasons atomically inside the GATED commit. Acceptance residue (property tests, timezone state, quiet hours, Pro Max, race case) is preserved in `docs/foundation/archive/SLICE-3C-HANDOFF.md` and awaits a founder placement call.
- HEY-122/SLICE-4 is complete and merged via PR #27.
- HEY-123/SLICE-5 is complete and merged via PR #28. It proves one Durable Object alarm entrypoint
  can dispatch due run resume, outbox retry, and scheduled proactive wake rows through durable
  schedule state.
- The current work is HEY-77: a pure triage dispatcher that classifies incoming wake envelopes to
  one canonical `TriggerType` before downstream Governor/ACL/runtime wiring.
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

## Exact Current Slice

Complete **HEY-77: Triage dispatcher single entry**.

Goal:

- One pure `triage(event)` function classifies incoming wakes to exactly one canonical trigger or a
  typed rejection.
- Scheduler alarm wakes, webhooks, user messages, app events, and HealthKit background delivery use
  authenticated envelope metadata, never raw payload content or health values.
- `journal` and `handoff` scheduler wakes resume only when supplied the original run trigger; they
  must not invent a new trigger.
- Unknown or malformed envelopes reject with a typed reason and never guess a default trigger.
- Scheduler proactive wakes enter the runtime through the triage seam before `startRun`.

Out of scope for HEY-77:

- Full patrol cadence matrix.
- Hook registry (HEY-12).
- ToolDispatcher/runtime ACL (HEY-78).
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.
- Full run-loop integration (HEY-136).

First PR shape:

```text
runtime: add triage dispatcher single entry
```

Acceptance:

- Failing tests first for the triage dispatcher behavior.
- Every supported envelope kind maps to one canonical trigger.
- The schedule alarm path uses triage before starting a proactive run.
- Unknown/malformed input returns typed rejection; no guessed fallback trigger.
- Hostile webhook payload content cannot influence trigger choice or appear in reason strings.
- Duplicate wake classification is deterministic.
- Existing SLICE-3a/3b/3c/4/5 crash/resume, exactly-once, gate, governor, and scheduler tests
  still pass.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue in `docs/foundation/archive/SLICE-3C-HANDOFF.md` awaits a placement call. |
| Scheduler Multiplexer | Complete through PR #28 | Codex/scheduler | HEY-123/SLICE-5: alarm pop, recurrence, retry, quarantine, stale-run wake proof. Held-candidate wakeup + quiet-end re-admission policy remains later wiring. |
| Loop Governor Runtime | Complete through PR #27 | Codex/policy runtime | HEY-122/SLICE-4: deterministic admission, budget kill, stuck-loop guard. |
| Dispatcher + Hooks + ACL + Sanitiser | HEY-77 active | Codex/security runtime | HEY-77 owns triage only. Hook registry, ToolDispatcher ACL, and sanitiser placement remain later PRs. |
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

Immediate plan:

1. Review and PR HEY-77 from `codex/hey-77-triage-dispatcher-single-entry`.
2. Preserve the SLICE-3a/3b/3c/4/5 proofs while adding triage classification.
3. Run ADR-0066 ES256 Supabase issuer spike in parallel (HEY-125).
4. Start fake-first LLM routing/eval lane only if it avoids runtime files.
5. Start fake channel sink and Telegram ingress gate tests only against contracts/fakes.
6. Start trace/conformance artifact scaffold only if it does not take over runtime files from the
   HEY-77 writer.
7. Founder placement call on the HEY-124 acceptance residue (property tests · timezone state · quiet hours · Pro Max · race case).

After HEY-77 merge:

1. Begin HEY-12 hook registry.
2. Keep held-candidate quiet-end re-admission and full cadence matrix out unless explicitly
   re-scoped.
3. Wire ToolDispatcher/ACL and sanitiser around the invocation skeleton after hooks.
4. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs, the foundation handover, slice handoffs, and old Codex review
notes are under `docs/foundation/archive/`. They are useful for archaeology and slice-specific
lessons, not current planning. Do not use them as the active next-session plan.
