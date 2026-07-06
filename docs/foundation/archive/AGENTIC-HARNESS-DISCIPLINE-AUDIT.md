# Agentic Harness Discipline Audit

Historical note: this audit explains why the backend builder workflow was imported and repaired.
For the active runtime build plan, use `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md` and
`docs/foundation/NEXT-SESSION-PLAN.md`.

Verified on 2026-07-06 from local checkouts:

- `waldo-backend` at `f77b29b` on `main`.
- `waldo-brain` at `a2d783d` on `main`, locally ahead of `origin/main` by 2 and behind by 1. Treat this as the current local Brain working source until the remote is reconciled.

This note answers one question: what should `waldo-backend` inherit from the recent `waldo-brain` rules, skills, workflows, and philosophy work so AI agents can build the backend harness with discipline instead of drift.

Implementation status: the first backend pass from this audit has been applied in this working tree. The detailed operating loop now lives in `docs/foundation/AGENT-OPERATING-WORKFLOW.md`.

## Executive Verdict

The six universal rule files are already mirrored into backend and match Brain in substance. The only diff after the mirror banner is blank-line formatting.

The backend skill surface was useful but stale in several places. It had good Waldo-native build/break skills (`tdd`, `diagnose`, `break-feature`, `review-all`, `check-contract`, `run-eval`, `new-adapter`, `phase-handoff`), but several referenced old paths and old contract facts:

- Missing local paths referenced by skills: `Docs/CONTEXT.md`, `Docs/WALDO_ADAPTER_ECOSYSTEM.md`, `.claude/rules/architecture.md`, `.claude/rules/coding-standards.md`, `.claude/rules/phase-orchestration.md`, `tools/eval`, `cloudflare/waldo-worker`, `src/adapters`, `Docs/handoffs`.
- `check-contract` still points at `@waldo/types` and `../waldo-types`, while `CLAUDE.md` says current contracts live in `packages/contracts`.
- `CLAUDE.md` itself has one legacy tech-stack line naming `@waldo/types`; its "Current facts" section overrides this, but future agents can still be misled.
- `.claude/skills/` is tracked and should be the backend source. `.agents/skills/` is an untracked duplicate compatibility copy; cloud sessions will not see it.

The right move was not to copy all Brain skills. Backend now imports the small missing discipline set, repairs stale backend skills against current foundation docs, and keeps Waldo-specific hardening where backend is already stronger than Brain's generic versions.

Newly imported Brain builder skills:

- `current-ideal-gap`
- `thinking-mode-router`
- `codebase-design`
- `code-review`
- `compound-learning-capture`
- `codify-craft-judgment`
- `writing-great-skills`
- `waldo-builder-registry`
- `waldo-isa-run-contract`
- `waldo-memory-proposal-review`
- `research`
- `domain-modeling`
- `improve-codebase-architecture`

New backend implementation artifacts from this pass:

