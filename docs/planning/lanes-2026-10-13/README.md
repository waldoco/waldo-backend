# Fresh sessions, 13 Oct 2026: shared handoff

Every new session reads this file, then its own lane file in this folder. This pack replaces the overnight log and the 12 Oct briefs; you don't need to read those.

**Source wins.** Current source, tests and Git state decide what Waldo can do; this pack, plans and memory don't. Every SHA below is as of 21:15Z on 12 Oct, so re-check it before acting.

## The goal

Waldo works end to end in the app as a personal agent, on the iOS Simulator first and on the founders' phones later. The daily loop covers:
- sign in;
- connect Google;
- health consent, then scores;
- Main chat answers that use mail, calendar and health;
- approvals (Approve, Not now, Don't do this) that really carry out the action;
- reminders and proactive messages in the app;
- push.

Simple, high-value features come before hard ones. Examples: meeting prep that reads the related email and finds the Meet link, and reliable mail reading. A general "computer" waits.

The plan of record is Ansh's **Waldo Build Bible**, §7 Phase 1 (Claude Doc https://claude.ai/artifact/5AvvW7H1p9s2wM8TjC7Vbi; its "Reconciliation at d704ffff" tab lists the rulings that differ from it). HEAD code wins over the Bible.

## Owner rulings (12 Oct, about 21:06Z and 21:20Z, in the orchestrator session)

These let you work without asking.

1. **Merges and deploys, for every PR tonight, Ansh's included.** This overrides #1103's "nobody merges tonight".
   - **Merges:** the Mac orchestrator merges any PR once CI is green, a fresh review subagent passes it and the advisor agrees.
   - **Deploys:** it deploys `beta-mvp` tips to staging (Worker only), then tests on the Simulator.
   - **Reviews:** findings go to the PR as GitHub comments.
   - **Still held for the owner:**
     - database migrations (`supabase/migrations/`, a new DO SQLite table, or DO migration lineage). These include A3's "app connect route with its migration";
     - production and secrets;
     - new third-party services other than Expo (Browserbase is already in the code);
     - new places health data goes.
2. **The `v6` OwnerDO rename** ships in its own deploy right after #1100's behaviour passes a Simulator check, without asking. Rollback across it is forward-only.
3. **Scheduled meeting prep may read the text of related emails,** within these limits:
   - only the owner's mail;
   - only threads tied to that meeting (the invite thread, its attendees or its title), read at prep time;
   - nothing stored or logged, and codes and links stay quarantined.

   A short ADR states these limits before the change merges.
4. **Push uses Expo Push** for iOS and Android, replacing direct APNs.
   - Push text is template-only: never health, email content or names.
   - The Brief pushes "Your Brief is ready", with at most three pushes a day. This is from Ansh's brief.
   - The owner or Ashish uploads the APNs key and an FCM service account to Expo.
5. **Acceptance is a Simulator run** the session makes itself, with screenshots and a trace id. The owner doesn't approve each run. Phone testing comes later.
   - iPhones install from source; TestFlight comes once signing exists.
6. **Test sends:** to test approvals, a session may email the owner's own address and tap Approve on the Simulator.
   - Only the words "probe" or "QA", and at most 5 sends tonight across all sessions.
   - The orchestrator counts them in LOG.md.
7. **The app:**
   - One app session runs, on the owner's Mac.
   - It follows Ansh's app list after the approval and refresh bugs, including his layout items for the open design-review decisions.
   - It **keeps "Patrol" and "Spots"**; the owner overrode retiring them.
   - Anything Ansh's list doesn't cover waits for the owner.
8. **Backend work split:**
   - A Mac email-and-calendar session builds the P1 approval fix and the email-reading fixes.
   - Ansh's cloud backend lane keeps its A0–G list, plus the Telegram-copy switch and #1101's six follow-ups.
9. **Settled earlier:**
   - E15 keeps one plain Telegram copy of proactive messages.
   - #1100 replaces #1088 (closed).
   - Standing grants are parked.
   - No Apple sign-in for the beta.
   - App chat is the core, and Telegram is a dev surface.

## Board: issue #1103 (all sessions, Mac and cloud)

https://github.com/waldoco/waldo-backend/issues/1103

- **Finished PRs:** one comment per PR, with its number, head SHA, what passed, what didn't, and anything parked.
- **Questions:** a comment prefixed "Q (<lane>)", naming the file and the decision needed.
  - Ansh's cloud orchestrator answers from the Bible about once an hour.
  - Anything only Ansh can answer is marked NEEDS ANSH, and you move on.
- **Public contract changes** are additive only. Announce them on the board before the PR opens: the route or field, its zod shape and the PR number.
  - The app consumes only what is merged into `beta-mvp`, pinned by hash.
  - A path that waits on an unmerged backend PR is marked "awaiting backend PR #N".
- **Who does what:**
  - The Mac orchestrator posts each merge, deploy and Simulator result on the board.
  - Mac sessions may also message each other directly to unblock.

## Sessions and who owns what

| Session | Where | Owns (by file) | Lane file |
|---|---|---|---|
| **Orchestrator** | Mac, backend worktree | Merges, staging deploys, Simulator QA on `iPhone 17`, this docs folder | `ORCHESTRATOR.md` |
| **Backend core (Ansh)** | Cloud, with its own cloud orchestrator | A0–G on #1103 (owner DO, `owner-turn.ts`, `tool-loop.ts`, skills, identity, sessions, push backend, guards), plus `channels/delivery-routes.ts` (the Telegram-copy switch and #1101's follow-ups) | `ANSH_BACKEND.md`, which adds tonight's facts to its own brief |
| **Connectors** | Mac, backend worktree | `connectors/**`, `tools/live/google.ts`, `channels/event-briefs.ts`, `channels/telegram-turn.ts` (the approval presentation only), and Gmail and Calendar tool schemas in `packages/contracts` (additive) | `CONNECTORS.md` |
| **App** | Mac, waldo-app worktree | waldo-app `app/**`, `src/**`, app CI and builds; Simulator `iPhone 17 Pro` | `APP.md` |
| Flaky-test fix | Mac (already running, "Fix the alarm race in the trusted run-loop crash test") | `test/trusted-run-loop.test.ts` and the alarm race it exposes | Keeps going; its PR goes through the gate |

**A file outside your list:** coordinate on #1103 first. Whoever merges second rebases.

**`telegram-owner-do.ts`, which #1100 renames to `owner-do.ts`, belongs to Ansh's lane.** Mac sessions don't edit it until #1100's behaviour PR and its rename PR have both merged. After that, announce any edit on #1103 first.

**Parked, each with its record kept. Don't start these:**
- the health-plane follow-ups: the zone-clipping gap, the trend query across versions, #1083 Form v2;
- standing grants;
- the audit ledger (#1057, #1058);
- the browser lane (#1032, #1071), except Ansh's A2;
- iMessage (#1095 and #1017, Ashish);
- the #998 re-cut;
- the dormant-stack deletion.

## State at handover (12 Oct, 21:20Z; re-verify)

- **Backend:**
  - Staging and `beta-mvp` are both `e93a87c9` (`/healthz` release `e93a87c9`; Worker version `a446c445`; rollback `b6b2c5ec`, which is `d704ffff`). CI is green.
  - It includes #1101 (E15 app-first routing), #1099, #1089, #1098, #1091, #1090, #1092, #1084 (the app connect path) and #1086/#1087 (app-path scheduled work).
- **App:** `main` is `f37223b0`. It has no CI. Both Simulators run app build `60fce743`, whose tree is identical to `main` (tree `9666106f`).
- **Open:**
  - #1100 (Ansh, A0) is `a2db8589` and DIRTY.
  - #1042 is a draft connector-depth PR from an idle lane; Connectors ports it.
  - #1077 is this docs branch.
- **P1 failed at 21:05Z on staging.** On the app, Waldo saved a Gmail draft and raised no approval, then said app chat can't carry a send approval.
  - **Cause [verified in source]:** `channels/telegram-turn.ts:15` sets `approval: 'none'` for every surface except Telegram and WhatsApp. The prompt therefore tells the model "Approval delivery: none" on the app.
  - The old L2 session was fixing it at handover. Connectors checks its state first.
  - One unsent "probe" draft sits in the test account.
- **Two of the three Simulator tests failed to read email bodies:** a bank alert, and the Fireflies recap of the Razorpay meeting.
  - HTML-only bodies are not the cause: `threadBody` already falls back to HTML.
  - Candidates are a useless text/plain part winning, unhandled `body.attachmentId`, or the model never calling `read_thread`.
- **Seen in the account's history:** a duplicate `set_reminder` (failed, then two accepted) and meeting-prep latency of about 2 minutes.
- **Unpushed local branches** (visible from any backend worktree on this Mac because they share `.git`):
  - `l2/e15-followups` `4621a68c`
  - `l2/e15-no-copy` `3a930b6b`
  - `l2/s2-routing` `4efc521a`
  - `l3/approval-expiry-on-read` `93de9d5d`
  - `l3/brief-latest-reader` `49008f8b`
  - `l3/reminder-push-contract` `a8882b36`

  The old L2 was asked to push its three. Don't delete any of them.

## Rules for every session

- **Never:** production, applying hosted migrations, secrets or credentials (never read `.env`), `--no-verify`, force-push, deleting data, sessions or other lanes' branches, creating accounts (including Expo or EAS logins), or publishing anything. Posts are limited to #1103 and PR review comments. Don't use the Workflow tool or Claude in Chrome.
- **Git:** stage by path, never `git add -A`. Take SHAs from `git rev-parse`. Never run the full `pnpm verify` locally, because it resets the shared local Supabase; CI runs it, including pgTAP. Locally, run targeted vitest, `typecheck` and `npx -y pnpm@10.34.4 verify:guards`.
- **Process:** TDD for behaviour, with a red test first. Every PR names its problem, files, privacy and authority impact, tests and rollback. The repo `CLAUDE.md` and `.claude/rules/*` apply.
- **Privacy:** no health values, email content, sign-in codes or the test account's email in logs, docs, PR text, commits, board comments or messages. Synthetic fixtures only.
- **Usage:** the account shares one 5-hour window across all sessions.
  - Start with no subagent fan-out. Run at most one review subagent per PR, and give every subagent a "no Agent tool" rule and a tool budget.
  - Check `get_usage`. Above 80%, pause non-critical work until the reset.
- **Cross-session messages:** about 10 per owner message. Send one combined message per lane, and only to unblock.
- **Labels:** mark claims verified, inferred or unverified. Compiling or a green CI run isn't proof that a feature works; a Simulator run is.
- **If the classifier refuses an action,** don't route around it. Record it on #1103 and leave it for the owner.

## Simulator rules

- **One device per session:**
  - the orchestrator has `iPhone 17` (`18AC0C6B-041B-4632-8FD1-CCF9BA532C36`);
  - the App lane has `iPhone 17 Pro` (`3D82E6D8-3102-43AF-8819-96754D369187`).

  Never drive another session's device.
- **Sign-in:** a human signs in once per device. Never type sign-in codes. The app session lasts 12 hours until PR B (the 30-day session) is deployed. The orchestrator's device was signed in at about 20:40Z on 12 Oct.
- **One account:** both devices use the same app-only test account, so turns from either device land in the same Main chat.
  - The App lane owns the P1 re-run. The orchestrator makes QA turns only after P1 is recorded, and starts each turn with "QA:".
  - Relaunch the app before reading Approvals or Home, until the refresh bug is fixed.
- **Test sends:** only within ruling 6. Never send mail to anyone else, purchase anything or delete real data.
- **Tooling:** use `mcp__Claude_Code_iOS_Simulator__control` (attach, launch with `app_path`, screenshot, tap, text). Coordinates are device points (402 x 874).
