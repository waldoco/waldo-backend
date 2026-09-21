# Waldo worker implementation guide

Updated 21 September 2026 · companion to [the build plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md)

This is the implementation entrypoint for the finalized MVP baseline published in PR #138. It defines how to turn the plan into code, evidence and a useful product. Assign one slice at a time. Start with the [S0 assignment](FIRST_WORKER_ASSIGNMENT.md), including the [bounded ADR synchronization](ADR_RECONCILIATION.md) for affected seams. The user has selected the product direction; no second broad strategy audit or renewed product approval is required. Accepted wire contracts and protected engineering invariants still require explicit versioned migration.

## 1. What you are building

One cloud Waldo understands the person's goals, commitments, preferences and permitted body context; decides the next useful step and executor; acts within permission; checks evidence; follows through; and updates its understanding.

The showcase combines a useful health-aware personal loop with one real Kennel work handoff. Personal capabilities include day planning, bounded Calendar adaptation, exact-approved email follow-up and useful public research. K0 connects one attached project to one installed coding harness through Kennel. Health sharing is optional. This is a general assistant demonstrated through a small set of reliable task families, not a claim to complete every task competitors advertise.

Keep the full web dashboard, coordination between people's Waldos, broad commerce, every work harness and unrestricted computer use outside the showcase critical path. Preserve the contracts needed to add them. Do not turn anticipated extensions into prerequisite frameworks.

## 2. Read just the context required for your slice

Use the [repository map](REPOSITORY_MAP.md) for exact repo ownership, current-ref precautions, source paths and repo-specific commands. Use [engineering quality](ENGINEERING_QUALITY.md) for CI, executable evaluations, dependency upgrades, bounded improvement and cleanup. These companions implement this guide; they do not add release scope.

Every worker reads the repository's current AGENTS.md and its required rules, this guide, the build-plan sections for its slice, and the issue's current acceptance criteria. Read the relevant implementation and tests before changing it. Treat the source audit as navigation to a pinned snapshot, not as a substitute for checking current source. Competitor research is background, never runtime specification.

| Owner | Read in the build plan | Read in source before changing it | Evidence to produce |
|---|---|---|---|
| Integration/kernel | §§2–7, 10–11, 14 | Backend `packages/runtime/src/index.ts`, `run-loop/adapters.ts`, `run-loop/do.ts`, `coordinator/identity-presence-module.ts`, `scheduler/multiplexer.ts`, `llm/gateway.ts`, ContextComposer, contracts and outbox tests | Production composition, durable publication, isolation, recovery and generated API contract |
| App/health | §§1, 7–9, 11 | App `src/agent/agentClient.ts`, `src/chat/useChat.ts`, `src/health/sync/`, native `modules/health/`, account/store lifecycle; backend protected-health interfaces | Physical-device day loop, freshness and consent proof, truthful errors, reconnect and account-switch isolation |
| Google actions | §§6–7, 9, A3–A6 | App prototype `supabase/functions/agent/commit.ts` only as a migration reference; backend typed proxy/secret ownership and effect dispatcher | Real provider read-back, etag conflict and uncertain-send recovery, exact approved payload |
| Browser/research | §§5, 9, A8 and browser research appendix | Existing executor boundary; hosted Stagehand API contract; Browserbase session/context lifecycle | Supported public research, citations, cancellation, iPhone handoff, owner isolation and full cost |
| Channels/web | §13, C/W, A11–A12 | Owner presence registry, authentication, command idempotency and durable event cursor | Same task across surfaces, replay-safe link/revoke, no duplicate approvals/effects |
| Kennel K0 | §13, K0 and A14 | Kennel AGENTS.md, current STATUS, outcome/attempt ingress, provider readiness, artifact/proof paths, harness connection authority | One real Codex-first serial task, exact attachment, reconnect/cancel, diff/test evidence, no fake bridge |
| Independent reviewer | Proof story, slice acceptance, changed contracts | Changed runtime paths plus adjacent failure/recovery tests | Reproduction steps, concrete failures, passed/failed/not-run evidence and remaining limits |

One integration owner writes shared contracts, migrations and generated client/schema outputs. Other owners propose interface changes. Each lane uses its own worktree and bounded file ownership; preserve unrelated modifications. Register the actual implementation lane through the existing repository workflow. Parallelize independent slices only after their shared contract is released.

## 3. Dependency and library choices

