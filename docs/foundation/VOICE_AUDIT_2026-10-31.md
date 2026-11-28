# Voice audit, 31 October 2026

How Waldo actually sounds on the app, iMessage and WhatsApp, checked against voice v2 (`VOICE` in `packages/runtime/src/prompt/messaging-behavior.ts`, `VOICE_VERSION = 2`) and the north star as the [voice digest](WALDO_PERSONALITY_AND_VOICE.md) records it. Base: `beta-mvp` at `aad5a124`. Open PR #1743 (S8a, revised day cards and the `update` push) was read as the next state of the card and push code.

The sweep covered every prompt module in `src/prompt/`, every fixed owner-facing string in `src/channels/` (about 230 string families) and the rest of `src/` (about 75), and the nightly voice evals. The full inventory is in the shared notes folder (`voice-audit-inventory-2026-10-31.md`); this page keeps the findings that matter, ranked by how often an owner meets them.

Evidence labels: **[verified]** read in source at the cited line; **[inference]** a conclusion from source, not observed on a device or in a trace. Nothing here was checked against a live conversation or a staging transcript.

## The short version

1. The words owners read most are not the model's. The day cards are model-written but shaped into a report by their prompt; the receipt line, the push bodies and the failure notices are fixed strings, several in plumbing language ("loop opened", "in-flight changes", "this run", "my model").
2. The prompt and the north star disagree about the two most-read messages. The Brief prompt asks for a header and sections; the north star's own example is one line. The Close prompt forbids anything that needs an answer; the north star's Close is a question.
3. The voice gate does not look at those messages. The three day-card eval scenarios have no voice rubric, so the voice judge never grades a card, and every label the judge is calibrated on is still a draft nobody has reviewed.
4. The VOICE block itself holds up. Its two real tensions (it bans sounding like a coach while Waldo is a health coach, and its silence-by-default line predates the 30 October "act ahead of them" direction) are founder calls, listed as questions.

## Ranking

Tier 1 is every reply or every day; tier 2 is every approval; tier 3 is failures (rare, but where the voice matters most); tier 4 is onboarding, linking and the console. Telegram is internal, so Telegram-only text is listed last.

Each finding says who can fix it: **(a)** fixable here as a fixed string or prompt line; **gate** sits in a file an active lane owns, so it goes to the orchestrator as a note; **(b)** needs a decision from Suyash or the owner, listed in the questions below.

## Tier 1: every day, every reply

### F1. The Brief is shaped as a report. gate, (b) Q2
- Surface: the Brief, Check-in and Close on every surface (app card, iMessage, WhatsApp).
- `packages/runtime/src/prompt/day-cards.ts:74`: "Format it as a compact card for chat: a first line naming "${card.name}", then short sections. Keep it tight enough to read in 20 seconds."
- `day-cards.ts:21`: "Open with a one-line read of the day. Then the day in order: events with times and what each is for, reminders due today, and anything waiting on them."
- Wrong: this is the north star's "report" never-mode. Its own anchor (`evals/nightly/voice.ts:28`) fails "Good morning! Here's your Brief. Meetings: 1. Reminders: None." and passes "Morning. Swim at 8, then nothing until the 2pm call." The labelled set agrees (`evals/fixtures/voice-labels-v0.jsonl`, `brief-quiet-pass` vs `brief-report-fail`). VOICE says "When it is morning for the owner, the greeting is "Morning."", but the card prompt asks for a first line naming "The Brief" instead, so the two collide on the one message that is always in the morning. On iMessage and WhatsApp there is no card chrome, so the name line is the only label; in the app the card already carries its name [inference: the app renders `card_ref`].
- Fix: drop the fixed first line and "short sections"; say the card opens with the read of the day (or "Morning." and the read), lists only what is there, and stops. If a label is needed on text surfaces, the host can add it outside the model's words. Owner: w1-day-awareness (S8). Whether the card keeps a visible name is Q2.

### F2. The Close forbids the north star's Close. gate, (b) Q3
- `day-cards.ts:38-39`: "Done today: ... Carried over: ... Tomorrow: ..." and "Close loops, do not open new ones. No new tasks, no stress, nothing that needs an answer tonight."
- Wrong: three fixed sections invite empty categories ("Carried over: nothing"), which VOICE bans ("An empty category never appears"). The north star's pitch-day pair (`voice.ts:29`) fails a Close that reports "Carried over: nothing is listed as open" and passes "How did the pitch go?", a question. The prompt makes the passing answer impossible.
- Fix: let the Close react to the day first when it had a moment, allow one light question that needs no action, and keep "nothing that needs work tonight". Owner: w1-day-awareness. The question itself is Q3.

