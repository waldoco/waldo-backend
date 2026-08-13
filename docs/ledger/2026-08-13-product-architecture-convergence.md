# Product Architecture Convergence and Launch Surfaces Handoff

## Identity

- **Date:** 2026-08-13
- **Owning issue:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116)
- **Launch umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
- **Backend branch:** `codex/waldo-launch-ledger`
- **Backend base:** `d34d0a6`; current `origin/main` observed at `51da2d1`
- **Scope:** documentation authority, B0-B6 sequencing, launch-surface acceptance, GitHub delivery workflow, and cross-session convergence
- **Runtime implementation:** none

## What Was Built

- Converged the product around one owner-bound Waldo across Electron Kennel, Waldo mobile, and messaging presence.
- Made Telegram and Discord required launch adapters; WhatsApp remains a primary target but vendor approval is non-blocking.
- Reconciled the backend milestone, B0-B6 issue dependency map, surface labels, channel labels, and cross-repository desktop/mobile lanes.
- Retired HEY-109, the Linear session bus, stale wave sequencing, and completed one-off handoffs as current authority.
- Added the GitHub-backed [execution-ledger protocol](../foundation/EXECUTION-LEDGER.md), PR convergence template, and a copy-ready next-session B0 prompt.

## What Works (with evidence)

- Documentation whitespace: `git diff --check` — PASS before publication across backend, Brain, Types, and the clean App worktree.
- Backend governance guards: `npx -y pnpm@10.34.4 verify:guards` — PASS before publication.
- Local Markdown links: audited across the live documentation packet — PASS before publication.
- Backend full wall: typecheck and 58 contract files/1,475 tests passed; `verify` then stopped because Docker/OrbStack was unavailable, so Supabase/Worker/session-revocation/full-wall proof remains unavailable.
- Backend runtime: 37 files and 994 tests passed; one file and seven tests failed with `responsibility authority denied`. The two `authenticatedSessionExpiresAt: 2026-08-08T00:00:00.000Z` fixtures are also present on `origin/main`, classifying this as the pre-existing B0 expiry failure rather than a documentation regression.
- GitHub workflow: milestone, labels, #78, #86, #107-#116, Kennel #26-#28, and mobile #6-#8 were inspected after mutation.
- Independent Spec review: B1/channel ownership and desktop dependency findings were corrected.
- Independent Standards review: readiness criteria and mobile-lineage sequencing findings were corrected.

## What Doesn't Work Yet

- **B0 baseline is not green:** severity HIGH; owner B0 implementation session; dependency [#107](https://github.com/Pin4sf/waldo-backend/issues/107). Runtime previously showed seven failures caused by expired authorization fixtures.
- **Full repository wall is not proved:** severity HIGH; owner B0 implementation session; Docker/Supabase was unavailable at the observed local OrbStack socket.
- **Launch surfaces are not integrated:** severity HIGH; disposition dependency-ordered B1-B6 work; owners are the linked backend, Kennel, and mobile issues.
- **WhatsApp approval is unavailable:** severity MEDIUM; disposition explicitly non-blocking; owner [#115](https://github.com/Pin4sf/waldo-backend/issues/115) after external approval.
- **Types dependency audit is not clean:** severity HIGH; owner [Pin4sf/waldo-types#8](https://github.com/Pin4sf/waldo-types/issues/8). The npm-managed repository passed typecheck and 20 files/248 tests, but `npm audit` reported three high transitive findings and one low finding; no dependency change was included in this documentation publication.

## Architecture Decisions or Conflicts

- One backend authority root owns identity, Outcome state, authority, context, evidence, verification, acceptance, Open Loops, and ordered projections for every surface.
- Channel payload identity is untrusted input. Provider delivery is transport evidence and cannot close an Outcome.
- Health First is recommended, never required; health-declined users retain the complete core Waldo path.
- GitHub issues, milestones, labels, PRs, and ledger evidence are the current delivery workflow. Linear and HEY identifiers are historical only.
- Only B0 starts next. Parallel surface work consumes released contracts/fixtures and cannot claim integration before its named gate.

## Parallel Agent and Worktree Ledger

| Lane | Role | Scope | Result | Write ownership |
|---|---|---|---|---|
| Root session | integration owner | docs, GitHub reconciliation, verification, publication | adopted | backend authority documents and GitHub state |
| `planner` | read-only planner | stale docs/issues and B0-B6 reconciliation | adopted after source check | none |
| `launch_surface_planner` | read-only planner | Telegram/Discord/WhatsApp gate placement | adopted after source check | none |
| `spec_review` | independent reviewer | contract ownership and dependency correctness | two findings fixed | none |
| `standards_review` | independent reviewer | workflow/readiness consistency | two findings fixed | none |

The backend checkout also contains unrelated, pre-existing skill-import, settings, and `.understand-anything` WIP. That WIP is not part of this handoff or publication. Historical worktrees remain navigation evidence only; a future session must not infer that they are active from their existence.

## Hard-Won Lessons

- A single mutable session-state document becomes a conflict hotspot. GitHub issue comments are better live coordination; bounded immutable handoffs are better durable context.
- Surface parallelism is safe only behind a released contract/fixture boundary. Shared writers and schemas need one integration owner and explicit merge order.
- Messaging delivery needs a separate reconciliation truth from product completion; vendor `sent` or `delivered` cannot advance Outcome closure.

## Next-Session Prerequisites

1. Start from fresh `origin/main` in a clean worktree and register `SESSION START` on [#107](https://github.com/Pin4sf/waldo-backend/issues/107).
2. Inspect PRs #99 and #100 against current source and CI; do not inherit their claims from tracker prose.
3. Define the B0 run contract, repair the time-relative fixture and migration-lineage/public-route gaps as separate reviewable changes, and run the complete wall at one SHA.
4. Run breaker plus independent Standards and Spec review.
5. Close B0 only when another clean checkout reproduces the evidence; then promote #81 and no other B1 issue.

## Files Changed

- Repository entrypoints: `README.md`, `AGENTS.md`, `docs/README.md`.
- Current operating packet: `docs/foundation/NEXT-SESSION-PLAN.md`, `NEXT-BACKEND-SESSION-PROMPT.md`, `CONTRIBUTOR-ONBOARDING.md`, `AGENT-OPERATING-WORKFLOW.md`, `LOCAL-DEV-TESTING-PIPELINE.md`, and this ledger protocol.
- Product authorities: convergence, architecture lock, capability matrix, final Home/Work detail, and retained source/audit notes under `docs/planning/`.
- Governance: mirrored universal rules, accepted-ADR manifest, stale-reference guard, HEY-109/session-bus retirement, and `.github/pull_request_template.md`.
- Reference evidence: `docs/planning/GROK_BOT_PRODUCT_RESEARCH_2026-08-12.md`.
- Cross-repository rule retirement: `waldo-brain`, `waldo-types`, and a fresh `waldo-app` publication branch.
