# Next Session — Waldo Personal Agent

Updated 21 September 2026 · sole backend execution entrypoint

The user has finalized the MVP direction in the [canonical build plan](../planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md). Start with the [worker packet](../planning/waldo-agent-mvp/README.md) and [S0 assignment](../planning/waldo-agent-mvp/FIRST_WORKER_ASSIGNMENT.md). These documents supersede the old G0–G9 release order; historical Brain/app product cuts must be synchronized, not treated as a competing roadmap.

## Current baseline and proof boundary

Backend main `e91bee017b0c36759cbfda1353fc11c73e3afe0a` and app main `7218c18fed8b874492e3831bbb5bd1e1c58abe58` were inspected for the September 20–21 audit. PR #138 started this finalization at `10e48fb979f8c775491d0121dbafa18b8624006c`. Re-fetch before implementation. Preserve dirty primary checkouts.

The backend has owner routing, Coordinator/RunLoop, durability, scheduling, context and effect foundations. Production composition still has fail-closed placeholders. The app has real HealthKit/SQLCipher foundations but prototype success, legacy thread-ownership and consent/lifecycle gaps. Source findings are in the [audit](../planning/waldo-agent-mvp/SOURCE_AUDIT.md); none proves a deployed agent. Historical tests are not rerun evidence for a later head.

## First dependency frontier

1. Register one bounded S0 lane through [the ledger protocol](EXECUTION-LEDGER.md) and [#116](https://github.com/Pin4sf/waldo-backend/issues/116).
2. Complete the [precise cross-repository synchronization](../planning/waldo-agent-mvp/ADR_RECONCILIATION.md), preserving accepted security/wire invariants. The product direction is selected; protected amendments and generated snapshots must still be published before changing their seams.
3. Reproduce and contain fictional app success and legacy thread-ownership risk. Prove truthful pending/error/receipt behavior and two-owner isolation.
4. Wire app → authenticated owner DO → real model → read-only test Calendar → staged durable answer, including stop/reconnect, permission, spend, context and delivery dependencies.
5. Resolve the generated closure API/runtime mismatch for the touched contract rather than advertising unimplemented routes.
6. Produce the S0 acceptance evidence, model/config evaluation and measured estimate; release only the shared contracts needed by the next frontier.

Advance S1 memory/personality; S2 + H health-aware day/Calendar/cloud follow-through; S3 + B approved email/public research; S4 repeated device/provider/usefulness/cost proof. K0 is required for the joined showcase, while a clearly labeled personal-only pilot is independently useful. C supplies the Telegram demonstration; WhatsApp remains a supported-route workstream. W/K/R expansion follows. Exact dependencies and ownership live in the canonical plan, not duplicated issue queues. No fixed date, budget or exact cohort is agreed.

## Stable engineering boundaries

One owner authority root; one writer per aggregate. Supabase owns visible conversation content; the DO owns run/schedule/outbox order. Freeze effect intent before I/O and reconcile uncertainty before retry. Correction outranks inference; memory never grants authority. Health sharing is optional and purpose-scoped. Provider completion is evidence, not Acceptance. Channels, browser and Kennel retain the same task identity and permission boundaries. Use the [implementation contracts](../planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md) for exact recovery rules.

## Verification and handoff

Documentation/instruction changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

Runtime/contract/integration changes:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

App/native claims require their repository gates and appropriate simulator/physical-device proof. Record exact base/head, scope, commands, passed/failed/not-run results, rollback and next owner. Documentation publication is not merge, deployment, runtime proof or permission for hosted mutations.

## MVP engineering companion

Use the [repository map](../planning/waldo-agent-mvp/REPOSITORY_MAP.md) for source ownership, fresh checkouts and per-repo verification. Apply the [engineering quality guide](../planning/waldo-agent-mvp/ENGINEERING_QUALITY.md) to CI/evaluations, dependencies, bounded improvement and cleanup. Establish actual CI and first behavior-suite evidence alongside S0; preserve the canonical plan's acceptance criteria and existing repository merge wall.
