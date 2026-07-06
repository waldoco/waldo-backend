# Harness Runtime Build Plan

Status: active planning source for the next Waldo backend runtime build.
Date: 2026-07-06.
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
- Static guard wall and pinned verification command.

Not built:

- Full run FSM runtime.
- Durable multi-kind DeliveryGate/outbox flusher.
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

## First Slice

Build **SLICE-3a: durable DeliveryGate/outbox proof**.

The first PR should prove exactly-once delivery at the durable layer, not only exactly-once enqueue and not only process-local fake-sink dedupe.

Required test:

- Start a run.
- Commit the outbox intent.
- Simulate sink send.
- Crash before ack is recorded.
- Evict/reconstruct the Durable Object.
- Resume.
- Assert the side effect is not delivered twice.
- Assert durable state records the ack/retry outcome.

The implementation may still use fake sinks, but the fake must enforce the same idempotency contract expected from real APNs/Telegram/feed sinks. The proof cannot rely on a module-scope map hiding duplicate sends.

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

Before coding SLICE-3a, grill these decisions:

1. What is the minimal production outbox row shape: `status`, `attempts`, `next_retry_at`, `acked_at`, `sink_ack`, `last_error`, `idempotency_key`?
2. Does the notification-log mirror belong in SLICE-3a or the next DeliveryGate PR?
3. What exactly is the sink contract: native idempotency required, synthetic key required, or both?
4. Which operations are inside the same DO SQLite transaction as the `GATED` transition?
5. What state transition follows "sent but ack not recorded" on retry?
6. How do we test a non-idempotent sink to prove the runtime rejects it or wraps it?
7. Which tracer code should be promoted, and which tracer code should be left as test-only scaffolding?
