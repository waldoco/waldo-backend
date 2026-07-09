# HEY-136 Harness Runtime Benchmark - 2026-07-09

## Verdict

[observed] PR #35 was analyzed at commit `3d336c741591471352b00f678f4faeded86ff3a3` on branch `codex/hey-136-run-loop-integration`. GitHub reports PR #35 merged on 2026-07-09. Local `origin/main` contained the HEY-78 and HEY-17 base merges (`600fb34`, `0aae766`).

[observed] The implementation is good enough for the initial HEY-136 proof if the proof is stated narrowly: one fake-backed scheduled `brief` run can move through the contract runtime FSM, persist trace/journal/outbox evidence, resume after eviction at selected boundaries, and avoid live provider/channel/Scribe side effects.

[observed] It is not yet good enough to call Waldo's actual Pi/Hermes-style runtime loop complete. The loop anatomy exists, but the product runtime is still fake-first: no real Worker ingress path reaches the loop, context and delivery are hardcoded fakes, live provider/channel/memory paths are intentionally absent, and several safety/failure branches are only adjacent seams rather than integrated loop behavior.

Rubric count across the 11 requested benchmark axes:

| Rating | Count | Meaning |
|---|---:|---|
| Green | 2 | Integrated in the HEY-136 loop proof with local tests. |
| Yellow | 6 | Seam exists or adjacent tests exist, but the end-to-end run loop still uses fakes or does not cover the failure branch. |
| Red | 3 | Not yet built into the runtime loop. |

This is a credible proof of loop anatomy, not a credible proof of the actual agent runtime loop.

## Post-Benchmark Hardening Status

[observed] Update after 2026-07-09 merges: PR #38 / HEY-139, PR #37 / HEY-10, and PR #39 /
HEY-111 are now merged into `main` through `61eb3c7`. The original verdict still holds: Waldo has
a much stronger fake-first harness proof, but the actual Pi/Hermes-style loop is still not complete
until HEY-142 builds governed multi-iteration `plan -> act -> observe` behavior and the context lane
wires real recall/prompt/skill hydration.

[observed] A follow-up Runtime hardening branch was started after this benchmark. It does not make
the runtime production-ready, but it closes several integration gaps identified here:

- Spend-cap behavior now uses the deterministic floor without making a gateway call.
- Governor deny decisions at admission and mid-run usage become durable runtime `FAILED` outcomes.
- The fake run loop now performs plan -> tool dispatch -> observe/synthesise before gate/outbox.
- Runtime fake provider/sink behavior is behind a test override seam so adversarial loop tests do
  not require live provider calls or channel delivery.
- Duplicate schedule/run idempotency, authenticated local ingress, gate branches, malformed/denied
  branches, and replayable local evidence are now covered by HEY-139 / HEY-111.

Remaining P0 gaps before an honest Agent Harness Alpha:

- HEY-142 governed multi-iteration loop; the current run loop can observe once but is not yet a
  general iterative agent runtime.
- Real context/recall/prompt/skill hydration behind fake provider and fake delivery.
- HEY-143 real-provider flip readiness after HEY-142 proves iteration with fake adapters.

Linear mapping: HEY-142 owns runtime iteration; HEY-15/HEY-14/HEY-16 own context, recall, skills,
and prompt hydration; HEY-143 owns fake-to-real provider readiness.

## Run Contract

Current state:

- [observed] `packages/runtime/src/run-loop/do.ts` defines `RunLoopDO`, schema, fake scheduling, fake context, fake LLM, fake tool dispatch, gate/outbox handoff, trace persistence, and resume transitions.
- [observed] `packages/runtime/src/index.ts` exports `RunLoopDO` and binds `RUN_LOOP_DO`, but Worker `fetch` still returns `404`.
- [observed] `packages/runtime/test/run-loop.test.ts` covers the happy run and eviction at `CONTEXT_BUILT`, `LLM_CALLED`, `TOOLS_DONE`, `GATED`, and `DELIVERED`.
- [observed] Linear's HEY-136 documents scope the proof as fake-first and explicitly exclude live provider calls, live channel delivery, Scribe writes, raw health context, and real CRS/body context.

Ideal state:

