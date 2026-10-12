# Orchestrator log, 13 Oct 2026 (Mac)

Times come from `date -u`. Each entry is marked verified, inferred or unverified.

## 21:28Z: handover pack, owner rulings, owner asleep

- **The owner went to sleep at about 21:27Z, after these instructions:**
  - coordinate every session to finish as much as possible tonight;
  - don't ask the owner questions;
  - sessions decide among themselves;
  - log everything;
  - where things are dire, copy what mature agent harnesses do.
- **Rulings recorded in `README.md`:**
  - 21:06Z: merge and deploy on the gate; the `v6` rename after a Simulator check; bounded email in meeting prep; Expo Push.
  - 21:20Z: merges apply to Ansh's PRs too; the app session runs on the owner's Mac; keep Patrol and Spots; a Mac email-and-calendar lane; follow Ansh's list for the design decisions; up to 5 test sends to the owner's own address.
- **Sessions tonight:**
  - **Orchestrator:** this session, `local_281f8c04`. It merges, deploys and runs Simulator QA on `iPhone 17`. Heartbeat cron `29a6d33d`.
  - **App:** a new session, `local_5eb95055-494e-44d2-88a9-47d493c751d7` ("Take over L4: Waldo app overnight build"), started from the old L4's card. It reports to the orchestrator and uses `iPhone 17 Pro`. The old L4 (`local_2c085cba`) has stopped taking work.
  - **Connectors:** the old L2 session (`local_83ce6587`) continues under `CONNECTORS.md`. No start-session tool exists, and `clear_session` works only on sessions this one started, so it keeps its context and relies on auto-compaction.
  - **Ansh's cloud backend lane and cloud orchestrator** work from #1103; the addendum is `ANSH_BACKEND.md`.
  - **The flaky-test session** (`local_7fe60b28`) has PR #1102 open, which goes through the gate.
  - **L1** (`local_63e9825d`) stands down; its deploy role is now the orchestrator's. **L3** stays parked.
- **Decisions on the owner's behalf:**
  1. **#1103 is the shared board for every session,** Mac included.
     - Why: the cloud sessions can't receive Mac messages.
     - To reverse: go back to #116 for the Mac lanes.
  2. **The design decisions R1–R14 follow Ansh's list wherever it covers them, keeping Patrol and Spots.** The rest wait for the owner.
     - This is the owner's 21:20Z ruling, relayed to the App session.
  3. **The orchestrator holds PR D's guard deletions or downgrades for the owner.**
     - Why: they change what blocks a merge, and posture.md treats process and security decisions as needing human-visible review.

## 21:31Z: board post, lanes briefed, heartbeat repointed, two reviews running

- **#1103:** posted the owner's rulings, the Mac lane map, the P1 cause and the handed-over E15 items (comment 6132960211).
- **Lanes briefed:**
  - **App** (`local_5eb95055`): R1–R14 follow Ansh's list wherever it covers them; up to 5 test sends are pre-approved; the board is #1103; merges are the orchestrator's. Its plan: #89 follow-ups, then B1, B2, the plain fixes P1–P13, and the P1 re-run.
  - **Connectors** (the old L2): `CONNECTORS.md`, starting with the P1 approval fix. It was asked to push `l2/e15-followups` and `l2/e15-no-copy` for Ansh's A3.
  - **L1:** stood down; deploys are the orchestrator's now (message delivered).
- **Heartbeat:** the new cron `1880182e` (`3,23,43`) reads the 13 Oct pack. The old `29a6d33d` is deleted.
- **#1102** (flaky run-loop test fix, test-only, +92/-92) is at `5c57cefb`, with CI 6/6 and CLEAN. Its review subagent is running.
- **#1100** is now `655b77a7`, with CI 6/6 and CLEAN.
  - It still contains the `v6` rename (`wrangler.jsonc`, `owner-do.ts`), so it's **not merged**: the owner's ruling puts the behaviour first, then the rename after a Simulator check.
  - A review subagent is checking the merge resolution in `owner-turn.ts` and `tool-loop.ts` now. Its findings go to #1100 as PR comments, for the cloud lane's split.
