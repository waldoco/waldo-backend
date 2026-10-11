# Lanes and delegation, 11 October 2026

This plan follows the owner's sessions-alignment review. It assigns who builds what toward the website promises, app first.

It is a planning document. Merges, deploys, migrations and PR closes each still need the owner's go, in the session that runs them. Current source and tests decide capability.

| File | What it is |
|---|---|
| [SESSIONS_ALIGNMENT_REVIEW.md](SESSIONS_ALIGNMENT_REVIEW.md) | A snapshot audit of all 16 Claude sessions, the path to the iPhone, the structural findings and the coverage map |
| [IDENTITY_ROOT_PLAN.md](IDENTITY_ROOT_PLAN.md) | One owner on every surface: what is already rooted on the user id, what is Telegram-shaped, Google connect, the ordered slices |
| [APP_CHAT_PLAN.md](APP_CHAT_PLAN.md) | The app chat as the core (owner direction, 11 Oct afternoon): the gap map against Claude, ChatGPT and the website, the session decisions, the order of work |
| [lanes/](lanes/) | One brief per lane we own (L1–L4), the bounded browser lane, and the PR sweep |
| [instinct/](instinct/README.md) | Three self-contained briefs delegated to Instinct |
| [handoffs/](handoffs/) | The stopped gap-analysis lane's hand-off, kept for L3 |

## Owner rulings recorded here (11 Oct)

- **Proactive delivery** goes to the owner's chosen surface; otherwise to the app. This includes Telegram-linked owners until a "deliver to" setting exists.
- **One main conversation per owner** across all surfaces. Threads stay app and console only.
- **Telegram is a test surface.** The app is the main surface, and the console uses the same owner and contracts.
- **We own the work that ties app and backend together.** Instinct takes disjoint slices under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md`, and we review them before merge.

## Lanes

| Lane | Session | Brief |
|---|---|---|
| L1: health plane and staging deploys | New session | [lanes/L1-health-and-staging.md](lanes/L1-health-and-staging.md) |
| L2: owner identity and delivery router | The existing event-route session (#1034) | [lanes/L2-identity-router.md](lanes/L2-identity-router.md) |
| L3: approvals, app contracts, Google connect, ledger | New session | [lanes/L3-approvals-contracts-connect.md](lanes/L3-approvals-contracts-connect.md) |
| L4: app, TestFlight build for Suyash | The existing #16 app session | [lanes/L4-app-testflight.md](lanes/L4-app-testflight.md) |
| Browser and computer (bounded) | The existing browser session (#1032) | [lanes/BROWSER-bounded.md](lanes/BROWSER-bounded.md) |
| PR sweep | Short-lived session | [lanes/PR-SWEEP.md](lanes/PR-SWEEP.md) |

**Instinct briefs and who reviews them:**
- 01, health score calculations: L1.
- 02, weather tool: L1; L2 adds the one registration line in `telegram-owner-do.ts`.
- 03, connector read depth: L3.

**No new task chips for flakes or side work.** Before starting a new session, check it against the path to the iPhone in the review.

## Consolidate first, then build on top

These are ordered so that each lane builds on a `beta-mvp` that matches staging.

1. **#1034** (L2): adapt the routing to the 11 Oct ruling, then merge. Staging already serves its unmerged tip `625214cc`.
2. **This docs PR**, so every lane and Instinct reads the same plan from `beta-mvp`.
3. **#1031** (L1, H3 health routes): merge `beta-mvp` up, CI, merge. Then **one staging deploy of the `beta-mvp` tip**, which also carries the merged-but-undeployed #1022, #1024, #1028 and #1030.
4. **Piece A** (L3): rebase `feat/approvals-any-surface`, finish round 4, fix C13, open the PR.
5. **Small open items:**
   - #1033: test-only; rebase and merge, or close.
   - #1029: fold C11–C13 into the ledger, then close.
   - #1032: keep as the browser design until the owner approves it.
   - waldo-app #27 (checklist) and #29 (Simulator seeder): merge or close.
   - waldo-app #16: close once its remaining slices are ported or dropped.
6. **Ashish's PRs:**
   - #1017 (iMessage): renumber its migration above `20261011000000` before it can apply.
   - #1006 (device bridge).
7. **Brain `Pin4sf/waldo-brain#34`:** revise for rulings 11, 13, 15 and 16, then merge. Then repin CLAUDE.md and regenerate `accepted-adrs.json`. This blocks no code.

**Re-cut sources.** Do not merge these; the named lane mines them:
- **#998:**
  - L1: health, history, backfill, rights for the health purge;
  - L3: threads, memory correction, receipts, controls, work;
  - L2: channels, proactivity.
- **#915, #931, #932:** L3 in Phase 2 (levels, grants, responsibilities, cost ledger).
- **#908 (S0 files), #973, #987:** the browser lane.

**Close after the owner's go:**
- the browser drafts audited in #1032: #881, #894, #895, #906, #911, #941, #966;
- the "DO NOT MERGE" pins #840 and #847;
- the rest of the stale drafts, once the PR sweep has triaged them.