- A per-user runtime can accept real wake sources, hydrate scoped context, call a routed LLM provider, dispatch allowed tools, write durable memory proposals when appropriate, gate egress, enqueue exactly-once delivery, resume after crashes, arbitrate competing loops, and expose replayable observability without leaking raw health/private data.
- This matches the local Waldo harness target: per-user Durable Object, journaled FSM, deterministic Loop Governor, DeliveryGate, session reset, product loops for Brief/Fetch/Chat/Spots, eval/replay, and Agent-Ready gates.

Acceptance criteria used for this benchmark:

- Full contract FSM is not just type-compatible; the loop must prove each transition through durable evidence.
- Resume must be durable across eviction and external-call boundary failures.
- Governor deny, budget, kill, and no-progress behavior must be integrated into loop outcomes.
- Context hydration must be source-scoped and raw-data-safe.
- LLM routing must prove provider selection, fallback, malformed output, and timeout behavior without live credentials.
- Tool dispatch must prove ACL, autonomy approvals, schema validation, and denied-tool behavior.
- Delivery must prove hold/degrade/drop/send and exactly-once outbox behavior.
- Observability must be replayable and suitable for evals.
- Concurrency and duplicate wakes must be idempotent.
- Product loops must map to Brief, Fetch, Chat, and pre-activity Spots.

Test strategy used:

- Local code and doc inspection.
- Focused runtime test path and full verify wall.
- Safety scans for provider calls, credentials, live channels, and raw health/private data in the HEY-136 proof files.
- Four bounded research lanes:
  - Agent A reconstructed Pi/Hermes/Waldo harness criteria from local benchmark/reference docs.
  - Agent B audited PR #35 source and tests against runtime criteria.
  - Agent C red-teamed fake-only claims and failure modes.
  - Agent D synthesized remaining work and issue mapping.
- Spot checks were done against local sources. One subagent claim that `waldo-brain/.firecrawl/openclaw-hermes.md` was unusable was corrected: the local file contains usable Hermes/OpenClaw benchmark material.

## Sources

Repo docs:

- `AGENTS.md`
- `.claude/rules/INDEX.md`
- `.claude/rules/posture.md`
- `.claude/rules/mental-model.md`
- `.claude/rules/language.md`
- `.claude/rules/hey-109-workflow.md`
- `.claude/rules/work-modes.md`
- `.claude/rules/security-checklist.md`
- `README.md`
- `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
- `docs/foundation/BUILD-PLAN.md`
- `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
- `docs/foundation/FOUNDATION-HANDOVER.md`

Linear docs and issue read-only:

- `Waldo Harness Runtime Build Map - Source Reconciled 2026-07-09`
- `State - waldo-backend`
- `HEY-136 Verification Playbook - Initial Harness Runtime`
- `HEY-136`

Local Waldo Brain / benchmark references:

- `waldo-brain/04-Agent-Harness/harness-runtime-architecture-decided-vs-gap.md`
- `waldo-brain/04-Agent-Harness/harness-final-build-image-2026-06-27.md`
- `waldo-brain/04-Agent-Harness/agent-harness-build-readiness-consolidation-2026-06-26.md`
- `waldo-brain/04-Agent-Harness/harness-devx-teardown-2026-06-29.md`
- `waldo-brain/03-References/ADL/research-corrections-may-2026.md`
- `waldo-brain/03-References/ADL/waldo-extraction-summary.md`
- `waldo-brain/01-Waldo/planning/WALDO_AGENTIC_HARNESS_LAYER_MAP.md`
- `waldo-brain/01-Waldo/planning/WALDO_ARCHITECTURE_OVERVIEW.md`
- `Waldo/.claude/pi-mono-reference.md`
- `waldo-brain/.firecrawl/openclaw-hermes.md`

Primary implementation files:

- `packages/runtime/src/index.ts`
- `packages/runtime/src/run-loop/do.ts`
- `packages/runtime/test/run-loop.test.ts`
- `packages/runtime/src/run-journal/outbox-runtime.ts`
- `packages/runtime/src/delivery-gate/gate.ts`
- `packages/runtime/src/loop-governor/governor.ts`
- `packages/runtime/src/scheduler/multiplexer.ts`
- `packages/runtime/src/llm/provider.ts`
- `packages/runtime/src/hooks/registry.ts`
- `packages/contracts/src/runtime/run.ts`
- `packages/runtime/wrangler.jsonc`
- `packages/runtime/vitest.config.ts`

