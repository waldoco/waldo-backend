# Next Session Plan - Runtime Hardening To Agent Harness Alpha

Status: active entrypoint after HEY-17 and HEY-136. The current lane is Runtime hardening before
the first honest agent-harness alpha.
Date: 2026-07-09 IST.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at
`f47127f`, SLICE-3c/HEY-124 merged in PR #24 at `5789b42`, HEY-122/SLICE-4 merged in
PR #27, HEY-123/SLICE-5 merged in PR #28 at `061e72c`, HEY-77 triage dispatcher merged
in PR #29 at `a947600`, HEY-12 hook registry merged in PR #31 at `1b180ef`, and HEY-78
ToolDispatcher + per-trigger ACL enforcement merged in PR #33 at `600fb34`. HEY-17 merged in
PR #34 at `0aae766`; HEY-136 merged in PR #35 at `3d336c7`.

HEY-136 proved the fake-first run-loop skeleton. The current hardening branch closes the highest
integration gaps before live provider/channel or memory work: spend cap must avoid gateway calls,
governor deny decisions must become durable runtime failures, and the loop must do a
plan -> act -> observe/synthesise pass rather than gating a constant string.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. `docs/foundation/FOUNDATION-HANDOVER.md`
8. `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md` when touching HEY-10 or DO SQLite schema scope.
9. `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md` when touching deferred DO SQLite tables.
10. The Waldo Brain source files listed in the runtime build plan for the seam being reviewed.

Then run the baseline gate before planning claims or edits:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Current Truth

- The Waldo Brain architecture is no longer an open research problem for V1. It calls for a
  per-user Cloudflare Durable Object running a resumable, journaled, deterministically governed
  agent loop.
- The backend contract spine is broad and real: contracts exist for runtime run/session/schedule/
  goal/outbox/policy, tools, memory, prompt, model routing, adapters, public DTO/OpenAPI,
  telemetry, and evidence lanes.
- The runtime spine now includes journal/outbox, DeliveryGate, Loop Governor, scheduler/alarm
  multiplexer, triage dispatcher, hook registry, ToolDispatcher/ACL runtime, fake-first
  LLMProvider routing, and fake-first `RunLoopDO`.
- HEY-136 is intentionally fake-first: it proves loop anatomy and durable resume, not production
  provider/channel/memory behavior.
- The active hardening slice keeps live provider calls, live channel delivery, Scribe writes, and
  raw health/private data out of scope.
- Split work by runtime seam, not by product pillar. Brief, Fetch, Spots, and Chat all converge on
  the same DO loop, journal, scheduler, dispatcher, memory, model, and delivery files.

## Exact Current Slice

Start **HEY-142 governed multi-iteration runtime loop** while the context lane continues from
HEY-10.

Goal:

- Preserve the HEY-139 hardened fake-first proof and HEY-111 replay/evidence surface.
- Turn the current single observe/synthesise pass into a bounded `plan -> act -> observe` loop.
- Accumulate governor usage across all model/tool passes and stop deterministically on budget,
  kill, or no-progress outcomes.
- Keep trace/replay evidence readable enough to debug each iteration without storing prompts,
  raw health, provider bodies, credentials, or channel payloads.
- Revisit trace `event_key` granularity if repeated event types in one runtime state step become
  legitimate during iteration.

Out of scope for this iteration slice:

- Live provider calls, live API credentials, or provider-specific SDK adoption.
- Scribe memory writes or committed memory mutation.
- Production context/prompt hydration beyond the HEY-15/HEY-14/HEY-16 seams.
- Channel delivery and app feed integration.
- Multi-loop arbitration across simultaneous product loops.

Acceptance:

- Failing tests first for at least one multi-pass path, budget accumulation across passes,
  deterministic stop conditions, and replay evidence of each pass.
- Existing contracts and runtime tests still pass.
- `/check-contract`: runtime remains on contract-owned run states, model routes, tool schemas, and
  governor decisions.
- `/break-feature`: the PR must not imply production provider/channel/memory readiness.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue in `SLICE-3C-HANDOFF.md` awaits a founder placement call. |
| Scheduler Multiplexer | Complete through PR #28 | Codex/scheduler | Alarm pop, recurrence, retry, quarantine, stale-run wake proof. |
| Loop Governor Runtime | Complete through PR #27 | Codex/policy runtime | Deterministic admission, budget kill, stuck-loop guard. |
| Dispatcher + Hooks + ACL + Sanitiser | Complete through PR #33 | Codex/security runtime | HEY-77, HEY-12, and HEY-78 are merged; do not re-own this seam in HEY-17. |
| Context + Memory + Prompt Hydration | Fake-backed design now | Claude memory/context + Codex integration | Keep raw health out of DO/R2/prompts/logs. |
| LLMProvider + Routing + Eval | Complete fake-first with HEY-111 local evidence | Codex/eval | No live credentials; HEY-142 must reuse trace/replay evidence. |
| Channels + App Surfaces | Fake sinks now | Codex/channel + app team | Production delivery waits on outbox, feed/channel contracts, and explicit adapter work. |
| Auth/Data Plane/Adapters | Now | Claude/Supabase + Codex adapters | ADR-0066 ES256 Supabase issuer spike remains parallel. |
| Observability/Conformance | HEY-111 merged; extend in HEY-142 | Codex/infra | Trace event shape, replay fixture, local eval are available for fake-first loop proof. |

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
- Fake channel sink tests.
- Supabase ES256 staging spike.
- Live-chat/feed spike notes, without production implementation.

## Week Plan

Immediate plan:

1. Work from `origin/main` at or after `61eb3c7` (`HEY-111 add runtime evidence spine`, PR #39).
   HEY-139, HEY-10, and HEY-111 are merged.
2. Start HEY-142 on the runtime lane: governed multi-iteration `plan -> act -> observe` loop,
   using HEY-111 evidence for trace/replay assertions.
3. Continue the context lane from the HEY-10 schema root: HEY-15 recall-before-act, HEY-14 skill
   loader, and HEY-16 prompt builder. Full goal hydration still waits for HEY-144.
4. Keep live providers, Scribe runtime, memory writes, app feed, and live channels out
   unless explicitly re-scoped.

Next build step for the actual agent harness:

1. Build HEY-142 so one runtime can call the model, dispatch tools, observe results, and iterate
   under governor budgets instead of stopping after one pass.
2. Wire real context/recall/prompt/skill registry into `RunLoopDO` behind fake provider and fake
   delivery adapters.
3. Add Scribe proposal lifecycle after context/prompt hydration is testable and redaction proof is
   green.
4. Only then add HEY-143 opt-in live-provider dogfood with spend cap, kill switch, replay evidence, and no
   live channel delivery by default.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`.
They are useful for archaeology, not current planning. Do not use them as the active next-session
plan.