### F3. The Check-in and Brief must always offer a decision. gate
- `day-cards.ts:22`: "Name the one thing that matters most today and one clear action."
- `day-cards.ts:30`: "Offer one decision that would steady the rest of the day."
- Wrong: on a light day this forces an invented action, the "empty encouragement" VOICE bans. The Check-in already has a `SKIP` exit, but a day with one change still gets a manufactured decision.
- Fix: "when one would help" on both lines.

### F4. The update card and the health note start with the word "Update". gate
- `packages/runtime/src/prompt/update-cards.ts:19`: "write the update card: a first line "Update", then one to three short lines".
- `packages/runtime/src/health/trigger.ts:365`: "Write it as a short update card: a first line "Update", then one or two short lines".
- Wrong: a fixed header on a one-line note is ceremony (test 2: the point in the first line). #1743 replaces the update-card path with `updateEffectsPrompt` (revise / say / push) but keeps the old prompt, and its fixtures show the revision voice "Brief, updated: the sync with Krati moved...".
- Fix: lead with the change ("Your 10:00 with Krati moved to 3."); let the host mark it as an update. Owners: w1-day-awareness (`update-cards.ts`), health-backend (`trigger.ts`).

### F5. The receipt line repeats the reply in plumbing words. (b) Q4
- `packages/runtime/src/hooks/receipt-line.ts:40-55`, appended at `src/channels/owner-turn.ts:828-831` to every owner reply whose turn made an effect.
- Text: `Done: reminder set`, `Needs your yes: email send`, `Done: loop opened; loop closed`, or, when any effect is not accepted, `Receipts: reminder set (accepted); email send proposed (failed)`. Labels are the effect ids with underscores turned to spaces (`src/tools/records.ts:130-150`).
- Wrong: the app strips the line from the bubble and renders it as a typed receipt part (`src/channels/app-api.ts:343-346`) [verified]. iMessage and WhatsApp get it as plain text under the reply [inference: no strip on those paths]. So an owner who asked for a reminder reads "Done. 6pm." and then "Done: reminder set": test 3 (one job, no second message repeating the first), and "loop opened" is vocabulary the owner never learns (`WALDO_VOCABULARY` says Handoff).
- Fix proposal: keep the receipt (it is the honesty mechanism and must not become optional), but on text surfaces render it in owner words from a fixed map ("Reminder set." / "Waiting on your yes: the email to Priya.") or fold it into one short line only when the reply does not already state the same effect. Changing the text touches the `ConversationReceipt.line` fallback pinned in `packages/contracts/src/runtime/reply-parts.test.ts`, so it is a contract-adjacent change: Q4.

### F6. A second, older voice line rides every owner turn. (a)
- `packages/runtime/src/context-composer/owner-turn.ts:93`: `soul_base: 'Be warm, direct and useful.'`, rendered in the REASONS norms layer (`src/prompt/reasons.ts:141`) after the VOICE block.
- Wrong: VOICE asks for "composed, perceptive, quietly warm, dryly funny"; a later bare "Be warm" pulls toward the default-cheer register VOICE rules out. Two voice sources in one prompt is the drift the version pin exists to prevent.
- Fix: point the fragment at the voice block ("Speak in the voice above.") so VOICE stays the only voice text. Needs the stable-prompt snapshot updated and the eval gate; listed as a later fix, not in the first wave.

### F7. Saved health notes are quoted back unasked, with ids. gate (privacy)
- `packages/runtime/src/channels/health-memory.ts:48`: `Saved to memory from our earlier chat: "${claim}" (c${id}); and N more. Tell me to correct or forget any of it, or turn health notes off in your settings.` Appended to the owner's next reply.
- Wrong: a saved claim can carry a reading ("slept 4 hours"), so this can put a raw value in a reply the owner did not ask for, against VOICE's "a raw reading only when they ask". `(c123)` is a database id. "our" is the only first-person plural Waldo uses in chat.
- Fix: name the topic, not the words ("I kept a note about last night's sleep. Say if you want it gone."), drop the id. Owner: memory / health-backend lanes; raised as a privacy note.

