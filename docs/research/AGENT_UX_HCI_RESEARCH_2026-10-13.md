# Agent UX and HCI research for the Waldo app

Date: 13 Oct 2026. Lane: UX and HCI research, read-only. App code read at waldo-app `origin/main` `7e09317c` (fetched 13 Oct 2026). Every `file:line` below is at that SHA. The owner's UX rules come from the design brief (`waldo-app-design-brief.html`, same SHA).

Sources I read directly: Horvitz (CHI 1999) and Amershi et al. (CHI 2019) as PDF page images, the Claude Code checkpointing page as raw markdown, and the app code via `git show`. Everything else was fetched through the WebFetch summarizer, so I paraphrase it and you should open the link to check wording.

## 0. Evidence tags, owner rules, and what I could not read

Tags used in the tables:

- [read]: I read the primary text myself.
- [summary]: fetched through the summarizer. Apple HIG pages came from their JSON data endpoints. Treat the wording as paraphrase.
- [inference]: my reading of evidence, not a source claim.
- [proposed]: a design suggestion with no source behind it.
- [check on Simulator]: runtime behavior I did not observe.

Not available:

- OpenAI agent UX guidance: `introducing-chatgpt-agent` returned HTTP 403. Nothing from OpenAI is cited.
- HAX Toolkit page: it says there are 18 guidelines in four stages but does not list them. The titles below come from Table 1 of the paper [read].
- Voice input UX: I found no primary source. Every voice state below is [proposed].
- Mark, Gudith and Klocke (CHI 2008): Crossref confirmed the DOI and main title only. I do not use its abstract.

Owner rules treated as constraints (design brief):

- Buttons name their effect. The soft no is "Skip". The final no reads "Not doing".
- "Done" only after the action is checked. "Unconfirmed" when we cannot tell.
- "Checked N things" lists the lines, not a count.
- After a decision on Home, an Undo window.
- Home order: updates stack with the Brief always present, "Waldo is carrying", "Needs your yes or no", To send, Ask Waldo bar.
- Hide examples that need a connector we do not have. Do not say what is coming.
- No spinners or animated waiting marks. `noSpinners.test.ts:4-17` and `StatusLine.tsx:3` enforce it for the agent-driven screens. A wait is named, not decorated.

Facts given for this pass: a model call takes about 6 s, so turns run 10 to 40 s. Typed chat parts (progress, "what changed", receipts), Stop and rating are being added by the backend. Push notifications do not exist yet.

## 1. Principles (18)

| # | Principle | Meaning for Waldo | Citation |
|---|---|---|---|
| 1 | Answer every tap within about a tenth of a second. | Press state, haptic and the person's own bubble appear at once. Never wait on the server to show their words. | NN/g response times [summary]: https://www.nngroup.com/articles/response-times-3-important-limits/ and progress indicators [summary]: https://www.nngroup.com/articles/progress-indicators/ |
| 2 | Name any wait over about a second, and make the name specific. | "Reading your calendar", not "Waldo is working". A static line is allowed. A vague one is not. | NN/g progress indicators [summary] (a bare "Loading" says too little); Apple HIG generative AI [summary] (progress messages should say what is being done): https://developer.apple.com/design/human-interface-guidelines/generative-ai ; NN/g heuristic 1 [summary]: https://www.nngroup.com/articles/ten-usability-heuristics/ |
| 3 | Past ten seconds, show progress that moves with the work. A frozen label reads as a hang. | The line changes when a step changes, not on a timer. Today it changes only at 30 s (`ChatPane.tsx:536-537`). The no-spinner rule means text must do the moving. | NN/g response times [summary] (10 s is the attention limit; beyond it show progress); Apple HIG progress indicators [summary] (a stationary indicator suggests a frozen app; explain a stall): https://developer.apple.com/design/human-interface-guidelines/progress-indicators |
| 4 | Always offer a way out of a long run, and say what already ran when it stops. | A Stop beside the working line. After Stop, name what ran and what did not. | NN/g response times [summary] (a clearly marked way to interrupt past 10 s); NN/g heuristic 3 [summary]; Apple HIG progress indicators [summary] (cancel when safe, confirm if cancelling loses work); Anthropic [summary]: https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents (users can stop the agent at any time) |
| 5 | Show the trail of work at a level of detail the person can check. | "Checked 3 things" lists the three lines (owner rule). A readable trail, not a log. | Anthropic [summary] (real-time to-do list so people can follow and step in; the right level of detail is an open problem); Magentic-UI [summary]: https://arxiv.org/abs/2507.22358 (co-planning is one of its six human-involvement mechanisms) |
| 6 | Ask before anything consequential or irreversible, with exact wording, and re-check at the moment of action. | Named-effect buttons. The digest check that rejects a changed proposal (`approvalsController.ts:48`) stays. | Apple HIG generative AI [summary] (confirm significant or irreversible actions); Anthropic [summary] (human approval before the agent changes things); Magentic-UI [summary] (action guards) |
| 7 | Make dismissal, correction and undo cheap, and put them next to the result. | Skip and Not doing are one tap. Undo sits on the receipt. People refine answers in chunks, so let them act on part of a reply. | Amershi G8 and G9 [read]: https://www.microsoft.com/en-us/research/uploads/prod/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf ; Apple HIG generative AI [summary] (Edit, Undo, Retry near generated content); NN/g heuristic 3 [summary]; Horvitz factor 6 [read]: https://erichorvitz.com/chi99horvitz.pdf ; NN/g chatbot study [summary]: https://www.nngroup.com/articles/accordion-editing-apple-picking/ (8 participants, 2023; users repeatedly shortened and expanded answers and wanted to edit or point at parts) |
| 8 | Be honest about what undo cannot reverse. | Say before the action when it cannot be undone (a sent email). Never show an Undo that does nothing. | Claude Code checkpointing [read]: https://code.claude.com/docs/en/checkpointing ("Checkpointing does not track files modified by Bash commands"; external changes are not tracked either, and it is not version control) |
| 9 | When something fails, say what happened in plain words and what to do next. | No HTTP codes in user copy. One action. Say whether retrying is safe. | NN/g heuristic 9 [summary]; Apple HIG generative AI [summary] (state what happened, offer a next step); PAIR errors [summary]: https://pair.withgoogle.com/chapter/errors-failing/ (explain, offer alternatives, hand control back) |
| 10 | Under doubt, do less and ask one question. | When a request has two readings, act on the clear part and ask about the rest. | Horvitz factors 5 and 8 [read] (the paper prefers "doing less" done correctly, to avoid costly undoing); Amershi G10 [read]; PAIR errors [summary] (proactive recommendations only when confident) |
| 11 | Time Waldo's own messages to the person's attention, and state urgency honestly. | Ask once, wait, withdraw. Time Sensitive only for things due within the hour. | Horvitz factors 3 and 7, and the LookOut timing study [read] (it waits patiently, then withdraws with an apologetic gesture); Amershi G3 [read]; Apple HIG managing notifications [summary]: https://developer.apple.com/design/human-interface-guidelines/managing-notifications (interruption levels, accurate urgency); Pu et al. 2025 [summary]: https://arxiv.org/abs/2502.18658 (proactive support raised efficiency but disrupted work; presence indicators reduced the disruption); Mark, Gudith and Klocke 2008: https://doi.org/10.1145/1357054.1357072 [inference: abstract not retrieved, so no finding is claimed from it] |
| 12 | Say what the system can do and how well, before the person relies on it. | Capability lines in first run and empty states. "Couldn't check X" inside answers. No invented confidence. | Amershi G1 and G2 [read]; Apple HIG machine learning [summary]: https://developer.apple.com/design/human-interface-guidelines/machine-learning (set expectations before use, explain why results are weak); Apple HIG generative AI [summary] (transparency about limits) |
| 13 | Calibrate trust. Do not maximize it. Explanations can inflate acceptance. | Show evidence the person can check, not reassurance. Add friction in proportion to stakes. | PAIR explainability and trust [summary]: https://pair.withgoogle.com/chapter/explainability-trust/ ; Bansal et al. 2021 [summary]: https://arxiv.org/abs/2006.14779 (explanations raised acceptance whether or not the AI was right); Bucinca et al. 2021 [summary]: https://arxiv.org/abs/2102.09692 (forcing functions cut overreliance but were rated least favorably) |
| 14 | Explain why in one short, factual attribution. | Reference chips name the events and emails behind a card. No talk about the model. | Amershi G11 [read]; Apple HIG machine learning [summary] (attribution that explains the basis without describing the model); PAIR explainability and trust [summary] (partial explanations tied to actions) |
| 15 | Let people see, correct and switch off what Waldo remembers and learns. | Memory notes appear when written. Correct and forget are server-confirmed. | Amershi G12, G13, G15, G17 [read]; PAIR feedback and controls [summary]: https://pair.withgoogle.com/chapter/feedback-controls/ (editable preferences, reset to default); Apple HIG machine learning [summary] (corrections) |
| 16 | Take feedback lightly, voluntarily, and show it was heard. | Rating is optional, never blocks, and acknowledges only what will change. | Apple HIG generative AI [summary] (voluntary, easy, non-interrupting); PAIR feedback and controls [summary] (state what changes and when, promise only timing you can keep); Amershi G15 and G16 [read] |
| 17 | Announce changes in what Waldo does, and raise automation gradually. | New capabilities and standing permissions are announced, scoped and revocable. | Amershi G14 and G18 [read]; PAIR explainability and trust [summary] (increase automation as trust grows, keep permissions easy to review); Anthropic [summary] (lasting permissions for routine tasks) |
| 18 | Show real system state: offline, stale, unconfirmed, partial. | "As of" times, an offline line, and the "Unconfirmed" wording Waldo already uses. Never imply freshness. | NN/g heuristic 1 [summary]; Apple HIG progress indicators [summary] (an iOS refresh title can say when content last updated); PAIR errors [summary] (state limits specifically) |

