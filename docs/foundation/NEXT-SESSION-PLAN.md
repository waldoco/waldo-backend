# Next Session Plan - HEY-143 To Agent Harness Alpha

Status: HEY-143 provider-readiness hardening is implemented on
`codex/hey-143-provider-readiness` and awaiting PR review. Full real-provider flip and alpha
acceptance remain blocked by safety, spend, credential, context, and channel prerequisites.
Date: 2026-07-10 IST.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at
`f47127f`, SLICE-3c/HEY-124 merged in PR #24 at `5789b42`, HEY-122/SLICE-4 merged in
PR #27, HEY-123/SLICE-5 merged in PR #28 at `061e72c`, HEY-77 triage dispatcher merged
in PR #29 at `a947600`, HEY-12 hook registry merged in PR #31 at `1b180ef`, and HEY-78
ToolDispatcher + per-trigger ACL enforcement merged in PR #33 at `600fb34`. HEY-17 merged in
PR #34 at `0aae766`; HEY-136 merged in PR #35 at `3d336c7`; HEY-139 merged in PR #38 at
`b736470`; HEY-10 merged in PR #37 at `7980aad`; HEY-111 merged in PR #39 at `61eb3c7`;
HEY-142 merged in PR #42 at `d896500`.

HEY-136 proved the fake-first run-loop skeleton. HEY-139 hardened the runtime driver, HEY-10 landed
the context schema root, HEY-111 added replayable local evidence, and HEY-142 added the fake-first
governed multi-iteration `plan -> act -> observe` loop. HEY-143 now owns real-provider flip
readiness.

## HEY-143 Review State

[observed] The review branch moves fake adapters and permissive callbacks behind explicit
configuration, adds a metadata-only Cloudflare gateway adapter, requires a Secrets Store-style
credential binding, sanitises before provider egress, and fails closed for absent spend state or
non-local ingress.

[verified] `npx -y pnpm@10.34.4 verify` passed with 1,168 contract tests, 182 runtime tests, and
all guards. `git diff --check` passed. No live provider, credential, channel, Cloudflare, or
Supabase side effect occurred.

[blocked] A real gateway RunLoop call remains disabled until HEY-13 provides the safety callbacks,
HEY-99 provides an auditable daily-spend reader, and a Cloudflare Secrets Store binding plus
explicit staging-smoke approval exist. See `docs/foundation/HEY-143-PHASE-HANDOFF.md`.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. `docs/foundation/HEY-142-PHASE-HANDOFF.md`
8. `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md` when touching DO SQLite context schema scope.
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
  LLMProvider routing, fake-first `RunLoopDO`, replay/evidence, and a governed multi-iteration
  model/tool/observe loop.
- HEY-136 is intentionally fake-first: it proves loop anatomy and durable resume, not production
  provider/channel/memory behavior.
- HEY-142 is still fake-first. It does not prove production provider, channel, context, memory, or
  live health-data behavior.
- HEY-143 may prepare real-provider readiness, but live channel delivery, Scribe writes, and raw
  health/private data remain out of scope unless explicitly re-scoped with staging safeguards.
- Split work by runtime seam, not by product pillar. Brief, Fetch, Spots, and Chat all converge on
  the same DO loop, journal, scheduler, dispatcher, memory, model, and delivery files.

## Exact Current Slice

Review **HEY-143 provider-readiness hardening** while the context lane continues from HEY-10.

Goal:

- Preserve the HEY-142 fake-first multi-iteration loop and HEY-111 replay/evidence surface.
- Make the provider flip safe to test behind explicit staging-only configuration, spend limits,
  kill switches, and fake-first defaults.
- Prove provider response/error parsing at the adapter seam without storing prompts, raw health,
  provider bodies, credentials, or channel payloads.
- Keep live channel delivery, committed Scribe memory writes, and production Cloudflare/Supabase
  side effects out of the default verification path.
- Carry forward the HEY-142 P3 notes: iteration-cap semantics are explicit today, and future real
  tools need semantic observation canonicalizers for duplicate/no-progress detection.

Out of scope for this iteration slice unless explicitly re-scoped:

- Production live-provider calls or unmanaged API credentials.
- Scribe memory writes or committed memory mutation.
- Production context/prompt hydration beyond the HEY-15/HEY-14/HEY-16 seams.
- Channel delivery and app feed integration.
- Multi-loop arbitration across simultaneous product loops.

Acceptance:

- Failing tests first for provider adapter readiness, response/error classification, spend-cap or
  kill-switch behavior before live calls, and replay evidence privacy.
- Fake-first local runtime tests still pass, including HEY-142 multi-pass loop coverage.
- Existing contracts and runtime tests still pass.
- `/check-contract`: runtime remains on contract-owned run states, model routes, tool schemas, and
  governor decisions.
- `/break-feature`: the PR must not imply production channel/memory readiness or uncontrolled live
  provider use.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue is archived in `docs/foundation/archive/SLICE-3C-HANDOFF.md`; do not use it as a current plan. |
| Scheduler Multiplexer | Complete through PR #28 | Codex/scheduler | Alarm pop, recurrence, retry, quarantine, stale-run wake proof. |
| Loop Governor Runtime | Complete through PR #27 | Codex/policy runtime | Deterministic admission, budget kill, stuck-loop guard. |
| Dispatcher + Hooks + ACL + Sanitiser | Complete through PR #33 | Codex/security runtime | HEY-77, HEY-12, and HEY-78 are merged; do not re-own this seam in HEY-17. |
| Context + Memory + Prompt Hydration | Fake-backed design now | Claude memory/context + Codex integration | Keep raw health out of DO/R2/prompts/logs. |
| LLMProvider + Routing + Eval | HEY-143 hardening in review | Codex/eval | Live provider remains fail-closed pending HEY-13, HEY-99 spend data, Secrets Store binding, and approved staging smoke. |
| Channels + App Surfaces | Fake sinks now | Codex/channel + app team | Production delivery waits on outbox, feed/channel contracts, and explicit adapter work. |
| Auth/Data Plane/Adapters | Now | Claude/Supabase + Codex adapters | ADR-0066 ES256 Supabase issuer spike remains parallel. |
| Observability/Conformance | HEY-111 merged; HEY-142 reused it | Codex/infra | Trace event shape, replay fixture, and local eval are available for fake-first loop proof; standalone eval suite is still absent. |

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

1. Work from `origin/main` at or after `d896500` (`HEY-142 governed runtime loop`, PR #42).
2. Start HEY-143 on the runtime lane: real-provider flip readiness, keeping fake-first defaults and
   staging-only live-provider safeguards.
3. Continue the context lane from the HEY-10 schema root: HEY-15 recall-before-act, HEY-14 skill
   loader, and HEY-16 prompt builder. Full goal hydration still waits for HEY-144.
4. Keep live providers, Scribe runtime, memory writes, app feed, and live channels out
   unless explicitly re-scoped.

Next build step for the actual agent harness:

1. Build HEY-143 so the fake-first multi-iteration loop can be prepared for real-provider dogfood
   without uncontrolled credentials, spend, provider logs, or channel side effects.
2. Wire real context/recall/prompt/skill registry into `RunLoopDO` behind fake provider and fake
   delivery adapters.
3. Add Scribe proposal lifecycle after context/prompt hydration is testable and redaction proof is
   green.
4. Keep opt-in live-provider dogfood behind spend cap, kill switch, replay evidence privacy, and no
   live channel delivery by default.

## Archived Docs

Historical phase handoffs, old build plans, and benchmark reports are under `docs/foundation/archive/`.
They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
