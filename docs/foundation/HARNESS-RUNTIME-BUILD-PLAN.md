# Harness Runtime Build Plan

Status: active planning source for the next Waldo backend runtime build.
Date: 2026-07-07.
Purpose: convert Waldo Brain's final harness architecture and the backend contract-spine audit into an assignable runtime build plan.

## Source Map

GitHub links are the canonical collaborator source links. If a local companion
checkout exists at `../waldo-brain`, use the same repo-relative paths locally for
fast grep and source reading.

Primary Waldo Brain sources:

| Source | Why it matters |
| --- | --- |
| [01-Waldo/planning/WALDO_ARCHITECTURE_OVERVIEW.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/planning/WALDO_ARCHITECTURE_OVERVIEW.md) | Canonical architecture summary; Waldo is a persistent general-purpose agent, not only a wellness feature. |
| [01-Waldo/planning/WALDO_AGENTIC_HARNESS_LAYER_MAP.md](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/planning/WALDO_AGENTIC_HARNESS_LAYER_MAP.md) | Layer map for runtime, context, memory, tools, safety, model fabric, evals, and delivery. |
| [04-Agent-Harness/harness-final-build-image-2026-06-27.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/harness-final-build-image-2026-06-27.md) | Most concrete final build image: per-user DO, Loop Governor, run journal, DeliveryGate, Scribe, memory, tools, evals. |
| [04-Agent-Harness/harness-runtime-architecture-decided-vs-gap.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/harness-runtime-architecture-decided-vs-gap.md) | Settled-vs-open runtime map; says architecture is no longer open design, execution is the gap. |
| [04-Agent-Harness/harness-finalization-blockers-2026-06-28.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/harness-finalization-blockers-2026-06-28.md) | Remaining Agent-Ready blockers: proof gates, privacy/deletion, live chat, app feed, Google verification. |
| [04-Agent-Harness/agent-harness-build-readiness-consolidation-2026-06-26.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/agent-harness-build-readiness-consolidation-2026-06-26.md) | Build-ready control plane: Loop Governor, Think adapter caution, conformance suite. |
| [04-Agent-Harness/loop-governor-restructure.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/loop-governor-restructure.md) | Deterministic loop-governance rationale: priority, budgets, kill, no-progress, Art-9 egress floor. |
| [04-Agent-Harness/state-of-the-art-memory-system-2026-06-26.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/state-of-the-art-memory-system-2026-06-26.md) | Memory control-plane updates: memory_class, prospective intents, procedural split, retrieval gateway, evals. |
| [04-Agent-Harness/harness-devx-teardown-2026-06-29.md](https://github.com/Pin4sf/waldo-brain/blob/main/04-Agent-Harness/harness-devx-teardown-2026-06-29.md) | DevX and observability plan: journal is the trajectory; emit one event per transition. |
| [01-Waldo/WALDO_HARNESS_DEEPWIKI.html](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/WALDO_HARNESS_DEEPWIKI.html) | Generated build bible and module atlas; useful as a source map, not higher authority than accepted ADRs. |

Primary backend sources:

| Source | Why it matters |
| --- | --- |
| `docs/foundation/FOUNDATION-HANDOVER.md` | Current done-vs-unbuilt map and single-writer rules. |
| `docs/foundation/BUILD-PLAN.md` | Contract-spine build order and current runtime dependency layer. |
| `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md` | Verification wall and runtime/evidence testing standard. |
| `docs/foundation/AGENT-OPERATING-WORKFLOW.md` | Session loop, skill map, plugin boundaries, and verification wall. |
| `packages/contracts/src/index.ts` | Barrel for the implemented contract spine. |
| `packages/runtime/src/tracer/tracer-do.ts` | Only executing runtime slice today. |
| `packages/runtime/test/tracer.test.ts` | Workerd crash/resume proof for the tracer path. |

Research inputs used:

- Read-only Brain-intent subagent: final harness goal, source map, runtime components, non-negotiables.
- Read-only backend-state subagent: contract spine vs skeletal runtime audit, missing surfaces, first next slice.
- Read-only pillar-decomposition subagent: async runtime seam split, dependencies, collision risk.

## Final Harness Goal

Waldo's V1 harness should become a first-party, persistent, body-and-life-aware agent runtime:

1. One per-user Cloudflare Durable Object owns the hot runtime brain.
2. Schedules, app events, Telegram/app messages, and future channel events enter through authenticated Worker routes or DO alarms.
3. A deterministic Loop Governor admits, drops, holds, degrades, or kills work before any model loop.
4. A durable run journal records each transition so crashes and hibernation resume from committed state.
5. Context is built from derived body state, recall, R2 workspace files, working memory, skills, thread/channel hints, and REASONS prompt layers.
6. Models route behind `LLMProvider` policy and fake-first adapters.
7. Typed tools execute under trigger ACL, taint, approval, autonomy, and sanitiser gates.
8. Memory writes go through Scribe/proposal paths; committed memory is never written directly by the LLM.
9. Delivery passes through DeliveryGate and an idempotent transactional outbox.
10. Verification is a layer: trace, conformance, eval, replay, redaction, privacy, and deletion proof.

V1 product proof runs through Brief, shadow Fetch, Pre-Activity Spots, and Chat. The runtime should be horizontal enough that later verticals swap tools, policies, skills, and prompts without replacing the harness.

## Non-Negotiables

- Runtime is DO-only; no L1 invoke-agent Edge Function owns agent execution.
- Raw health data stays in Supabase. DO/R2/logs/prompts/public API/Telegram receive only derived or redacted forms.
- Sessions never resume. Authorization, canaries, pending approvals, and tool permissions reset on every wake. Runs may resume from the journal.
- Loop Governor is deterministic and outside the LLM.
- Tools derive from typed contracts and per-trigger permissions. Fixed prose tool counts are stale.
- `execute_code`, browser use, and image analysis are not V1 runtime powers.
- MCP is a narrow client escape hatch, not the integration layer. Waldo-as-MCP-server is deferred.
- Cloudflare Agents SDK/Think can be studied or spiked as plumbing, not adopted as the owner of Waldo's trust, memory, or side-effect idempotency boundary.

## Current Backend Reality

Built:

- Contract spine across core, runtime, tools, memory, prompt, model, adapters, auth, telemetry, public DTO/OpenAPI, and evidence lanes.
- Workers/DO test substrate with `@cloudflare/vitest-pool-workers`.
- One scheduled `fetch_alert` tracer path proving `DO alarm -> Governor -> journal -> DeliveryGate -> outbox -> fake sink -> DONE`.
- SLICE-3a/HEY-120 durable outbox proof: crash after sink send and before local ack resumes across DO eviction without duplicate physical delivery, with an explicit idempotent sink contract.
- SLICE-3b/HEY-121 landed in PR #23 at `f47127f`: journal/outbox behavior is promoted into `RunJournalOutbox` with
  `startRun`, `tickRun`, `resumeRun`, `enqueueOutbox`, and `flushOutbox`.
- Static guard wall and pinned verification command.

Not built:

- Full run FSM runtime.
- Durable multi-kind DeliveryGate/outbox flusher and retry exhaustion policy.
- Scheduler multiplexer.
- Loop Governor runtime enforcement.
- Dispatcher/tool runtime.
- Scribe/sanitiser runtime placement.
- Context builder/prompt hydration runtime.
- LLM provider runtime.
- Real channel sinks, Telegram ingress, app feed, live chat.
- Scenario/property/mutation/live evidence runners.

## Build Strategy

Split by runtime seam, not product feature. Product features should wait until the shared spine exists because Brief, Fetch, Spots, and Chat all need the same DO loop, journal, scheduler, dispatcher, memory, model, and delivery seams.

### Pillars

| # | Pillar | Scope | Can start | Verification | Collision risk |
| --- | --- | --- | --- | --- | --- |
| 1 | Run Journal + Outbox | Durable run FSM, transactional outbox, retry/ack, exactly-once delivery. | Now | Workerd eviction/crash tests; duplicate-send tests. | High |
| 2 | DeliveryGate Runtime | Budget, cooldown, held candidates, `GATED` step, class policy. | After Pillar 1 transaction shape | Property tests for day boundaries, cooldowns, exempt-but-counted behavior. | Medium-high |
| 3 | Scheduler Multiplexer | Single alarm slot, seven schedule kinds, recurrence, watchdog/liveness. | Design now; runtime after Pillar 1 | DST/recurrence/lost-alarm tests; `setAlarm` guard stays green. | High |
| 4 | Loop Governor Runtime | Priority, budgets, kill, dedup, no-progress, Art-9 floor. | Comparator tests now | Fetch-over-Brief, budget kill, stuck-loop, health egress tests. | Medium-high |
| 5 | Dispatcher + Hooks + ACL + Sanitiser | Hook runner, session reset, typed dispatcher, taint provenance, sanitiser placement. | Isolated tests now | Prompt-injection fixtures, ACL denial, canary/health leak tests. | High |
| 6 | Context + Memory + Prompt Hydration | Recall, Scribe write path, REASONS builder, goals, skills, working memory. | Fake-backed design now | Recall fail-open tests, prompt fencing, no raw-health persistence. | High |
| 7 | LLMProvider + Routing + Eval | Fake-first provider, routing, fallback, shadow eval. | Now | Model roster guard, fallback tests, trace assertions. | Low-medium |
| 8 | Channels + App Surfaces | Fake APNs/Telegram sinks, Telegram gate tests, live-chat/feed spike. | Fake sinks now | Secret-header tests, update dedupe, no health logs. | Medium-high |
| 9 | Auth/Data Plane/Adapters | ES256 Supabase issuer, `db.forUser`, Vault OAuth, provider adapters. | Now | RLS cross-tenant tests, token expiry, no service-role in DO. | High in migrations/EFs |
| 10 | Observability/Conformance | Trace event shape, scenario artifacts, replay/eval scaffolding. | Now | Scenario replay, property seeds, mutation reports, redaction checks. | Low |

## Completed Runtime Slices

**SLICE-3a/HEY-120: durable DeliveryGate/outbox proof** landed in PR #21.

The PR proved exactly-once delivery at the durable layer, not only exactly-once enqueue and not only process-local fake-sink dedupe.

Proof covered:

- Start a run.
- Commit the outbox intent.
- Simulate sink send.
- Crash before ack is recorded.
- Evict/reconstruct the Durable Object.
- Resume.
- Assert the side effect is not delivered twice.
- Assert durable state records the ack/retry outcome.
- Assert the sink declares idempotency by key and the fake cannot hide re-key bugs.

**SLICE-3b/HEY-121: promoted journal/outbox runtime interface** landed in PR #23 at `f47127f`.

The slice promoted the tracer-proven behavior behind `RunJournalOutbox`, preserves the SLICE-3a
exactly-once delivery proof, adds Workers tests for the promoted interface across eviction, and
enforces durable row parsing plus sink request/ack parsing at the runtime seam.

**SLICE-3c/HEY-124: DeliveryGate runtime policy state** landed in PR #24 at `5789b42`.

The slice promoted ADR-0068 policy state onto the promoted journal/outbox seam: per-class daily
caps, counted APNs budget keyed by local date, exempt-but-counted telemetry, event-scoped
cooldowns, adjustment sub-kind caps, held-candidate freeze plus a callable `releaseHeld`, a closed
`gate_reason` vocabulary on every non-send verdict, and DO-local schema migration — with the GATED
commit atomic and the SLICE-3a/3b proofs preserved. Verify green at merge: contracts 1,163 /
runtime 46 / 10 guards.

Acceptance residue from HEY-124 (details in `SLICE-3C-HANDOFF.md`): the fast-check property tests
named in the acceptance bar were not written (example-based coverage only); day boundaries use the
UTC fallback because user timezone state does not exist yet; quiet-hours runtime and `sync_error`
`exempt_after_h` escalation wait on user-settings and scheduler slices; the Pro Max tier case and
the last-budget-slot race case are untested.

Remaining after PR #24: multi-kind outbox flusher, retry exhaustion policy, notification-log
mirror, full FSM expansion, scheduler multiplexer, Loop Governor runtime, dispatcher, Scribe
runtime, and live provider/channel integration.

## Next Slice

Build **SLICE-4/HEY-122: Loop Governor deterministic gate** (ADR-0074).

The governor decides whether a loop may execute; DeliveryGate remains the separate module that
decides whether a candidate sends. Consume `packages/contracts/src/runtime/loop-policy.ts`
(`LOOP_POLICIES`, `lookupLoopPolicy`, `admit`) — do not invent runtime policy constants. The
tracer's reduced `GOVERNOR_ADMITTED` admission is the seam this slice makes real.

Required first failing test:

- Drive a loop admission decision through runtime code consuming the loop-policy contract.
- Assert allowed, held, and blocked loop decisions are deterministic and outside the LLM —
  including Fetch-over-Brief priority, budget kill, and stuck-loop cases.
- Assert governor state survives eviction: a killed run stays killed on resume.
- Assert no budget decrement or outbox insert occurs inside the governor module.
- Assert existing SLICE-3a/3b/3c eviction, exactly-once, and gate tests still pass.

Review carry-forward from SLICE-3a/3b/3c:

- Promote only production-shaped code; leave crash knobs and fixture helpers in tests.
- The Art-9 egress floor reuses `RAW_SENSOR_PATTERNS` from `packages/contracts/src/memory/sanitise.ts`;
  do not declare another copy.
- Keep `enqueueOutbox` as the gate-owned commit boundary; the governor never reaches the outbox.
- Date-scoped counters and cross-date cooldown timestamps have different storage semantics; keep
  them separate (SLICE-3c lesson).

## Parallel Assignment Packet

Use this template for each developer/agent assignment:

```text
Owner:
Pillar:
Primary sources:
Files owned:
Out-of-scope files:
Runtime invariant:
First failing test:
Verification command:
Merge dependency:
```

## What To Grill Next

Before coding SLICE-4, grill these decisions:

1. What is the smallest Loop Governor runtime state that proves ADR-0074 without the scheduler or
   the full run FSM?
2. Where do `loop_progress` rows live and what exactly does the cross-run no-progress guard
   (`isStuck`) read?
3. How does the governor hand off to DeliveryGate without sharing state or transaction scope?
4. Which malformed loop-policy or progress rows fail closed before a loop executes?
5. Where does the HEY-124 acceptance residue land: a hardening slice, or folded into SLICE-4/5
   scopes (property tests · timezone state · quiet hours · Pro Max · race case)?
6. Which files are single-writer for HEY-122, and which fake-eval/channel tasks can run in parallel
   without touching them?
