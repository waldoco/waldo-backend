# Waldo sessions alignment review

As of 2026-10-10 19:30Z (11 Oct, 01:00 IST). A dated snapshot: it decides nothing by itself and goes stale at the next merge. Lane briefs: [lanes/](lanes/). Identity plan: [IDENTITY_ROOT_PLAN.md](IDENTITY_ROOT_PLAN.md).

Sources:
- the transcripts of all 16 non-archived Claude sessions (read from disk and `list_events`);
- read-only `gh` on waldoco/waldo-backend, waldoco/waldo-app and Pin4sf/waldo-brain;
- `origin/beta-mvp` @ `ce80802f`;
- staging `/healthz`.

The questionnaire sent to the live sessions did not get through:
- The four `SendMessage` copies expired unread, because those sessions run in a different permission mode.
- The copies sent over the app's channel are queued and unanswered.

So everything below comes from transcripts and Git, not from self-reports. `[verified]` means seen in source, `gh` or a transcript. `[inference]` means judgment.

## Verdict

Not blind arrows. The work is mostly real, honest and tested, and the landing rate is high. On 10 Oct about 30 backend PRs and 20 app PRs merged.

The problem is target selection, not aim:
- Six sessions were active in the last half hour. Two are on the path to the iPhone: the event-route session, now doing S2, and the #16 app lane. Two are test-flake chips. One is docs. One is the browser design.
- The two sessions that held the backend critical path (the handoff and gap-analysis lanes) both stopped, and no successor has started.
- Five steps on the iPhone path have no owner.
- Meanwhile, task chips keep spawning sessions for whatever the previous session noticed: one test file, two causes, four sessions.

Three facts matter more than everything else:

1. **Nothing has run on a physical iPhone.**
   - All app evidence comes from the Simulator or a Node test harness.
   - That harness hid a real transport bug: the controls screen returned 400 until app #37.
   - The ledger's Wave 0 exit (sign-in, send, history, receipt and sign-out on a physical iPhone against staging) has never been run, and no session owns it.
2. **The owner runtime is still keyed on Telegram identity** [verified at `ce80802f`].
   - `telegram-owner-do.ts:1175-1185`: `alarm()` returns before `scheduler.dispatchDue` for any owner without a `telegram_subject`.
   - `owner-browser-runtime.ts` `assertOwner` resolves the owner through `'telegram'`.
   - The final outbox keys delivery on the Telegram `chat_id` (`:1214`).
   - So for a user who never links Telegram, there are no Briefs, Close, heartbeat, nightly memory or browser errands.
   - #1034 (open, being deployed to staging now) fixes reminders only.
3. **Staging has zero health rows.**
   - Recovery cannot appear until H3 is deployed, the app uploads (its consent screen and native hourly reader are not built), and an H4 producer plus a trigger write a row.
   - No session is building H4.

## The path to the iPhone, and who owns each step

