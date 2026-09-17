# Waldo Execution Ledger Protocol

Status: active cross-session coordination protocol; navigation reconciled 2026-09-17.

Live ownership and evidence: [GitHub issue #116](https://github.com/Pin4sf/waldo-backend/issues/116), owning issues and PRs. Current personal-agent scope: [the pinned master launch contract](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md). Start execution from [NEXT-SESSION-PLAN.md](NEXT-SESSION-PLAN.md).

The older #78/milestone/B0-B6 map is historical delivery context, not a parallel release definition. GitHub issue bodies may also be stale: follow the latest explicit user direction, current contract and linked evidence. Linear/HEY identifiers are historical only.

## Two records, one workflow

The owning issue/PR carries live status, dependencies, ownership, commits and verification. A bounded `docs/ledger/<date>-<workstream>.md` handoff is justified only when it preserves non-obvious source, failure, architecture or cross-repository context for another session. Do not create a new Markdown status file for every session or erase old evidence to make status look cleaner.

## Session start

Before a write-capable lane changes files, inspect fresh remote/source/tests, applicable ADRs, current issue/PR and the latest relevant ledger comments. Post `SESSION START` with session/parent, human owner, agents, repo/branch/worktree, base SHA, scope and exact claimed files/writers, dependency/consumer boundaries, acceptance/falsifiers, verification and rollback. Read-only reviewers may be in the parent roster; write-capable children register independently.

Keep blocked work blocked until the real dependency is met. Do not claim, close or relabel unrelated issues automatically.

## Parallel work

Shared schemas, migration allocation, generated artifacts, composition roots and definitive writers stay single-writer. Release contracts/fixtures or an explicit merge order before dependent implementation. Cross-repository consumers pin the exact contract revision. If lanes collide, stop shared writes and establish one integration owner.

Record subagent output as proposed/reviewed/adopted/rejected; it is not truth until verified. Worktree paths are custody/navigation, not product completion. Preserve unrelated dirty work and record whether a worktree is retained, removable, superseded or abandoned.

## Handoff and PR gate

Before pause, transfer, PR or end, post `SESSION HANDOFF` on the owning issue/ledger with branch/commits/PR, changed files/contracts, independent review where required, PASS/FAIL/SKIPPED/UNAVAILABLE/NOT RUN evidence, decisions/conflicts, residual blockers, consumer actions, next owner/task and worktree disposition.

PRs link their issue and session record, pin base/head, state whether shared contracts/fixtures changed, and describe rollback. Merge only after the applicable repository wall and acceptance checks pass at the reviewed head and merge authorization exists. A documentation PR is not permission for deployment, credentials or live effects.

## Retained evidence

Existing dated records in `docs/ledger/` remain intact. The [pre-reconciliation ledger index](https://github.com/Pin4sf/waldo-backend/blob/e91bee017b0c36759cbfda1353fc11c73e3afe0a/docs/foundation/EXECUTION-LEDGER.md) links the August B0/B1/contract/bridge handoffs. They preserve historical verification and sole-writer decisions; do not promote old counts or frontiers into current proof.

This reconciliation deliberately adds no separate mutable session dashboard. The current change's start/handoff records are on #116.
