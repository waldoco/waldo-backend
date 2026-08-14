# Waldo Production Execution Ledger

- **Status:** active cross-session coordination protocol
- **Live index:** [GitHub issue #116](https://github.com/Pin4sf/waldo-backend/issues/116)
- **Launch map:** [GitHub issue #78](https://github.com/Pin4sf/waldo-backend/issues/78) and [milestone 1](https://github.com/Pin4sf/waldo-backend/milestone/1)

This ledger replaces the retired Linear/HEY-109 session bus. GitHub carries live ownership and delivery state. Repository handoffs preserve bounded, reviewable context after a workstream pauses or crosses a session boundary. Neither can override source, tests, accepted ADRs, the current convergence, or the user's latest instruction.

## Two records, one workflow

1. **Live lane record:** the owning GitHub issue and PR contain current status, ownership, dependencies, commits, review, and verification evidence.
2. **Durable handoff:** `docs/ledger/<YYYY-MM-DD>-<workstream>.md` records the bounded result when another session genuinely needs the context.

Do not create a Markdown handoff for every trivial session. Do create one when work changes architecture, crosses repositories, uses parallel write lanes, leaves a non-obvious failure, changes the build frontier, or must be resumed by another session.

## Session start

Before a write-capable session changes files:

1. Fetch the remote and inspect the issue, PRs, current source/tests, accepted decisions, and [next-session entrypoint](./NEXT-SESSION-PLAN.md).
2. Read [issue #116](https://github.com/Pin4sf/waldo-backend/issues/116) and the latest relevant entry under `docs/ledger/`.
3. Add a `SESSION START` comment to the owning GitHub issue with:
   - session ID and parent session, if any;
   - repository, gate, branch, worktree, base SHA, and intended integration branch;
   - human owner and agent/subagent roster;
   - exact scope plus claimed contracts, modules, and files;
   - named dependencies and cross-repository consumers;
   - acceptance, falsifier, verification commands, and rollback.
4. Remove `ready-for-agent` only when the issue is actually claimed. Keep `blocked` until its named dependency is satisfied.

Read-only planners and reviewers may be registered in the parent session's roster. A write-capable child lane requires its own branch/worktree and file ownership record.

## Parallel execution rules

- One issue is the bounded unit of delivery. One session may coordinate several issues, but every commit and PR must still identify its owning issue.
- Shared contracts, migrations, generated artifacts, composition roots, and definitive writers are single-writer surfaces. Parallel work starts only after an explicit contract/fixture release or a named merge order.
- The parent session records each subagent's role as `proposed`, `reviewed`, `adopted`, or `rejected`. Subagent output is untrusted until the parent verifies it independently.
- A worktree path is navigation evidence, not product status. Record branch, base SHA, head SHA, dirty state, and whether the worktree is retained, removable, superseded, or abandoned.
- Cross-repository consumers link the backend contract issue and the exact fixture/schema SHA. They cannot call fixture success live integration or production proof.
- When two lanes collide, stop both writers at the shared seam, name one integration owner, establish merge order, and rerun the full affected verification wall after convergence.

## Session handoff and convergence barrier

Before a session pauses, transfers ownership, opens a PR, or ends, add a `SESSION HANDOFF` comment to the owning issue containing:

- commit SHA(s), PR, and branch;
- contracts/modules/files changed;
- passed, failed, skipped, unavailable, deferred, and not-run evidence separately;
- decisions, conflicts, residual risks, and named blockers;
- cross-repository impact and required consumer action;
- next action, next owner, and worktree disposition.

A PR is the convergence barrier. Its description links the owning issue and ledger entry, names the base/head SHAs, records independent review, and states whether shared fixtures or contracts changed. Merge only after the issue acceptance and repository verification wall pass at the reviewed head.

## Durable handoff shape

Use the repository `/phase-handoff` structure:

```markdown
# <workstream / issue> handoff

## Identity
- Session / parent / owner / agents
- Repository / issue / gate / branch / worktree / base / head / PR

## What Was Built
## What Works (with evidence)
## What Doesn't Work Yet
## Architecture Decisions or Conflicts
## Parallel Agent and Worktree Ledger
## Hard-Won Lessons
## Next-Session Prerequisites
## Files Changed
```

Use severity, disposition, owner, and dependency for each known issue. Never erase a prior handoff to make current status look cleaner; supersede it explicitly and keep Git history.

## Current ledger

- [2026-08-14 — B1 execution-environment port and #87 frontier](../ledger/2026-08-14-b1-execution-environment-port-frontier.md)
- [2026-08-14 — B1 sole execution writer and #80 convergence](../ledger/2026-08-14-b1-sole-execution-writer.md)
- [2026-08-14 — B1 additive contract/fixture release and #80 execution-writer frontier](../ledger/2026-08-14-b1-contract-fixture-release.md)
- [2026-08-13 — B0 baseline closure and B1 contract frontier](../ledger/2026-08-13-b0-baseline-closure.md)
- [2026-08-13 — product architecture convergence, launch surfaces, and GitHub workflow](../ledger/2026-08-13-product-architecture-convergence.md)
