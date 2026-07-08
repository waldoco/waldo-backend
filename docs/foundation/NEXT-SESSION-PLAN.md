# Next Session Plan - Harness Runtime HEY-78 Review

Status: active entrypoint for HEY-78 draft PR review and HEY-17 prep after merge.
Date: 2026-07-08.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at `f47127f`, and
SLICE-3c/HEY-124 merged in PR #24 at `5789b42`. HEY-122/SLICE-4 Loop Governor merged via PR #27;
HEY-123/SLICE-5 scheduler/alarm multiplexer merged via PR #28 at `061e72c`; HEY-77 triage
dispatcher merged via PR #29 at `a947600`; HEY-12 hook registry merged via PR #31 at `1b180ef`.
HEY-78 ToolDispatcher + per-trigger ACL enforcement is open as draft PR #33 on branch
`codex/hey-78-tooldispatcher-acl`.

The durable delivery spine is real: journal/outbox resume is proven, the promoted `RunJournalOutbox`
interface owns the commit boundary, the DeliveryGate runtime enforces ADR-0068 policy state, and
the Loop Governor runtime seam is merged. The scheduler/alarm multiplexer, triage dispatcher, and
hook registry are merged; the current runtime-lane unit is HEY-78 review. Keep HEY-17, HEY-136,
Scribe runtime, memory writes, live providers, and channel delivery out of PR #33.

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
- The backend runtime is still incomplete, but the runtime spine now includes journal/outbox,
  DeliveryGate, Loop Governor, the HEY-123 scheduler/alarm multiplexer, HEY-77 triage dispatcher,
  and HEY-12 hook registry.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- SLICE-3b/HEY-121 is complete: `RunJournalOutbox` exposes `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`, with durable read parsing and ack-key enforcement.
- SLICE-3c/HEY-124 is complete: the DeliveryGate runtime enforces ADR-0068 caps, budgets, cooldowns, sub-kind caps, held candidates, and gate reasons atomically inside the GATED commit. Acceptance residue (property tests, timezone state, quiet hours, Pro Max, race case) is listed in `SLICE-3C-HANDOFF.md` and awaits a founder placement call.
- HEY-122/SLICE-4 is complete and merged via PR #27.
- HEY-123/SLICE-5 is complete and merged via PR #28. It proves one Durable Object alarm entrypoint
  can dispatch due run resume, outbox retry, and scheduled proactive wake rows through durable
  schedule state.
- HEY-77 is complete and merged via PR #29 at `a947600`: incoming wake envelopes classify from
  authenticated envelope metadata to a canonical `TriggerType` or typed rejection.
- HEY-12 is complete and merged via PR #31 at `1b180ef`: the deterministic hook registry, timeout
  halts, session reset, ACL/schema/autonomy/taint/egress/Scribe/canary/medical hook seams, and
  payload/context isolation exist behind `packages/runtime/src/hooks/registry.ts`.
- HEY-78 is in draft PR #33: a ToolDispatcher runtime seam consumes provider-shaped tool calls,
  validates against contract-owned schemas, enforces per-trigger ACL and hook gates, invokes typed
  handlers, and returns bounded/sanitised tool results.
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

Review and merge **HEY-78: ToolDispatcher + per-trigger ACL enforcement** in draft PR #33.

Goal:

- One `dispatchTool(call, ctx)` runtime seam parses provider-shaped tool calls into the
  contract-owned tool name + args surface.
- Tool args validate against the existing Zod schemas from `packages/contracts/src/tools/schemas/*`.
- The dispatcher enforces `TOOL_PERMISSIONS[ctx.session.trigger]` and composes with the HEY-12
  `PreToolUse` / `PostToolUse` hooks instead of duplicating safety law.
- Tool handlers are typed and injected; HEY-78 may use fake handlers but must not implement the full
  live adapter/provider surface.
- Tool results are bounded and pass through the hook/sanitise seam before returning to the loop.

Out of scope for HEY-78:

- Hook registry design changes beyond consuming HEY-12 exports.
- Full Scribe memory runtime and memory writes.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.
- Full run-loop integration (HEY-136).
- New tool contract names or trigger values unless the contract package changes in the same reviewed
  slice.

First PR shape:

```text
runtime: add tool dispatcher acl
```

Acceptance:

- Failing tests first for parser, ACL deny, schema deny, handler success, handler failure, taint /
  approval deny, sanitise deny, and unknown tool rejection.
- A tool outside `ctx.session.tool_permissions` is denied before handler execution.
- Invalid args fail before handler execution.
- `search_connector` remains fail-closed unless a contract-owned schema lands.
- Privileged tools route through the existing autonomy/taint gate semantics.
- Existing SLICE-3a/3b/3c/4/5, HEY-77, and HEY-12 tests still pass.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue in `SLICE-3C-HANDOFF.md` awaits a placement call. |
| Scheduler Multiplexer | Complete through PR #28 | Codex/scheduler | HEY-123/SLICE-5: alarm pop, recurrence, retry, quarantine, stale-run wake proof. Held-candidate wakeup + quiet-end re-admission policy remains later wiring. |
| Loop Governor Runtime | Complete through PR #27 | Codex/policy runtime | HEY-122/SLICE-4: deterministic admission, budget kill, stuck-loop guard. |
| Dispatcher + Hooks + ACL + Sanitiser | HEY-78 draft PR #33 | Codex/security runtime | HEY-77 triage and HEY-12 hook registry are merged. HEY-78 owns ToolDispatcher + per-trigger ACL integration only. |
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

1. Review draft PR #33 for HEY-78.
2. Confirm the required validation remains green: runtime `tool` / `dispatcher` filters,
   workspace typecheck, `npx -y pnpm@10.34.4 verify`, `git diff --check`, check-contract, and
   break-feature.
3. Keep HEY-17, HEY-136, Scribe runtime, memory/context hydration, live providers, and live
   channels out unless explicitly re-scoped.
4. After PR #33 merges, begin HEY-17 LLMProvider via CF AI Gateway, fake-first.
5. Founder placement call on the HEY-124 acceptance residue (property tests · timezone state · quiet hours · Pro Max · race case).

After HEY-78 merge:

1. Begin HEY-17 LLMProvider via CF AI Gateway, fake-first.
2. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
