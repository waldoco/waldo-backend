# L3: approvals, app contracts, Google connect, ledger

**Owner:** a new Claude session, the successor to the stopped gap-analysis lane. Repo: `waldoco/waldo-backend`, base `beta-mvp`.

## Why

When the gap-analysis lane stopped, three things on the iPhone path were left with no owner:
- **Approvals from the app (piece A).** It sits on a branch with no PR.
- **The app contracts.** The sole editor of `packages/contracts/src/app/*` is gone.
- **Connecting Google from the app.** There is no route, and the app has a legacy path that writes a store the backend never reads.

## Read first

- [`../handoffs/GAP_ANALYSIS_HANDOFF_2026-10-11.md`](../handoffs/GAP_ANALYSIS_HANDOFF_2026-10-11.md): piece A round 4, open owner decisions, verification habits.
- [`../IDENTITY_ROOT_PLAN.md`](../IDENTITY_ROOT_PLAN.md) §1 (the Google findings) and §3 (G1–G4).
- Ledger §2 (the omnipresence acceptance rule) and §12 (lanes and rules).

## Queue (Phase 1)

1. **Take over as sole editor of `packages/contracts/src/app/*`.**
   - Announce it on #116.
   - The app pins six of these files byte for byte. Changes are additive.
   - A new row-level or page-level value needs a version bump, or an app re-pin first.
2. **Piece A: approvals from any surface.**
   - Rebase `origin/feat/approvals-any-surface` (@ `9c6056b0`) onto `beta-mvp`.
   - Finish round 4 (ruling 16): the full MCP and browser review shown and approvable in the app, with secret-type fields masked on every surface.
   - Fix C13: the branch adds `google_task_change` inside the strict approvals page, which makes an older app pin fail closed.
   - Open the PR, then send L4 the final contract diff.
   - It touches `approvals.ts` and `telegram-owner-do.ts`: coordinate with L2.
3. **"Deliver to" setting.** A control in the app contract and the console that L2's router reads (owner ruling: otherwise app).
4. **Google connect from any surface.**
   - **G1:** a connect route or action issuing the same `/c/<ticket>` with surface `app`, the existing `waldo://oauth/complete` deep link, and a migration allowing connect channel `app` (reserve the number).
   - **G2:** with L4, retire the app's legacy `oauth-google` path.
   - **G4:** ask the owner to confirm one OAuth client (`GOOGLE_CLIENT_ID` vs `GOOGLE_OAUTH_CLIENT_ID`).
5. **Threads contract** (app and console only), from #998's threads slice.
6. **Keep ledger §12 current.** This includes:
   - the corrections C11–C13 in #1029 (fold them in, then close #1029 or merge it as a dated snapshot);
   - the 10 Oct 19:05Z rulings: cohort 5–10 (at most 50); $25 per user per month; browser tasks from any surface;
   - the 11 Oct rulings in [`L2-identity-router.md`](L2-identity-router.md).
7. **Review Instinct brief 03** (connector read depth) when its PR arrives.
8. **Brain ADR PR `Pin4sf/waldo-brain#34`.** One revision pass when idle: it predates rulings 11, 13, 15 and 16.

## Phase 2

- Levels and grants (#932, slice I), responsibilities (J), cost ledger (L, $25 per user per month), activity log with decision provenance.
- Export and delete (#998 rights).
- Memory correction (through the existing single write path: no chat `update_memory`).

## Rules

- **Per-action owner go** for merges and migrations.
- **Testing:**
  - red-first;
  - every Zod schema gets a valid and an invalid test;
  - report PASS / FAIL / NOT RUN / UNAVAILABLE at the exact SHA.
- **Peer messages get dropped.** Put anything another lane must know on #116, or in the PR, as well.
