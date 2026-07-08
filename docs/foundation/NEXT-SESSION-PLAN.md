# Next Session Plan - Harness Runtime SLICE-5 Build

Status: active entrypoint for the Waldo backend SLICE-5 scheduler/alarm multiplexer review and PR.
Date: 2026-07-08.
Baseline: SLICE-3a/HEY-120 merged in PR #21, SLICE-3b/HEY-121 merged in PR #23 at `f47127f`, and
SLICE-3c/HEY-124 merged in PR #24 at `5789b42`. HEY-122/SLICE-4 Loop Governor merged via PR #27;
`origin/main` is at or after `bef73fa`.

The durable delivery spine is real: journal/outbox resume is proven, the promoted `RunJournalOutbox`
interface owns the commit boundary, the DeliveryGate runtime enforces ADR-0068 policy state, and
the Loop Governor runtime seam is merged. The current local branch
`codex/hey-123-scheduler-alarm-multiplexer` implements SLICE-5/HEY-123; the next action is review,
PR preparation, and merge discipline. Do not start HEY-77, HEY-12, HEY-78, HEY-17, HEY-136, or later
runtime-lane work from this document until HEY-123 has been reviewed and merged.

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
  DeliveryGate, Loop Governor, and a local HEY-123 scheduler/alarm multiplexer implementation.
- SLICE-3a/HEY-120 is complete: PR #21 proved crash-after-send-before-ack resume without duplicate physical delivery in real `@cloudflare/vitest-pool-workers` tests.
- SLICE-3b/HEY-121 is complete: `RunJournalOutbox` exposes `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`, with durable read parsing and ack-key enforcement.
- SLICE-3c/HEY-124 is complete: the DeliveryGate runtime enforces ADR-0068 caps, budgets, cooldowns, sub-kind caps, held candidates, and gate reasons atomically inside the GATED commit. Acceptance residue (property tests, timezone state, quiet hours, Pro Max, race case) is listed in `SLICE-3C-HANDOFF.md` and awaits a founder placement call.
- HEY-122/SLICE-4 is complete and merged via PR #27.
- HEY-123/SLICE-5 is implemented locally on `codex/hey-123-scheduler-alarm-multiplexer`, pending
  review/PR/merge. It proves one Durable Object alarm entrypoint can dispatch due run resume,
  outbox retry, and scheduled proactive wake rows through durable schedule state.
- The current work is HEY-123 review and merge, not more broad contract expansion and not full
  product wiring.
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

Complete **SLICE-5/HEY-123: Scheduler/alarm multiplexer + wake proof**.

Goal:

- Preserve the single raw `setAlarm` owner in `packages/runtime/src/scheduler/alarm-slot.ts`.
- Use durable DO SQLite schedule rows as the system of record for logical wakes.
- Dispatch due run resume, outbox retry, and scheduled proactive wake rows from one `alarm()`
  entrypoint.
- Keep due-work ordering deterministic by schedule-kind priority, due time, and schedule id.
- Make duplicate alarm delivery idempotent: a completed one-shot row is gone, and terminal runs do
  not send again.
- Quarantine repeatedly failing product schedules durably; never quarantine durability kinds
  (`journal`, `handoff`).
- Keep schedule payloads to typed references only: ids/cursors, never prompt text, health values, or
  raw content.
- Use real `@cloudflare/vitest-pool-workers` helpers for alarm delivery and eviction proof.

Out of scope for SLICE-5:

- Full patrol cadence matrix.
- Dispatcher/tool runtime (HEY-78).
- Triage dispatcher entrypoint (HEY-77).
- Hook registry (HEY-12).
- Scribe memory runtime.
- Real LLM provider calls.
- Live APNs/Telegram/provider credentials.
- Live chat transport and app feed implementation.
- Full run-loop integration (HEY-136).

First PR shape:

```text
runtime: add scheduler alarm multiplexer
```

Acceptance:

- Failing tests first for the multiplexer behavior.
- One alarm dispatches due run resume, outbox retry, and scheduled proactive wake.
- Duplicate delivery after success is a no-op.
- Schedule state survives DO eviction.
- Lost due rows are picked up on the next in-scope wake.
- Product-kind repeated failure quarantines durably without wedging the alarm slot.
- Daily-local recurrence covers DST gap/repeated-hour behavior at the scheduler layer.
- Existing SLICE-3a/3b/3c/4 crash/resume, exactly-once, gate, and governor tests still pass.
- `npx -y pnpm@10.34.4 verify` and `git diff --check` pass.

## Async Pillars

| Pillar | Can start? | Main owner | Notes |
| --- | --- | --- | --- |
| Run Journal + Outbox | Complete through PR #23 | Codex/runtime | Preserve; expand only if a slice exposes a real gap. |
| DeliveryGate Runtime | Complete through PR #24 | Codex/runtime | Residue in `SLICE-3C-HANDOFF.md` awaits a placement call. |
| Scheduler Multiplexer | Local implementation pending review | Codex/scheduler | HEY-123/SLICE-5: alarm pop, recurrence, retry, quarantine, stale-run wake proof. Held-candidate wakeup + quiet-end re-admission policy remains later wiring. |
| Loop Governor Runtime | Complete through PR #27 | Codex/policy runtime | HEY-122/SLICE-4: deterministic admission, budget kill, stuck-loop guard. |
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

Immediate plan:

1. Review and PR HEY-123/SLICE-5 from `codex/hey-123-scheduler-alarm-multiplexer`.
2. Preserve the SLICE-3a/3b/3c/4 proofs while merging scheduler runtime state.
3. Run ADR-0066 ES256 Supabase issuer spike in parallel (HEY-125).
4. Start fake-first LLM routing/eval lane only if it avoids runtime files.
5. Start fake channel sink and Telegram ingress gate tests only against contracts/fakes.
6. Start trace/conformance artifact scaffold only if it does not take over runtime files from the
   HEY-123 writer.
7. Founder placement call on the HEY-124 acceptance residue (property tests · timezone state · quiet hours · Pro Max · race case).

After HEY-123 merge:

1. Begin HEY-77 triage dispatcher single entry.
2. Keep held-candidate quiet-end re-admission and full cadence matrix out of HEY-77 unless explicitly
   re-scoped.
3. Wire dispatcher/hooks/sanitiser around the invocation skeleton.
4. Keep memory/context fake-backed until the runtime loop can consume it safely.

## Archived Docs

Historical Phase A/B/D handoffs and old Codex review notes are under `docs/foundation/archive/`. They are useful for archaeology, not current planning. Do not use them as the active next-session plan.