Note on the no-spinner rule [inference]: NN/g and Apple default to animated or determinate indicators. The design system forbids animation, so the sources' aim (the person can tell work from a hang) has to be met by text that changes with the work. An agent turn has no knowable percent, so the honest substitute is "Checked N things so far". Probe 1 below tests this.

## 2. Waldo's app today, per surface (waldo-app `7e09317c`)

"missing" means I found no code for it in `app/` or `src/`.

### 2.1 Chat (Waldo tab)

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | History load: "Opening your conversation with Waldo…". Send in flight: own bubble marked "Sending…". Turn open: one static line, "Waldo has your message." then "Waldo is working.", and after 30 s "Still working. This one is taking longer than usual." Older rows: "Getting earlier messages". Announcements to VoiceOver on start and finish. | `ChatPane.tsx:229-230`, `:430-452`, `:528-546` (label choice `:536-537`, 5 s clock tick `:533`), `:250`, `:129-134` |
| Streaming or progress | **missing.** One line, no steps, no partial text. The reply arrives as a whole row after the receipt poll (2 s for the first 20 s, then 10 s). The app reads only text and approval parts. The pinned `parts.ts` has no progress, receipt or "what changed" part (only approval, quick_replies, chart_series, file, voice). | `appRuntime.ts:274-278`, `mainChatController.ts:111-126`, `transcriptAdapter.ts:4-19`, `parts.ts:27-52` |
| Empty | "What should we sort first?" with variants for a draft and for signed out. Chat list: "No chats yet". | `ChatPane.tsx:231-235`, `:337-360`, `chats.tsx:97` |
| Error and retry | History failed: cause in brackets, "Nothing is shown in its place.", "Trying again in N seconds.", Try again. Auto-retry backs off from 2 s to 60 s. Send failed: bubble marked "Unconfirmed" with Retry (same message id). Generic line "Agent request could not be confirmed (status…). Retry when connected". | `ChatPane.tsx:548-579`, `appRuntime.ts:119-134`, `ChatPane.tsx:432-447`, `useChat.ts:64-65`, `appRuntime.ts:21-23,107`, `ChatPane.tsx:280` |
| Offline | **missing.** No connectivity check anywhere. Offline surfaces as "Unconfirmed" or the generic line. Only a signed-out chat keeps a draft ("Keep an unsent draft"). | `ChatPane.tsx:623`, `appRuntime.ts:22` |
| Partial failure | Interrupted or session-ended turns say the request "may have partly run" when effects are unconfirmed. It is one notice above the composer, cleared when the next message is sent. Per-step outcomes: **missing.** | `mainChatController.ts:128-135`, `ChatPane.tsx:279`, `mainChatController.ts:81` |
| Confirmation and undo | Retry of the same message is idempotent. Approval cards inline in replies. Long-press on a reply: share or copy. On the person's message: share or edit. Stop, rating and undo: **missing.** Send is inactive while a turn is open (typing stays possible). | `useChat.ts:46-54`, `ChatPane.tsx:516`, `:491`, `:500`, `:509-510`, `:610`, `:627`, `useChat.ts:80`, `ChatPane.tsx:285` |
| Stale data | Pull to refresh and a "Latest" jump pill. A failed refresh keeps the transcript on screen with no "may be out of date" line, unlike other surfaces. In the background polling stops, and it resumes on return. | `ChatPane.tsx:192`, `:267-276`, `mainChatController.ts:22-24`, `useChat.ts:24`, `:26-27` |