Apply the [dependency lifecycle](ENGINEERING_QUALITY.md#5-library-and-dependency-lifecycle): source/version verification, compatibility tests, frozen installs, reviewed update proposals and rollback. Library availability is not runtime compatibility or product proof.

Use existing lockfiles. The inspected backend declares Node >=22, pnpm 10.34.4, TypeScript 5.9.3, Wrangler 4.105.0, Vitest 4.1.9, the Cloudflare Workers test pool, fast-check and Stryker. The app declares pnpm 9.15.9, Expo 54, React Native 0.81.5, React 19.1, TanStack Query 5, Zustand 5, Supabase JS 2, Zod 4, OP-SQLite/SQLCipher and a local HealthKit module. These are snapshot manifests, not an instruction to upgrade other repositories or replace resolved lockfile versions.

| Need | Use | Do not add without a demonstrated gap |
|---|---|---|
| Durable agent execution | Existing Cloudflare owner DO, Coordinator, RunLoop, scheduler and outbox | A second state-owning Agents SDK/LangGraph/Temporal runtime |
| Model reasoning | Existing typed model gateway, one evaluated primary model and pinned prompt/config | A model-router platform, evaluator model on every turn, or a separate reasoning swarm |
| Auth/protected persistence | Supabase Auth, existing Postgres/RLS and typed secret-owning connector proxy | Another identity service, shared untyped credential/tool endpoint |
| Memory | Existing database, explicit revisions and lexical retrieval first | Graph database, standalone vector service or managed memory provider by default |
| Calendar and email | Direct official Google APIs through the proxy | An entire connector marketplace for two providers |
| Browser reach | Browserbase hosted Stagehand HTTP, Worker fetch and one typed adapter | A second Node server, local user browser dependency, unsupported SDK-version assumption |
| App data/UI | Existing Expo Router, Query/Zustand responsibilities, native HealthKit and secure storage | Framework rewrite or a second persistent source of task truth |
| Notifications | Existing expo-notifications device registration and server APNs delivery interface | Always-on client polling or a model call just to resend a push |
| Work execution | Existing Kennel daemon, project attachment, artifacts and available Codex-first adapter | A new coding agent, public local daemon, credential copying or provider-identity-as-readiness |
| Later web | React/TypeScript/Vite and Workers static assets; shared API client | A separate agent backend or SSR requirement without a product need |

Primary implementation references, checked during the audit:

- Runtime/recovery: [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). Read the retry semantics; your task reconciliation still needs its own persisted state and bounded repair path.
- App streaming: [Expo SDK 54 API](https://docs.expo.dev/versions/v54.0.0/sdk/expo/). Use the documented fetch streaming path; prove reconnection from the canonical snapshot/cursor.
- Calendar concurrency: [Google resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources). Handle precondition failure as changed reality, not a reason to overwrite.
- Email: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [send API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [push notification guide](https://developers.google.com/workspace/gmail/api/guides/push). Start with selected-thread bounded polling; add push when justified. Scopes and production access need explicit verification.
- Browser: [hosted session start](https://docs.stagehand.dev/v3/api-reference/python/start-a-new-browser-session), [hosted action](https://docs.stagehand.dev/v3/api-reference/python/perform-an-action), [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts), [live view](https://docs.browserbase.com/platform/browser/observability/session-live-view). The hosted HTTP contract is usable without adopting the Python client or assuming the current JS SDK is v3.
- Channels: [Telegram Bot API](https://core.telegram.org/bots/api). Read §13 for the separate WhatsApp supported-route question.
- Web: [Cloudflare React SPA + API tutorial](https://developers.cloudflare.com/workers/vite-plugin/tutorial/).

Keep model, API and library versions in the lane's evidence. Read the exact installed-version documentation when implementing. A moving docs page must not silently alter an active release contract.

## 4. Harness engineering: five practical responsibilities

The following is the recommended Waldo implementation recipe, not a transcription of any vendor framework.

| Responsibility | Implement | Inspect when a task fails |
|---|---|---|
| Instructions | Short versioned personality and operating prompt; a few demonstrated procedures loaded only when relevant | Did the prompt provide the missing judgment, or merely repeat rules? |
| Tools | Narrow typed operations, clear input/error contracts, server-derived owner/grants and bounded output | Wrong tool choice, missing permission, malformed parameters, misleading result or unavailable capability? |
| Environment | Known connector account, pinned provider config, isolated browser/workspace and declared executor availability | Wrong account/version, unavailable desktop, dirty workspace or stale session? |
| State | Durable user input, commitments, operation IDs, results, pending decisions and next wake | Was progress lost, duplicated, stale, or reconstructed from a summary? |
| Feedback | Provider read-back, independent checks, user correction and cost/latency/outcome metrics | Did the system claim success without observing the intended result? |

A worker should be able to start fresh, identify one next slice, reproduce its failure, implement it, run meaningful checks and leave a truthful handoff. Keep the repository entrypoint short and link to local detail. Automate repeatable checks; avoid requiring a worker to memorize the whole project history. [OpenAI harness-engineering reference](https://openai.com/index/harness-engineering/)

## 5. Context engineering: the runtime context contract

Build one ContextComposer output per reasoning step. It should contain the task objective; current explicit user direction; relevant active commitments and preferences; permitted current health projection; recent conversation; durable completed tool results; unresolved decisions; available tool descriptions; and remaining time/spend/step bounds. Add source IDs, observed time, owner/consent generation and validity where needed. Keep private retrieved content distinctly labeled as data.

Use a configurable input budget with reserved space for results and output. Record the actual budget and truncation in evaluation evidence; choose the initial number from the model/task spike rather than treating the context-window maximum as the target. Order context by current task relevance. Retrieve summaries or references first and load details only when needed. Never silently truncate a pending approval, revocation or completed-effect identity.

Compaction produces a working summary with references. It cannot replace the authoritative records for an action, approval, memory correction, deadline or deletion. Revalidate references on the next step. An email or web page can contribute evidence but cannot modify the user's instructions or grants. A revised preference invalidates contradictory cached context. Expired health/self-report projections fall out of the context without becoming permanent traits.

Apply the finalized §8 memory design: five tiered responsibilities, compact claims/episodes/commitments, fresh revision-bound briefing, immediate explicit changes and an incremental background consolidation job. Do not confuse the five tiers with the older five hall labels or introduce five separate services. Fix the retained-provenance write/read path: the currently inspected SQLite recall adapter excludes all legacy rows, so passing schemas or generating a summary is not a recall implementation. Test ordinary task personalization as well as explicit factual recall; “today only” must not become a permanent preference. Acknowledge only the durable state actually achieved.

Measure context quality using omission, stale-retrieval, correction, irrelevant-history and hostile-source tests alongside token/cost measurements. Before adding embeddings or a new memory service, show a representative retrieval failure that a simpler fix cannot address. These choices apply the finite-context and selective-retrieval principles in [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## 6. Agent and tool engineering

Use one model-guided loop for deciding useful steps, with code enforcing identities, state transitions, permissions and effect rules. A fixed Calendar read is deterministic plumbing; choosing how to adapt a day is reasoning; sending the approved event change is a checked effect. Do not move deterministic validation into prompts.

Separate prepare, approve, execute and reconcile for consequential actions. The model may prepare a proposal but cannot manufacture the approval token. Bind approval to the exact payload, account, task and applicable version. Recheck permission at dispatch and after waiting. Preserve operation IDs across inference retries and durable results across context compaction.

Return tool results with a factual status, data/evidence reference, observed time and a specific error classification. Distinguish unavailable, forbidden, conflict, interrupted, uncertain effect and confirmed failure. Limit output size and page through large results. Human-readable descriptions should explain when a tool applies and which outcomes it cannot prove.

Load only tools relevant to available connections and the current task. A procedure or skill may teach the model how to perform a workflow; it cannot expand permissions, enable connectors or grant itself new tools. Test the one-off workflow before turning it into a scheduled routine. Keep autonomous work bounded by steps, elapsed time, total spend and a next-wake policy. Use specialist delegation only where a distinct environment or capability earns it. [Effective agents](https://www.anthropic.com/engineering/building-effective-agents), [tool design](https://www.anthropic.com/engineering/writing-tools-for-agents)

## 7. Work packages and build order

The main plan's S0–S4/H/B/C/K0/W/K/R rows define scope and acceptance. This guide maps them into worker assignments:

1. **S0 integration:** prove app → cloud owner → real model → Calendar read → committed answer. Fix/disable legacy thread isolation and mock success. Publish the command/event/projection baseline that other lanes consume.
2. **S1 continuity:** implement personality, correction/forget, durable commitments, stop and reconnect. Deliver the first real task lifecycle before adding channels.
3. **S2 + H personal loop:** backend owns Calendar effects and schedules; app owner proves HealthKit consent/freshness on a physical phone. Join them in an actual day that changes and is followed up with the laptop off.
4. **S3 + B breadth:** real approved follow-up/reply monitoring and public browser research. Reuse the effect and recovery spine. Scope each connector to the proof story.
5. **K0 work proof:** a separate Kennel owner first audits current readiness, then joins one Codex-first serial work request to the same Waldo task. Prove artifacts and a verification result. Do not start full agent orchestration.
6. **C and S4 release:** demonstrate Telegram only if included in the promised demo; complete longitudinal usefulness, recovery, physical-device and cost checks. Track WhatsApp access independently.
7. **W/K/R expansion:** add the proper web control surface, broader work execution and a two-person scheduling protocol after the preceding loop is useful. Each requires its own live acceptance story.

If the same two people own all lanes, serialize contested work and revise the schedule. More agents do not create more independent interfaces. A single contract/migration author is still required.

## 8. Verification and completion

Follow the [CI and evaluation lanes](ENGINEERING_QUALITY.md#3-tests-evaluations-and-ci-lanes). The September 21 audit found no recorded Actions runs and no general executable behavior suite at its pinned baseline. Recheck current state; implement the first CI/eval evidence alongside S0 and never call a workflow file or run-eval fallback a passing behavior suite.

Create tests for behavior and failure boundaries, not for implementation details. Use deterministic unit/property tests for permission, ordering and conflict behavior; Workers integration tests for storage/restart semantics; provider conformance tests for actual responses; physical-device tests for HealthKit/push; and held-out model scenarios for judgment/personality/usefulness.

The inspected backend scripts include `pnpm typecheck`, `pnpm verify:node`, `pnpm verify:workers`, `pnpm verify:supabase:session-revocation`, `pnpm verify:guards` and the aggregate `pnpm verify`. The aggregate also installs the locked dependencies and performs Supabase checks. Inspect the current script and use the assigned test environment before running it. App scripts include `pnpm check` and `pnpm test`. Kennel Go tests run from `backend/`, for example `go test ./... -count=1`; follow its current repo-specific gates as well. No listed command was run by this planning audit.

For each slice capture source SHA, dependency/config/prompt version, environment, exact command/scenario, exit/result, evidence path, elapsed time and cost where relevant. Report passed, failed, blocked and not run separately. A test-only fixture cannot prove deployed routing. Provider completion cannot prove a human outcome. One recorded demo cannot establish repeated reliability or competitor parity.

Use the plan's A1–A16 checks as applicable. Include duplicate delivery, crash after external commit, revoked permission while waiting, incorrect owner, changed Calendar version, forgotten context and disconnected executor. Keep development examples separate from the held-out evaluation set. Score success on observable task completion; report abstention, assistance and retry rates rather than hiding them.

App owners must also implement the §1 experience decisions inside their slices: task-first onboarding, optional connections, correction scope and visible application, typed useful result cards, burst-message steering, unsupported-task handoff, quiet progress and accessible controls. Prove the complete flow on a physical iPhone. Do not substitute component screenshots, an infrastructure demo or a large prose answer for a usable result. Product observation measures actual repeat delegation and rescue burden; it is separate from deterministic engineering gates and must not be presented as a representative market study.

Completion handoff:

```text
Slice and user outcome:
Source/config pins and changed files:
Behavior now implemented:
Acceptance evidence (commands, scenarios, artifacts):
Failure/recovery checks:
Cost and latency observations:
Known limitations / failed / not run:
Interface changes and migration/rollback needs:
Next smallest frontier and required owner:
```

## 9. Copy-ready worker assignment

For the lead coordinating the complete MVP, use [IMPLEMENTATION_PROMPT.md](IMPLEMENTATION_PROMPT.md). The bounded template below is for one delegated slice.

> Implement only [SLICE] from the consolidated Waldo MVP plan. Read the repository's current instructions, this worker guide, REPOSITORY_MAP.md, ENGINEERING_QUALITY.md and the source/primary references for that slice. Verify the current baseline; preserve dirty checkouts; register a bounded lane and use an isolated worktree. Your required user outcome is [OUTCOME]. You own [FILES]; shared contracts and migrations belong to [INTEGRATION OWNER]. Reproduce the current gap, propose only necessary interface changes, and build the smallest production path. Apply the plan's context, permission, effect and recovery rules. Prove [ACCEPTANCE IDS] with actual evidence at the claimed layer. Do not add later roadmap features or claim success from mocks, tests alone or a provider's completion flag. Leave the completion handoff above and identify the next smallest frontier. If current source contradicts the plan, report the exact contradiction and a bounded correction instead of quietly building another architecture.

## 10. Cross-verify sources without reopening the entire plan

For each lane, record the exact installed library/API version, official reference URL and date checked, source file/line, expected behavior, and the small test that could disprove the assumption. Read provider docs at implementation time: moving pages, preview availability, prices and product claims can change. If a decisive assumption fails, isolate the failing adapter or contract, compare the smallest viable alternative, and record the change and consumer impact. Do not silently substitute a framework or expand scope.

Competitor evidence lives in [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md), [RUNTIME_BROWSER_RESEARCH.md](RUNTIME_BROWSER_RESEARCH.md), and build-plan §§4/8. Separate advertised behavior, third-party teardown inference, and personally observed behavior. To claim parity, run the same consented synthetic scenario on a dated product/account/version, capture its result and limitations, and compare Waldo at the same proof level. Public feature pages cannot establish reliability or exclusivity. No competitor credentials, private datasets, access-control bypasses, or invented hands-on stories are required to build the MVP.

Use [IMPLEMENTATION_CONTRACTS.md](IMPLEMENTATION_CONTRACTS.md) for exact recovery boundaries. In root-cause analysis, preserve the failing input and sanitized trace, reproduce at the owning layer, compare at least two plausible causes, test the discriminating evidence, fix the producer/contract, and rerun the failed scenario plus adjacent recovery cases. A retry that happened to pass does not explain a failure.