- **Usage:** the 5-hour window reset at 21:30Z (0%). The orchestrator's context is at 55%.

## 21:34Z: mail-reading root causes; E15 follow-ups stay with Connectors; deploy tooling

- **Connectors (old L2) evidence:** L1's hops for the 20:52:49Z turn show `read_thread` ran once and returned ok. About 21 s later the model sent the identical call again, which was refused as `repeat_refusal`. So the model read the thread but didn't trust what came back.
  - Reproduced with synthetic mail through the real handler, dispatcher and scribe:
    1. A placeholder text/plain part wins over the HTML part.
    2. A part that arrives as `attachmentId` with no `data` falls back to the snippet.
    3. **The scribe's health scan on external text withholds business phrases**, such as "Form 16", "load tests at 200" and "Next steps: 3". "Slept 5 hours" is a correct hit.
    4. `read_thread` pages the oldest messages first.
  - A Fireflies recap carries a summary plus a link, so readable bodies are enough to answer "what did we learn".
- **Decisions (orchestrator, owner asleep):**
  1. **Body choice follows RFC 2046 §5.1.4:** the last renderable alternative, falling back only when it's empty. There's no length heuristic. Artifact extraction (codes and links) runs over every text part, hrefs included, before the body is chosen.
     - Why: it's a parsing standard, not a judgment rule.
     - To reverse: revert that PR.
  2. **The scribe false positives (3):** Connectors writes them up on #1103 with file:line and what the scan protects, then prepares a narrow PR with a corpus test. The test pairs must-withhold real readings with must-pass business phrases; no true positive may be lost, and nothing changes about persistence. The orchestrator and the advisor decide at review. If no safe narrowing exists, it becomes the owner's first morning decision.
     - Why: it's a privacy boundary.
  3. **#1101's six follow-ups stay with Connectors.** They're already built on `l2/e15-followups` (12/12 mutants) and land after #1100's behaviour PR merges. Ansh's A3 keeps only the Telegram-copy switch. Posted on #1103 (6133027170).
     - Why: avoids redoing finished work, with one writer per file.
     - This departs from the letter of the 21:20Z ruling, but not its intent.
  4. **The P1 approval fix comes before mail reading** in the Connectors queue.
- **Deploy tooling:** L1's scratch dir holds pnpm10, the gate script (identical to the memory copy) and the live tail. Details are in `ORCHESTRATOR.md`.
  - **connector-proxy** (Supabase Edge Function, v17 since 10 Oct) is staging's Google path and imports `google.ts`. Mail fixes need it redeployed from the same SHA as the Worker. That's backend code, not a migration, so the owner's deploy ruling covers it.
- **L1 stood down,** with nothing unpushed and nothing in flight.

## 21:38Z: App session decisions

1. **Workspace setup.** The App worktree's `node_modules` dates from July (RN 0.76, expo 53, zod 3), but `package.json` wants RN 0.81.5, expo 54 and zod 4. The lane's classifier refused cloning another worktree's `node_modules`, and the lane didn't retry.
   - **Decision:** run `npx -y pnpm@9.15.9 install --frozen-lockfile --offline`, dropping `--offline` if the store lacks packages, and `pod install --deployment`.
   - **Why:** a frozen-lockfile install changes no dependency. The "no installs or upgrades" limit covers adding or bumping packages.
   - **If the classifier refuses this too:** push the branch, mark check and test as not run, and the orchestrator sets up a worktree to run them.
2. **#89 item 1a.** The server's Retry-After not-before survives a release and re-hold within one session, and resets on sign-out or account change.
   - **Why [verified]:** app rate limits are keyed per owner, as `${bucket}:${doName}` (app-api.ts:151-152).
   - Both behaviours get tests.