### F8. Push bodies speak about Waldo in the third person and mislabel approvals. gate, (b) Q5
- `packages/runtime/src/channels/expo-push.ts:10-12`: "Your Brief is ready", "Waldo has a suggestion for your day", "Waldo has a note before your next meeting". #1743 adds "Waldo has an update to your day".
- Wrong: the app's notification already carries the app name, so "Waldo has..." reads "Waldo / Waldo has a suggestion". Every approval kind, including an email send waiting on a yes, is called "a suggestion", which undersells a decision the owner must make. "Your Brief is ready" is an app-notification template. These are fixed for a good reason (lock-screen discretion, gated by the privacy notice's Expo row through `PREP_PUSH_NAMES` and `UPDATE_PUSH_NAMES`), so the fix is wording, not model text.
- Fix: first person or bare ("Something needs your yes", "A note before your next meeting", "Your day changed"); keep them free of names and health. Owner: w1-day-awareness (#1743 touches `expo-push.ts`). Voice of a push is Q5.

## Tier 2: every approval

### F9. Approval outcomes can show raw JSON and raw errors. gate (security/privacy)
- `src/tools/live/propose-action.ts:142-145`: a replayed action's result is `JSON.stringify(result.data)`, shown as `Done: ${what}. ${result}` (`src/channels/approvals.ts:1020`). Errors pass through verbatim at `approvals.ts:1078` ("The call failed (${error.message})...") and `:1153` ("That didn't work: ${error.message}").
- Wrong: tool error text is written for the model and can name tools or internals; a replayed health-log result could put numbers on a card. This is a privacy and contract issue before it is a voice issue.
- Fix: a per-tool owner summary, or "Done." plus the effect, never the payload. Raised to the gate; not a wording PR.

### F10. One button, four names. (b) Q6
- `approvals.ts:211`: buttons "Not now" (defers) and "Don't do this" (skips). The skip toast is "Not now" (`:743`, "Left it. Nothing changed."), which Telegram rewrites to "Skipped" (`:1500`); the defer toast is "Later" (`:747`). The console uses "Do it" / "Don't do this" (`src/channels/console.ts:353-391`); `DIRECT_DOING` in `messaging-behavior.ts:100` tells the model the buttons are "Do it / Modify / Not now".
- Wrong: the model describes a button set that is not the one on the card, and the same tap is named differently in the toast. Owners learn one vocabulary only if there is one.
- Fix: pick the pair (Q6), then align the prompt line, buttons and toasts in one change. The app's own labels are app-lane copy.

## Tier 3: failures

### F11. The turn-failure line is an apology template, on app and iMessage. (a)
- `src/channels/telegram-listener.ts:198`: "Sorry - I hit a problem answering that. Please try again in a moment." `:197`: "That took too long. In-flight changes may still finish. Try again, or split it into smaller asks." `:206` reacts 😢 to a failed turn.
- Reach: `TelegramOwnerListener` is the turn listener for every channel (`src/channels/owner-do.ts:4406`, `surface: channel`); WhatsApp rethrows to its own notice (`:201`). So app and iMessage owners get these lines [inference from source].
- Wrong: "Sorry - ... Please" is the over-apologiser and corporate register; "in-flight changes" is plumbing. The model's own reaction rule saves 😢 "for genuinely sad news (a loss, bad health news)" (`src/channels/reactions.ts:23`); the host puts it on every failed turn, so Waldo looks sad about his own error.
- Fix: "I hit a problem answering that. Try again in a moment." and "That took too long, and anything I had started may still finish. Try again, or split it into smaller asks." Text in #1747. The 😢 reaction is left for a decision (Q10): no reaction, or 🤷 "can't help right now".

### F12. The interrupted-run notices are jargon and inconsistent. gate
- `src/channels/owner-do.ts:353`: "This run did not finish. In-flight changes may still finish. Please check before retrying changes." `:721-727`: five more ("...could not be verified for delivery. A private result may already be saved. I did not send the unverified final...", "Your added message was used by a run whose outcome is uncertain...").
- Wrong: "run", "in-flight", "final", "verified for delivery" are machinery; "Please check" never says what to check. The same situation is worded well elsewhere: `src/prompt/fixed-lines.ts:22` "I was interrupted partway through answering your message from ${said}, so I can't tell what I'd already done about it. Check before you send it again."
- Fix: reuse that line's shape for all five. Owner: w1-day-awareness holds `owner-do.ts`.

### F13. The out-of-budget reply lists tool names and scripts a password. (a)
- `src/conversation/tool-loop.ts:67-73`: "I ran out of time before finishing this. Done so far: search communication, query calendar. The rest is still open; say "continue" and I will pick it up from here."
- Wrong: tool names are machinery (and read-only steps are not effects; real effects are already on the receipt line). `say "continue"` tells the owner the exact word to type, while TASKS already reads any "keep going" as carry on.
- Fix in #1748: "I ran out of time partway through this. Reply and I'll pick it up from where I stopped." (or "...before I got anywhere with this. Reply and I'll try again." when no step ran).

### F14. A debug line can be the whole reply. (a)
- `tool-loop.ts:300`: "No tools are available this turn; no tool calls were executed." when the model returns no text and the turn had no tools.
- Fix in #1748: "I couldn't act on that here, so nothing was done."

### F15. The background-task progress note counts steps. (a)
- `src/prompt/fixed-lines.ts:63`: `Still working on "${title}" in the background (${rounds} steps so far). I'll tell you when it's done.` Pinned at `test/task-lane.test.ts:226` with "(0 steps so far)".
- Wrong: the step count is machinery and "0 steps so far" reads as no progress. Chat-turn progress notes are model-written (`src/channels/progress-pacer.ts:47-53`), so the background note is the odd one out.
- Fix in #1746: `Still working on "${title}". I'll tell you when it's done.` Making it model-written is possible but needs a model when one may be the thing that is down; not proposed.

### F16. WhatsApp's failure notices say "Please" and name the channel. (a)
- `src/channels/whatsapp-api.ts:441-442`: "I could not handle your last WhatsApp message. Please send it again." / "I may have only partly handled your last WhatsApp message. Please check what happened before you resend it."
- Fix in #1747: "I couldn't get to your last message, so nothing happened. Send it again?" (only on the path where the turn never started) / "I may have only partly handled your last message. Check what went through before you send it again."

### F17. "My model" is said four ways. (b) Q7
- `src/llm/owner-routes.ts:39` "I can't reach my model right now. I've kept your message and will answer as soon as I can."; `src/scheduler/failure-notice.ts:36` "...so today's day cards are waiting..."; `fixed-lines.ts:19` "I still can't reach my model..."; `src/channels/day-cards.ts:199-201` "Waldo couldn't reach its model this morning" (console, third person, "its").
- Wrong: consistent honesty, inconsistent person. "Its" contradicts the north star's "He, not it", and `src/channels/mcp-oauth-routes.ts:24` is the one place that says "He".
- Fix after Q7: one wording for the outage, one pronoun for Waldo in third person.

## Tier 4: onboarding, linking, console

### F18. The console greets "Afternoon." and "Evening.". (a), later
- `src/channels/console.ts:516`: `'Morning.' : ... 'Afternoon.' : 'Evening.'` plus "Here is where things stand." and "What needs you, what ran, and what comes next. No guesswork."
- Wrong: VOICE: "At any other hour, greet without naming a time of day." "No guesswork." is marketing copy.
- Fix: "Morning." before noon, no greeting otherwise; drop "No guesswork.".

### F19. Linking replies differ by channel. (a), later
- "Linked. This chat now talks to your Waldo." (`telegram-link-controller.ts:24`, `whatsapp-webhook.ts:238`) vs "Linked. Texts from this number now go to your own Waldo." (`imessage/bridge-do.ts:97`); "Get a new one from your console." vs "...from your Waldo console.". Stranger replies open "Hi, I'm Waldo." (`imessage/bridge-do.ts:103,105`), which is fine for someone without a Waldo, since no model may answer them.
- Fix: one wording per situation across channels.

### F20. Memory facts are stored about "them" and shown under "About you". memory lane
- `src/onboarding/first-run.ts:40,68-123` stores setup answers as third-person claims ("Wants to be called ${name}", "Wears an Apple Watch."), shown under "About you" (`src/memory/claims.ts:1147`). A list addressed to the owner speaks about them. Note for the memory lane.

### Telegram only (internal)
`/ledger` prints raw statuses, tool names and health-log calories (`src/channels/health-log.ts:78-85`, `schedule-preferences.ts:21-26`, `loops.ts:113-115`); Telegram link copy says "currently". Low priority while Telegram stays internal.

## The voice gate

### F21. The voice judge never grades a day card. (a), eval-only
- `packages/runtime/evals/nightly/suite.ts:94` runs the voice judge only when `scenario.rubric.voice` is set. `card-scenarios.ts` (d1-d3) has none; `brief-health-scenarios.ts` has 3 of 6; `skill-scenarios.ts`, `state-memory-scenarios.ts` and `errands.ts` have none.
- Fix in #1749 for d1-d3, naming the report never-mode; the pitch-day Close waits on Q3. The three Brief cases in `brief-health-scenarios.ts` without one are a follow-up.

### F22. The judge's character line drifts from VOICE. (b) Q8
- `evals/nightly/voice.ts:41`: "Alfred in a modern register, a caring and considerate concierge the owner could text." VOICE: "a capable peer who serves, not a servant who performs (no "sir", no ceremony, no default cheer)."
- Wrong: "concierge" leans toward the servant register VOICE rejects, so the judge may pass replies VOICE would rewrite. Changing the judge text moves its calibration and needs a live `eval:voice-agreement` rerun, so it is not fixed here.

### F23. The judge is calibrated on unreviewed drafts. (b) Q8
- All 35 rows of `evals/fixtures/voice-labels-v0.jsonl` are `"labelled_by": "claude-draft", "reviewed_by": null`. Until Suyash or the owner reviews them, a voice "pass" means agreement with a draft, not with the north star.

### F24. The digest still quotes a removed line. (a), fixed in this PR
- `WALDO_PERSONALITY_AND_VOICE.md:70` said the product ruling is "open warmly, shift to Alfred-like precision in a back-and-forth, close dry", which voice v2 removed (its own changelog, line 66). Corrected below.

## Questions for Suyash and the owner

These are not decided here.

1. **Coach (owner).** VOICE says "Never sound like ... a coach"; the product is a personal assistant and health coach, and `HEALTH` says coaching is his. Is the ban on the coach *register* (pep talks, "you've got this") only? Proposed wording if yes: "a hype coach".
2. **Card shape (Suyash).** Should the Brief, Check-in and Close read as a message ("Morning. Swim at 8, then nothing until the 2pm call.") with the host adding any label, or as a named card with sections? Does iMessage need a visible "The Brief" label?
3. **The Close may ask (Suyash).** May the Close end on one light question when the day had a moment ("How did the pitch go?"), given its current rule "nothing that needs an answer tonight"?
4. **Receipts on text surfaces (owner).** On iMessage and WhatsApp: keep the receipt line verbatim, render it in owner words from a fixed map, or show it only when the reply does not already state the same effect? It stays mandatory in every option.
5. **Push voice (Suyash).** Does a push speak as Waldo in the third person ("Waldo has..."), in the first person, or bare ("Something needs your yes")? Is an approval a "suggestion"?
6. **Button names (Suyash, app lane).** One pair for defer and skip across app, iMessage and console: "Not now" / "Don't do this", or "Later" / "Skip"?
7. **Saying "my model" (owner).** Keep "I can't reach my model" as the honest-about-software line, or plainer ("I'm having trouble on my side")? And in third person, "he" or "it"?
8. **Judge calibration (Suyash).** Review the 35 draft labels, and confirm the judge's character line should match VOICE ("capable peer who serves"), not "concierge".
9. **Silence by default (owner).** VOICE: "Silence is the default; the Brief, Check-in and Close carry nearly everything." The 30 October direction is to act ahead of the owner, and proactive skills and prep notes now speak between cards. Does the line still hold as written, or should it read "speak up when it helps their day, never to fill silence"?
10. **The failure reaction (Suyash).** A failed turn gets a fixed 😢 reaction on surfaces that react. Keep it, use 🤷, or none?
11. **North-star items still open** (from the digest): use only what you gave him vs. owner look-up; sentence case; the mascot; care without surveillance and the follow-up cadence.

## For the app lane

Not edited here: the app's own button labels and section headers (Q6, Q2), and any app copy that restates the push bodies. The app already renders the receipt as a typed part, which is the model F5 proposes for text surfaces.

## Fix plan

First wave, smallest blast radius first, no VOICE change and no lane-owned file:
1. #1746: `fixed-lines.ts` progress note (F15).
2. #1747: WhatsApp failure notices and the turn-failure lines in `telegram-listener.ts` (F16, F11 text).
3. #1748: `tool-loop.ts` out-of-budget and empty-turn replies (F13, F14).
4. #1749: voice rubrics on the day-card eval scenarios (F21).

Later, after answers or with the lane owners: F1-F4 and F8 (S8 lane), F5 (Q4), F6 (stable-prompt change), F7 and F9 (privacy notes), F10, F17-F19.

## Eval evidence at this base

- Recorded run of the 34 voice, personality and day-card scenarios (`WALDO_EVAL_MODE=recorded`): 34 scenarios, 102 trials, every scenario `ungraded`, none blocked. Recorded mode proves the harness runs; it grades nothing.
- Live run: NOT RUN. It needs model and judge keys, which this lane does not hold.