## Verification Evidence

[observed] First focused test attempt failed before dependency installation:

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime exec vitest run test/run-loop.test.ts
```

Result: `vitest` was not found because `node_modules` was absent.

[observed] Dependency installation passed:

```bash
npx -y pnpm@10.34.4 install --frozen-lockfile
```

[observed] Runtime tests passed:

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts
```

Result: `13` runtime test files passed, `127` tests passed. The package script ran the runtime suite rather than only the named file.

[observed] Full verify wall passed:

```bash
npx -y pnpm@10.34.4 verify
```

Result summary:

- contracts tests: `47` files, `1163` tests passed.
- runtime tests: `13` files, `127` tests passed.
- guards passed, including health leak, model IDs, OpenAPI freshness, `setAlarm`, stale types, and self-test guards.

[observed] Whitespace diff check passed before this report:

```bash
git diff --check
```

[observed] HEY-136 proof-file safety scans found no provider fetches, credentials, Supabase/R2/KV calls, Scribe writes, or raw health/private fixtures in `packages/runtime/src/run-loop` and `packages/runtime/test/run-loop.test.ts`. The only `raw` match was the test assertion that the proof JSON does not contain `raw`.

## Capability Matrix

| Axis | Pi/Hermes-style target | Waldo HEY-136 current state | Rating | Remaining work |
|---|---|---|---|---|
| Wake sources and scheduler | Multiple wake sources, scheduler, webhook/app/user/health events, idempotent occurrence handling. | `RunLoopDO.scheduleFakeRun` accepts only fake scheduled `brief`; `Scheduler` seam exists; Worker `fetch` still returns `404`; duplicate schedule IDs can create orphaned runtime runs because the runtime run is opened before scheduler upsert. | Yellow | Add real authenticated ingress, occurrence idempotency, malformed wake tests, and multi-wake dispatch. |
| Durable journal / FSM / resume | Journaled FSM is the source of truth; exact resume after crash at every material boundary. | `runtime_runs`, `runtime_journal`, `runtime_trace` persist; tests cover happy FSM and selected eviction boundaries. External-call atomicity windows are not proven. | Green | Add failure tests around provider/tool/channel success before commit and around failed transitions. |
| Loop governor / budgets / kill / no-progress | Governor denies, budgets, kill flag, no-progress, egress policy, and arbitration are part of loop semantics. | `LoopGovernor` exists and is partly used. In `RunLoopDO`, deny currently throws instead of becoming a durable failed runtime outcome; kill/no-progress paths are not integrated in the proof. | Yellow | Integrate deny/kill/no-progress outcomes into runtime FSM and trace. |
| Context / recall / prompt hydration | Scoped recall, body/health summaries, session reset, prompt hydration, no raw data leakage. | `buildFakeContext` returns static `fake-derived` context; prompt text is fixed; session reset hook runs through always-allow fake callbacks. | Red | Wire real scoped context packages, prompt builder, recall, and redaction proof. |
| LLM routing / provider fallback | Provider routing, fallback, circuit behavior, timeout, malformed output handling, no live credentials in tests. | `RuntimeLLMProvider` seam is used, but the run loop uses `FakeRunLoopGateway`; adjacent provider tests cover fallback behavior. Timeout and malformed loop behavior are not proven in HEY-136. | Yellow | Add adapter injection and tests for fallback, malformed output, timeout, and refusal branches. |
| Tool dispatcher / ACL / autonomy hooks | Tool calls are schema-validated, allowlisted, autonomy-gated, and auditable. | Fake LLM always calls `get_crs`; dispatch seam exists; `HookRuntimeContext` exists; run-loop callbacks are always-allow fakes. | Yellow | Add denied tool, bad args, autonomy approval, taint, and ACL tests inside `RunLoopDO`. |
| Memory write / Scribe lifecycle | Candidate memory proposals, Scribe review, persistence, and audit lifecycle. | Intentionally absent from HEY-136; no Scribe writes or durable memory proposals. | Red | Implement Scribe proposal path after context/prompt/recall are real enough to exercise safely. |
| Delivery gate / outbox / channel adapters | Gate produces hold/drop/degrade/send; outbox is exactly-once; adapters deliver through real channels. | `RunLoopDO.gate` calls egress and enqueues hardcoded `send`; fake sink proves one exactly-once fake delivery; `runGate` has adjacent hold/drop/degrade handling outside the run-loop path. | Yellow | Make gate verdicts injectable and prove hold/drop/degrade/send plus retry/channel adapter paths. |
| Observability / evals / replay | Structured trace, journal, replay, eval cases, local debug, no raw data in logs. | `runtime_trace` exists and tests assert trace order; no replay CLI/eval fixture for HEY-136 yet. | Yellow | Build HEY-111-style scenario replay and eval harness before broader runtime claims. |
| Multi-loop arbitration / concurrency | Competing Brief/Fetch/Chat/Spots runs are arbitrated with priorities and idempotency. | Single fake `brief` run only; governor arbitration exists as a lower-level function, but no multi-loop proof. | Red | Add loop-kind model, concurrency policy, duplicate wake behavior, and arbitration tests. |
| Product loop surfaces: Brief / Fetch / Chat / pre-activity Spots | Product loops have distinct triggers, context, delivery surfaces, and acceptance tests. | Brief-shaped fake proof only; no Fetch, Chat, or Spots loop integration. | Yellow | Map HEY-20/21/22/24/66/27 product loops onto runtime contracts. |

