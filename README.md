# Waldo Backend

Waldo Backend is the durable owner-side runtime for one Waldo across three primary launch surfaces: Electron Kennel desktop, Waldo mobile with optional Health/Care, and messaging presence through Telegram and Discord. WhatsApp remains a primary target but approval-dependent activation does not block launch. The backend contains the trusted RunLoop foundation and is the target home for the per-owner Coordinator, canonical product contracts, governed execution, effects, evidence, acceptance, continuity, and cross-surface projections.

This repo is not meant to be worked on in isolation. Keep the Waldo Brain repository available as the companion source of truth for ADRs, foundation context, agent-harness research, source maps, and builder philosophy:

- GitHub: [Pin4sf/waldo-brain](https://github.com/Pin4sf/waldo-brain)
- Recommended local checkout: `../waldo-brain`

## Start Here

Before coding, read:

1. [Next Session Plan](docs/foundation/NEXT-SESSION-PLAN.md) for the current backend-first execution entrypoint and source/target boundary.
2. [Product and Architecture Convergence](docs/planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md) for the current product definition, Health First optionality, surfaces, launch experience, and proof-gated build order.
3. [Architecture Lock](docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) for placement, ownership, invariants, and implementation authority.
4. [Product Capability Matrix](docs/planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) for the current capability envelope and honest delivery status.
5. [Final Home + Work Architecture](docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) for the earlier source-pinned contract and failure-path detail; the convergence supersedes conflicting product wording.
6. [Execution Ledger](docs/foundation/EXECUTION-LEDGER.md) and [GitHub ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) for live ownership, parallel worktrees, agent/subagent rosters, and bounded handoffs.
7. [Contributor Onboarding](docs/foundation/CONTRIBUTOR-ONBOARDING.md), [AGENTS.md](AGENTS.md), and [Agent Operating Workflow](docs/foundation/AGENT-OPERATING-WORKFLOW.md) for execution discipline.
8. [Local Dev Testing Pipeline](docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md) for verification expectations.
9. `.claude/rules/INDEX.md` plus the relevant accepted ADRs and Waldo Brain pages for the seam you are touching. Report conflicts; do not silently treat older wording as current target direction.

The live documentation tree contains only the operating packet and source-backed reference evidence listed in [docs/README.md](docs/README.md). Completed handoffs, the HEY-109 session-bus workflow, wave plans, superseded app plans, generated graphs, and one-off verification logs remain in Git history; do not restore them as current instructions.

## Operating Loop

Use this as guidance, not ceremony. The goal is disciplined progress with evidence.

```text
Open context -> define done -> design the seam -> build with tests -> break it -> verify -> capture learning
```

Session flow:

1. Read the current architecture lock, execution ledger, owning issue/PR, and source/tests for the seam being changed; register the session before writing.
2. Shape fuzzy work with `/current-ideal-gap`.
3. Use `/waldo-isa-run-contract` for non-trivial work, shared contracts, architecture changes, agent-harness work, or handoffs.
4. Use `/thinking-mode-router` when the problem needs the right reasoning mode before action.
5. Design seams with `/codebase-design`.
6. Build with `/tdd` for new behavior or `/diagnose` for bugs and regressions.
7. Use `/check-contract` whenever touching DTOs, schemas, tool outputs, adapters, Worker/EF responses, or `packages/contracts`.
8. Break the feature with `/break-feature`, then review with `/code-review` or `/review-all`.
9. Close with verification, `/compound-learning-capture` when useful, `/phase-handoff` for a
   workstream handoff, and a concise issue/PR evidence update.

GitHub is the current delivery system: [umbrella #78](https://github.com/Pin4sf/waldo-backend/issues/78), [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), the [production milestone](https://github.com/Pin4sf/waldo-backend/milestone/1), gate/surface/channel labels, bounded issues, and linked PR evidence. Historical Linear and HEY identifiers are not current work state.

## Skill Guide

Use these skills intentionally:

| Skill | Use when |
| --- | --- |
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