- `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
- `scripts/guards/guard-agent-surface-stale-refs.mjs`
- repaired backend skill references in `.claude/skills/*`
- updated `AGENTS.md` skill roster and Dev-QA loop
- clarified stale contract/eval/model guidance in `CLAUDE.md`

## Philosophies To Carry

These are the durable principles from the recent Brain work that should govern backend harness construction.

1. **Harness is the product boundary.** The model is not the agent. The agent is model plus context, tools, memory, scheduler, policy, observability, and verification.
2. **Verification is a layer, not a phase.** Every run needs evidence: tests, trace replay, conformance, evals, or runtime observation. Static review is not enough for agent systems.
3. **Context is the workflow.** Incorrect context is worse than missing context, and missing context is worse than noise. Prefer pre-hydration, JIT retrieval, compaction, and tool lazy-loading over stuffed prompts.
4. **Current -> ideal -> criteria -> verification.** Vague goals must become observable current state, desired state, gaps, checkable criteria, and proof.
5. **Single-writer with scoped subagents.** Use parallel agents for research, review, attack, and disjoint fixtures. Keep shared runtime and contract files single-writer.
6. **Memory is governed mutation.** Persistent user/project learning needs provenance, confidence, review status, consent, scope, and rollback. No silent self-editing of identity, safety, or health policy.
7. **Deep modules over shallow wrappers.** Put complexity behind small interfaces at real seams. Test through the interface. Do not add a seam until variation is real.
8. **Inference is a product contract.** `LLMProvider` routes should declare quality, latency, privacy, cost, cache, retry, and canary expectations. Model swaps are eval-gated routing changes, not vibes.
9. **Build the moat, buy plumbing.** Waldo should own trust, memory, body context, safety, delivery policy, and run semantics. Borrow platform/runtime plumbing only behind stable seams.
10. **Visible control plane.** Runs, route decisions, active criteria, tool use, verification evidence, memory proposals, data-source health, and conformance failures should be inspectable.

## Rules Baseline

Keep the six universal rules as the root discipline:

- `posture.md`
- `mental-model.md`
- `language.md`
- `hey-109-workflow.md`
- `work-modes.md`
- `security-checklist.md`

No new universal rule file is needed from Brain right now. The gap is downstream: backend skills and workflows need to point at the current foundation docs and contracts.

Add a deterministic drift check later:

```bash
diff -q -B <(tail -n +4 .claude/rules/posture.md) ../waldo-brain/.claude/rules/posture.md
```

Apply the same pattern for all six mirrored files.

## Backend Skills Status

Keep these backend skills. The stale references identified below have been repaired in `.claude/skills` in this pass:

| Skill | Status | Result |
|---|---|---|
| `session-bus` | Keep | Mandatory start/end workflow. Automation should still confirm Linear slugs and `WALDO_DEV_HANDLE` before writes. |
| `tdd` | Keep | Still the core red-green-refactor skill; use with confirmed seams and non-tautological tests. |
| `diagnose` | Repaired | Uses current rule index, foundation docs, accepted ADRs, and local contracts. Keeps trace replay, DO/EF logs, and health-data redaction. |
| `break-feature` | Keep | Operationalizes workflow-mapper -> qa-breaker and the null/hostile/concurrent/degraded pass. |
| `review-all` | Keep | Broad review remains mandatory before merges; native-module checks are conditional for backend. |
| `check-contract` | Repaired | Now centers `packages/contracts`, strict schemas, public exports, and `npx -y pnpm@10.34.4 verify`. |
| `run-eval` | Repaired as triage gate | Because the eval suite is absent, it probes for the suite, records the gap, and runs the current verify wall. |
| `new-adapter` | Repaired | Now uses `packages/contracts/src/adapters/*`, accepted ADRs, and foundation docs; no legacy runtime tree assumption. |
| `phase-handoff` | Repaired | Now points at foundation docs and `/session-bus`/Brain handoff ownership. |
| `grill-me`, `grill-with-docs`, `zoom-out` | Repaired | Source paths now use accepted ADRs, `docs/foundation`, Brain source pages, and `packages/contracts`. |
| `write-a-skill` | Augmented | Keep for repo-local creation; prefer `writing-great-skills` and `codify-craft-judgment` when designing durable skill behavior. |

## Skills To Import Or Adapt

These have now been imported from Brain into backend `.claude/skills/`.

| Skill | Decision | Why backend needs it |
|---|---|---|
| `current-ideal-gap` | Adopted | Converts fuzzy asks into current state, ideal state, gaps, steps, and verification. This should precede non-trivial harness work. |
| `thinking-mode-router` | Adopted | Routes architecture/debug/strategy/ideation into first-principles, systems, science, red-team, or council mode. Prevents generic answers. |
| `codebase-design` | Adopted | Gives backend agents the deep-module vocabulary behind `language.md`: module, interface, depth, seam, adapter, leverage, locality. |
| `domain-modeling` | Adapted/user-invoked | Useful when backend terminology changes. Do not create random `CONTEXT.md`; map to current foundation docs and accepted ADRs. |
| `improve-codebase-architecture` | Adapted/user-invoked | Useful for periodic architecture-deepening reviews. It should produce reports only when explicitly requested. |
| `code-review` | Adopted | Two-axis review, Standards vs Spec, maps well onto `@waldo-review` and prevents spec correctness from masking code-quality issues. |
| `compound-learning-capture` | Adopted | Captures reusable lessons after fixes, reviews, research, and repeated agent failures. This is how backend avoids rediscovering the same mistakes. |
| `codify-craft-judgment` | Adopted | Turns repeated review feedback into real skills/checklists/evals instead of vague "use good judgment" prose. |
| `writing-great-skills` | Adopted | Better skill authoring discipline: trigger design, context load, progressive disclosure, pruning, failure modes. |
| `research` | Adapted/user-invoked | Useful for primary-source research captures. Require source links and local path destinations; do not use it as authority over accepted ADRs. |
| `waldo-builder-registry` | Adopted | Turns source-backed builder philosophies, plugin records, tool manifests, evals, and lifecycle state into inspectable backend guidance. |
| `waldo-isa-run-contract` | Adopted | Gives backend sessions stable criteria, test strategy, work slices, verification evidence, and learning capture. |
| `waldo-memory-proposal-review` | Adopted | Brings LifeOS memory-proposal discipline into Waldo's privacy, ADR-0064, health-data, and rollback boundaries. |

Do not import by default:

- Frontend/design/motion skills unless the backend task explicitly touches UI artifacts.
- LifeOS installer/workflow skills.
- Broad "full OS" or self-modifying skill systems.
- `prototype`, `teach`, weekly planning, inbox, or Obsidian-native skills for backend runtime work.

## Operating Workflow

Use this as the backend agentic build loop.

```text
Session start:
  session-bus
  read .claude/rules/INDEX.md
  read relevant docs/foundation file(s)
  read accepted ADR(s) and Brain source pages for the touched seam

Shape:
  current-ideal-gap for vague work
  thinking-mode-router for high-stakes or ambiguous thinking
  grill-with-docs only when a decision needs user/founder input

Design:
  name Module, Interface, Contract, Seam, Adapter, Impact Surface
  keep shared runtime/contract files single-writer
  write golden acceptance and degraded-path checks before implementation

Build:
  tdd for new core logic
  diagnose for bugs or regressions
  check-contract for every DTO, schema, tool output, adapter, EF/Worker response
  never rely on subagent claims without source inspection and commands

Break:
  break-feature for feature completion
  review-all or @waldo-review for security/privacy/health/contract/determinism
  run-eval only once the eval suite path exists

Close:
  npx -y pnpm@10.34.4 verify
  git diff --check
  compound-learning-capture if reusable learning emerged
  phase-handoff when a phase/wave boundary is crossed
  session-bus
```

## Collaboration Policy

Use multi-agent work where it buys context isolation, not because it feels powerful.

Safe parallel lanes:

- Read-only research.
- Adversarial review.
- Failure-mode mapping.
- Independent fixture generation.
- Spec vs standards review.
- Architecture alternatives that do not write shared files.

Single-writer lanes:

- `packages/contracts/src/runtime/*`
- `packages/contracts/src/core/*`
- `packages/contracts/src/tools/*`
- `packages/contracts/src/memory/*`
- `packages/runtime/src/*`
- any file owning a shared vocabulary, registry, budget, trigger, model roster, schema barrel, or migration.

A subagent verdict is a lead, not proof. The author must inspect source, re-run validations, and confirm tests are non-vacuous.

## Backend Harness Requirements From Brain

These are the product/runtime disciplines that should be reflected in backend code and tests.

| Layer | Backend requirement |
|---|---|
| Context | Pre-hydrate deterministic context before the LLM loop. Keep stable prompt prefixes cache-friendly. Put volatile body/life/memory context after the cacheable prefix unless a route intentionally disables caching. |
| Action | Typed tools only. Zod input validation. Per-trigger ACL. Taint gate before privileged actions. JIT tool discovery; no giant always-loaded tool list. |
| Memory | Raw health stays in Supabase. DO/R2 receive derived, redacted, provenance-bearing memory. Memory writes go through Scribe/proposals, not direct table writes. |
| Initiation | DO alarms and Worker routes start runs; Loop Governor admits/drops/holds/degrades; sessions reset trust on wake; runs resume durably. |
| Verification | Trace-native evals, conformance fixtures, replay tests, crash/resume tests, delivery idempotency, model-route canaries, and cost/latency dashboards. |
| Observability | Run journal is the trajectory. Inspector/debug surfaces should render durable rows, not invent a second state store. |
| Cost | Treat escalation rate, prompt cache placement, input/output ratio, retry count, and offline/batch lanes as first-class product constraints. |

## Adopt, Adapt, Reject

Adopt:

- Current -> ideal -> criteria -> verification.
- Thinking-mode routing.
- Deep-module vocabulary.
- Two-axis review.
- Compound learning capture.
- Skill manifests with trigger, tools, source lineage, privacy tier, eval strategy, failure modes, owner, and promotion status.

Adapt:

- LifeOS memory proposals into DO/Supabase/R2-backed, tenant-scoped, consent-aware mutation queues.
- LifeOS hooks into Worker/DO lifecycle events, queues, alarms, outbox, and conformance jobs.
- Pulse-style visibility into app/admin/local inspector surfaces.
- OpenAI Agents SDK, Cloudflare Think, LangGraph, Temporal, Mastra, Letta, and similar systems as benchmarks behind Waldo seams, not as source-of-truth runtime ownership.

Reject for V1:

- Local filesystem as product runtime truth.
- Broad auto-permission settings.
- Fail-open hooks as safety authority.
- Self-modifying system/rule/skill files without review, evals, provenance, and approval.
- Multi-agent fan-out as default runtime architecture.
- Full code/browser execution tools in the health-agent V1 surface.
- Any external memory or hosted harness that owns Waldo's trust boundary.

## Implemented This Pass

1. **Repaired existing backend skills.** Stale paths and stale package references were updated. `/run-eval` is now an explicit triage gate until the eval suite exists.
2. **Imported the missing discipline skills.** The active builder set now includes current/ideal shaping, thinking routing, codebase design, code review, compound learning, craft judgment, skill design, builder registry, ISA run contracts, and memory proposal review.
3. **Added a stale-skill-reference guard.** `scripts/guards/guard-agent-surface-stale-refs.mjs` fails on obsolete operational references in agent-facing surfaces.
4. **Clarified `CLAUDE.md`.** The retired contract package, missing eval script, and historical model-routing note no longer conflict with current facts.
5. **Declared `.agents/` policy.** `.claude/skills` is canonical. `.agents/skills` is a compatibility mirror when present and must not drift into a second source of truth.

## Remaining Product Work

1. Build the real eval suite behind `/run-eval` with trace replay, prompt/context, tool ACL, memory, delivery, model-routing, and synthetic-health fixtures.
2. Decide whether the `.agents/skills` compatibility mirror should be committed, generated locally, or replaced by a Codex skill-loader policy.
3. Add a registry-data artifact if Waldo wants machine-readable skill records, not only SKILL.md files plus references.
4. Add a deterministic Brain rule mirror drift check for the six universal rule files.

## Source Notes Read

Backend:

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/rules/*`
- `.claude/skills/*`
- `docs/foundation/*`

Brain:

- `.claude/rules/*`
- `.claude/skills/*`
- `.claude/skills/waldo-builder-registry/*`
- `.claude/skills/waldo-isa-run-contract/*`
- `.claude/skills/waldo-memory-proposal-review/*`
- `02-Knowledge/concepts/waldo-builder-skill-registry.md`
- `03-References/research/waldo-builder-source-reverification-2026-07-04.md`
- `03-References/research/lifeos-install-skills-deep-dive-2026-07-04.md`
- `03-References/research/everyinc-compound-engineering-skills-deep-dive-2026-07-05.md`
- `03-References/repos/everyinc-compound-engineering-plugin.md`
- `01-Waldo/planning/WALDO_AGENTIC_HARNESS_LAYER_MAP.md`
- `03-References/ADL/ai-agent-harness-and-persistent-agents-master-note.md`
- `03-References/blogs/context-engineering.md`
- `03-References/books/inference-engineering.md`
- `03-References/repos/danielmiessler-lifeos.md`
- `03-References/repos/openai-agents-sdk.md`
- `01-Waldo/engineering/adapter-ecosystem.md`
- `01-Waldo/planning/cost-model-v2-realistic-may-2026.md`
- `04-Agent-Harness/mothership-harness-first-principles.md`
- `04-Agent-Harness/harness-final-build-image-2026-06-27.md`