## Contract vs Runtime Drift

[observed] The contract FSM in `packages/contracts/src/runtime/run.ts` defines the canonical states and transition guard. `RunLoopDO` uses those transitions, so state naming and forward movement match the contract on the happy path.

[observed] Drift exists at the behavioral-contract level:

- The runtime contract includes `FAILED`, but HEY-136 does not prove durable failed outcomes for governor denial, gate hold/drop, malformed LLM output, denied tool calls, or repeated no-progress.
- The contract has idempotency input that includes scheduled occurrence fields, but `RunLoopDO.scheduleFakeRun` opens a runtime run before `Scheduler.schedule` upserts by schedule ID. A duplicate fake schedule can overwrite the scheduler entry while leaving an earlier PENDING run unreachable.
- The target architecture treats the journal as the replayable trajectory. HEY-136 records a trace, but replay/eval tooling is not present yet.
- The target architecture treats context and prompt hydration as part of the loop. HEY-136 uses fixed fake context and prompt strings.
- The target architecture treats delivery gate verdicts as policy outcomes. HEY-136 hardcodes `send` in the loop path.

## Adversarial Pass

The strongest ways PR #35 could overstate reality:

- "The runtime loop exists" can be misread as real provider/channel/memory runtime. [observed] The loop is fake-backed and local proof-only.
- "Scheduler works" can be misread as production wake support. [observed] Worker fetch does not route into the loop and only fake scheduled `brief` is exercised.
- "Resume works" can be misread as exactly-once recovery around every side effect. [observed] Tests cover eviction at state boundaries, not all external-call commit windows.
- "Delivery works" can be misread as channel adapter delivery. [observed] fake sink delivery is process-local and intentionally non-live.
- "Safety hooks run" can be misread as real auth/ACL/autonomy/taint enforcement. [observed] HEY-136 hook callbacks are static always-allow fakes.
- "No raw data leak" can be misread as proving real redaction. [observed] the proof contains only fake-derived context, so the privacy assertion is necessary but shallow.

## Current -> Ideal -> Gaps

Current:

- A Durable Object loop proof with fake scheduled wake, fake context, fake LLM, fake tool call, fake delivery sink, durable trace/journal/outbox, and passing local verification.

Ideal:

- A source-backed runtime loop that can safely run Waldo's product loops under real but local/fakeable adapters: wake -> context -> LLM -> tools -> memory proposal -> gate -> outbox -> channel/app surface -> trace/replay.

Gaps:

- Ingress: no real Worker route into `RunLoopDO`.
- Idempotency: schedule/run creation is not yet duplicate-safe at the runtime-run level.
- Failure semantics: deny/hold/drop/malformed/ACL/no-progress are not durable loop outcomes yet.
- Side-effect atomicity: external success-before-commit windows are not proven.
- Context and memory: prompt hydration, recall, and Scribe lifecycle are absent.
- Delivery: fake sink proves shape, not channel adapter runtime.
- Replay/evals: trace exists, but eval/replay harness is still missing.
- Concurrency: no multi-loop arbitration proof.

