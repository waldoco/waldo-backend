# Waldo Backend Documentation

## Current entrypoints

- [Personal-agent product architecture and build plan](planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md): proposed single backend roadmap, connector sequence, tests, and cleanup authority. After review/merge it governs backend roadmap, dependency order, and documentation cleanup; conflicting product-scope or architecture seams remain non-authoritative until the Brain launch contract/ADR dispositions are published, the plan/entrypoints are repinned, and `accepted-adrs.json` is regenerated.
- [Personal-agent launch contract — pinned Brain revision](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md): current cross-repository product authority and durable product/privacy baseline; G0 must amend its WhatsApp-complete-release and M0–M8 sequencing before the plan's conflicting release cuts become live.
- [Next session](foundation/NEXT-SESSION-PLAN.md): short backend execution view; read current source and the owning issue next.
- [Execution ledger protocol](foundation/EXECUTION-LEDGER.md) and [live #116](https://github.com/Pin4sf/waldo-backend/issues/116): session ownership and evidence.
- [Contributor onboarding](foundation/CONTRIBUTOR-ONBOARDING.md), [operating workflow](foundation/AGENT-OPERATING-WORKFLOW.md), and [verification pipeline](foundation/LOCAL-DEV-TESTING-PIPELINE.md): engineering method, not a separate release definition.

The old [next-backend prompt](foundation/NEXT-BACKEND-SESSION-PROMPT.md) and dated planning files are compatibility redirects. Do not maintain a second product or sequencing plan in them.

## Retained decision and source evidence

- Accepted ADRs and released schemas: binding for their exact seam until explicitly amended.
- Existing `docs/ledger/` handoffs: durable execution evidence, not current sequencing.
- The dated planning/research paths are short historical redirects to exact Git history. Their unique stable decisions and current source register were migrated into the canonical plan.

The Brain launch contract, accepted ADRs, and released wire contracts are not silently changed by this documentation pass. The canonical plan names the launch-contract and ADR changes required; they become live only when published in Brain, repinned, and resynced here. Historical references to Telegram/Discord or desktop as mandatory launch surfaces do not govern the proposed personal-agent release. Health is a launch capability while consent remains optional per person. WhatsApp provider admission and eligible live activation are separate proposed gates.

## Evidence rules

Live progress belongs in issues/PRs, not copied tables or new state dashboards. Pin source and test evidence; classify architecture, contracts, module implementation, adapter conformance, cross-surface acceptance and operational proof separately. Existing audit findings are not automatically true of a later head.

No runtime source, migration, protected soul file, or canonical rule mirror was removed by this reconciliation. Retired research/planning prose was removed from the live tree after its current decisions and source register were migrated; every full original remains recoverable at the exact `e91bee0` links in its historical redirect. See the canonical plan's cleanup register for tested replacement/decommission gates.
