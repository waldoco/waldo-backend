# Overnight decisions, 12 Oct 2026

Decisions the orchestrator made on the owner's behalf under the brief ([ORCHESTRATOR_BRIEF_2026-10-12.md](ORCHESTRATOR_BRIEF_2026-10-12.md)). These are **delegated decisions, not owner rulings.** Each says how to reverse it. Owner rulings are quoted in the brief and the log, never restated here as decisions.

| # | Time (UTC) | Question | Decision | Alternatives | Why | Reverse by | Unblocked |
|---|---|---|---|---|---|---|---|
| D1 | 21:45 | Merge order for L2's send-path follow-up and #1066 | Follow-up first, then #1066 after it is brought up to the current `beta-mvp` with a merge from base, so its CI runs on today's base | Merge #1066 now (CI 6/6 is from 19:08Z, before #1074); merge both together | #1066's proactive deliveries use the same strict `load()`, so they would fail for an account with a bad row until the follow-up lands (L2's report). CI on a stale base is weaker evidence. | Merge #1066 first in the morning; nothing irreversible | L2 |
| D2 | 21:47 | The app repo has no CI, so gate item 1 ("CI green, pgTAP included") can't be met for waldo-app PRs | **CI-equivalent, not CI:** before merging an app PR, the orchestrator runs `pnpm install --frozen-lockfile`, `pnpm run check` and `pnpm test` itself, at the exact head SHA, in a fresh detached waldo-app worktree it creates (not L4's tree, not L4's report). Any install drift or failure means hold. Each merge is logged as CI-equivalent. | Hold every app merge for the morning | The owner's standing go names "app main", so holding all app merges would defeat it. An independent run at the exact SHA is the strongest proof available without CI. | Revert the merge on app `main`; or rule that app merges wait for the owner | L4 |
| D3 | 21:47 | L2's order after the follow-up and #1066: S7 spike or the `defer` desk branch first | The `defer` desk branch first, then the S7 spike | Keep L2's handoff order (S7 before W4) | "Not now" is on the golden path (tonight's priority 2), and #1070's guard answers `defer` with 409 until the desk branch lands. Push is priority 7 and waits on the owner's APNs key anyway. | Tell L2 to swap back | L2, L4 |
| D4 | 21:47 | How the orchestrator talks to lanes, given the cross-session message cap | A pull channel: `OVERNIGHT_BOARD_2026-10-12.md` on the pushed branch, which lanes read with `git show`. Lanes hand over a PR by marking it ready for review with its claims in the body. Messages only for urgent blockers. | One message per lane per cycle | The brief warns cron-fired prompts may not reset the 10-message cap. Six were used by 21:50Z. | Return to messages | all lanes |
| D5 | 21:53 | The skipped `input_origin` row: skip it on every read path (L2's follow-up), or accept its value on read as legacy data (the old alignment session's suggestion) | **Skip it, as L2 plans.** Don't widen the validator. | Accept the legacy `inputOrigin` on read for display and send; or migrate the row reversibly | Git evidence: the rule `role === 'user'` requires `inputOrigin` `owner` or `machine` arrived with the canonical store itself (`e35d0262`, 10 Oct). The only user-entry writer on `beta-mvp` always sets it (`owner-turn.ts:580`), and the forget redaction keeps it (`...entry`, `contracts/src/runtime/conversation-entry.ts:84`). So no merged build wrote the row; a build outside `beta-mvp` did, as L2 suspected. `inputOrigin` decides whether text counts as authenticated owner input (`canonical-owner-store.ts:23-24`), so accepting a row without it would mean guessing its provenance. Skipping hides one row from display and context and rewrites nothing. | Accept the value later in a separate, reviewed change, if the owner wants that row back; the stored row is untouched | L2 (no change to its plan), old alignment (answered) |
| D6 | 22:00 | An app-channel owner whose stored zone came from a routing header (unconfirmed) and already equals the phone's zone gets no "Use this device's time zone" row, so after #1066 their heartbeat, day cards and nightly never arm | **App: show a one-tap "Confirm" row whenever `timezone_confirmed` is false, even when the zones match.** Tapping calls `timezone.set` with the shown zone. The auto-write stays exactly the owner's option (a): only while unconfirmed and still `'UTC'`. | Auto-confirm when the stored zone equals the phone's zone (beyond the ruling's literal "only while … UTC"); mark header-written zones confirmed in #1066 (they are routing data, not the owner's choice) | It closes the deadlock with an explicit owner tap and keeps the ruling's letter: nothing is replaced and nothing is confirmed without the owner. | Remove the row; or the owner rules the auto-confirm in the morning | L4, L2 (#1066 depends on it for those owners) |
| D7 | 22:00 | The 18+ checkbox (owner ruling: sign-up with an 18+ checkbox) has no field in the sign-up request schema | **Tonight, an app-side gate:** sign-up can't proceed until the box is ticked. Recording the attestation server-side (an additive `app.v1` field, plus storage that likely needs a migration) goes in the morning batch. | Hold the checkbox until the contract and storage exist | The ruling's visible behavior ships tonight and is trivially reversible. Server-side storage needs a migration and a privacy review, which are morning items. | Remove the gate | L4 |
| D1a | 22:07 | Revision of D1: does #1066 wait for the follow-up to *merge*, or only to *deploy*? | **Merge #1066 as soon as it passes the gate; deploy only once the follow-up is merged too.** | Keep D1 (merge the follow-up first) | D1's risk was staging running #1066's proactive deliveries into the strict load. That's a deploy question, and L1 deploys only tips I report. Merging early also tests the merge path hours before the deploy window. L2 asked for "follow-up first, or together"; from staging's view this is together. | Revert the #1066 merge commit on `beta-mvp` | L2 |
| D8 | 22:32 | #1066 after its review (FAIL on re-plan and a clock-dependent test; HOLD on health destinations) | **Held for the owner's morning ruling.** L2 fixes the re-plan, the test and the held-skip trace tonight, so the PR is ready the moment the owner rules. | Merge with a follow-up issue (rejected: the brief holds anything that widens health-data destinations); drop the day-card arming from #1066 (a product cut I shouldn't make) | Health-log numbers in the machine prompt reach `conv:*` and `episodes` for a new population (app-only owners). The owner must decide whether those count as forbidden values. | Owner merges after ruling | L2 |
| D9 | 22:34 | Pacing under the account's 5-hour usage limit (81% at 22:33Z, resets 01:30Z) | **Until 01:30Z:** no new subagents; heartbeats do only a few cheap checks (`gh pr list`, `/healthz`, new #116 comments); app PR reviews and merges are batched into 01:30–02:15Z (the app is built from source in the morning, so no deploy waits on them); the promise map is written after the reset. The only critical action before the reset is L1's deploy of `889efa27` and its probe. | Keep full cycles and per-PR review subagents (risks stopping every session before the deploy is verified) | Spend the remaining budget where it changes the morning: send works on staging. | Resume full cycles at any time | all |

## Correction to D5 (03:20Z)

D5's provenance claim, that no merged build wrote the row, was wrong. [verified from git objects]
- `40522697` (7 Oct) is an ancestor of `889efa27`. It added `packages/runtime/src/channels/owner-canonical-history.ts`, which wrote canonical rows under today's prefix `canonical-owner-v1:<principal>:<tenant>:`:
  - `conv:<slot>`, `witness:<id>` and `lineage` keys;
  - a count under `conv-count` (`:69`, `:87`), not `count`;
  - no `inputOrigin` field anywhere in contracts or runtime (introduced only in `e35d0262` on 10 Oct).
- `2afc6ebd` (8 Oct) deleted that file. `e35d0262` (10 Oct) added today's store, with `count`, `leaf` and the `inputOrigin` rule.
- So the skipped row and the missing `count` key both fit a store last written by the 7–8 Oct build on `beta-mvp`'s own history.
- My mistake: I searched only the current store's history, from `e35d0262` onwards.

The decision stands: skip the row, and don't widen the validator.
- What's still unknown is the row's origin, owner or machine, which the old build never recorded. Accepting it would still mean guessing.
- A separate, reviewed change could read such legacy rows (canonical lineage, no `inputOrigin`) as `machine`, the least-authority value, so they show again without counting as owner input. That's for L2 and the owner.
- Exposure: any staging owner whose store the 7–8 Oct build wrote has `conv-count` but no `count`. On `889efa27`, each send there overwrites the next old slot until the count passes the last old row. #1080 fixes this.

## D10 (05:51Z, daytime; an orchestrator engineering decision, not an owner ruling)

**Question.** L4 asked whether an approval left `open` after its `expires_at` has passed should be shown as expired by the app, or moved to expired by the server.

**Decision.** The server owns approval state, and the app adds no client rule.
- The fix is L3's server-side expiry branch, which moves past-expiry rows to `expired` on read or in a sweep.
- Until it deploys, staging shows a contradictory badge on two 9 Oct approvals.

**Why.** One owner per policy. A client rule would duplicate the expiry policy in two places, and the copies would drift.

**Reverse.** Add the client rule later if L3's fix slips.

**Unblocks.** L4 relabels nothing, and L3's PR is the single fix.

## D11 (09:59Z, daytime; an orchestrator decision, not an owner ruling)

**Question.** L2 asked which custody key app turns should use for skill activations (SHOULD, #1088). (a) `principal_ref` only. (b) A bridge: the DO's own stored, verified Telegram subject, then `principal_ref`.

**Decision.** (b) for today. The bridge reads only the DO's stored subject, never one from the request.
- Tests:
  - a seeded Telegram-custody row loads on an app turn;
  - a fresh DO uses `principal_ref`;
  - a row stamped with another subject or principal stays disabled.
- L2's evidence for option (i) shows the DO can't be re-bound to another owner's app principal:
  - `do_name` is `not null unique` and minted as `'owner-' || gen_random_uuid()`;
  - it is never rewritten;
  - the app principal is `prn_<owner_id>`, resolved by `do_name`.

**Why.**
- Under (a), the Telegram-linked probe account's activations show as disabled on the app, so probe 7 fails.
- Skills are instructions, not permissions.
- No data is rewritten.

**Reverse.** Revert the PR. Both surfaces move to `principal_ref`, with a reviewed re-stamp, in E15's routing slice.

**Gate.** The PR touches user isolation, so it is on the hold list: the owner merges #1088, not the orchestrator.

**Unblocks.** Probe 7 ("Prep me for my 3 pm") on a Telegram-linked account.

## D12 (11:44Z, daytime; an orchestrator sequencing decision, not an owner ruling)

**Question.** G1, earlier tool results reaching the reply, needs about 5 lines in `owner-turn.ts` and `telegram-owner-do.ts`, both hot files. #1089 (Weight) also changes `telegram-owner-do.ts`. L2 offered to wait until #1089 lands.

**Decision.** Don't wait. L2 builds G1, hot-file lines included, in parallel, and posts the exact lines on #116 before pushing. Whichever PR passes its gate first merges first, and the other merges base (merge, no rebase).

**Why.**
- #1089 merges only on the owner's yes in L1's session, which may take hours.
- G1 is core to E17: the agent works end to end in the app, and earlier tool results reach later turns.
- The two PRs touch different parts of the file. #1089 adds 8 lines at `:615-618`, near `appContext` at `:596`, so any conflict should be small and textual [inference].

**Reverse.** Hold G1's push until #1089 lands, as L2 first offered.

**Unblocks.** G1 starts now, not after the owner's next answer in L1's session.

## D13 (11:53Z, daytime; an orchestrator engineering decision, not an owner ruling)

**Question.** The owner asked that strict checks fail per item, not per read, as #1075 does for chat history. A sweep at `614d1aff` found three different skip shapes in the code:
- the history store logs `history_rows_skipped` with the check and a count;
- the recall gateway reports `row_rejected`/`partial`;
- the tool-output ledger deletes bad rows and records no code.

**Decision.** One standard, with no shared helper:
- Reads of stored data skip the bad item and log one fixed-code line with the check and a count, never ids or text.
- A row tied to a promise the owner can see, such as a reminder, is skipped in memory and never mutated, so a rolled-forward Worker can still run it.
- Authority, approval, receipt and effect chains, canaries and write paths keep failing closed.

**Why.** One concept, one log shape. The sites differ in what a skip means (exclusion in memory, an omission line, a safe default), so a shared helper would hide those differences. The scheduler case shows why a mutation is wrong: a quarantine with no expiry would lose a reminder that a rollback merely failed to parse.

**Reverse.** Per site. Each fix is its own small PR.

**Unblocks:**
- L1: the scheduler fix (`multiplexer.ts`). One bad row currently stops all scheduled jobs for that owner [verified].
- L2: the per-hit episode-read fix (`owner-turn.ts:333-337`), after G1.
- Backlog: `loops.ts` `proactivity()`, `update-cards.ts` `unfolded()`, and the recall length cap. Each needs a corrupt row or a live recall gateway first.