### 2.2 Home

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | Each part has its own static line: "Reading your approvals", "Reading today's cards", "Reading your scores". Cards ease in with a staggered fade. | `TodaySummary.tsx:84,114,135,152`, `HomeCard.tsx:12` |
| Streaming or progress | Not applicable today. "Waldo is carrying" (ongoing work) is not served. | brief table |
| Empty | "Nothing waiting for you. Approvals appear here when Waldo asks." "Waldo has no cards scheduled for today." Brief: the card is absent when there is nothing to say, where the brief rule says it is always present with a status line. | `summaryView.ts:31`, `TodaySummary.tsx:111`, `:134`, `:102` |
| Error and retry | Per part: "X could not be loaded. Nothing is shown in its place." One shared Try again. The server's Retry-After is respected. | `TodaySummary.tsx:83`, `:155`, `:56-63`, `:95` |
| Offline | **missing.** | grep: no NetInfo or reachability |
| Partial failure | Parts load independently. Scores show a per-score reason instead of a number. | `TodaySummary.tsx:59-63`, `:96-99`, `summaryView.ts:12,17` |
| Confirmation and undo | **missing.** Waiting rows open Approvals. Home decides nothing yet. Undo on Home is in review (#117, #118). | `TodaySummary.tsx:25-26`, `:27-36` |
| Stale data | Approvals: "The latest refresh failed. This may be out of date." Scores: a static "Scores update while Waldo is open." with no as-of time. Re-read on focus, on foreground and at the owner's midnight. No pull to refresh, no "updated at". | `TodaySummary.tsx:113`, `:149`, `:64-73`, `useDayInView.ts:13-30` |

### 2.3 Approvals (list and chat card)

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | "Reading your approvals". Chat card: "Checking this request". Deciding: "Sending your decision…" and all buttons dim while any decision is pending. | `ApprovalsList.tsx:37`, `:60`, `:55`, `ApprovalCard.tsx:39`, `:65` |
| Streaming or progress | Not applicable. The outcome arrives as the server's receipt wording. | `approvalsController.ts:85-90` |
| Empty | "Nothing is waiting for your decision." Sections "Needs you" and "Earlier". | `ApprovalsList.tsx:70-72` |
| Error and retry | Load failed with Try again. Decision unconfirmed: "…it does not decide twice." with Retry and Dismiss. Specific notices for changed, gone, limit reached and not accepted. | `ApprovalsList.tsx:35-36`, `:61-63`, `ApprovalCard.tsx:66-68`, `approvalsController.ts:11-12`, `:74-78` |
| Offline | **missing.** A dropped decision becomes "uncertain" with Retry. | `approvalsController.ts:79` |
| Partial failure | Requests the app cannot read are counted. A chat card can be unchecked, changed or missing. | `ApprovalsList.tsx:68`, `approvalCardView.ts:4-13`, `ApprovalCard.tsx:40-51` |
| Confirmation and undo | Effect-named labels for the generic kind ("Send email", "Move the event"). Decision bound to the digest the person saw. Undo: the label and the "Undone" state exist, no UI or window (**missing**, in review). Expiry is static text with no countdown and no "if you do nothing" line (**missing**). | `approvalsView.ts:19-23`, `approvalsController.ts:44-52`, `approvalsView.ts:13`, `:27`, `:75`, `ApprovalsList.tsx:53` |
| Stale data | "The latest refresh failed. This list may be out of date." Re-read each time the screen comes into view. | `ApprovalsList.tsx:69`, `approvals.tsx:7` |

### 2.4 Body (scores, Apple Health, consent)

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | "Reading your scores", "Reading your health agreements", "Saving your choice", "Sending your Apple Health readings". The wearable screen uses "Reading the latest from {source}..." and is outside the no-spinner test. | `HealthScores.tsx:34`, `HealthConsent.tsx:60`, `:106`, `ingestLine.ts:25`, `wearable.tsx:60` |
| Streaming or progress | A health send is one line with no progress shape. | `ingestLine.ts:25` |
| Empty | "No readings came back. There may be no records yet, or access for Waldo may be off…" Scores unavailable show the server's reason. "Trends and history are not available yet, and no scores are invented." Health detail screens are placeholders. | `HealthSnapshotRows.tsx:15-18`, `summaryView.ts:12`, `scoresView.ts:20,26`, `HealthStats.tsx:23`, `featureAvailability.ts:2` |
| Error and retry | "Scores could not be loaded. Nothing is shown in their place." with Try again. Consent load failure. Ingest failures say what to do next. | `HealthScores.tsx:35-36`, `HealthConsent.tsx:54-58`, `ingestLine.ts:34-41`, `healthConsentController.ts:124,128` |
| Offline | A paused send says it will try again the next time the app opens. No general offline state (**missing**). | `ingestLine.ts:39` |
| Partial failure | Unread kinds are named: "X could not be read this time." "Saved, but the switches could not be refreshed." | `ingestLine.ts:18-20`, `healthConsentController.ts:110` |
| Confirmation and undo | Consent changes are server-confirmed. Withdrawal wording not checked [check on Simulator]. | `healthConsentController.ts:84-110` |
| Stale data | Best in the app: "Out of date. Last calculated" and "Expired. Last calculated", plus a stale-inputs reason and a footer note when a refresh failed. | `scoresView.ts:18,25,47`, `HealthScores.tsx:42` |

### 2.5 Patrol, Spots, Constellations

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | Constellations: "Reading your constellations". A picked node: "Reading the notes and links behind this" (polite live region). Patrol and Spots: placeholders. | `ConstellationsScreen.tsx:49`, `ConstellationPanel.tsx:58`, `patrol.tsx:2`, `spots.tsx:2` |
| Streaming or progress | Not applicable. | n/a |
| Empty | "No constellations yet". Patrol: "Activity is unavailable". Spots: "Memory is unavailable", which also says confirm, dismiss and forget need server-backed results. Settings rows read "Not shown in the app yet". | `ConstellationPanel.tsx:38`, `featureAvailability.ts:2`, `settings.tsx:18-19` |
| Error and retry | "Constellations could not be loaded. Nothing is shown in their place." with Try again. Memory unavailable card with Try again. Pick failure with Try again. | `ConstellationsScreen.tsx:40,43-48`, `ConstellationPanel.tsx:59-60` |
| Offline | **missing.** | grep |
| Partial failure | Supporting notes the server linked but could not show are counted. | `types.ts:10-11`, `view.ts:42` |
| Confirmation and undo | Correct, dismiss, forget: **missing** (needs backend write receipts). | `featureAvailability.ts:2` |
| Stale data | "The latest read failed. This may be out of date." Read again each time the screen opens. The map honors Reduce Motion. | `ConstellationsScreen.tsx:56`, `:15`, `ConstellationMap.tsx:46` |

### 2.6 Notifications

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | **missing.** No import or call of a notification package in `app/` or `src/`. The push registration contract exists (apns or fcm, environment, device epoch, active or revoked) and a Worker without the routes answers 404. | `devices.ts:3-22` |
| Streaming or progress | Not applicable. | n/a |
| Empty | Settings has no notification row. Schedule covers time zone, quiet hours and volume. | `settings.tsx:15` |
| Error and retry | **missing.** | n/a |
| Offline | Not applicable. | n/a |
| Partial failure | Not applicable. | n/a |
| Confirmation and undo | The onboarding notifications step is a placeholder, so no priming and no denied state (**missing**). | `app/(onboarding)/notifications.tsx:2` |
| Stale data (in-app substitutes) | Home card "Pick up where you left off, What changed: Waldo wrote…". VoiceOver line "Waldo wrote in Main chat". Polling stops in the background, so a turn that finishes while the person is away is found only on return. | `MainChatReEntry.tsx:9-23`, `ChatPane.tsx:135-144`, `useChat.ts:24` |

### 2.7 Onboarding and sign-in

| State | What exists | Evidence |
|---|---|---|
| Loading, waiting, thinking | "Checking your session". Sign-in button uses a loading flag with no named line. All 17 onboarding steps are placeholders ("Agent setup is unavailable"). | `RequireSession.tsx:18`, `agent-sign-in.tsx:72`, `featureAvailability.ts:2`, `hello.tsx:2` |
| Streaming or progress | A progress header component exists but no screen uses it [unverified]. | `src/components/onboarding/ProgressHeader.tsx` |
| Empty | Not applicable. | n/a |
| Error and retry | Wrong or used code: "Ask for a new code and try again; the last one may already be used." Invite needed. "Can't reach Waldo" with Try again when the session cannot be restored. Signing out: "Chat stays locked until Waldo confirms it." with Try signing out again. | `agent-sign-in.tsx:46`, `:79-81`, `RequireSession.tsx:20-27`, `agent-sign-in.tsx:60-62` |
| Offline | Mentioned only when a restore fails ("Check your connection") and in Settings ("try again when you are online"). | `RequireSession.tsx:23`, `settings.tsx:31` |
| Partial failure | Not applicable. | n/a |
| Confirmation and undo | Adult checkbox. Account deletion requires the person to type a confirmation word. | `agent-sign-in.tsx:75-76`, `AccountPanel.tsx:14` |
| Stale data | The code is single use, but there is no expiry or resend cue (**missing**). | `agent-sign-in.tsx:45` |

## 3. The gap list, ranked

Ranking rule: how often the person meets the gap (every chat turn first), then trust and safety, then launch blockers, then polish. Status says whether the work is already in flight, so nobody gets a duplicate ask. In flight: app #117 and #118 (Undo, approval question and countdown), #121 (To send), approval labels after 12:30 UTC today, Patrol and Spots wiring (L4), and the backend's typed parts, Stop and rating. Owners: DESIGN (Suyash), L4 (app wiring), BACKEND (ask).

| Rank | Gap | Surface | Owner | Status | User value |
|---|---|---|---|---|---|
| 1 | Step timeline for a 10-40 s turn | Chat | DESIGN, BACKEND, then L4 | new; backend parts in flight | People can tell working from stuck and see what Waldo touched |
| 2 | Stop, and steer while Waldo works | Chat | BACKEND, DESIGN, L4 | Stop in flight; steer new | A wrong request can be cut off instead of waited out |
| 3 | Leaving and coming back (push, resume) | Notifications, Chat, Home | BACKEND, DESIGN, L4, package ask | new; push not live | A turn that outlasts attention is not lost until the app opens |
| 4 | Failure copy: plain words and a next step | All | DESIGN, L4 | new | People learn what to do instead of reading an HTTP status |
| 5 | Approval completion: Undo window, countdown, "if you do nothing", Done label | Approvals, Home, Chat | L4, DESIGN, BACKEND | #117, #118 and labels in flight; the rest new | The highest-trust moment is clear, reversible where possible, and honest about what is not |
| 6 | Offline and as-of times | All | DESIGN, L4, package ask | new | People know whether what they see is current and whether their message went |
| 7 | Per-step outcomes and partial-failure receipts | Chat | BACKEND, DESIGN, L4 | receipts in flight | Honest partial results instead of a silent gap |
| 8 | Proactive etiquette: per-category control, why-now, snooze | Notifications, Settings | OWNER, DESIGN, BACKEND | partly exists | Trust that Waldo will not become noise |
| 9 | Memory transparency and correction at point of use | Chat, Spots, Constellations | BACKEND, DESIGN, L4 | Spots wiring in flight; correction new | The person can see and fix what Waldo believes about them |
| 10 | Limits disclosure and first-run capability lines | Chat, Onboarding, Body | DESIGN, BACKEND | new | No false reliance on a check that never ran |
| 11 | Rating and feedback | Chat | BACKEND, DESIGN, L4 | in flight | Tells Waldo what missed |
| 12 | Refine in place: act on part of a reply | Chat | DESIGN, L4 | new | No re-asking to shorten one paragraph |
| 13 | Render the contract parts the app ignores | Chat | L4, DESIGN | new | One-tap replies, and charts and files that actually show |
| 14 | Voice input states [proposed] | Chat | DESIGN, L4, package ask | new | Hands-free input without sending a wrong transcript |
| 15 | Onboarding and sign-in waits, permission priming | Onboarding | DESIGN, L4 | flow is in the brief; sign-in waits new | Setup waits that say what is happening |
| 16 | Accessibility of waiting | All | L4, DESIGN | new; checks only | VoiceOver users get the same status as everyone else |
| 17 | Home completeness against the brief | Home | DESIGN, L4, BACKEND | partly in the brief | The screen matches the decided order |

### Gap 1. Step timeline for a 10-40 s turn

- Pattern to add: replace the three-label row (`ChatPane.tsx:537`) with a trail under Waldo's mark. One line names the current step and is replaced as each step starts. A running count reads "Checked 2 things so far". On completion the trail collapses to "Checked 3 things", and a tap lists the three lines (owner rule). A failed step stays in the list ("Couldn't reach Gmail"). No spinner or pulse. If no new step arrives for about 8 s, the line adds "Still on this." The existing 30 s line stays and now names the step.
- Surface: Chat. Patrol later shows the same steps after the fact.
- Owner: DESIGN for the states. BACKEND for a progress part: an event at accept, one per tool start and finish, stable step ids that match the receipt. L4 wiring is blocked until the pinned contract folder is repinned: `parts.ts` at `7e09317c` has no progress or receipt part, and `transcriptAdapter.ts:4-19` reads only text and approval parts.
- User value: every reply is a 10-40 s wait, and today it shows one line that changes at most twice, so people cannot tell working from stuck or what Waldo touched.
- Why: principles 2, 3, 5. Step cadence follows model calls (about 6 s), which fits inside the 10 s attention limit if the backend emits an event at each call start [inference].

### Gap 2. Stop, and steer while Waldo works

- Pattern to add: Send becomes Stop while a turn is open (today Send is inactive: `ChatPane.tsx:610`, `:285`, `useChat.ts:80`). After Stop: "Stopping.", then a receipt line saying what ran and what did not. If unknown, reuse the existing honest wording (`mainChatController.ts:128-130`). Steering: allow a follow-up during a turn, shown as "Queued, sends when Waldo finishes" [proposed], or a correction that interrupts [owner decision].
- Surface: Chat composer and trail.
- Owner: BACKEND (stop endpoint, queue-or-interrupt semantics, receipt for a stopped turn), DESIGN, L4.
- User value: a wrong request today means waiting out 10-40 s, with any action it takes.
- Why: principles 4 and 6, Horvitz factor 6.

### Gap 3. Leaving and coming back

- Pattern to add: (a) permission priming at a moment of value, plus a denied state [proposed]. (b) "Reply ready" at Apple's Active level. "Needs your yes or no" at Time Sensitive only when it is due within the hour [summary]. (c) No health content on the lock screen unless the owner decides otherwise [proposed]. (d) On return, resume at once (exists, `useChat.ts:26-27`) and show a "finished while you were away" entry. The Home re-entry card is the start (`MainChatReEntry.tsx:9-23`).
- Surface: Notifications, Chat, Home.
- Owner: BACKEND (push live, per-event levels). PACKAGE ASK: a notification package, because the brief says to ask before adding packages. DESIGN for copy, priming and denied. L4 for wiring.
- User value: 10-40 s turns outlast attention, and without push a finished turn is invisible until the app opens (`useChat.ts:24`).
- Why: principles 11 and 18.

### Gap 4. Failure copy: plain words and a next step

- Pattern to add: one error pattern. First, what happened in plain words. Second, what Waldo did or did not do, including whether retrying is safe (the existing "it does not decide twice" is the model, `ApprovalsList.tsx:61`). Third, one action. Fourth, detail behind a "Details" disclosure for support. Three classes: passes on its own (auto-retry with a countdown, exists, `ChatPane.tsx:559-560`), needs you (sign in, reconnect Google), not available in this version (exists as "Nothing is shown in its place").
- Evidence: `failureDetail` builds "status N, reason" into user text (`appRuntime.ts:21-23`), which feeds "Agent request could not be confirmed (…). Retry when connected" (`:107`) and the history failure line (`ChatPane.tsx:564`). The "Retry when connected" tail also appears when the cause is not connectivity.
- Surface: all.
- Owner: DESIGN (pattern and copy), L4 (stop showing `failureDetail` to people).
- User value: the person learns what to do instead of reading an HTTP status.
- Why: principle 9.

### Gap 5. Approval completion

- In flight: Undo, question and countdown (#117, #118), and L4's approval labels after 12:30 UTC.
- Pattern still to add: (a) a live countdown only inside the final minute, with a static outcome line, "If you do nothing, Waldo drops this and tells you" [copy depends on backend expiry semantics, open question]. (b) The Undo window per the owner rule, with a line before the decision when an action cannot be reversed. (c) "Done" only after the check. (d) Skip and Not doing. (e) A VoiceOver announcement and a haptic when the receipt lands, not on tap [proposed]. (f) Button text that names the specific effect ("Move to Thu 11:00"); today it is generic (`approvalsView.ts:22`).
- Surface: Approvals, Home, Chat card.
- Owner: L4 (labels, #117, #118), DESIGN (countdown and undo states), BACKEND (undo action, its limits, expiry behavior).
- User value: this is the moment of highest trust and highest cost of error.
- Why: principles 6, 7, 8.

### Gap 6. Offline and as-of times

- Pattern to add: a static line above the composer, "Can't reach Waldo. Your message is kept.", with Send disabled and the reason shown, clearing itself when the connection returns. An "Updated 9:41" line on Home parts and Body. Pull to refresh on Home, Approvals and Body (only Chat has it, `ChatPane.tsx:192`). Body already has freshness copy to reuse (`scoresView.ts:47`).
- Package ask: NetInfo needs approval. Cheaper first step: infer "can't reach Waldo" from failed requests. `appRuntime.ts:22` already separates "no answer from the server" from an HTTP answer.
- Evidence: no connectivity check anywhere. Only Settings says "online" (`settings.tsx:31`). The icon set already has an offline glyph (`waldoIconRegistry.ts:126`).
- Owner: DESIGN, L4.
- Why: principles 9 and 18.

### Gap 7. Per-step outcomes and partial-failure receipts

- Pattern to add: attach the outcome to the turn: "Checked 3 things. Couldn't reach Gmail, so this doesn't cover email." Interrupted turns keep "may have partly run" on the turn until dismissed, with "Check what ran" opening Patrol (the activity view is served). Today it is one notice above the composer that clears on the next send (`ChatPane.tsx:279`, `mainChatController.ts:81`).
- Surface: Chat, later Patrol.
- Owner: BACKEND (per-step outcome in the receipt), DESIGN, L4.
- User value: honest partial results instead of a silent gap.
- Why: principles 12 and 18.

### Gap 8. Proactive etiquette: per-category control, why-now, snooze

- Already exists: quiet hours and volume (`settings.tsx:15`), and the Home re-entry card. Do not treat proactive control as wholly missing.
- Pattern to add [proposed]: each unprompted message carries a one-line reason ("Because your 11:00 moved"). "Not now" snoozes that category. A log of what Waldo sent unprompted, in Patrol. Per-category switches. A daily budget of unprompted messages.
- Surface: Notifications, Settings, Chat.
- Owner: OWNER (budget, levels), DESIGN, BACKEND (categories and levels in the notification policy).
- User value: trust that Waldo will not become noise.
- Why: principle 11. Apple's machine-learning page warns that people have less patience for errors in proactive features [summary].

### Gap 9. Memory transparency and correction at point of use

- Pattern to add: when Waldo writes memory, a line in chat, "Waldo noted: <plain line>" with Correct and Forget. "Used from memory" lines inside "Checked N things". A Spots list with confirm, dismiss and forget that shows the server receipt, and says "Forgotten" only after it is confirmed.
- Evidence: Spots shows "Memory is unavailable" (`featureAvailability.ts:2`) while the claims view is served (brief). Constellations is real but read-only.
- Surface: Chat, Spots, Constellations.
- Owner: BACKEND (memory write receipts and a note part), DESIGN, L4 (Spots wiring in flight).
- Why: principles 14 and 15.

### Gap 10. Limits disclosure and first-run capability lines

- Pattern to add: capability starters in the empty state, limited to connected tools (the brief says to hide examples that need a connector we do not have). "Couldn't check X" inside answers (links to gap 7). No invented confidence. Body's reason-per-score pattern is the model (`summaryView.ts:12`).
- Evidence: the chat empty state is a title and one line (`ChatPane.tsx:354-359`).
- Surface: Chat, Onboarding, Body.
- Owner: DESIGN. BACKEND supplies "not checked" facts.
- Why: principle 12.

### Gap 11. Rating and feedback

- Pattern to add: thumbs on Waldo's replies (the long-press menu already holds share and copy, `ChatPane.tsx:500`, `:509-510`), optional reason chips, and an acknowledgment that says only what is true. Ask rarely [proposed].
- Surface: Chat.
- Owner: BACKEND (rating endpoint), DESIGN, L4. In flight.
- Why: principle 16.

### Gap 12. Refine in place: act on part of a reply

- Pattern to add: long-press a paragraph or line for "Ask about this", "Shorter", "Use this in a message". Number steps so they can be referenced (NN/g's interim advice). The brief says editing a draft happens in chat for now, so this is about replies, not drafts.
- Evidence: NN/g's 8-participant study found repeated shorten-and-expand rounds, pasting parts of earlier answers into prompts, and trouble comparing versions [summary]. In Waldo the reply menu offers share and copy only (`ChatPane.tsx:500`). Edit exists only on the person's own messages (`:491`).
- Surface: Chat.
- Owner: DESIGN, L4.
- Why: principle 7.

### Gap 13. Render the contract parts the app ignores

- Pattern to add: states for each part. Quick replies (named-effect chips, disabled after use). Chart (loading line, failed, empty). File (fetching, failed, unavailable). Voice (transcript plus the contract's fallback text).
- Evidence: `parts.ts:33` quick_replies, `:39` chart_series, `:47` file, `:52` voice, but `transcriptAdapter.ts:4-19` passes only text and approvals.
- Surface: Chat.
- Owner: L4, DESIGN.

### Gap 14. Voice input states [proposed]

- Pattern to add: microphone priming and denied, listening, transcribing, review before send (editable transcript, never auto-send), nothing heard, voice unavailable (fall back to typing). No primary source backs these states.
- Surface: Chat composer.
- Owner: DESIGN, L4. PACKAGE ASK for any audio or speech package. The mic is approved but not built.

### Gap 15. Onboarding and sign-in waits, permission priming

- Pattern to add: named lines for sign-in ("Sending a code to <email>", "Checking the code"). A resend after a pause [proposed]. Priming plus a denied state for each permission (health, notifications). A "Setting up" screen with named steps (the first health send already has a line, `ingestLine.ts:25`).
- Evidence: 17 onboarding steps are placeholders (`featureAvailability.ts:2`). The sign-in button shows a loading flag with no named line (`agent-sign-in.tsx:72`).
- Surface: Onboarding.
- Owner: DESIGN, L4. The onboarding flow is already in the brief.

### Gap 16. Accessibility of waiting

- Checks, not assertions: how VoiceOver reads `accessibilityRole="progressbar"` on plain text (`ChatPane.tsx:230`, `:541`) [check on Simulator]. Whether Reanimated `FadeInDown` honors Reduce Motion (`HomeCard.tsx:12`); the app's own hook is used by `motion.tsx:12-17,25`, `SideMenu.tsx:28`, `SegmentedControl.tsx:18` and `ConstellationMap.tsx:46`, but not by `HomeCard` [check on Simulator].
- Policy to set [proposed]: announce a turn's start and its end, not every step (start and end already exist, `ChatPane.tsx:129-134`). No ticking live regions for countdowns. Haptic when a decision's receipt lands.
- Owner: L4, DESIGN.

### Gap 17. Home completeness against the brief

- Brief card is conditional (`TodaySummary.tsx:102`) where the brief says always present with a status line. "Waldo is carrying" is not served. Home decides nothing yet (`TodaySummary.tsx:25-26`). No as-of times or pull to refresh (gap 6).
- Owner: DESIGN (status line copy), L4 (wiring after #117 and #118), BACKEND (carrying feed).

### Code versus brief: state both, code wins

1. `approvalsView.ts:13`: `done` reads "Confirmed". Owner rule: "Done" once the action is checked.
2. `approvalsView.ts:27`: the final-no button reads "Don't do this". Brief: "Not doing". In flight with L4's label work after 12:30 UTC, so do not ask twice.
3. `TodaySummary.tsx:102`: the Brief card is conditional. Brief: always present.
4. `TodaySummary.tsx:25-26`: Home decides nothing yet. The brief table lists Home buttons as real.
5. `settings.tsx:24`: "Dark" shows "Coming soon", close to the brief's rule against saying what is coming. Check with the owner.
6. `useChat.ts:60`, `ChatPane.tsx:422,537`: "Waldo is working." can show while the bubble still says "Sending…", though the code comment says the line claims only what the receipt says (`ChatPane.tsx:528`) [check on Simulator].
7. `ChatPane.tsx:156-157`: the composer keeps the text until the server accepts, so the same words show in the bubble and the composer for that round trip [check on Simulator].
8. `useChat.ts:36`: Main chat rows carry only id, role, body, approvals, times and channel, so the `card` and `evidenceLine` slots in `ChatPane.tsx:517-522` get no data from Main chat [inference].
9. `ChatPane.tsx:230`: the history load line says "Opening your conversation with Waldo…" and carries a progressbar role with no value [check on Simulator].

### Open questions for the owner

1. How long is the Undo window, and what does "if you do nothing" do on expiry?
2. Stop: does a follow-up sent during a turn queue, or interrupt?
3. Show the step count, elapsed time, or both?
4. Unprompted-message budget, and what may appear on the lock screen?
5. May the app say a typical turn length ("This can take up to a minute")? Only if the latency data supports it.

## 4. Loader and state catalogue

### 4.1 Timing ladder

| Threshold | What the app does | Source |
|---|---|---|
| 0.1 s | Press state, haptic, own bubble appear. No extra feedback needed. | NN/g response times [summary] |
| 0.1 to 1 s | Keep the screen stable. No indicator. | NN/g response times [summary] |
| Over 1 s | Show a named line. | NN/g progress indicators [summary], Apple HIG progress indicators [summary] |
| 10 s and over | The line changes with the work. Offer Stop. Give a rough expectation if the data supports it. | NN/g response times [summary], Apple HIG [summary] |
| About 6 s per model call | The first step line must come from a backend progress event. A client timer can only add "still" wording. | owner fact; [inference] |
| 30 s | Existing slow line (`ChatPane.tsx:536-537`), now naming the step. | app |
| Over 3 min | Turn becomes "Unconfirmed" (`ChatPane.tsx:434`). Resend is refused after 12 h (`mainChatController.ts:12`). | app |

### 4.2 Catalogue

Status: exists, partial, new, proposed. Copy lines marked [proposed] are suggestions in Waldo's voice. They use no health numbers. Connector examples show only when that connector is linked.

#### Chat

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| C1 | Tap received (exists) | Tap Send | Pressed state, light haptic, own bubble "Sending…" | "Sending…" (`ChatPane.tsx:435`) | 0.1 s for press and bubble [check on Simulator] | Bubble label "Your message, Sending" (`ChatPane.tsx:439`); haptic is never the only cue |
| C2 | Accepted (exists) | Server accepts | Bubble "Sent". Line under Waldo's mark | "Waldo has your message." (`ChatPane.tsx:537`) | About 1-2 s [check on Simulator] | Polite live region (`ChatPane.tsx:541`) |
| C3 | Working, step named (new, needs backend part) | Each progress part | One line, replaced at each step. Optional "Checked N things so far" | [proposed] "Reading your calendar", "Checking Gmail for the thread with Priya", "Writing the reply" | First step line within about 2 s of accept. Changes only when a step changes. After 8 s with no new step add "Still on this." | Announce "Waldo is working" once (exists, `ChatPane.tsx:131`), then the end or a failure only |
| C4 | Slow turn (partial) | Over 30 s | Current line plus slow note | "Still working. This one is taking longer than usual." (`ChatPane.tsx:537`). [proposed] second tier at about 90 s once push exists: "Still on <step>. You can leave. Waldo will tell you when it's done." | 30 s exists. About 90 s proposed | One announcement per tier |
| C5 | Stopping (new, Stop in flight) | Tap Stop | Stop becomes a disabled line. Composer stays locked until the receipt | [proposed] "Stopping. Waiting to hear what already ran." | Press state 0.1 s. At 5 s with no receipt: "Still stopping." | Button label "Stop Waldo's work". Announce "Stopping", then the receipt |
| C6 | Stopped receipt (new) | Receipt says stopped | Line on the turn: what ran, what did not | [proposed] "Stopped. Waldo checked your calendar and sent nothing." and "Stopped. One step may have run. Check before you ask again." (second reuses `mainChatController.ts:128-130`) | Shows with the receipt, stays until the next send | Announce once, polite |
| C7 | Follow-up queued (proposed) | Send during an open turn | Second bubble marked queued | [proposed] "Queued. Sends when Waldo finishes." | Until the turn closes | Label "Queued message" |
| C8 | Finished, reply not readable yet (partial) | Receipt completed, reply row missing | Today nothing new, then a notice | Today "Waldo finished, but the reply is not showing yet. Use Refresh." (`mainChatController.ts:126`). [proposed] first closed read: "Waldo finished. Getting the reply." | Polls 2 s apart, up to 8 reads (`mainChatController.ts:11`, `appRuntime.ts:278`) | Polite |
| C9 | Interrupted or session ended (exists) | Receipt interrupted or revoked | One notice above the composer | Existing wording, `mainChatController.ts:128-135`. [proposed] attach it to the turn until dismissed | Persists until dismissed [proposed] | Announce once |
| C10 | Unconfirmed (exists) | No receipt, or no answer in 3 min | Bubble marked "Unconfirmed" with Retry | "Unconfirmed", "Retry same message" (`ChatPane.tsx:435`, `:445`) | 3 min. Resend refused after 12 h | Retry has its own label |
| C11 | Opening conversation (exists) | First history read | Centered line | "Opening your conversation with Waldo…" (`ChatPane.tsx:230`) | Immediate, it is a full-screen state. Auto-retry from 2 s up to 60 s (`appRuntime.ts:132`) | Role has no value [check on Simulator] |
| C12 | History failed (exists) | Every read failed | Cause, "Nothing is shown in its place.", countdown, Try again | `ChatPane.tsx:564-575`. [proposed] drop the bracketed status, keep it under "Details" | Backoff 2 s to 60 s | Announced once (`ChatPane.tsx:147`) |
| C13 | Earlier messages (exists) | Tap "Load earlier messages" | Pill reads "Getting earlier messages" | `ChatPane.tsx:250`. Failure wording not verified | Show at once | Busy and disabled state set (`ChatPane.tsx:245`) |
| C14 | Can't reach Waldo (new) | A send or read gets no answer | Static line above the composer. Send disabled with the reason. Draft kept. Clears itself | [proposed] "Can't reach Waldo. Your message is kept." | After the first failed attempt. Retry quietly in the background | Announce once on change |
| C15 | Signed out or session ended (exists) | Session not active | Notice above the composer | "Sign in to read and send in Main chat." (`useChat.ts:63`) | Immediate | Polite |

#### Approvals

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| A1 | Reading approvals (exists) | Screen opens | Static line | "Reading your approvals" (`ApprovalsList.tsx:37`) | Immediate | Polite live region (`StatusLine.tsx:5`) |
| A2 | Checking a chat card (exists) | Card appears in a reply | Static line in the card | "Checking this request" (`ApprovalCard.tsx:39`) | Immediate | Polite |
| A3 | Deciding (exists) | Tap a decision | Buttons dim. Static line | "Sending your decision…" (`ApprovalsList.tsx:60`). [proposed] name the effect: "Moving it to Thu 11:00…" | Line within 0.1 s | Buttons expose a disabled state |
| A4 | Decision unconfirmed (exists) | Answer lost | Explanation, Retry, Dismiss | "Your decision could not be confirmed. Retrying asks Waldo for the first outcome; it does not decide twice." (`ApprovalsList.tsx:61`) | Until the person acts | Retry and Dismiss are labeled |
| A5 | Done with Undo window (new, #117 and #118) | Receipt says checked | "Done" plus what changed, and Undo | [proposed] "Done. Waldo moved it to Thu 11:00." and "Undo". After the window: "Undo is no longer available." | Window length is an open owner decision | Announce "Done. Undo available." once. No ticking live region |
| A6 | Undoing (new) | Tap Undo | Line, then result | [proposed] "Undoing…", then "Undone. Back to Wed 15:00." or "Couldn't undo. The change is still in place." | As A3 | Announce the result |
| A7 | Cannot be undone, said first (new) | Before an irreversible decision | Line above the buttons | [proposed] "This sends an email. It can't be unsent." | Shown before the decision | Read before the buttons in focus order |
| A8 | Expiry (partial) | Request has an expiry | Static "Expires <time>". [proposed] live countdown only in the final minute plus an outcome line | `approvalsView.ts:75`. [proposed] "If you do nothing, Waldo drops this and tells you." (copy depends on backend behavior) | Final minute | Avoid ticking announcements |
| A9 | Changed since asked (exists) | Digest differs | Waldo's wording, no decision buttons | "This request changed since Waldo asked. Review the current version before deciding." (`ApprovalCard.tsx:49`) | Immediate | Button "Open approvals" |
| A10 | No longer available (exists) | Gone or expired and removed | Waldo's wording | "This request is no longer available to decide here." (`ApprovalCard.tsx:45`) | Immediate | Alert role on controller notice (`ApprovalsList.tsx:67`) |

#### Home

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| H1 | Reading a part (exists) | Home in view | Static line in that card | "Reading your scores", "Reading today's cards" (`TodaySummary.tsx:135,152`) | Immediate | Polite |
| H2 | Part failed (exists) | A read failed | Failure line, one shared Try again | "X could not be loaded. Nothing is shown in its place." (`TodaySummary.tsx:83`) | Retry-After respected (`:95`) | Try again is a labeled button |
| H3 | Stale part (partial) | Refresh failed, or old data | Approvals only today | "The latest refresh failed. This may be out of date." (`TodaySummary.tsx:113`). [proposed] "Updated 9:41" on each part | On failure, and always for as-of | Plain text |
| H4 | Brief, nothing new (missing) | No delivered brief | Today the card is hidden (`TodaySummary.tsx:102`) | [proposed] "Nothing new since your last brief." | Immediate | Header role on the card title |
| H5 | Waldo is carrying (not served) | Ongoing work exists | Rows with next move, who holds it, when Waldo checks again | [proposed] "Waldo is carrying 2 things." (design on sample data) | n/a | Rows as buttons |
| H6 | Pull to refresh (missing) | Pull down | Standard refresh control | none | Show at once | Standard control |

#### Body

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| B1 | Reading scores (exists) | Screen opens | Static line | "Reading your scores" (`HealthScores.tsx:34`) | Immediate | Polite |
| B2 | Score unavailable (exists) | Server gives a reason | Reason instead of a number | Server reason (`summaryView.ts:12`, `scoresView.ts:20`) | n/a | Row label includes the reason (`HealthScores.tsx:45`) |
| B3 | Stale or expired score (exists) | Freshness stale or expired | Footer note | "Out of date. Last calculated" (`scoresView.ts:47`) | n/a | Plain text |
| B4 | Sending Apple Health readings (exists) | A send runs | Static line | "Sending your Apple Health readings" (`ingestLine.ts:25`) | Immediate | Polite |
| B5 | Nothing came back (exists) | Empty read | Honest empty note | "No readings came back…" (`HealthSnapshotRows.tsx:18`) | n/a | Plain text |
| B6 | Saving a health choice (exists) | Toggle a consent | Static line | "Saving your choice" (`HealthConsent.tsx:106`) | Immediate | Polite |
| B7 | First score pending (new) | Not enough days of readings | Reason with what is missing | [proposed] "Waldo needs a few more days of readings before it can score this." | n/a | Plain text |
| B8 | Health detail (placeholder) | Open a metric | Placeholder card | "Health detail is unavailable" (`featureAvailability.ts:2`). Design on synthetic data | n/a | Summary role (`UnavailableFeature.tsx:6`) |

#### Spots, Patrol, Constellations

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| S1 | Reading constellations (exists) | Screen opens | Static line | "Reading your constellations" (`ConstellationsScreen.tsx:49`) | Immediate | Polite |
| S2 | Reading a node (exists) | Pick a node | Line under the node | "Reading the notes and links behind this" (`ConstellationPanel.tsx:58`) | Immediate | Polite live region |
| S3 | Reading activity (new, Patrol) | Screen opens | Static line | [proposed] "Reading what Waldo did" | Immediate | Polite |
| S4 | Empty activity (new) | Nothing has run | Plain note | [proposed] "Nothing has run yet." | n/a | Plain text |
| S5 | Saving a correction (new, needs backend write) | Tap Correct | Line, then result | [proposed] "Saving your correction" then "Corrected. Waldo will use this from now on." only after the receipt, else "Couldn't save. Nothing changed." | As A3 | Announce the result |
| S6 | Forgetting (new) | Tap Forget | Line, then result | [proposed] "Forgetting this" then "Forgotten. Waldo no longer uses it." only after the receipt | As A3 | Announce the result |
| S7 | Memory unavailable (exists) | Server says so | Card with Try again | "Waldo's memory is unavailable right now, so there is nothing to draw." (`ConstellationsScreen.tsx:45`) | n/a | Header role |

#### Notifications (all new)

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| N1 | Permission priming | Before the system prompt | One screen on what Waldo will send, per category | [proposed] "Waldo can tell you when a long task is done, or when something needs your yes or no. You choose which." | Shown once, at a moment of value | Plain text, large target |
| N2 | Permission denied | System says no | Plain note with a way to Settings | [proposed] "Notifications are off. Waldo will wait for you here." and "Open Settings" | Immediate | Button label names the destination |
| N3 | Reply ready | Turn finishes while away | Active-level push | [proposed] "Waldo replied." with no body text unless the owner decides otherwise | On finish | Standard |
| N4 | Needs your decision | Request due within the hour | Time Sensitive push, only in that case | [proposed] "Waldo needs your yes or no by 11:00." | Only if due within the hour [summary: Apple HIG] | Standard |
| N5 | Registration failed | Stale epoch or 404 | Silent retry, one Settings line if it persists | [proposed] "Notifications couldn't be set up. Waldo will try again." | Retry with backoff | Plain text |

#### Voice input (all proposed, no primary source)

| ID | State | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| V1 | Mic priming and denied | First use | One line on why, then the system prompt. Denied: how to turn it on | [proposed] "To talk to Waldo, allow the microphone." and "Microphone is off. You can type instead." | Immediate | Typing always available |
| V2 | Listening | Tap mic | Static "Listening" line, Stop control | [proposed] "Listening" | Show within 0.1 s | Announce "Listening" once |
| V3 | Transcribing | Stop speaking | Line | [proposed] "Writing down what you said" | Over 1 s: name it | Polite |
| V4 | Review before send | Transcript ready | Editable text with Send and Discard. Never auto-send | [proposed] "Check this before it goes." | Until the person acts | Text is a normal field |
| V5 | Nothing heard | Silence | Short note, retry | [proposed] "Didn't catch anything. Try again." | Immediate | Polite |
| V6 | Voice unavailable | Offline or error | Fall back to typing | [proposed] "Can't use voice right now. Type instead." (the contract's voice part carries fallback text, `parts.ts:52`) | Immediate | Typing preserved |

#### Sign-in and onboarding

| ID | State (status) | Trigger | What the user sees | Copy | Thresholds | Accessibility |
|---|---|---|---|---|---|---|
| O1 | Sending code (partial) | Tap "Email me a code" | Button loading flag only (`agent-sign-in.tsx:72`) | [proposed] "Sending a code to <email>" | Name the wait after 1 s | Polite |
| O2 | Waiting for code (partial) | Code requested | Code field. No resend cue | [proposed] "Didn't get it? Send another code." after a pause | After about 30 s [proposed] | Resend is a labeled button |
| O3 | Wrong or used code (exists) | Verify fails | Note | "Ask for a new code and try again; the last one may already be used." (`agent-sign-in.tsx:46`) | n/a | Plain text |
| O4 | Invite needed (exists) | Server says needs invite | Note | `agent-sign-in.tsx:79-81` | n/a | Plain text |
| O5 | Checking your session (exists) | App launch | Static line | "Checking your session" (`RequireSession.tsx:18`) | Immediate | Polite |
| O6 | Can't reach Waldo on launch (exists) | Restore fails | Header, explanation, Try again | "Can't reach Waldo" (`RequireSession.tsx:22-27`) | n/a | Header role |
| O7 | Setup step waits (new) | Onboarding flow | Named steps | [proposed] "Setting up. First, connecting Apple Health." | Name the wait after 1 s | Polite |

## 5. What to test with users

Use a test account and synthetic data only. Do not record screens that show real health data.

1. **The twenty-second wait.** Stage a scripted 25 s turn in three variants: today's single line, a line that changes with each step, and the changing line plus "Checked N things so far". Watch whether people say the app froze, reach for the Home gesture, or can say what Waldo is doing. Signal: in the changing-line variants, fewer people call it stuck and more can name the step. This tests the no-spinner assumption in section 1.
2. **Wrong request, mid-turn.** Ask people to cancel a request they just sent ("wrong person"). Watch whether they find Stop, and whether they can say what already ran and what did not.
3. **Approval cards.** Show four cards with generic labels against four with named effects, and "Skip" against "Not doing". Ask what happens on tap, whether it can be undone, and what happens if they do nothing. Signal: correct predictions.
4. **Undo.** After a decision, ask people to reverse it. Watch discoverability and whether they understand what Undo cannot reverse, using one reversible and one irreversible action.
5. **Three failures.** Induce airplane mode during a send, a server error, and a disconnected Google. Ask what happened and what they would do next. Watch whether they retry safely and how they read "Unconfirmed".
6. **Leave and return.** Start a turn, lock the phone for 40 s, return. Then repeat with a mocked push. Measure time to find the reply and what they expected to happen while away.
7. **Unprompted messages.** Show eight hypothetical messages with their level and reason. Ask which they want, when, and how many a day. Signal: where they draw the line, which feeds the budget question for the owner.
8. **Memory and limits.** Show a synthetic "Waldo noted: you prefer mornings for deep work" line and ask them to correct or forget it. Then ask what they think Waldo cannot do, after seeing two variants of the empty state. Watch whether they find Spots and whether "Forgotten" is believed.

## 6. Sources

Read directly:

- Horvitz, "Principles of Mixed-Initiative User Interfaces", CHI 1999: https://erichorvitz.com/chi99horvitz.pdf (twelve factors, the expected-utility threshold, the LookOut timing study).
- Amershi et al., "Guidelines for Human-AI Interaction", CHI 2019, Table 1 (G1 to G18): https://www.microsoft.com/en-us/research/uploads/prod/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf
- Claude Code checkpointing: https://code.claude.com/docs/en/checkpointing
- waldo-app code at `origin/main` `7e09317c`, and the design brief HTML.

Fetched through the summarizer (paraphrased):

- HAX Toolkit page (confirms 18 guidelines in four stages): https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
- Google PAIR: https://pair.withgoogle.com/chapter/errors-failing/ , https://pair.withgoogle.com/chapter/explainability-trust/ , https://pair.withgoogle.com/chapter/feedback-controls/
- Apple HIG (JSON data endpoints): https://developer.apple.com/design/human-interface-guidelines/generative-ai , https://developer.apple.com/design/human-interface-guidelines/machine-learning , https://developer.apple.com/design/human-interface-guidelines/progress-indicators , https://developer.apple.com/design/human-interface-guidelines/managing-notifications
- NN/g: https://www.nngroup.com/articles/response-times-3-important-limits/ (Nielsen), https://www.nngroup.com/articles/progress-indicators/ (Sherwin, 2014), https://www.nngroup.com/articles/ten-usability-heuristics/ , https://www.nngroup.com/articles/accordion-editing-apple-picking/ (Gibbons, Mugunthan, Nielsen, 2023)
- Anthropic, "Our framework for developing safe and trustworthy agents", 4 Aug 2025: https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents
- arXiv (via the arXiv API feed): Magentic-UI https://arxiv.org/abs/2507.22358 ; Pu et al. https://arxiv.org/abs/2502.18658 ; Chen et al. https://arxiv.org/abs/2410.04596 ; Bansal et al. https://arxiv.org/abs/2006.14779 ; Bucinca et al. https://arxiv.org/abs/2102.09692

Metadata only: Mark, Gudith and Klocke, CHI 2008: https://doi.org/10.1145/1357054.1357072

Unavailable: OpenAI ChatGPT agent page (HTTP 403); a primary source for voice-input states.