| Step | State | Owner now |
|---|---|---|
| Sign-in, chat, history | Works on the Simulator against staging. Never run on a physical iPhone; no TestFlight | App lane; the device run is unowned |
| Your schedule (controls) | App #33 and #37 merged; Simulator only | App lane |
| Reminders for an app-only owner (S2, part 1) | #1034 open, not merged. Staging now serves its branch tip `625214cc` (deployed ~19:27Z with your go; `/healthz` verified). Live "remind me" proof not yet seen | Event-route session |
| Brief, Close, heartbeat, nightly, Calendar Prep for app-only owners (rest of S2) | Telegram runtime only | **Nobody.** Event-route offered to take it |
| Push (S7, APNs) | No code | **Nobody** |
| Approvals in the app (piece A, S1+S3) | Branch `feat/approvals-any-surface` @ `9c6056b0`, 15 ahead and 23 behind, no PR. Round 4 (ruling 16) not started. Adds a page-level enum value, so the app's older pin fails closed (C13) | **Nobody.** The gap-analysis lane stopped |
| Sole editor of `packages/contracts/src/app/*` | Vacant. The browser lane's contract proposals are parked on #116 | **Nobody** |
| Health routes H3 | #1031 draft, CI green, 19 commits behind `beta-mvp` | **Nobody.** The handoff lane stopped |
| App consent screen, native hourly reader, ingest client | Not built. #38 (pure H1 normalizer) merged 19:27Z | App lane, blocked on H3 being deployed |
| H4 Recovery producer, plus a trigger on ingest commit | Not started. Candidate bands are posted on #116 (comment 6101070400) | **Nobody** |
| Recovery screen | Placeholder | App lane, after H4 |
| A browser errand from the app | Runtime needs `telegram_subject`; design only (#1032) | Browser lane, blocked on piece A and app-only admission |

## Every session

| # | Session | State | What it really did | Its philosophy (its words) | Verdict [inference] | Recommendation |
|---|---|---|---|---|---|---|
| 1 | Waldo app-backend handoff | stopped 18:58Z | #999 (app sign-in and chat backend), the #998 re-cut steps (#1008, #1009, #1013), #1015, #1019, #1021, H1 #1020, H2 #1022 (migrations applied on staging), #1031 draft. Several staging deploys with your go | "The gap is mostly in following through, not intelligence"; health is "Waldo's wedge" | Critical path, heavy overhead: about 1.5 h on deploy plumbing, repeated merge-ups, 3 compactions. 4 of its 14 PRs were Wave 5 connector work exercised on Telegram | Start a successor for the health lane from its handoff memory; archive this one |
| 2 | Gap-analysis ("fix(cli): check the runtime source…") | stopped 18:58Z | 13 PRs: #1004, #1007, #1010, #1011 (app contracts), #1012, #1014, #1016, #1023, #1024, #1028, ledger #1005 and #1026. Captured rulings 1–17. Piece A is on a branch | "The binding constraint is landing, not building"; "Telegram traces are development evidence, not acceptance" | Critical path. About a third of its time went to coordination; it drifted into orchestrating other lanes. Stopping it orphaned piece A and the app contracts | Start a successor for approvals and the app contracts; archive |
| 3 | "Find why event-route Telegram sends are blocked" | running | #1030: about 2.5 h on a Telegram dev-surface symptom it never reproduced, before ruling 12. Then S2 reminders, #1034; deployed its branch tip to staging with your go | "The Telegram question is the wrong thing to fix" (after you pushed back) | Critical path now. The only lane building scheduled delivery for owners without Telegram | Keep, and rename to "owner runtime off Telegram". Give it the rest of S2, then S7. Make it the sole writer of `telegram-owner-do.ts` |
| 4 | Take over waldo-app PR #16 in slices | running (renewed 19:27Z) | #28 (HealthKit hardening, the only #16 port), #30 (H1 pin), #31–#34, #36 (removed the fake Watch Recovery 81), #37 (fixed the controls 400), #38 and #39 (merged 19:27Z). Set the staging time zone to Asia/Kolkata with your go | "The app only uses an endpoint after the backend says it's served. I won't fake data" | Supporting, close to the critical path. The only reachable app lane. Honest, tested slices; never on a device | Keep as THE app lane. Do a physical iPhone build and the Wave 0 exit run first |
| 5 | Start waldo-app session: iOS first | stopped 18:09Z | #14, #15, #17–#20, #23–#26: the working chat against staging on the Simulator, and the app contract review | "I won't fake streaming, because a typewriter effect … would look like a capability that isn't there" | Critical path earlier. It ended in checklist churn. Its #27 and #29 are open, and it is a second writer on `src/agent/**` if resumed | Archive; don't resume. Decide on #27 and #29 |
| 6 | Re-pin the app to #999 | stopped | #21, #22; superseded by #24 within about 1.5 h | — | Done | Archive; remove the local branch `f8d0589a` (unpushed, do not push) |
| 7 | Finalize the browser lane | running | #1032 (docs draft): audited 10 browser/compute drafts (recommends closing 7, landing #987 after piece A, re-cutting #973 and the S0 files of #908), defined a 23-errand set with independent oracles, planned the in-app browser B0–B10. Nothing closed or run yet | "The browser is one capability of Waldo's single owner loop"; "Pass means independent evidence, never the agent's claim" | Supporting; off the critical path until app-only owners are admitted and approvals reach the app. S0 has never run live; the browser binding is not in the staging source | Keep it bounded: execute the closes and the S0 re-cut. No in-app browser UI until piece A and app-only admission land |
| 8 | Backend-app traceability (docs only) | resumed | #1029 (draft): maps app slices to contract symbols and gates. Accurate at `ce80802f`. Findings C11–C13 are addressed to a gap-analysis successor that doesn't exist | "It decides nothing, merges nothing, deploys nothing" | Supporting, leaning low. A second status snapshot that rots at the next merge | Give C11–C13 to the approvals/contracts successor, then close #1029 or merge it as a dated snapshot. Archive |
| 9 | Stop pinned-clock owner tests leaking | idle | #1033 (test-only, CONFLICTING with `beta-mvp`, no CI): fixes one of two scheduler-leak sources | Falsification-driven | Low-value. No merge was ever blocked by this flake (22 failed runs checked; each re-ran green within 1–2 minutes) | Rebase once, merge, stop |
| 10 | Stop sealed-world owner tests arming past alarms (**new**, 19:25Z) | running | The 4th session in a chain: each flake session offered a chip for the next, and each was started | — | Low-value | Stop, or let it finish this one change. No more flake chips: one structural fix (a fresh owner per test, or a single pinned-clock helper) or nothing |
| 11 | Diagnose eviction test flake | stopped | #1027 merged. Ruled out a real replay after eviction (that mattered) | "Your falsifier would have pointed the wrong way" | Supporting | Archive |
| 12 | Fix owner-do-ingress clock race | stopped | #1025 merged: a 3-line fixture fix for the most frequent CI breaker | Narrow and evidence-first | Supporting | Archive |
| 13 | Device bridge staging trace | stopped | No code. Handed Kennel device-bridge testing to Ashish, plus one read-only staging query | "The cookie never leaves your machine" | Off-path (Kennel), cheap and bounded | Archive. Decide the scope of Ashish's deploy access |
| 14 | Draft heywaldo.in copy fixes | stopped | 2 local commits, never pushed; moot under ruling 10 | App-first, honest copy | Wasted, but about 40 min | Archive. Copy its open items (two meanings of "Working today", Galaxy Watch vs iPhone-first, support/privacy pages still naming Telegram) before deleting the branch |
| 15 | Amend Brain ADRs (Pin4sf/waldo-brain#34) | stopped | Open, mergeable, no review, no CI. Written before rulings 11–17, so it contradicts 11 (consent split), 13 (WhatsApp/iMessage scope), 15 and 16, and the already-merged #1014 | Additive, dated amendments | Supporting but stalled; nobody is driving it. It gates no code | One revision pass when the approvals/contracts lane has slack |
| 16 | This review | — | — | — | — | — |

## Structural findings (event → pattern → structure → fix)

1. **Telegram is still the identity root of the owner runtime.**
   - S2, browser admission (the browser lane's B3) and piece A each cut their own hole through it.
   - #1013 plus migration `20261010060000` (applied) is the foundation; #1034 is its first caller.
   - Fix: one lane makes owner admission surface-neutral once, across all of these:
     - the alarm;
     - `setup(channel = 'telegram')`;
     - the browser `assertOwner`;
     - the final outbox keyed by `chat_id`;
     - the Calendar Prep exit;
     - `/event`, which builds the Telegram runtime.
2. **"Done" is measured off-device.**
   - The ledger says Telegram traces are not acceptance. Simulator and Node runs aren't either.
   - Fix: a TestFlight build, then one physical-iPhone run per backend deploy as the acceptance bar.
3. **Health is a three-sided dependency with nobody holding the middle.**
   - The chain: H3 deploy → app consent and upload → H4 producer.
   - The design computes on `health_arrived` (H5), so H4 alone writes no row. Call the producer after the ingest commit.
   - A baseline needs about 14 days unless the 30-day backfill (H6) is uploaded. Pull backfill forward.
4. **Session stops orphan critical queues, while chips staff side quests.**
   - The handoff and gap-analysis lanes both stopped with critical-path queues and no successor started.
   - In the same hour, three flake chips, a copy-fix chip, an ADR chip and a device-bridge session ran.
   - Fix: before starting any chip, check it against the table above. When a lane stops, its successor starts before any new chip.
5. **The coordination channel loses messages and costs a lot.**
   - Permission-mode holds dropped this review's 4 messages, the traceability lane's 3, and the handoff lane's deploy report.
   - About 250 peer messages flowed between lanes on 10 Oct.
   - Corrections C11–C13 are stranded, and the 19:05Z rulings (cohort 5–10, at most 50; $25 per user per month; browser tasks from any surface) live only in memory and an untracked handoff, not in the ledger.
   - Fix:
     - one permission mode for every Waldo session;
     - #116 plus ledger §12 as the single durable bus, kept by the approvals/contracts lane;
     - fewer concurrent sessions.
6. **Backlog clutter taxes every new lane.**
   - waldoco/waldo-backend has 71 open PRs, 56 of them into `beta-mvp` (39 drafts). 51 have not been updated since 8 Oct, including the two `DO NOT MERGE` pins.
   - The browser lane spent its first hours re-auditing drafts.
   - Fix: one close sweep with your go.
7. **Staging is a single shared slot with three or more deployers** (the health-lane successor, the event-route session, Ashish).
   - It now serves the unmerged #1034 tip `625214cc`.
   - If anyone deploys the `beta-mvp` tip before #1034 merges, S2 silently disappears from staging.
   - Fix: deploy only `beta-mvp` tips, merging first, with one deploy owner.

## Parity with Instinct, Meta and Muse: what is and isn't tracked

- **Where it is tracked:** only in ledger §11 (the "Instinct-parity bar": booking, payments, logged-in browser errands, parallel workers, rich files, agent-to-agent) and in the browser lane's 23-errand set. Neither has been run.
- **What this review did not cover:** no competitive measurement, and no new research on Meta or Muse. The Muse study (#186) and the capability-gap ledger (#812) are open, stale docs PRs.
- **Browser:** public read, navigation, screenshots, retained interaction, attachments and the login/MFA handoff are merged on `beta-mvp` (#962, #965, #972, #984, #985) [verified]. The native path still needs S0 and a staging binding.
- **Agent computer:** #973 is to be re-cut, #906 closed, and the #776 sandbox spike is open. No lane owns the agent computer end to end.
- **WhatsApp and iMessage (the Instinct-style messaging presence):** no Claude session covers these.
  - Ashish owns them.
  - His iMessage connector #1017 is a default-off draft.
  - Its migration `20261010120000` sorts below the applied `20261011000000`, so it must be renumbered before it can apply.
  - The WhatsApp adapter is not wired (`channels/surfaces/whatsapp.ts` is never imported).
- **Distance to the iPhone:** none of this reaches the iPhone until app-only owners are admitted and approvals reach the app.

## Proposed lane plan (four lanes, five sessions at most)

| Lane | Who | Queue, in order |
|---|---|---|
| L1 Backend: health and the staging deploy train | New session (successor to the handoff lane; reads [lanes/L1-health-and-staging.md](lanes/L1-health-and-staging.md)) | 1. Merge #1031 up, merge it, deploy from the `beta-mvp` tip (with #1034 merged first)<br>2. H4 producer, triggered on ingest commit, plus the per-day read migration<br>3. H6 backfill<br>4. H5<br>It is the only staging deployer |
| L2 Backend: owner runtime off Telegram | Event-route session (rename) | 1. Rest of S2 (Brief, Close, heartbeat, nightly, Calendar Prep)<br>2. Surface-neutral admission for the browser, the outbox and `/event`<br>3. S7 APNs push<br>Primary owner of `telegram-owner-do.ts`. L1's H5 and L3's piece A also touch that file: either L2 makes their DO-side edits on request, or they announce before editing and whoever merges second rebases |
| L3 Backend: approvals, app contracts, ledger | New session (successor to the gap-analysis lane; reads [handoffs/GAP_ANALYSIS_HANDOFF_2026-10-11.md](handoffs/GAP_ANALYSIS_HANDOFF_2026-10-11.md)) | 1. Piece A round 4, fixing C13 with a version bump or an app re-pin first<br>2. Open its PR<br>3. App approvals contract<br>Sole editor of `contracts/src/app/*`; absorbs #1029's corrections; keeps ledger §12 current; revises Brain #34 when idle |
| L4 App | The #16 takeover session | 1. TestFlight build and the Wave 0 exit run on your iPhone<br>2. Consent screen, hourly reader and ingest client against H3<br>3. Recovery screen<br>4. Approvals screen, after L3<br>5. Push registration, after L2's S7 |
| Browser (paused or bounded) | Browser lane | Closes and the S0 re-cut only, until L2 admits app-only owners and L3 serves approvals |

Stop or archive: sessions 5, 6, 8, 9 (after its rebase and merge), 10, 11, 12, 13 and 14. Archive 1 and 2 once their successors have read their handoffs.

## Coverage: does the lane plan cover every issue and the end state?

No, not on its own, and not by design. The four lanes own the foundation every promise sits on:
- a user who never touches Telegram;
- proof on a physical iPhone;
- real health rows;
- approvals in the app;
- push.

Building everything at once is what produced 16 sessions. So the plan runs in phases, each lane keeps its domain across phases, and the rows marked **GAP** below needed an owner. Those owners are now assigned.

**Phase 1 exit ("first complete presence").** On your physical iPhone against staging, as a user with no Telegram link:
1. Sign in and connect Google from the app.
2. Get a Brief, and a reminder as a push notification.
3. Approve a calendar or task change in the app.
4. See a Recovery score with its coverage, using backfill.
5. Withdraw consent and see the data purged.

Also in Phase 1:
- the alpha legal gates: consent copy including the trace-capture line, App Store privacy disclosure, DPDP;
- a new account can sign in.

### Issues found in this review

| Issue | Owner | Phase |
|---|---|---|
| No physical-iPhone proof | L4 (first item); one device run per deploy as the gate | 1 |
| Runtime keyed on Telegram identity | L2 | 1 |
| Zero health rows | L1 + L4 | 1 |
| Orphaned piece A, app contracts, H3/H4, push | L3, L1, L2 | 1 |
| Coordination: messages lost, rulings only in memory | Your permission-mode setting. L3 keeps #116 and ledger §12 as the one bus and records the 19:05Z rulings | 1 |
| Staging: one slot, unmerged deploys | L1 is the only deployer, from `beta-mvp` tips | 1 |
| `delete_owner` skips `health_context_daily` (privacy gap) | L1, with the health purge | 1 |
| **GAP:** connecting Google from the app (no contract; an app-only tester can't connect Calendar or Gmail, so no Brief) | L3 contract + L4 screen | 1 |
| **GAP:** alpha legal gates and new-account sign-in | L4 copy and screens, L3 rights, you | 1 |
| **GAP:** 71 open PRs, 51 stale | One close sweep. I prepare the list; you approve each close | 1 |
| Flake chain | Stop rule. The structural test fix stays unowned unless flakes start blocking merges | — |
| Brain #34 contradicts rulings 11/13/15/16 | L3 when idle | 1–2 |
| **GAP:** measured quality (evals, errand scoring), needed for any parity claim | New Phase 2 lane "Evals and latency". The eval provider key is your decision | 2 |
| **GAP:** latency (~6 s per model call, no streaming) | Same lane, with L2 for the reply path (streaming needs a chunked-guard design) | 2 |
| Ashish: deploy scope, #1017 migration renumber | You | now |

### Website promises (ledger §4)

| Group | Promise | Owner | Phase |
|---|---|---|---|
| Health | Recovery, Bring your past (backfill), Apple Watch | L1 + L4 | 1 |
| Health | Sleep debt, Form (HR/HRV stress), Quiet flags, Training, Your history (7/30/90) | L1 + L4 | 2 |
| Health | Weight (the day's demand) | L1 + connector depth (all calendars, tasks) | 2 |
| Health | Weather and daylight, location consent ‡ | L1 + L4 | 2 |
| Day to day | Brief, Close, Prep, Your own routines (delivered to app-only owners) | L2 | 1 |
| Day to day | Fewer pings (interruption judgment, K) | L2 | 2 |
| Day to day | Patrol (grants I, responsibilities J), the Adjustment | L3 + L2 | 2 |
| Day to day | Window, Heads-Up, Best hours, Patterns, Slope, Right task, Tomorrow today | Learning layer (Wave 4): needs weeks of data plus grants | 3 |
| Talk to Waldo | Threads (app and console), Full history | L3 contract + L4 UI | 2 (early) |
| Talk to Waldo | Quick replies, Charts, Thumbs, Follow up on anything | L2 reply parts and renderers (S4), L3 provenance, L4 | 2 |
| Your rules | Always comes back to you (approvals on any surface) | L3 piece A + L4 | 1 |
| Your rules | Three levels per area, Activity log, Say it once (edit and forget), Yours always (export and delete) | L3 + L4 | 2 |
| Your rules | Your schedule and quiet hours | L4: done on the Simulator; per-card toggles in Phase 2 | 1–2 |
| Coming later | Voice in the app, Other agents ask Waldo | L4 + L2; L3 | 3 |

### Connectors, omnipresence and parity

| Item | Owner | Phase |
|---|---|---|
| Calendar depth: all calendars, attendees, live `calendar_list` proof (connector-proxy v18 and re-consent) ‡ | **GAP:** new Phase 2 lane "Connector depth" (‡ rows can be delegated to Instinct under ruling 2) | 2 |
| Gmail triage, attachments, full-body paging; Tasks on all lists, with writes; Drive writes ‡ | Connector depth | 2 |
| Galaxy Watch (Samsung source), Health Connect, Android | L1 + L4 | 3 |
| WhatsApp and iMessage | Ashish builds the adapters; L2 owns the seam (router, renderers) | 2 |
| One state across surfaces | L2 | 1–2 |
| Browser errands from any surface | Browser lane: bounded in Phase 1; in Phase 2, full and scored against the 23-errand set | 1–2 |
| **GAP:** agent computer (sandbox/Linux compute: #973, #776) | Browser lane becomes "browser and computer" | 2 |
| Parallel workers / background jobs (J), rich file outputs (S8, artifacts) | L3; L2 | 2 |
| Booking and payments | After you set spend limits | 3 |
| Kennel coding agents | Out of this picture (your instruction); Ashish | — |

## Your decisions

1. The lane plan, and which sessions to stop or archive.
2. Start the L1 and L3 successor sessions.
3. Put every Waldo session in one permission mode, so peer messages arrive.
4. **Decided 11 Oct (in this review): proactive delivery goes to the owner's chosen surface, and to the app when none is set.**
   - This replaces #1034's "Telegram if linked, else app" and the design doc's "last surface used".
   - The S2 lane (L2) needs to hear this before #1034 merges.
5. Deploy discipline: merge #1034 before any other staging deploy.
6. Does the first consent screen ask for model processing?
7. TestFlight, and a physical-device run.
8. A close sweep of stale PRs: the browser lane's seven, the two `DO NOT MERGE` pins, and the Sep 26–Oct 7 drafts.
9. App #27 and #29; backend #1029 and #1033.
10. The scope of Ashish's deploy and migration access, and relaying the #1017 migration renumber (`20261010120000` sorts below the applied `20261011000000`).
11. ~~The staging owner time zone was UTC.~~ Resolved: the app lane set it to Asia/Kolkata at 19:27Z with your go.

## Actions taken by this review (with your go)

- **Archived (11 Oct, ~01:08 IST):** re-pin #999, landing copy, device bridge, eviction flake, ingress clock race, Start waldo-app. All six can be restored from the Archived list.
- **Saved first**, locally on the owner's machine (not in this repository):
  - the landing branch's 2 unpushed commits, as patches;
  - the Start waldo-app worktree's uncommitted `project.pbxproj` diff (Watch target privacy manifest and Expo flags, probably regenerated by prebuild);
  - its untracked `HANDOFF-takeover-16.md`.

## Not done by this review

- No other session was stopped, renamed or re-tasked.
- No PR was closed, merged or commented on.
- Nothing was deployed.
- The only messages sent were the questionnaire to the four live sessions.
  - The `SendMessage` copies expired.
  - The app-channel copies are still queued in the browser, event-route, pinned-clock and #16 sessions. They will interrupt those sessions when they next go idle, with questions that may be stale by then.
  - Each one says "do not change course because of this note".
