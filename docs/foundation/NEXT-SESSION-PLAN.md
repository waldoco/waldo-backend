# Next Session Plan - Harness Runtime HEY-17 Review

Status: active entrypoint for HEY-17 draft PR #34 review and HEY-136 prep after merge.
Date: 2026-07-09 IST.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at
`f47127f`, SLICE-3c/HEY-124 merged in PR #24 at `5789b42`, HEY-122/SLICE-4 merged in
PR #27, HEY-123/SLICE-5 merged in PR #28 at `061e72c`, HEY-77 triage dispatcher merged
in PR #29 at `a947600`, HEY-12 hook registry merged in PR #31 at `1b180ef`, and HEY-78
ToolDispatcher + per-trigger ACL enforcement merged in PR #33 at `600fb34`.

HEY-17 is the current runtime-lane unit in draft PR #34 on branch
`codex/hey-17-llmprovider-routing`. It
adds the fake-first LLMProvider routing seam behind contract-owned model routes and Cloudflare AI
Gateway request policy. HEY-136 must not start until HEY-17 is accepted or merged.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
4. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
5. `docs/foundation/BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. `docs/foundation/FOUNDATION-HANDOVER.md`
8. The Waldo Brain source files listed in the runtime build plan for the seam being reviewed.

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
  multiplexer, triage dispatcher, hook registry, and ToolDispatcher/ACL runtime.
- HEY-17 is intentionally fake-first: it proves contract-owned model route selection, gateway
  request shaping, fallback, circuit behavior, spend-cap degradation, template fallback, hook
  composition, and metering-only return data without live provider credentials or calls.
- Split work by runtime seam, not by product pillar. Brief, Fetch, Spots, and Chat all converge on
  the same DO loop, journal, scheduler, dispatcher, memory, model, and delivery files.

## Exact Current Slice

Review and finish **HEY-17: LLMProvider via CF AI Gateway, fake-first**.

Goal:

- One runtime LLMProvider seam selects a `ModelRoute` from `packages/contracts`.
- Provider/model swaps are data-driven through the routing policy, not scattered conditionals.
- Gateway calls receive constant Cloudflare AI Gateway safety headers, especially
  `cf-aig-collect-log-payload:false`.
- Fallback order is deterministic: configured model full context, configured model reduced
  context, gateway fallback chain reduced context, then floor behavior.
- Spend-cap degradation is logged as budget state, not injection or provider failure.
- Circuit breakers are provider-scoped and cool down without taking every provider dark.
- Post-LLM hooks gate and sanitise generated text before it becomes tool-call source text.
- Output contains metering and bounded model text only; it does not persist prompts, raw health, or
  live provider payloads.

Out of scope for HEY-17:

- Full run-loop integration (HEY-136).
- Live provider calls, live API credentials, or provider-specific SDK adoption.
- Scribe memory writes or committed memory mutation.
- Context/prompt hydration beyond caller-injected request rendering.
- Tool execution, already owned by HEY-78.
- Channel delivery and app feed integration.

Acceptance:

- Failing tests first for route selection, provider swaps through config, gateway headers, fallback
  order, circuit cooldown, template floor, spend-cap degradation, and PostLLMCall safety.
- Existing contracts and runtime tests still pass.
- `/check-contract`: runtime imports and parses contract-owned schemas instead of duplicating model
  route or LLM response shapes.
- `/break-feature`: happy, null/malformed, hostile, concurrent, and degraded cases are covered or
  explicitly recorded as residual risk.
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
| LLMProvider + Routing + Eval | HEY-17 current | Codex/eval | Fake-first provider and route tests; no live credentials. |
| Channels + App Surfaces | Fake sinks now | Codex/channel + app team | Production delivery waits on outbox and HEY-136. |
| Auth/Data Plane/Adapters | Now | Claude/Supabase + Codex adapters | ADR-0066 ES256 Supabase issuer spike remains parallel. |
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
- Fake channel sink tests.
- Supabase ES256 staging spike.
- Live-chat/feed spike notes, without production implementation.

## Week Plan

Immediate plan:

1. Review draft PR #34 for the HEY-17 LLMProvider routing seam.
2. Confirm validation remains green: runtime `llm-provider` tests, workspace typecheck,
   `npx -y pnpm@10.34.4 verify`, `git diff --check`, check-contract, and break-feature.
3. Keep HEY-136, Scribe runtime, memory/context hydration, live providers, and live channels out
   unless explicitly re-scoped.
4. After HEY-17 is accepted or merged, begin HEY-136 SLICE-6 run-loop integration.

After HEY-17 merge:

1. Begin HEY-136 with fake LLM/context/channel seams only.
2. Preserve HEY-17 as the model-routing seam; do not inline provider logic into the run loop.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`.
They are useful for archaeology, not current planning. Do not use them as the active next-session
plan.
