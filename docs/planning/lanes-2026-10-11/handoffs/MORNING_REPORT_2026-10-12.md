# Morning report, 12 October 2026

From the overnight orchestrator (`local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`), for the owner. The night ran under your standing go "Merge + staging deploys". Every action is in [OVERNIGHT_LOG](OVERNIGHT_LOG_2026-10-12.md), every decision made on your behalf is in [OVERNIGHT_DECISIONS](OVERNIGHT_DECISIONS_2026-10-12.md), and every promise is in [PROMISE_DELIVERY_MAP](PROMISE_DELIVERY_MAP_2026-10-12.md).

Tags: **[verified]** observed tonight; **[lane report]** a lane said so, not re-checked; **[inference]** concluded, not observed.

## Do these first, in order

1. **Answer L4's pending question in L4's session.** It was already pending when I checked at 23:15Z. It probably dates from soon after app #78 opened at 21:57Z **[inference]**. L4 has done no work since. I couldn't read the question, and the classifier refused my attempt to stop the waiting turn.
2. **Open Main chat in the app and send one plain message.** For example: "Reply with one short sentence confirming you got this." Ask for no action. The send-path fix (#1075) is live on staging, but nothing has exercised it yet. L1's tail is waiting to read the result. If L1 is idle, ask it in its session to read the tail.
3. **Work through the batch below,** each answer in the session named.

## Late additions (02:15Z)

- This docs PR (#1077) passed CI: 6/6 incl. pgTAP, `CLEAN` **[verified]**.
- L2 opened **#1078** (draft), "Count the history each reply call leaves out". It's the measurement step of the long-sessions plan.
- The Audit lane ran a ledger delta pass on #1057 (`604e5538`) from the map's findings and posted a note on #116.

## Staging now

| What | State | Evidence |
|---|---|---|
| Release | `889efa27` (Worker version `3f059c04`), deployed 22:39Z by L1 under your standing go | `/healthz` `889efa27` **[verified 22:54Z]**; signed-out `/app/v1/session` and `/app/v1/chat/main` → 401 **[lane report]**; rollback is version `65a07f13` |
| Main chat history | 200 on the previous release `4bb040f5` at 21:39Z, skipping one bad stored row (`input_origin`) | L1's tail and L4's Simulator **[lane report, consistent with #116]**. On `889efa27` it is unprobed: #1075 rewrote that reader |
| Main chat send | Failed on `4bb040f5` (strict history load). #1075 fixes it; deployed, unprobed | Failure **[lane report]**; fix merged and deployed **[verified]**; working **[unverified until your first send]** |
| `beta-mvp` vs staging | Identical: tip `889efa27` = staging | **[verified]** |
| App `main` | `c2ccd5d0` (#77, the "Not now" label re-pin, merged by your account at 21:30Z) | **[verified]** |

**What your first send should show** (L1 reads it):
- the reply appears in Main chat;
- one `app_history_load` line: `input_origin`, count 1, unwitnessed 0, orphans 0, leaf true;
- no `history_conflict`;
- a second send still logs a skip line. If it doesn't, an old `commit()` path overwrote the bad row: not harmful, but worth knowing.

**Golden path at a glance** (map §2):
- **Deployed, unprobed:** history, send, a chat-set reminder.
- **Merged, not run on a device:** email + invite sign-in, Google connect, approve and "Don't do this".
- **Partial:** health consent, ingest and scores; proactive in the app; deletion.
- **Open PR:** "Not now" (#1076, held).
- **Missing:** Google sign-in, the 18+ checkbox, Telegram ↔ app continuity, push.

## Merges and deploys tonight

| Action | SHA | CI | Review |
|---|---|---|---|
| Merged waldoco/waldo-backend#1075 (app turns and scheduled app messages skip a shape-invalid history row) | head `01e20d19` → merge `889efa27`, 22:30:43Z | 6/6 incl. pgTAP at head; push CI 6/6 at `889efa27` | Independent review **PASS**: 100/100 related tests, 12/13 new tests red on base, 12/12 mutations caught, custody and fail-closed checked. Advisor: no blocker |
| Deployed `889efa27` to staging (L1) | Worker `3f059c04`, 22:39Z | L1's gate: tip, 6/6, no wrangler/migration/contract change, 0 pending migrations | — |

Nothing else was merged or deployed.

## Held for you, with my recommendation

Each is ready for AskUserQuestion.

1. **#1066: proactive messages for app-only owners.** L2 pushed its fixes as `c8d3190c` at 01:47Z ("Re-plan every day card on a zone change and log each held job"). CI 6/6 incl. pgTAP, `CLEAN` **[verified]**. CI passed at about 01:50Z, inside the 23:00–04:00Z window where the old test 4 failed, which suggests the clock fix landed **[inference]**. Those fixes haven't been independently re-reviewed yet: a short delta review comes before any merge.
   - **Question:** may #1066 merge once the day-card prompt it saves no longer carries health-log lines ("~N kcal, estimate", "N min")?
   - **Options:**
     - (a) **Strip, then merge (recommended).** CLAUDE.md forbids numeric health values in transcripts, and the same change fixes Telegram owners, who have this leak today.
     - (b) Merge as is.
     - (c) Drop day-card arming for app-only owners.
2. **#1076: "Not now".**
   - **Question:** approve its guarded Durable Object `ALTER` (`ledger.deferred_at`)? Should "raises it again" mean "presented again on any surface when the model re-raises it"? Should Telegram's "Not now" become defer?
   - **Options:** (a) **approve L2's proposal (recommended)**; (b) approve without re-raise (deferred items stay hidden until they expire); (c) hold, so "Not now" keeps answering 409.
3. **L3's work,** in L3's session. Its lane rule needs your yes there for every push, PR and post. Full text: `L3_MORNING_BATCH_2026-10-12.md` at L3's worktree root (`sweet-germain-e44f4d`).
   - **(a) Open the reminder-push contract PR**
     - Branch `l3/reminder-push-contract`, local head `a8882b36`.
     - The `reminder` push class: exempt, 10 a day, held in quiet hours unless urgent, degrades over cap. `agent_invocable: false`. `set_reminder.urgent` is refused until L2 stores it.
     - No migration, endpoint or app.v1 change.
     - L3's full wall PASS at `a8882b36`; pgTAP is left to CI **[lane report]**.
     - **Recommend: open.** Merging is a second yes, or extend my standing go to L3's PRs.
   - **(b) Open and merge the one-line ADR-0068 correction** (`agent_invocable: false`). Recommend yes; it matches (a).
   - **(c) The approvals proposal.**
     - Put the "why now / if you approve / if you don't / based on" explanations inside the approval digest. Recommend yes: you approve the reason you read.
     - Ship all three changes as one contract PR and one re-pin. Recommend yes.
     - Show deferred approvals in the default list, marked `deferred_at`, so the chat card can say "You said not now". Recommend yes. It needs #1076's `ALTER`.
     - Take the design's "changed" state and version numbers to Suyash. Recommend yes.
     - Let L3 post the proposal on #116. Recommend yes.
   - **(d) Let L3 post its exact `telegram-owner-do.ts` lines on #116** before it wires the Brief `latest` reader (lane rule for that hot file).
4. **The Brief `latest` record.** L2's `day_plan` columns need a Durable Object `ALTER` (your yes in L2's session).
5. **Server-side 18+ record.** The app gate can ship without it (D7). Recording the attestation needs an additive app.v1 field plus storage, probably a migration. Recommend yes, with a privacy note.
6. **Sessions last 12 hours with no refresh.** Every user signs in again twice a day. It's auth work, so it needs your go and a security review. Recommend scheduling it next, after the send path is proven.
7. **#1072 (flaky-test fix).** The review passed the logic but failed the wording: it names the wrong cause (`multiplexer.ts` rearm, not a workerd retry). Hand the findings to the latency session (log entry at 22:07Z), or close it.
8. **Overnight permissions for next time.** Tonight the classifier refused two things:
   - (a) stopping a lane turn that was waiting on you;
   - (b) a board-triggered deploy cron for L1.
   - Options: grant either, or keep both as they are. Recommend (a) for turns blocked on AskUserQuestion only.
9. **Copy versus build** (map §5, O1–O14): landing #18, Calendar/Tasks scopes ("read only"), export and delete ("Working today", with no export), "Undo it in one tap", the wearables list, Telegram copy, beta pricing and the Terms gate, the 6:30 push, twelve "Working today" labels with no code, Android, mail holding. Each has options and a recommendation in the map.
10. **Already held under the brief:** #1071 (staging browser binding), Audit's #1057 and #1058, waldo-brain#35 (Suyash's review and the font licence), Pin4sf/waldo-landing#18.

## When you're back: the standing go ends

- Your overnight standing go ends now. L1's deploy go ends when you're next in L1's session. Merges and deploys go back to per-action yeses.
- **After each ruling, who merges:**
  - **#1066:** a short delta review of `c8d3190c` first; then your "merge #1066".
  - **#1076:** your yes on the `ALTER`, in L2's session; then the merge; then L1's deploy.
  - **App #78:** after L4's comment fix and the D6 row, your yes in L4's session.
  - **L3's PRs:** your yes in L3's session.
- I've put a closing line on the board, so the lanes stop acting on overnight instructions.

## Decisions I made on your behalf

All are reversible; the decisions file says how to reverse each.

| # | Decision | Reverse by |
|---|---|---|
| D1/D1a | L2's send fix (#1075) before #1066; #1066 may merge once it passes, but no deploy without the fix | Merge order only |
| D2 | The app repo has no CI: before an app merge, I run frozen install + `tsc` + jest at the exact head in a fresh worktree ("CI-equivalent, not CI") | Rule that app merges wait for you |
| D3 | L2 builds the "Not now" desk branch before the push spike (golden path first) | Swap back |
| D4 | Lanes take instructions from a board file, not messages, because sends are capped | Return to messages |
| D5 | Skip the bad `input_origin` row; don't accept it as legacy data. No merged build ever wrote it, and accepting it would mean guessing whether the text was your input | A separate, reviewed change |
| D6 | The app shows a one-tap "Confirm" time-zone row whenever the zone is unconfirmed, even when it matches the phone. Otherwise those owners can never arm #1066's jobs | Remove the row |
| D7 | The 18+ checkbox first ships as an app-side gate | Remove the gate |
| D8 | #1066 held for your health ruling; L2 fixes its bugs meanwhile | Merge after your ruling |
| D9 | Under the usage limit: no new subagents, lean heartbeats, app merges batched after the 01:30Z reset | Resume full cycles (the window reset at 01:30Z) |

## Your own tasks

- **APNs key.** Create the `.p8` key and enter it in the secrets store. The S7 reachability spike passed at 21:55Z: a throwaway Worker got Apple's `MissingProviderToken` from the sandbox, so Workers reach APNs. The Worker was deleted **[lane report]**.
- **Deletion test.** Sign up a throwaway staging account in the app, then delete it from the app. L1 verifies read-only that everything is gone (#1064, #1069). A code read says RunLoopDO and DeviceBridgeDO data survive deletion (map, section L rights rows): a gap to fix **[inference]**.
- **Real-iPhone run.** Build app `main` from source and walk the golden path with the probes in map §2.
- **Message Suyash.** The register's "For the design owner" list, items 8 and 9 in the alignment handoff, and tonight's additions:
  - the Apple-first `AuthButton` order and section 17 text (Apple is out for the beta);
  - the Form-zone table vs `tokens.json`;
  - which Mottle font file to bundle;
  - decision 53;
  - the G2 names and G5 gauge colours.
- **Google connect, your first consent** (L3's read-only check at `4bb040f5`: wired end to end in source, fails closed, never exercised).
  - **Before you try:**
    - the redirect URI `https://waldo-runtime-staging.piyushfulper3210.workers.dev/oauth/google/callback` is registered on the OAuth client;
    - your Google account is a listed test user (the app is unverified);
    - the Worker and the Edge Function use the same client.
    - Otherwise you land on Google's error page with no way back to the app.
  - **Expect** the consent screen to show edit access to Calendar and Tasks, send and compose for Gmail, and read access to Drive, Docs, Sheets and Slides. That contradicts the site's "read only" labels (O2).
  - **Proof:** Connectors shows Calendar, Mail and Tasks granted, and Waldo reads your calendar in Main chat.

## Risks and what is unverified

- **The send fix is unprobed.** Your first send is the proof.
- **A health-data leak, live today for Telegram owners:** health-log lines (calorie estimates, minutes) go into the day-card prompt, which is saved verbatim to `conv:*` and the episodes full-text index. CLAUDE.md forbids numeric health values in transcripts, independent of #1066. Evidence: the #1066 reviewer's code read plus a probe on synthetic data in a test worktree. Not observed on staging. Option (a) of question 1 fixes it for everyone.
- **No proactive message reaches the app** until #1066 merges and deploys.
- **Telegram and the app keep two transcripts.** The episodes index and nightly consolidation don't see app chat. Fixing that is structural work for L2 (owner principal, slice 2) **[verified by code read]**.
- **Harness finding:** tool results from earlier turns don't reach the reply model on either path. That's a code read, unverified by a test, and it contradicts the long-conversations brief (`research-2026-10-12/04-harness-context.md`). It matters for the working-set work (option C).
- **WhatsApp linking is impossible today:** the only link-code issuer hard-codes `'telegram'` **[code read]**.
- **Website:** 33 promises have no implementation and 21 need a copy decision. The Gmail "read only" line contradicts what Waldo does (map §1).
- **Usage:** the 5-hour usage window reached 84% overnight, so I paused low-value lane work from 22:17Z until the 01:30Z reset.
- **App lane:** L4 was blocked from about 23:00Z, so none of tonight's app fixes landed. The time-zone write (app #78) is green on the CI-equivalent but needs a comment fix and D6's confirm row.

## Research done tonight

All six reports are in [`research-2026-10-12/`](research-2026-10-12/):
- website promises: 120;
- competitors and open-source agents: Meta Muse, Instinct, OpenClaw, Hermes, Letta and others;
- the design system: none of G1–G22 is closed; top 8 ranked;
- harness and context engineering: C+A design and its eval;
- backend capability: 70 ledger rows;
- app capability: the golden path.

The promise map joins them.
