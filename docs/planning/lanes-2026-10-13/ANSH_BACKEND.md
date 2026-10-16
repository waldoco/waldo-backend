# Ansh's cloud backend lane: what changed tonight (an addendum to #1103)

Ansh's cloud lane keeps its own brief: A0–G on #1103. This file adds the owner's rulings and the facts it doesn't have yet. The same text is posted on #1103.

## Owner rulings (Shivansh, 12 Oct about 21:06Z and 21:20Z)

1. **PRs merge and deploy tonight.** The Mac orchestrator merges any PR whose CI is green and that passes an independent review and the advisor, Ansh's included. It deploys `beta-mvp` tips to staging (Worker only) and tests on the Simulator.
   - This overrides #1103's "Nobody merges anything tonight".
   - **What this means for the cloud lane:** expect `beta-mvp` to move, and rebase onto it. Review findings arrive as PR comments.
2. **Still held for the owner:**
   - Database migrations: `supabase/migrations/`, any new DO SQLite table, or DO migration lineage. That includes **A3's "app connect route with its migration"** and any push-token table in E.
   - Production and secrets.
   - New third-party services other than Expo. Browserbase is already in the code, so A2 is fine.
   - New places health data goes.
   - Guard deletions or downgrades (D).

   Open such PRs anyway. They wait, labelled, for the owner.
3. **The `v6` rename (A0)** ships in its own deploy right after #1100's behaviour has passed a Simulator check, without asking.
   - Split it out, and land the behaviour PR first.
   - Keep G1's D16 filter and taint stamp, and #1098's per-origin ring, intact in `owner-turn.ts` and `tool-loop.ts`. The review checks them.
4. **Push uses Expo Push.**
   - Template text only, never health, email content or names.
   - At most three a day, with quiet hours.
   - The Brief pushes "Your Brief is ready".
   - **Before adding any table for push tokens:** `delete_owner` already removes "Vault push tokens". Reuse that storage if you can; a new table is a migration (held).
5. **Scheduled meeting prep may read related email,** within limits: only threads tied to the meeting, nothing stored or logged, and an ADR first.
   - The Mac Connectors lane owns this. If it needs the prep job's tools enabled in the owner DO, it asks on #1103.
6. **The owner kept "Patrol" and "Spots"** in the app. That's an app-lane matter.

## Work the Mac lanes are doing (don't duplicate it)

- **The P1 approval fix,** in the Mac Connectors lane.
  - **Symptom:** P1 failed on staging. The app saved a draft and raised no approval card.
  - **Cause [verified in source]:** `channels/telegram-turn.ts:15` gives every surface except Telegram and WhatsApp `approval: 'none'`. So app turns say "Approval delivery: none".
  - This is the Bible's PR A item "app approval presentation to native buttons". It isn't in A0–G.
- **Email reading:** unreadable bodies, porting #1042, the Meet link and attachments, Gmail beyond 60.
  - **Risk if you touch `CalendarItem`:** `calendarPrepDigest` spreads `...event`, so any new field re-preps every meeting after a deploy.
- **The duplicate `set_reminder`** (failed, then two accepted).

## Work handed to the cloud lane tonight

- **#1101 (E15)'s six non-blocking review items** join A3. The old L2 has them on branch `l2/e15-followups`, which it was asked to push.
  1. Make the dual-surface app send fail closed when no delivery is set.
  2. Log dormant records with their own code in the drain.
  3. A directory outage at the delivery's own recheck ends `quarantined/send_unknown`.
  4. The test at :326 should pin the terminal state.
  5. Re-pin the Telegram arm's `doName` and `bot` checks.
  6. Move four pieces of logic out of the hot file.
- **E15's Telegram copy stays on by default** (owner ruling). A3's switch must default to the current behaviour.

## State (12 Oct, 21:20Z)

- Staging and `beta-mvp` are both `e93a87c9`, with CI green.
- #1100 is at `a2db8589` and is DIRTY against `e93a87c9`.
- #1088 is closed.
- #1102 (the flaky run-loop test fix) is open, from a Mac session.
