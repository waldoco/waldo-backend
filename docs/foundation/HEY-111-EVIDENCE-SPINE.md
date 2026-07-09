# HEY-111 Evidence Spine

Status: implementation note for the local fake-first runtime proof spine.

## Positioning

[observed] HEY-111 enables a local, replayable evidence spine proving what the fake-first harness did without storing raw private source payloads, prompts, credentials, provider bodies, or live channel delivery bodies.

## Source-Grounded Shape

[observed] PR #36 already persists run-loop evidence in Durable Object SQLite through `runtime_runs`, `runtime_journal`, `runtime_trace`, the delivery journal, and outbox rows. HEY-111 tightens those surfaces instead of adding a generic observability platform.

[observed] ADR-0054 makes the run journal and outbox the durability truth for resume and side effects. Trace rows explain what happened in order; they do not drive runtime recovery.

[observed] ADR-0077 assigns production replay/export to an R2 Interaction Journal projection. HEY-111 only returns local sanitized replay fixtures from DO state.

[observed] ADR-0002 and ADR-0024 keep private health source data out of DO storage, prompts, logs, and replay evidence. HEY-111 trace details are enum/count/ref summaries with a recursive forbidden-key contract guard.

[observed] Cloudflare Durable Object storage is persistent private state for one object instance, and Workers Vitest can test DO storage locally. That matches the local fake-first proof requirement.

[observed] OpenAI Agents SDK tracing and LangGraph checkpoint/replay docs support the precedent that traces/checkpoints should explain agent behavior and permit replay, but Waldo's schema is derived from harness questions rather than copied from either project.

## Data Model Decisions

| Harness proof question | Runtime evidence | Storage/interface | Why it belongs here |
|---|---|---|---|
| Did Waldo wake for the right reason? | `wake/scheduled_wake` trace event with trigger and schedule ref | DO `runtime_trace`, replay fixture | Scheduler/runtime proof, not product telemetry. |
| Did the governor admit, deny, or kill correctly? | `governor_admitted` / `governor_denied` trace events with policy metadata | DO trace plus existing governor/journal state | Journal owns state; trace explains policy outcome. |
| What context was used? | `context_built` with derived source and summary class | DO trace plus sanitized context summary | Enough for fake-first proof without source payloads. |
| Which LLM/tool/gate/outbox decisions happened? | `llm_*`, `tool_dispatched`, `gated`, `delivered`, terminal outcome | DO trace plus outbox/journal-derived fields | Runtime owns fake adapter/gate proof; outbox owns side-effect state. |
| Can the run be replayed locally? | `RuntimeReplayFixture` with trace, FSM, current state, outbox summary, delivery journal, rule eval | `readRunEvidence` / `replayFixture` | Local deterministic artifact; no R2 write in this slice. |
| Can a future eval compare harness versions? | `RuntimeTraceEval` rule results for order, terminal visibility, privacy, outbox consistency, visible failure | `scoreRun` | Honest local scorer; WIS quality signals remain unavailable for fake-first runs. |

## Explicit Non-Goals

[observed] This slice does not write Supabase `agent_logs`, `trace_evaluations`, outcome signals, or R2 Interaction Journal segments. It does not add dashboards, OTel/Langfuse export, live provider traces, LLM judge, a 30-case corpus, mobile/channel delivery, or HEY-142 loop iteration logic.

[blocked] Full WIS/keep-rate scoring is not observable from fake-first local runs because there is no real user outcome signal in this runtime slice. The contract reports `wis.available = false` with reason `not_observed_fake_first`.

## Verification Recipe

Run from the repo root:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/runtime/evidence.test.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts
npx -y pnpm@10.34.4 verify
git diff --check
```

[blocked] No standalone eval-suite runner or golden corpus exists in this repo today. The HEY-111 local scorer is covered by contracts/runtime tests; `/run-eval` falls back to the verification wall until a real eval suite lands.

## Primary Sources Checked

- Local repo: `AGENTS.md`, `.claude/rules/*`, and `docs/foundation/*` operating/runtime build plans.
- Local repo: `packages/runtime/src/run-loop/do.ts`, `packages/runtime/src/tracer/schema.ts`, `packages/runtime/src/run-journal/outbox-runtime.ts`.
- Local repo: `packages/contracts/src/runtime/*`, `packages/contracts/src/testing/evidence.ts`.
- waldo-brain: ADR-0002, ADR-0024, ADR-0030, ADR-0037, ADR-0054, ADR-0070, ADR-0077, Waldo architecture overview, harness layer map, DeepWiki observability map.
- Official docs: Cloudflare Durable Objects storage and Workers Vitest testing docs.
- Official docs: OpenAI Agents SDK tracing docs.
- Official docs: LangGraph persistence and time-travel replay docs.
