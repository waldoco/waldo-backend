# App lane (Mac, waldo-app): lane handoff, 13 Oct

Read `README.md` in this folder first.

- **What you own:** waldo-app (`app/**`, `src/**`, app CI and builds), on base `main`, at `f37223b0` at handover.
- **Your device:** the Simulator `iPhone 17 Pro` (`3D82E6D8-3102-43AF-8819-96754D369187`), signed in to the shared test account. Its app build is `60fce743`, with the same tree as `main`.
- **Who you report to:** the Mac orchestrator (`local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`). Post finished PRs and questions on #1103.
- **Merges:** the orchestrator merges your PRs through the gate (owner ruling). You don't need the owner's yes.
- **Don't edit waldo-backend.**

## Order of work

1. **B1: Approvals and Home read approvals only once per app session.**
   - They load only while `load === 'idle'` (`ApprovalsList.tsx:27`, `TodaySummary.tsx:34`), so a new card shows only after a relaunch.
   - Fix: re-read on focus, and when a chat reply carries an approval part.
   - Write a test first. Then make a Simulator check on your device.
2. **P1 re-run,** once the backend approval-presentation fix is live on staging. Connectors builds it, and the orchestrator deploys it and tells you.
   - Relaunch the app. Then send, in Main chat: "Draft a note to myself saying 'probe' and send it once I approve".
   - An approval card should appear, in chat and in Approvals. Tap Approve, then confirm the send in chat.
   - This uses one of the owner's 5 test sends (ruling 6). An unsent "probe" draft from 21:05Z is already in the account; leave it.
   - Record the result on #1103 with screenshots and the trace id. Then tell the orchestrator P1 is done, so it may make its own QA turns on the account.
3. **#89's follow-ups, in one PR:**
   - Keep Retry-After as a not-before time on the runtime, across holds (`watchRead` and `scheduleWatch`). Test 429 → release → re-hold.
   - Run the end hook on a restore 401 or 403 (`appSessionController.ts:54-59`), with a test.
   - `wroteWhen` treats `at <= 0` as null (`wroteLine.ts:4`).
   - Re-run the Simulator check on the PR's head.
4. **B2: a bold run at the end of a bullet doesn't wrap.** Write a renderer unit test first.
5. **App CI:** a GitHub workflow that runs typecheck and jest on PRs to `main`.
   - Pin each action to a full commit SHA, and set minimal permissions (`contents: read`).
   - Until it exists, put your local typecheck and jest output in each PR.
6. **Ansh's app list, in his order.** The owner ruled you follow it, with two changes: **keep "Patrol" and "Spots"**, and any decision his list doesn't cover waits for the owner.
   1. **The design review's 13 plain fixes,** as two PRs: words and labels, then layout and colour. The design pass v2 is https://claude.ai/artifact/ARp5ttM3EagYxCupwoZtcW.
   2. **The shell:**
      - three tabs: Home, Body, Waldo;
      - the greeting header with the date, and the profile as the only trailing action;
      - plain chat chrome: the title "Waldo", one More menu, share and copy on long press, no footer;
      - reply attribution: mark, name and time;
      - one sign-out;
      - plumbing words out, and shaped approval labels;
      - the four placeholders removed, but Patrol and Spots stay;
      - dead composer controls hidden;
      - the zone colour on the Form ring.

      The iOS time picker rides the next build.
   3. **The Bible's Phase 1 app items:**
      - delete the 83 unreachable files, the Supabase client and the uncompiled Swift. Inventory the imports first, and prove the build and tests still pass;
      - fix the beta-logging origin check;
      - point the Home Brief row and the Brief screen at the latest scheduled row in Main chat;
      - Body shows recovery and sleep debt, labelled candidate, with the reasons they're unavailable.
   4. **Builds:** EAS init, `expo-dev-client`, and the backend origin in the EAS environment; an Android prebuild and an internal APK (package id `com.waldo.app`); iOS from the hand-maintained Xcode project.
      - Never prebuild iOS.
      - Anything that needs an Expo or EAS login, Apple signing or an Android SDK this Mac lacks is the owner's to set up. Don't create accounts or log in; record the blocker on #1103 and move on.
   5. **If time remains,** start the Samsung Health range reader (sleep sessions, heart-rate series, resting heart rate, exercise) in the shape the normaliser consumes.

## Contract rules

- Consume only backend shapes merged into `beta-mvp`, pinned by hash as today. App.v1 is additive-only.
- Backend additions announced on #1103 (`created_at`, the device routes, cancel, memory, connect action, spend) wait until they merge. Mark such a path "awaiting backend PR #N".
- **Push:** Expo Push (`expo-notifications`). Register the token only once the backend device routes are merged. Push text from the backend is template-only.

## Done for each PR

The PR states its problem, files, tests (red first), a Simulator run on your device with screenshots and a trace id where one applies, and rollback. Then post on #1103.
