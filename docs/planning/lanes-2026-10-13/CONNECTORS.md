# Connectors lane (Mac, waldo-backend): lane handoff, 13 Oct

Read `README.md` in this folder first.

- **What you own, by file:**
  - `connectors/**`
  - `tools/live/google.ts`
  - `channels/event-briefs.ts`
  - `channels/telegram-turn.ts`, for the approval presentation only
  - the Gmail and Calendar tool schemas in `packages/contracts`, additive only
- **Who you report to:** the Mac orchestrator (`local_281f8c04-1fc5-41f4-8fc8-4ac9e6558cf3`). It merges and deploys your PRs through the gate. Announce each PR on #1103 before you open it, and post it there when it's done.
- **Don't edit:** `telegram-owner-do.ts` or `owner-do.ts`, `owner-turn.ts` or `tool-loop.ts`. They belong to Ansh's lane. If you need a change there, ask on #1103.
- **Not yours:** the Telegram-copy switch and #1101's six follow-ups go to Ansh's lane. Push your `l2/e15-followups` branch so that lane can pick it up.

## Order of work

1. **The P1 approval fix,** first. P1 failed on staging `e93a87c9`: the app saved a draft and raised no approval card.
   - **Cause [verified in source]:** `channels/telegram-turn.ts:15` gives every surface except Telegram and WhatsApp `approval: 'none'`. On the app, the prompt (`prompt/messaging-behavior.ts:98, :106`) therefore says "Approval delivery: none".
   - **Fix:** the app surface gets `native_buttons`. The app already renders approval parts in chat and lists them, and the desk decides with `surface: 'app'`.
   - **Red tests first:**
     - the app presentation says `native_buttons`;
     - an app turn asked to send mail raises an approval card rather than only saving a draft;
     - Telegram and WhatsApp are unchanged.
   - The old L2 session may already have a branch or PR for this; check before starting.
   - The orchestrator merges and deploys it. The App lane then re-runs P1.
2. **Unreadable email bodies.** Two of the three Simulator tests hit them: a bank alert, and the Fireflies recap of the Razorpay meeting.
   - **Start from the 20:52:49Z app turn's tool calls and results on staging.** That turn was the Razorpay question; it ran on `d704ffff`.
   - **HTML-only bodies are not the cause** [verified]: `connectors/google.ts:330-336` `threadBody` falls back to HTML, and the thread read uses `format=full`.
   - **Candidates [inference]:**
     1. a non-empty but useless text/plain part wins, because the HTML fallback runs only when the plain part is empty;
     2. a large part comes back with `body.attachmentId` and no `body.data`, which nothing handles;
     3. the model never called `read_thread`.
   - **Write a failing synthetic test for the real cause, then fix it.** Also check whether a Fireflies recap carries the notes or only links to them. If it only links, record that on #1103; a Fireflies or Drive path is later work.
3. **Port draft #1042** (`instinct/connector-read-depth`, head `fffdb172`, from an idle lane) into your own branch, with credit. Don't push to its branch.
   - It adds:
     - body chunks past 32k;
     - attachment metadata (no ids, no content);
     - calendar `attendee_emails` and `has_conference`.
   - Add the Meet link itself: `hangoutLink`, or the `conferenceData` video entry point.
   - **Digest risk [verified]:** `calendarPrepDigest` (`event-briefs.ts:34`) spreads `...event`. Any new `CalendarItem` field changes every event's digest, so after a deploy every upcoming meeting could get its prep note again. Either hash a fixed projection that leaves out the new fields, or prove with a test that an unchanged event isn't re-prepped.
   - **Gmail search beyond one page of 60,** if it's cheap. A Simulator answer said "partial sample (60 messages)".
4. **Email-aware meeting prep** (owner ruling 3). First, a short ADR in `docs/adr/` that states the limits:
   - only the owner's mail;
   - only threads tied to that meeting (the invite thread, its attendees, its title), read at prep time;
   - nothing stored or logged, and the quarantine stays on.

   The orchestrator reviews the ADR and the code together.
   - **Today:** scheduled prep runs with "No tools" on calendar fields only (`event-briefs.ts` `calendarPrepPrompt`).
   - **Who changes the prep job's tools:** if enabling read-only mail tools for it needs a change in the owner DO, ask Ansh's lane on #1103. Don't edit that file.
   - **Goal:** an Instinct-style brief that names what the related emails said, the Meet link and the attached docs.
5. **The duplicate `set_reminder`.** The account history shows "reminder set (failed), (accepted), (accepted)" and two different stretch messages.
   - Write a red test first, and find where the retry creates a second reminder.
   - If the fix sits in a file outside your list, announce it on #1103 first.
6. **If time remains:** meeting-prep latency was about 2 minutes. Measure where the time goes from a trace before changing anything.

## Done for each PR

The PR states its problem, files, privacy and authority impact, red-first tests, `verify:guards`, and rollback. No email content goes in any fixture, log or PR text; use synthetic mail only. Then post on #1103 and message the orchestrator with the head SHA.
