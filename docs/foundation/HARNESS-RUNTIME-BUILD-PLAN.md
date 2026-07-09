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
| `docs/foundation/CONTRIBUTOR-ONBOARDING.md` | Short path for new contributors and lane ownership. |
| `docs/foundation/NEXT-SESSION-PLAN.md` | Current HEY-142 entrypoint and acceptance bar. |
| `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md` | Verification wall and runtime/evidence testing standard. |
| `docs/foundation/AGENT-OPERATING-WORKFLOW.md` | Session loop, skill map, plugin boundaries, and verification wall. |
| `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md` | HEY-10 deferred DO table coverage: ADR/Linear ownership for goals, memory edges, commitments, handoff state, and compaction. |
| `docs/foundation/HEY-111-EVIDENCE-SPINE.md` | Merged fake-first replay/evidence surface that HEY-142 must reuse. |
| `packages/contracts/src/index.ts` | Barrel for the implemented contract spine. |
| `packages/runtime/src/run-loop/do.ts` | Fake-first hardened runtime driver. |
| `packages/runtime/test/run-loop.test.ts` | Current runtime proof and replay/evidence assertions. |

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
- HEY-122/SLICE-4 Loop Governor runtime enforcement landed in PR #27.
- HEY-123/SLICE-5 scheduler/alarm multiplexer landed in PR #28 at `061e72c`.
- HEY-77 triage dispatcher landed in PR #29 at `a947600`.
- HEY-12 hook registry landed in PR #31 at `1b180ef`.
- HEY-78 ToolDispatcher + per-trigger ACL enforcement landed in PR #33 at `600fb34`.
- HEY-17 LLMProvider routing seam landed in PR #34 at `0aae766`, fake-first and contract-owned.
- HEY-136 fake-first `RunLoopDO` integration landed in PR #35 at `3d336c7`.
- HEY-139 runtime driver hardening landed in PR #38 at `b736470`.
- HEY-10 DO SQLite context schema root landed in PR #37 at `7980aad`.
- HEY-111 runtime evidence spine landed in PR #39 at `61eb3c7`.
- Static guard wall and pinned verification command.

Not built:

- Governed multi-iteration `plan -> act -> observe` loop; HEY-142 owns this next runtime slice.
- Production context builder, recall-before-act, skill loading, and prompt hydration; HEY-15/HEY-14/HEY-16 own this lane.
- Scribe/sanitiser runtime and committed-memory proposal lifecycle beyond injected hook callbacks.
- Multi-kind production channel delivery and app feed surfaces.
- Live provider calls, real channel sinks, Telegram ingress, app feed, live chat.
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

Acceptance residue from HEY-124 is archived in
`docs/foundation/archive/SLICE-3C-HANDOFF.md`. Do not use that handoff as the current slice plan.

Remaining after HEY-139/HEY-111: governed iteration, production context/prompt hydration, Scribe
proposal lifecycle, multi-kind production delivery, app/channel surfaces, and real-provider flip
readiness.

## Next Slice

Build **HEY-142: governed multi-iteration `plan -> act -> observe` loop**.

HEY-142 must keep the fake-first safety boundary while making the runtime loop honest: the model can
plan, tools can run, observations can feed the next model pass, and governor budgets/kill/no-progress
conditions bound the loop. It must reuse HEY-111 evidence instead of inventing a parallel trace path.

Required first failing test:

- At least one run performs multiple model/tool/observe passes before terminal gate/outbox.
- Governor usage accumulates across every LLM pass and stops deterministically at budget.
- Replay evidence shows each pass without prompt bodies, raw health, provider bodies, credentials,
  or channel payloads.
- Trace `event_key` granularity is revised if repeated event types within one runtime state step are
  legitimate.
- Prove fallback order: configured model full context, configured model reduced context, gateway
  fallback chain, then route floor behavior.
- Prove circuit breaker scope/cooldown, spend-cap degradation, template fallback, and PostLLMCall
  sanitise/halt behavior.
- Assert existing SLICE-3a/3b/3c/4/5, HEY-77, and HEY-12 tests still pass.

Review carry-forward from SLICE-3a/3b/3c/4:

- Promote only production-shaped code; leave crash knobs and fixture helpers in tests.
- The Art-9 egress floor reuses `RAW_SENSOR_PATTERNS` from `packages/contracts/src/memory/sanitise.ts`;
  do not declare another copy.
- Keep `enqueueOutbox` as the gate-owned commit boundary; the governor never reaches the outbox.
- Date-scoped counters and cross-date cooldown timestamps have different storage semantics; keep
  them separate (SLICE-3c lesson).
