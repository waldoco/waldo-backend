# App brief: the constellation and memory the app should reflect (30 Oct 2026)

For the app lane (Suyash). Source: a read-only audit of backend `beta-mvp` 776489078 and app `main` e935d649. File:line references point at those commits.

The backend fixes run in a separate lane:
- a correction no longer orphans its node;
- the console gets node confirm and correct.

Everything below is app-side. None of it needs a backend contract change, except re-pinning to the contract revision the backend already serves.

| # | Severity | Gap | Where | Fix |
|---|---|---|---|---|
| 1 | HIGH | After the tour, nothing can confirm a node read from mail or calendar. Those nodes rest on `untrusted` supports, and Waldo can't use them until the owner confirms. | Confirm, Not quite and Forget exist only in `FirstConstellation`, reached from the tour (`TourOverlay.tsx:136,199`). | Add `controller.nodeAction` (`node.confirm`, `node.correct`, `node.forget`) to `ConstellationPanel`. |
| 2 | MED | "That's not right" types a line into the chat composer instead of calling `node.correct`. | `ConstellationPanel.tsx:36-41`; the stale comment is at `view.ts:84`. | Call `node.correct`, and delete the stale comment. |
| 3 | MED | Every node shows a hard-coded "Unverified" badge. | `ConstellationPanel.tsx:111-112,144`. | Badge from `confirmation`, and show `sources`. |
| 4 | MED | No claims list. `toClaim` drops `source`, `kind`, `evidence` and `pinned`, and the empty state can say "nothing saved" while `counts.claims > 0`. | `constellationController.ts:31`, `ConstellationPanel.tsx:62-66`. | Read `memory_view=claims`, list the claims, and use the counts for the empty state. |
| 5 | MED | Pins and claim edits are unused, though the backend serves them from controls rev 2. | `contractRevisions.ts:11-12`; the backend side is `app-controls.ts:59,173-183`. | Offer `claim.pin`, `claim.unpin` and `claim.edit`. |
| 6 | LOW | Stale nodes look active, and their actions are refused. | `toNode` drops `stored_status` and `estimate` (`constellationController.ts:23-27`). | Map `stored_status`, and hide or disable actions unless the node is `active`. |
| 7 | LOW | After a correction, only `summary` is patched; the backend rewrites `label` too. | `constellationController.ts:165`. | Patch both, or re-read the node. |
| 8 | LOW | The app's contract copy predates rev 5–7 (the `setup` stage, the `days` view, identity fields) and sends `controls=3`. | `backend-999/controls.ts`, `contractRevisions.ts:14`. | Re-pin, and move to `controls=5` or later. Check `tourScript.ts:47-50` for a false "unreadable" when only the setup stage wrote nodes. |
| 9 | MED | A memory change in chat never reaches an open screen. Nothing pushes or polls memory: `appRuntime.ts:260` polls scores, day and approvals only. | `appRuntime.ts:260`, `InlineCards.tsx:91-96`. | Re-read memory on focus and after any chat turn whose receipt says memory changed. Until the backend adds that receipt, re-read on focus. |

What the owner sees when this is done:
- Every node Waldo learned can be confirmed, corrected or forgotten from the main constellation screen.
- Facts Waldo saved appear as a list that can be pinned and edited.
- Badges tell the truth.
- Changes made in chat show up when the screen is next opened.

## Additions from the memory redesign (waldoco/waldo-backend#1691), 30 Oct

Source: `docs/proposals/WALDO_MEMORY_REDESIGN_2026-10-30.md`. Each item is app-side. The backend slice named beside an
item must land first, unless the item says it works today.

| # | Severity | Gap | Backend | Fix |
|---|---|---|---|---|
| 10 | MED | A pattern resting on a replaced or dismissed note disappears from the app, so the owner can't correct or forget it. | S2 (#1695) lists it with `support.state: 'incomplete'`, which app.v1 already allows (`contracts/src/app/controls.ts:249`). | Render incomplete nodes: "a note under this changed". Offer correct and forget only. |
| 11 | MED | "Confirmed" will mean the owner confirmed the pattern's own wording, not that every note under it was confirmed one by one. | S1 (#1694) | Keep calling `node.confirm`. Badge from `confirmation`. The badge reads Waldo's read until the owner confirms the pattern itself. |
| 12 | MED | Gap 9: a memory change elsewhere never reaches an open screen. | Today: chat replies already carry receipt items `memory_stored` and `memory_forgotten`. Later: S3 (#1696) adds `memory_revision` to the day projection at **`controls=8`** (gate allocation). | Now: re-read memory on focus, and after a reply whose receipt has one of those items. After S3: re-read when `memory_revision` changes. |
| 13 | LOW | Notes and backlog items have no life areas. | S5 (#1698) adds seven areas: body, mind, home, work, people, goals, money, plus unsorted. The app.v1 revision for `area` is allocated when it is built. | Group by area, and let the owner change an item's area. Show `area` only once its revision is pinned. |
| 14 | LOW | Look-up findings' 30-day expiry is not shown. | Works today (`APP_FINDING_UNCONFIRMED_DAYS_V1 = 30`). S8 (#1704) adds keeping a finding from the Close card. | Show the expiry. A finding kept from the Close card appears as kept, the same as one kept in the app. |
| 15 | MED | People, organisations, places and projects are not shown as one thing each, and relationships are not drawn. | S9 (#1717) adds entities, with claims as the edges and validity in time. The app.v1 entity node and relation association get a revision from the gate when they are built. | Constellation: entity nodes beside the pattern nodes, relation edges labelled with their validity, filtering by area. Spots: entity chips, area and validity on each note. Patrol: background memory runs, with counts-only summaries. |