## Priority Backlog

P0 - HEY-142 governed multi-iteration loop:

- Turn the current plan/tool/observe/synthesise path into a real bounded loop.
- Accumulate governor usage across all model/tool passes.
- Revisit trace `event_key` granularity if the same event type can appear multiple times in one
  runtime state step.

P0 - HEY-111 observability/eval/replay spine:

- Merged via PR #39. Continue extending this surface during HEY-142 rather than inventing a second
  trace/eval path.

P0 - HEY-10 / HEY-13 / HEY-15 / HEY-14 / HEY-16 context, recall, prompt, skills, Scribe:

- Replace static fake context with source-scoped context hydration.
- Wire prompt builder and skill registry into the runtime loop.
- Add Scribe proposal lifecycle before durable memory writes.

P0 - HEY-100 / HEY-125 / HEY-134 data-plane safety:

- Prove summarized-only data movement, RLS/JWT boundaries, adapter-safe health context, and no raw health/private data in traces or fixtures.

P0 - HEY-110 / HEY-134 delivery runtime:

- Extend outbox to multi-kind delivery, retry, notification-log mirror, and channel-safe adapter seams.

P1 - HEY-127 then HEY-18 / HEY-19 / HEY-126 product delivery surfacing:

- Connect runtime delivery to testable app/channel surfaces under local fake adapters first.

P1 - HEY-20 / HEY-21 / HEY-22 / HEY-24 / HEY-66 / HEY-27 product loops:

- Map Brief, Fetch, Chat, and pre-activity Spots to runtime triggers, context, tool permissions, and delivery contracts.

P1 - New live-provider dogfood flip issue:

- After local replay and safety gates pass, add credential-free fixture tests plus opt-in local live-provider smoke docs. Do not make live calls in CI by default.

P1 - New multi-loop arbitration issue:

- Prove duplicate wakes, competing loop priorities, budget contention, and cancellation semantics.

P2 - HEY-137 / HEY-138 / HEY-135 hardening residue:

- Keep spec alignment, stale type checks, and review residue moving after the runtime path has real adapters.

## Reproduction Recipe

Use this to reproduce the benchmark locally without live providers, credentials, channel delivery, Cloudflare production side effects, or Supabase production side effects:

```bash
cd /Users/shivanshfulper/Developer/Pin4sf/waldo-backend
git fetch origin
git checkout 3d336c741591471352b00f678f4faeded86ff3a3
npx -y pnpm@10.34.4 install --frozen-lockfile
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts
npx -y pnpm@10.34.4 verify
git diff --check
```

Optional focused command after dependencies are installed:

```bash
cd packages/runtime
./node_modules/.bin/vitest run test/run-loop.test.ts --config vitest.config.ts
```

Optional safety scans:

```bash
rg -n "OPENAI|ANTHROPIC|OPENROUTER|api[_-]?key|secret|Authorization|Bearer|fetch\(|XMLHttpRequest|SUPABASE|R2|KV|Scribe|memory" packages/runtime/src/run-loop packages/runtime/test/run-loop.test.ts
rg -n "raw|heart|hrv|sleep|steps|spo2|blood|glucose|calorie|weight|height|distance" packages/runtime/src/run-loop packages/runtime/test/run-loop.test.ts
```

Expected scan result for HEY-136 proof files: no live provider/channel/credential/storage matches; only the `raw` privacy assertion in `run-loop.test.ts`.

## Linear Updates

None. Linear documents and issues were read for source truth, but no Linear document, comment, or issue was changed in this benchmark session.

## Reusable Lessons

- Keep the HEY-136 proof language precise: "fake-first loop anatomy proof" is accurate; "actual runtime loop complete" is not.
- Do not treat a lower-level seam as an integrated runtime behavior until a `RunLoopDO` test proves it through durable trace/journal/outbox evidence.
- The next runtime slice should prioritize replay/eval and failure branches before adding live surface area. This keeps the harness honest while the product loops are wired in.
