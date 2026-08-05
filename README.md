# Waldo Backend

Waldo Backend is the durable owner-side runtime for one Waldo across personal assistance and agent orchestration. It contains the trusted RunLoop foundation and is the target home for the per-owner Coordinator, canonical product contracts, governed execution, effects, evidence, acceptance, continuity, and cross-surface projections.

This repo is not meant to be worked on in isolation. Keep the Waldo Brain repository available as the companion source of truth for ADRs, foundation context, agent-harness research, source maps, and builder philosophy:

- GitHub: [Pin4sf/waldo-brain](https://github.com/Pin4sf/waldo-brain)
- Recommended local checkout: `../waldo-brain`

## Start Here

Before coding, read:

1. [Next Session Plan](docs/foundation/NEXT-SESSION-PLAN.md) for the current entrypoint and source/target boundary.
2. [Architecture Lock](docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) for build authority, ownership, invariants, and parallel workstreams.
3. [Final Home + Work Architecture](docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) for the source-pinned current state, target contracts, state machines, and migration rules.
4. [Product Capability Matrix](docs/planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) for committed product scope and honest delivery status.
5. [Contributor Onboarding](docs/foundation/CONTRIBUTOR-ONBOARDING.md), [AGENTS.md](AGENTS.md), and [Agent Operating Workflow](docs/foundation/AGENT-OPERATING-WORKFLOW.md) for execution discipline.
6. [Local Dev Testing Pipeline](docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md) for verification expectations.
7. `.claude/rules/INDEX.md` plus the relevant accepted ADRs and Waldo Brain pages for the seam you are touching. Report conflicts; do not silently treat older wording as current target direction.

Historical handoffs and old benchmark/build reports are evidence only. Files that retain an old stable path carry an explicit superseded banner; archived material lives in `docs/foundation/archive/`.

## Operating Loop

Use this as guidance, not ceremony. The goal is disciplined progress with evidence.

```text
Open context -> define done -> design the seam -> build with tests -> break it -> verify -> capture learning
```

Session flow:

1. Read the current architecture lock and inspect the source/tests for the seam being changed.
2. Shape fuzzy work with `/current-ideal-gap`.
3. Use `/waldo-isa-run-contract` for non-trivial work, shared contracts, architecture changes, agent-harness work, or handoffs.
4. Use `/thinking-mode-router` when the problem needs the right reasoning mode before action.
5. Design seams with `/codebase-design`.
6. Build with `/tdd` for new behavior or `/diagnose` for bugs and regressions.
7. Use `/check-contract` whenever touching DTOs, schemas, tool outputs, adapters, Worker/EF responses, or `packages/contracts`.
8. Break the feature with `/break-feature`, then review with `/code-review` or `/review-all`.
9. Close with verification, `/compound-learning-capture` when useful, `/phase-handoff` for a
   workstream handoff, and a concise issue/PR evidence update.

## Skill Guide

Use these skills intentionally:

| Skill | Use when |
| --- | --- |
| Legacy `/session-bus` | Not a loadable package in this checkout. Use issue/PR evidence and an explicit workstream handoff; record its packaging repair gap. |
| `/current-ideal-gap` | The ask is directionally clear but needs a current state, ideal state, gaps, and verification path. |
| `/waldo-isa-run-contract` | Done needs to be durable: acceptance criteria, tests, work slices, evidence, and learning. |
| `/thinking-mode-router` | The work needs first-principles, systems thinking, RCA, red-team, research, creative, or council mode. |
| `/codebase-design` | Adding or changing modules, interfaces, seams, adapters, contracts, or shared vocabulary. |
| `/tdd` | Adding new core logic or behavior that can be pinned with a failing test first. |
| `/diagnose` | Debugging failures, regressions, flakes, performance issues, or confusing behavior. |
| `/check-contract` | Verifying code against `packages/contracts`, Zod schemas, DTOs, adapter contracts, and public payloads. |
| `/break-feature` | A feature appears done and needs happy, null, hostile, concurrent, degraded, retry, and boundary checks. |
| `/review-all` | Preparing high-risk or merge-ready work for security, privacy, health-data, contract, and runtime review. |
| `/code-review` | Separating code-quality Standards from Spec correctness. |
| `/run-eval` | Running evals when the suite exists; otherwise recording the eval-suite gap and running the verify wall. |
| `/compound-learning-capture` | A reusable lesson emerged from a fix, review, source recheck, or repeated agent failure. |
| `/waldo-builder-registry` | Adding, auditing, or promoting builder skills, tool manifests, source-backed philosophies, or eval gates. |
| `/waldo-memory-proposal-review` | Reviewing durable memory, goal, preference, user-context, health-adjacent, or skill-learning proposals. |
| `/phase-handoff` | Closing a bounded workstream change and preparing the next session. |

Canonical skills live in `.claude/skills/`. `.agents/skills/` is a compatibility mirror when present and must not become a separate source of truth.

## Code Standard

Good backend work should be contract-first, evidence-backed, and boring at the plumbing layer.

- Every change names the real user or system problem.
- Every public shape is schema-backed and owned by `packages/contracts`.
- Every new seam earns its place through real variation, risk isolation, or a clear interface boundary.
- Health data never leaks into logs, prompts, Durable Object memory, R2, or generic memory.
- Tests prove rejection paths and degraded paths, not only happy paths.
- Runtime authority stays in local contracts, accepted ADRs, and security rules.
- Parallel agents are useful for research, review, failure mapping, and fixtures; shared runtime and contract files stay single-writer.
- A feature is not done until verification evidence exists.

## Verification

Default merge wall:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

For docs-only changes, run targeted whitespace checks and any touched guards. For runtime or agent-harness behavior, include trace, eval, conformance, replay, ACL, sanitizer, journal, log, or state evidence as appropriate.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Use the pinned verification command above before pushing or opening a PR.
