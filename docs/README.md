# Waldo Backend Documentation

## Start here

0. [What is built](CURRENT_SYSTEM.md): current state at a pinned SHA, with [messaging behavior](behavior/MESSAGING_BEHAVIOR.md), [production architecture](architecture/PRODUCTION_ARCHITECTURE.md) and [adoption direction](planning/ADOPTION_DIRECTION.md). Operations: [observability](ops/OBSERVABILITY.md), [teardown](ops/TEARDOWN.md).
1. [Worker packet](planning/waldo-agent-mvp/README.md): selected MVP decisions, read order and source index.
2. [Canonical product architecture and build plan](planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md): one release definition, stack, ownership, slices and acceptance criteria; finalized 21 September 2026.
3. [Worker guide](planning/waldo-agent-mvp/WORKER_GUIDE.md) and [first S0 assignment](planning/waldo-agent-mvp/FIRST_WORKER_ASSIGNMENT.md): libraries, role-specific reading, context/tool/harness engineering, verification and completion evidence.
4. [Next session](foundation/NEXT-SESSION-PLAN.md), [ledger](foundation/EXECUTION-LEDGER.md), [#116](https://github.com/Pin4sf/waldo-backend/issues/116), [onboarding](foundation/CONTRIBUTOR-ONBOARDING.md), [operating workflow](foundation/AGENT-OPERATING-WORKFLOW.md), and [verification pipeline](foundation/LOCAL-DEV-TESTING-PIPELINE.md): bounded delivery workflow.

## Supporting references

- [Implementation contracts](planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md): staged conversation publication/deletion, capability dispatch, connections and provider recovery.
- [ADR synchronization](planning/waldo-agent-mvp/ADR_RECONCILIATION.md): exact cross-repository dispositions; product direction is selected but protected technical amendments and generated snapshots are not silently applied.
- [Ecosystem strategy](planning/waldo-agent-mvp/ECOSYSTEM_STRATEGY.md): positioning, health/work bridge, partner incentives and later expansion; adds no MVP dependencies.
- [Source audit](planning/waldo-agent-mvp/SOURCE_AUDIT.md), [competitors](planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md), [runtime/browser research](planning/waldo-agent-mvp/RUNTIME_BROWSER_RESEARCH.md), and [Kennel map](planning/waldo-agent-mvp/KENNEL_K0_SOURCE_MAP.md): dated evidence, not shipped capability.

The previous [Brain launch proposal](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md) requires the bounded synchronization above; do not let its old sequence compete with the user's finalized MVP. Accepted ADRs and released wire contracts continue to constrain their exact seams until explicitly migrated. No protected Brain file, runtime source, migration or canonical rule mirror is changed by this publication.

## Evidence and history

Live ownership/progress belongs in issues/PRs, not copied dashboards. Re-pin current source and tests before implementation. Architecture, contracts, module implementation, adapter conformance, cross-surface acceptance and operational proof are distinct. Vendor/competitor claims require fresh verification for the exact capability being built.

Dated planning redirects and existing ledger records retain historical evidence. Full originals remain in Git history. This publication replaces the active build plan and preserves its detailed recovery contracts; it does not delete runtime modules. Cleanup requires caller/deployment inventory, tested replacement and rollback.
