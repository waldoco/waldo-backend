# Waldo Backend

Repository for Waldo's target owner-side runtime: one user-governed personal agent with correctable memory, a distinctive personality, health-aware planning, authorized actions, and continuity through the Waldo app plus officially eligible channels. WhatsApp and later desktop integration must cross the same authority boundary and are not claimed as shipped here.

## Read first

1. [Worker packet](docs/planning/waldo-agent-mvp/README.md): finalized MVP decisions and read order.
2. [Canonical build plan](docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md): source evidence, stack, memory, health, build slices and acceptance.
3. [Worker guide](docs/planning/waldo-agent-mvp/WORKER_GUIDE.md), [S0 assignment](docs/planning/waldo-agent-mvp/FIRST_WORKER_ASSIGNMENT.md) and [next session](docs/foundation/NEXT-SESSION-PLAN.md): concrete implementation frontier and required references.
4. [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [.claude/rules/INDEX.md](.claude/rules/INDEX.md), accepted ADRs, released schemas, the owning issue/PR and current source/tests.

Health-aware capability is required; each person's health consent remains optional. App and push come first. Telegram demonstrates the same Waldo, and WhatsApp has a supported-route workstream. A bounded K0 Kennel handoff is required for the joined showcase; the personal pilot is independently useful. Full work orchestration, web dashboard and cross-person coordination follow. No fixed date, budget or exact cohort is agreed. [Cross-repository synchronization](docs/planning/waldo-agent-mvp/ADR_RECONCILIATION.md) records the concrete changes needed in older Brain/app guidance before implementing affected seams.

## Current versus target

A documentation merge does not activate a hosted agent. The fetched September 18 backend baseline is `e91bee017b0c36759cbfda1353fc11c73e3afe0a`. Historical verification at that pin reported contract tests (1,584), runtime tests (1,152), typechecks, and guards passing; these are not rerun claims for this documentation publication. Production conversation, connectors, delivery, multi-presence, relationship coordination, and deployment remain unproved. Re-pin before every implementation claim. [GitHub ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116) and owning issues/PRs hold live state, not copied progress tables.

Keep `WaldoCoordinator`, the existing trusted RunLoop, ContextComposer, owning reducers, authority/consent boundaries and intent-before-I/O. Complete production adapters instead of adding another canonical runtime or bypassing fail-closed dependencies. Memory and personality never grant permission; provider completion is not Outcome Acceptance.

## Documentation policy

[docs/README.md](docs/README.md) separates current entrypoints from historical redirects and durable evidence. The old B0-B6, whole-product, desktop-first, and Telegram/Discord launch documents are not current sequencing. Their original content remains recoverable at the pinned Git revision. Runtime cleanup still requires caller/deployment inventory, a tested replacement, and rollback; this documentation cleanup deletes no runtime source.

## Verification

```bash
# Documentation/instruction changes
git diff --check
npx -y pnpm@10.34.4 verify:guards

# Runtime/contract/integration changes
npx -y pnpm@10.34.4 verify
git diff --check
```

Record what actually ran at an exact SHA. Source review, fakes and previous green tests are not device, live-adapter, staging or production proof. Do not deploy or mutate hosted state without separate authorization. Register and hand off work through [the existing ledger protocol](docs/foundation/EXECUTION-LEDGER.md).