- Keep HEY-136, Scribe runtime writes, memory/context hydration, live provider calls, and live
  channel delivery out of the LLMProvider PR.

## Slice Ladder To First Agent Run

Finalized 2026-07-08 (founder-directed). The target event is **SLICE-6/HEY-136**: one journaled run
walking the full contract FSM (`PENDING -> CONTEXT_BUILT -> LLM_CALLED -> TOOLS_DONE -> GATED ->
DELIVERED -> DONE`, pinned in `packages/contracts/src/runtime/run.ts`) from a scheduled wake to a
fake-sink delivery with a trace assertion — loop-anatomy parity with pi/Hermes on the DO substrate.
HEY-17 installs the fake-first provider seam before SLICE-6; the live provider flip remains gated
by the HEY-99 spend-cap decision and explicit credential work.

2026-07-09 update: HEY-17 and HEY-136 have merged. HEY-136 should now be described as the
fake-first run-loop skeleton, not the production agent loop. The follow-up Runtime hardening slice
adds the missing integration guardrails before Agent Harness Alpha: spend cap avoids gateway calls,
governor deny decisions become durable runtime `FAILED` outcomes, and the loop performs
plan -> act -> observe/synthesise before gate/outbox.

Codex runtime lane (strict order — one runtime writer at a time on `packages/runtime/src/*`):

1. HEY-122 · SLICE-4 Loop Governor — merged via PR #27.
2. HEY-123 · SLICE-5 scheduler/alarm multiplexer — merged via PR #28 at `061e72c`.
3. HEY-77 · triage dispatcher single entry — merged via PR #29 at `a947600`.
4. HEY-12 · hook registry (9 lifecycle events) — merged via PR #31 at `1b180ef`.
5. HEY-78 · ToolDispatcher + per-trigger ACL — merged via PR #33 at `600fb34`.
6. HEY-17 · LLMProvider via CF AI Gateway, fake-first — merged via PR #34 at `0aae766`.
7. HEY-136 · SLICE-6 run-loop integration — merged via PR #35 at `3d336c7`.
8. HEY-139 · Runtime hardening follow-up — merged via PR #38 at `b736470`.
9. HEY-111 · Runtime evidence spine — merged via PR #39 at `61eb3c7`.
10. HEY-142 · governed multi-iteration `plan -> act -> observe` loop — next runtime slice. It must
   reuse HEY-111 evidence and revisit trace `event_key` granularity if one runtime state step can
   legitimately emit the same event type more than once.
11. HEY-143 · real-provider flip readiness — after HEY-142 proves loop iteration with fake
   provider/sinks.

Claude context lane (parallel; fake-backed start allowed now):

- HEY-10 (DO SQLite base tables) merged via PR #37 at `7980aad` -> HEY-15
  (recall-before-act) -> HEY-14 (skill loader) -> HEY-16 (REASONS prompt builder). HEY-11
  (AuditedDB) rides HEY-10. HEY-13 (sanitiser runtime) runs parallel — the governor egress floor
  and Scribe both consume it. HEY-102 (CRS) may stay faked through SLICE-6.
- HEY-10 landed the exact 10-table base schema in
  `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md`. `goals` is intentionally excluded and owned by
  HEY-144, which blocks full HEY-16 goal hydration. Deferred tables remain mapped in
  `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md`.

Safe-parallel at any point: HEY-137 (DeliveryGate test hardening, `ready-for-agent`), HEY-100,
HEY-125, HEY-141, and channel/fake-sink prep that does not trigger live delivery.

Ordered follow-ups, not on the critical path: HEY-138 (ADR-0068 D4 timezone/quiet-hours — after
HEY-10), HEY-135 (fleet watchdog — after HEY-123), HEY-18/HEY-19 channels (after HEY-136; they make
the loop user-visible), Scribe memory-write slice (after HEY-136).

Explicitly not on this path, by decision: session resume and always-on sockets (ADR-0033 trust
reset; ADR-0074 socket residency), mid-run steering (HEY-126 live-chat spike owns that seam),
`execute_code`/browser powers (non-negotiables), LLM-written committed memory (Scribe-only, ever).

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

Before opening or merging HEY-17, grill these decisions:

1. Does every trigger resolve through contract-owned routing data, including provider swaps?
2. Does fallback degrade context/model deterministically without logging raw prompts or raw health?
3. Does spend-cap degradation stay separate from provider health and prompt-injection failure?
4. Do PostLLMCall hooks gate and sanitise before the model text becomes a tool-call source?
5. Did the PR avoid HEY-136 run-loop wiring, Scribe memory writes, live credentials, and channels?
6. Which files are single-writer for HEY-17, and which eval/trace fixtures can run in parallel
   without touching them?
