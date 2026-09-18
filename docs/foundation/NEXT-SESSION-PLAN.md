# Next Session — Waldo Personal Agent

**Status:** sole backend execution entrypoint

**Updated:** 2026-09-18

**Candidate build roadmap:** [Personal-agent product architecture and build plan](../planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md). After review/merge it governs backend roadmap, dependency order, and documentation cleanup; conflicting product-scope or architecture seams remain non-authoritative until the Brain launch contract/ADR dispositions are published, the plan/entrypoints are repinned, and `accepted-adrs.json` is regenerated.

**Current product-scope authority requiring G0 amendment:** [pinned Brain launch contract](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md)
**Coordination:** [ledger protocol](EXECUTION-LEDGER.md), [#116](https://github.com/Pin4sf/waldo-backend/issues/116), and the owning issue/PR

This page says where to resume. It does not duplicate implementation architecture, market research, or the live issue tracker.

## Fresh baseline

Fetched and inspected 2026-09-18:

- backend `origin/main@e91bee017b0c36759cbfda1353fc11c73e3afe0a`;
- app `origin/main@7218c18fed8b874492e3831bbb5bd1e1c58abe58`;
- Brain product contract branch `be08c4afa6f356c66600e73ae0bf54e5d7a3a158`;
- backend documentation reconciliation branch `c91fa51`;
- app documentation reconciliation branch `97b43ff2`.

Backend evidence at `e91bee0`:

- contracts: 74 files / 1,584 tests passed;
- runtime: 43 files / 1,152 tests passed;
- workspace typechecks: passed;
- static guards: passed;
- full Supabase/`verify`, staging, live adapters, native device, and production: not run or not proved by this documentation pass.

Re-fetch and re-pin before implementation. Preserve the dirty active backend and app checkouts; use fresh isolated worktrees.

## Current boundary

The backend has a strong owner-routed governance/durability kernel: Coordinator, planning/execution state, RunLoop, Judgment Authority, context/sanitization foundations, and closure contracts. It does not yet have the production conversation, connectors, delivery, memory experience, multi-presence, Trusted Relationships, or deployment needed for an Instinct-class personal agent.

Two truth gaps must be resolved early:

1. closure v0.6 endpoints appear in generated OpenAPI but have no runtime route/module on main;
2. the current identity module permits one registered Presence per owner, while app + email + WhatsApp requires governed multiple presences.

The app has real HealthKit/SQLCipher and iPhone/watch targets, but false-success chat behavior, contradictory health-upload copy/defaults, incomplete account/consent lifecycle, mock watch state, no App Intents/background HealthKit proof, and no native tests block release claims.

## Next authorized implementation frontier

Do not begin implementation merely because this plan exists. Under a bounded user-authorized issue, take only the first dependency frontier:

1. create clean backend/app worktrees from freshly fetched remote main;
2. reproduce the exact verification baselines;
3. publish the amended/superseding Brain launch contract and the plan's ADR disposition packet, repin all entrypoints, and regenerate/diff the backend ADR snapshot;
4. remove app fictional success and prove pending/error/receipt UI;
5. decide/version the closure OpenAPI/runtime mismatch;
6. contract Supabase conversation publication, governed multi-presence, per-account/consent lifecycle, model-route data-class egress, and the Vault/typed-connector-proxy boundary;
7. write the G1 run contract for one authenticated, durable, real-model app conversation with Profile Claim correction/deletion;
8. stop before Google implementation until G1's contracts, writer, privacy, tests, and rollback are reviewed.

After the applicable Brain authority changes are published and repinned, advance the plan's gates in dependency order: Calendar; Trusted Relationships; Gmail/Drive/Granola/proactivity; physical-device health; supported health patterns; Swiggy; browser fallback; joined channels; Kennel work bridge.

WhatsApp India activation is currently blocked by the public Business Solution Terms for a general-purpose AI provider. Pursue Meta Third Party Agent/provider admission as a disjoint external lane; do not build a production adapter without an official contract/test tenant and never use an unofficial linked-device workaround.

## Stable rules

- Keep one owner authority root and one durable writer per aggregate.
- Ordinary chat does not require Mission/Outcome ceremony; durable responsibilities do.
- Resolve the smallest per-turn capability manifest; a connection is not blanket permission.
- Persist frozen effect intent before I/O; reconcile ambiguity before retry.
- Provider or model `done` is an observation, never Verification or Acceptance.
- User correction outranks inference; memory and relationships are not authority.
- Raw health and credentials never enter generic prompts, traces, DO memory, or fixtures.
- Each Waldo in a Trusted Relationship acts only for its own owner.
- Local/fake/schema/simulator proof is never staging, device, channel, or production proof.

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

App and native claims run in `waldo-app` with its pinned package manager plus simulator/physical-device evidence appropriate to the claim. Every PR records base/head, scope, writer ownership, schemas, evidence, rollback, consumer actions, and worktree disposition. Register/handoff through #116. Deployment and hosted mutations require separate explicit authority.
